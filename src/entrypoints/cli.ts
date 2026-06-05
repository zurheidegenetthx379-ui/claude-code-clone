#!/usr/bin/env node
/**
 * CLI entry point - lightweight router for fast-path commands
 *
 * Mirrors Claude Code's cli.tsx architecture:
 * - Parse argv for fast-path commands (--version, --help, --print, etc.)
 * - Execute fast paths without loading heavy dependencies
 * - Dynamically import main.ts only when needed (REPL mode)
 */

import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'

// ============================================================
// .env File Loader
// ============================================================

/**
 * Load environment variables from a `.env` file.
 *
 * Searches upward from `startDir` for a `.env` file.  Variables already
 * present in `process.env` are NOT overwritten — explicit env vars always
 * take precedence.
 *
 * Supports:
 *   - `KEY=value` pairs (with optional surrounding quotes)
 *   - `# comment` lines and blank lines (skipped)
 *   - `.env.local` override (loaded after `.env` if present)
 */
function loadDotEnv(startDir: string): void {
  // Walk upward to find the project root (contains package.json).
  let dir = resolve(startDir)
  let projectRoot: string | null = null

  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      projectRoot = dir
      break
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  if (!projectRoot) return

  for (const filename of ['.env', '.env.local']) {
    const envPath = join(projectRoot, filename)
    if (!existsSync(envPath)) continue

    try {
      const content = readFileSync(envPath, 'utf-8')
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue

        const eqIndex = line.indexOf('=')
        if (eqIndex === -1) continue

        const key = line.slice(0, eqIndex).trim()
        let value = line.slice(eqIndex + 1).trim()

        // Strip surrounding quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }

        // Do NOT override existing env vars — they take precedence
        if (key && process.env[key] === undefined) {
          process.env[key] = value
        }
      }
    } catch {
      // .env loading is best-effort
    }
  }
}

// ============================================================
// Version & Package Info
// ============================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, '../../package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version || '1.0.0'
  } catch {
    return '1.0.0'
  }
}

// ============================================================
// Fast-Path Command Handlers
// ============================================================

function printVersion(): void {
  console.log(`cc-agent v${getVersion()}`)
  process.exit(0)
}

function printHelp(): void {
  const version = getVersion()
  console.log(`
cc-agent v${version} - AI Coding Agent

USAGE:
  cc-agent [options] [prompt]

FAST-PATH OPTIONS:
  -v, --version              Print version and exit
  -h, --help                 Print this help message and exit
  --dump-system-prompt       Dump the system prompt to stdout and exit

HEADLESS MODE:
  -p, --print <prompt>       Run in headless mode (pipe response to stdout)
  --sdk                      Enable SDK mode (JSON protocol on stdin/stdout)

REPL MODE:
  (default)                  Start interactive REPL
  --ink                      Start REPL with React+Ink terminal UI

RUNTIME OPTIONS:
  --model <model>            Override default model (e.g., claude-sonnet-4-20250514)
  --system-prompt <text>     Override system prompt
  --permission-mode <mode>   Permission mode: default | acceptEdits | bypassPermissions | plan
  --max-tokens <number>      Maximum output tokens
  --temperature <number>     Sampling temperature (0-1)
  --cwd <path>               Working directory (default: current directory)
  --resume <session-id>      Resume a previous session
  --no-memory                Disable session memory
  --verbose                  Enable verbose logging

EXAMPLES:
  cc-agent                   Start interactive REPL
  cc-agent "fix the bug"     Start REPL with initial prompt
  cc-agent -p "explain"      Headless mode: print response and exit
  cc-agent --model claude-3-opus-20240229

For more information, see the documentation.
`)
  process.exit(0)
}

async function dumpSystemPrompt(): Promise<void> {
  // Dynamically import only what we need for system prompt generation
  const { buildEffectiveSystemPrompt } = await import('../utils/systemPrompt.js')
  const result = await buildEffectiveSystemPrompt({
    tools: [],
    model: 'claude-sonnet-4-20250514',
  })
  console.log(result.content)
  process.exit(0)
}

async function runHeadless(args: string[]): Promise<void> {
  // Extract prompt from args
  const promptIndex = args.findIndex(a => a === '--print' || a === '-p')
  const prompt = args[promptIndex + 1]

  if (!prompt) {
    console.error('Error: --print requires a prompt argument')
    process.exit(1)
  }

  // Parse remaining options
  const options = parseOptions(args.filter((_, i) => i !== promptIndex && i !== promptIndex + 1))

  // Dynamically import main.ts for heavy lifting
  const { runHeadless: runHeadlessMain } = await import('../main.js')
  await runHeadlessMain({
    prompt,
    model: options.model,
    systemPrompt: options.systemPrompt,
    permissionMode: options.permissionMode,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    cwd: options.cwd || process.cwd(),
    outputFormat: 'text',
  })
  process.exit(0)
}

async function runSdkMode(args: string[]): Promise<void> {
  // Parse options
  const options = parseOptions(args.filter(a => a !== '--sdk'))

  // Dynamically import main.ts for heavy lifting
  const { runSdkMode: runSdkModeMain } = await import('../main.js')
  await runSdkModeMain({
    model: options.model,
    systemPrompt: options.systemPrompt,
    permissionMode: options.permissionMode,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    cwd: options.cwd || process.cwd(),
  })
  process.exit(0)
}

// ============================================================
// Argument Parsing Utilities
// ============================================================

interface ParsedOptions {
  model?: string
  systemPrompt?: string
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  maxTokens?: number
  temperature?: number
  cwd?: string
  resume?: string
  noMemory?: boolean
  verbose?: boolean
  prompt?: string
  allowList?: string[]
  denyList?: string[]
}

function parseOptions(args: string[]): ParsedOptions {
  const options: ParsedOptions = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--model' && args[i + 1]) {
      options.model = args[++i]
    } else if (arg === '--system-prompt' && args[i + 1]) {
      options.systemPrompt = args[++i]
    } else if (arg === '--permission-mode' && args[i + 1]) {
      const mode = args[++i]
      if (['default', 'acceptEdits', 'bypassPermissions', 'plan'].includes(mode)) {
        options.permissionMode = mode as ParsedOptions['permissionMode']
      } else {
        console.error(`Error: Invalid permission mode: ${mode}`)
        process.exit(1)
      }
    } else if (arg === '--max-tokens' && args[i + 1]) {
      const tokens = parseInt(args[++i], 10)
      if (isNaN(tokens) || tokens < 1) {
        console.error('Error: --max-tokens must be a positive integer')
        process.exit(1)
      }
      options.maxTokens = tokens
    } else if (arg === '--temperature' && args[i + 1]) {
      const temp = parseFloat(args[++i])
      if (isNaN(temp) || temp < 0 || temp > 1) {
        console.error('Error: --temperature must be between 0 and 1')
        process.exit(1)
      }
      options.temperature = temp
    } else if (arg === '--cwd' && args[i + 1]) {
      options.cwd = args[++i]
    } else if (arg === '--resume' && args[i + 1]) {
      options.resume = args[++i]
    } else if (arg === '--no-memory') {
      options.noMemory = true
    } else if (arg === '--verbose') {
      options.verbose = true
    } else if (arg === '--allow' && args[i + 1]) {
      (options.allowList ??= []).push(args[++i])
    } else if (arg === '--deny' && args[i + 1]) {
      (options.denyList ??= []).push(args[++i])
    } else if (!arg.startsWith('-') && !options.prompt) {
      // First non-option argument is the prompt
      options.prompt = arg
    }
  }

  return options
}

// ============================================================
// Main Router
// ============================================================

async function main(): Promise<void> {
  // Load .env before any dynamic imports so that env vars like
  // CC_AGENT_MODEL are available when main.ts evaluates its constants.
  loadDotEnv(__dirname)

  const args = process.argv.slice(2)

  // Fast-path: version
  if (args.includes('--version') || args.includes('-v')) {
    printVersion()
    return
  }

  // Fast-path: help
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }

  // Fast-path: dump system prompt
  if (args.includes('--dump-system-prompt')) {
    await dumpSystemPrompt()
    return
  }

  // Fast-path: headless mode (--print / -p)
  if (args.includes('--print') || args.includes('-p')) {
    await runHeadless(args)
    return
  }

  // Fast-path: SDK mode
  if (args.includes('--sdk')) {
    await runSdkMode(args)
    return
  }

  // No fast path matched - load main.ts and start REPL
  const options = parseOptions(args)

  if (args.includes('--ink')) {
    const { startInkRepl } = await import('../main.js')
    await startInkRepl({
      initialPrompt: options.prompt,
      model: options.model,
      systemPrompt: options.systemPrompt,
      permissionMode: options.permissionMode,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      cwd: options.cwd || process.cwd(),
      resumeSessionId: options.resume,
      enableMemory: !options.noMemory,
      verbose: options.verbose,
      useInk: true,
      allowList: options.allowList,
      denyList: options.denyList,
    })
  } else {
    const { startRepl } = await import('../main.js')
    await startRepl({
      initialPrompt: options.prompt,
      model: options.model,
      systemPrompt: options.systemPrompt,
      permissionMode: options.permissionMode,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      cwd: options.cwd || process.cwd(),
      resumeSessionId: options.resume,
      enableMemory: !options.noMemory,
      verbose: options.verbose,
      allowList: options.allowList,
      denyList: options.denyList,
    })
  }
}

// ============================================================
// Entry Point
// ============================================================

main().catch(error => {
  console.error('Fatal error:', error instanceof Error ? error.message : error)
  if (error instanceof Error && error.stack && process.env['DEBUG']) {
    console.error(error.stack)
  }
  process.exit(1)
})
