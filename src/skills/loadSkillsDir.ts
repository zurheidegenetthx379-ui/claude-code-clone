/**
 * Skills discovery, parsing, and command registration system.
 *
 * Loads SKILL.md definitions from multiple directory sources, parses YAML
 * frontmatter, and builds executable SkillCommand objects with support for
 * variable expansion and embedded shell execution.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import yaml from 'yaml';

// ─── Type Definitions ────────────────────────────────────────────────────────

/** Where a skill was loaded from – affects trust decisions. */
export type SkillSourceType = 'user' | 'project' | 'additional' | 'mcp';

/** Parsed representation of a single SKILL.md file. */
export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  allowedTools: string[];
  model?: string;
  effort: 'low' | 'medium' | 'high';
  userInvocable: boolean;
  paths: string[];
  context: string[];
  shell: string | false;
  prompt: string;
  sourceType: SkillSourceType;
  /** Canonical realpath – used for inode-level deduplication. */
  sourcePath: string;
}

/** Options for {@link getSkillDirCommands}. */
export interface SkillDirOptions {
  /** Extra skill directories supplied via --add-dir. */
  additionalDirs?: string[];
}

/** Runtime context passed to {@link getPromptForCommand}. */
export interface CommandContext {
  /** Unique identifier for the current session. */
  sessionId: string;
  /** Absolute path to the directory that contains the SKILL.md. */
  skillDir: string;
  /**
   * Whether the skill was loaded through an MCP server.
   * When `true`, embedded shell execution is suppressed for security.
   */
  isMcpSource?: boolean;
}

/** A parsed, ready-to-instantiate skill command. */
export interface SkillCommand {
  name: string;
  description: string;
  whenToUse?: string;
  allowedTools: string[];
  model?: string;
  effort: 'low' | 'medium' | 'high';
  userInvocable: boolean;
  paths: string[];
  shell: string | false;
  /** Returns the fully-expanded prompt with all variables resolved. */
  getPrompt: (args: string[], context: CommandContext) => string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SKILL_FILENAME = 'SKILL.md';
const CC_AGENT_DIR = '.cc-agent';
const SKILLS_SUBDIR = 'skills';

// ─── Inode-level deduplication ───────────────────────────────────────────────

/**
 * Tracks canonical real-paths of every SKILL.md that has been loaded in the
 * current discovery pass.  Prevents the same file (reached via symlink or
 * hardlink) from being registered twice.
 */
const loadedInodes = new Set<string>();

// ─── Memoization cache ───────────────────────────────────────────────────────

/**
 * Memoization cache keyed by normalised cwd.
 * Invalidated whenever {@link resetSkillsCache} is called.
 */
const commandCache = new Map<string, SkillCommand[]>();

/**
 * Clear both the command cache and the inode tracking set.
 * Call this when skill directories change or at session boundaries.
 */
export function resetSkillsCache(): void {
  commandCache.clear();
  loadedInodes.clear();
}

// ─── Directory helpers ───────────────────────────────────────────────────────

function getUserSkillsDir(): string {
  return path.join(os.homedir(), CC_AGENT_DIR, SKILLS_SUBDIR);
}

/**
 * Starting from `startDir`, walk upward through every ancestor directory and
 * collect each `<ancestor>/.cc-agent/skills/` that actually exists on disk.
 */
function walkUpwardForSkillsDirs(startDir: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, CC_AGENT_DIR, SKILLS_SUBDIR);
    try {
      if (fs.statSync(candidate).isDirectory()) {
        dirs.push(candidate);
      }
    } catch {
      // Directory does not exist at this level – keep walking.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // Reached the filesystem root.
      break;
    }
    current = parent;
  }

  return dirs;
}

/**
 * Build the full ordered list of skill directories to search:
 *   1. User-level skills (`~/.cc-agent/skills/`)
 *   2. Project-level skills (every `.cc-agent/skills/` found walking up from cwd)
 *   2b. Project root `skills/` directory (common convention)
 *   3. Additional directories provided via `--add-dir`
 */
function collectSkillsDirs(cwd: string, additionalDirs: string[]): string[] {
  const dirs: string[] = [];

  // 1. User skills
  const userDir = getUserSkillsDir();
  if (fs.existsSync(userDir)) {
    dirs.push(userDir);
  }

  // 2. Project skills (closest ancestor first)
  dirs.push(...walkUpwardForSkillsDirs(cwd));

  // 2b. Project root `skills/` directory (common convention)
  const projectSkillsDir = path.join(path.resolve(cwd), 'skills');
  if (fs.existsSync(projectSkillsDir) && fs.statSync(projectSkillsDir).isDirectory()) {
    dirs.push(projectSkillsDir);
  }

  // 3. Additional directories from --add-dir
  for (const dir of additionalDirs) {
    const resolved = path.resolve(cwd, dir);
    if (fs.existsSync(resolved)) {
      dirs.push(resolved);
    }
  }

  return dirs;
}

// ─── Directory loading ───────────────────────────────────────────────────────

/**
 * Scan `basePath` for SKILL.md files and return parsed {@link SkillDefinition}s.
 *
 * Searches both the base directory itself and one level of subdirectories
 * (e.g. `skills/code-review/SKILL.md`).  Files are deduplicated by inode
 * (via `fs.realpathSync`) so that the same physical file reached through
 * different paths is loaded only once.
 */
export function loadSkillsFromSkillsDir(basePath: string): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(basePath, { withFileTypes: true });
  } catch {
    // Directory unreadable or missing – silently skip.
    return [];
  }

  // Collect candidate SKILL.md paths: direct children + subdirectory children.
  const candidates: Array<{ fullPath: string; basePath: string }> = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name === SKILL_FILENAME) {
      candidates.push({ fullPath: path.join(basePath, entry.name), basePath });
    }

    // Recurse one level into subdirectories (e.g. skills/code-review/SKILL.md).
    if (entry.isDirectory()) {
      const subDir = path.join(basePath, entry.name);
      try {
        const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
        for (const subEntry of subEntries) {
          if (subEntry.isFile() && subEntry.name === SKILL_FILENAME) {
            candidates.push({
              fullPath: path.join(subDir, subEntry.name),
              basePath,
            });
          }
        }
      } catch {
        // Subdirectory unreadable – skip.
      }
    }
  }

  for (const { fullPath } of candidates) {
    // ── Inode-level deduplication ──
    let realPath: string;
    try {
      realPath = fs.realpathSync(fullPath);
    } catch {
      continue;
    }
    if (loadedInodes.has(realPath)) {
      continue;
    }
    loadedInodes.add(realPath);

    // ── Parse ──
    try {
      const skill = loadSingleSkill(fullPath, realPath, basePath);
      if (skill) {
        skills.push(skill);
      }
    } catch (error) {
      console.error(`[skills] Failed to load skill at ${fullPath}:`, error);
    }
  }

  return skills;
}

// ─── Single-skill loading ────────────────────────────────────────────────────

function loadSingleSkill(
  fullPath: string,
  realPath: string,
  basePath: string,
): SkillDefinition | null {
  const raw = fs.readFileSync(fullPath, 'utf-8');
  if (!raw.trim()) return null;

  // ── Split frontmatter from body ──
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;

  let frontmatterObj: Record<string, unknown>;
  try {
    frontmatterObj = (yaml.parse(fmMatch[1]) as Record<string, unknown>) ?? {};
  } catch (err) {
    console.error(`[skills] YAML parse error in ${fullPath}:`, err);
    return null;
  }

  // Everything after the closing `---` delimiter (trimmed).
  const body = raw.slice(fmMatch[0].length).trim();

  const sourceType = inferSourceType(basePath);
  const fields = parseSkillFrontmatterFields(frontmatterObj, body, sourceType, realPath);
  return fields;
}

/** Decide the source type based on the directory the skill was found in. */
function inferSourceType(basePath: string): SkillSourceType {
  const home = os.homedir();
  if (basePath.startsWith(path.join(home, CC_AGENT_DIR))) {
    return 'user';
  }
  if (basePath.includes(CC_AGENT_DIR)) {
    return 'project';
  }
  return 'additional';
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

/**
 * Extract and validate every known field from a parsed YAML frontmatter
 * object, returning a fully-populated {@link SkillDefinition}.
 */
export function parseSkillFrontmatterFields(
  frontmatter: Record<string, unknown>,
  promptBody: string,
  sourceType: SkillSourceType,
  sourcePath: string,
): SkillDefinition {
  const name = frontmatter.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Skill frontmatter must include a non-empty "name" string field');
  }

  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description : '';

  const whenToUse =
    typeof frontmatter.when_to_use === 'string' ? frontmatter.when_to_use : undefined;

  // ── allowed_tools ──
  let allowedTools: string[] = [];
  if (Array.isArray(frontmatter.allowed_tools)) {
    allowedTools = frontmatter.allowed_tools.filter(
      (t): t is string => typeof t === 'string',
    );
  } else if (typeof frontmatter.allowed_tools === 'string') {
    allowedTools = frontmatter.allowed_tools
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);
  }

  // ── model ──
  const model =
    typeof frontmatter.model === 'string' ? frontmatter.model : undefined;

  // ── effort ──
  let effort: 'low' | 'medium' | 'high' = 'medium';
  if (
    frontmatter.effort === 'low' ||
    frontmatter.effort === 'medium' ||
    frontmatter.effort === 'high'
  ) {
    effort = frontmatter.effort;
  }

  // ── user_invocable ──
  const userInvocable =
    typeof frontmatter.user_invocable === 'boolean'
      ? frontmatter.user_invocable
      : true;

  // ── paths ──
  let paths: string[] = [];
  if (Array.isArray(frontmatter.paths)) {
    paths = frontmatter.paths.filter((p): p is string => typeof p === 'string');
  } else if (typeof frontmatter.paths === 'string') {
    paths = [frontmatter.paths];
  }

  // ── context ──
  let context: string[] = [];
  if (Array.isArray(frontmatter.context)) {
    context = frontmatter.context.filter(
      (c): c is string => typeof c === 'string',
    );
  } else if (typeof frontmatter.context === 'string') {
    context = [frontmatter.context];
  }

  // ── shell ──
  let shell: string | false = false;
  if (typeof frontmatter.shell === 'string') {
    shell = frontmatter.shell;
  } else if (frontmatter.shell === true) {
    shell = '/bin/sh'; // Sensible system default
  }

  return {
    name,
    description,
    whenToUse,
    allowedTools,
    model,
    effort,
    userInvocable,
    paths,
    context,
    shell,
    prompt: promptBody,
    sourceType,
    sourcePath,
  };
}

// ─── Command instantiation ───────────────────────────────────────────────────

/**
 * Wrap a {@link SkillDefinition} into a {@link SkillCommand} whose
 * `getPrompt` method performs full variable expansion at call time.
 */
export function createSkillCommand(definition: SkillDefinition): SkillCommand {
  return {
    name: definition.name,
    description: definition.description,
    whenToUse: definition.whenToUse,
    allowedTools: definition.allowedTools,
    model: definition.model,
    effort: definition.effort,
    userInvocable: definition.userInvocable,
    paths: definition.paths,
    shell: definition.shell,
    getPrompt: (args: string[], context: CommandContext) =>
      getPromptForCommand(args, context, definition.prompt, definition.sourceType),
  };
}

// ─── Prompt expansion ────────────────────────────────────────────────────────

/**
 * Produce the final prompt string for a skill invocation by performing, in
 * order:
 *
 *   1. **Built-in variable expansion** – `${SKILL_DIR}`, `${SESSION_ID}`
 *   2. **Embedded shell execution** – `$(`cmd`)` (trusted sources only; NOT MCP)
 *   3. **CLI argument substitution** – `${0}`, `${1}`, … and `${ARGS}`
 */
export function getPromptForCommand(
  args: string[],
  context: CommandContext,
  promptTemplate: string,
  sourceType: SkillSourceType,
): string {
  let prompt = promptTemplate;

  // ── Step 1: Built-in variables ──
  prompt = prompt.replaceAll('${SKILL_DIR}', context.skillDir);
  prompt = prompt.replaceAll('${SESSION_ID}', context.sessionId);

  // ── Step 2: Embedded shell execution (trusted sources only) ──
  if (sourceType !== 'mcp') {
    prompt = executeEmbeddedShellCommands(prompt, context.skillDir);
  }

  // ── Step 3: CLI argument substitution ──
  prompt = prompt.replaceAll('${ARGS}', args.join(' '));
  for (let i = 0; i < args.length; i++) {
    prompt = prompt.replaceAll(`\${${i}}`, args[i] ?? '');
  }

  // Clear any remaining positional placeholders that have no matching arg.
  prompt = prompt.replace(/\$\{(\d+)\}/g, '');

  return prompt;
}

// ─── Shell helpers ───────────────────────────────────────────────────────────

/**
 * Find every `$(command)` sequence in the template, execute each command via
 * `execSync`, and splice the stdout back into the string.
 *
 * Failures are reported inline so the caller can see exactly which command
 * failed and why – this is preferable to silent swallowing.
 */
function executeEmbeddedShellCommands(
  template: string,
  cwd: string,
): string {
  const shellCommandPattern = /\$\(([^)]+)\)/g;

  return template.replace(shellCommandPattern, (_match, command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return '';

    try {
      const output = execSync(trimmed, {
        cwd,
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim();
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `[skills] Embedded shell command "${trimmed}" failed: ${msg}`,
      );
      return `[shell error: ${trimmed} – ${msg}]`;
    }
  });
}

// ─── Public entry point (memoized) ───────────────────────────────────────────

/**
 * Discover every skill visible from `cwd`, parse them, and return
 * {@link SkillCommand} objects ready for registration.
 *
 * Results are memoized per `cwd` – call {@link resetSkillsCache} to invalidate.
 */
export function getSkillDirCommands(
  cwd: string,
  options: SkillDirOptions = {},
): SkillCommand[] {
  const cacheKey = path.resolve(cwd);

  const cached = commandCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // Fresh discovery pass – reset inode tracking.
  loadedInodes.clear();

  const additionalDirs = options.additionalDirs ?? [];
  const dirs = collectSkillsDirs(cwd, additionalDirs);

  const commands: SkillCommand[] = [];
  for (const dir of dirs) {
    const definitions = loadSkillsFromSkillsDir(dir);
    for (const def of definitions) {
      commands.push(createSkillCommand(def));
    }
  }

  commandCache.set(cacheKey, commands);
  return commands;
}
