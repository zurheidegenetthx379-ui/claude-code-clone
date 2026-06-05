import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  classifyCommandRisk,
  shouldEnforceSandbox,
  validateFileAccess,
  extractFilePaths,
  sanitizeEnvironment,
  detectGitInternalAccess,
  validateNetworkAccess,
} from '../src/utils/sandbox/sandbox-enforcer.js'

// ── classifyCommandRisk ──────────────────────────────────────────────────────

describe('classifyCommandRisk', () => {
  it('returns "low" for an empty string', () => {
    expect(classifyCommandRisk('')).toBe('low')
  })

  it('returns "low" for whitespace-only input', () => {
    expect(classifyCommandRisk('   ')).toBe('low')
  })

  it('classifies ls as low risk', () => {
    expect(classifyCommandRisk('ls -la')).toBe('low')
  })

  it('classifies cat as low risk', () => {
    expect(classifyCommandRisk('cat file.txt')).toBe('low')
  })

  it('classifies head as low risk', () => {
    expect(classifyCommandRisk('head -n 20 file.txt')).toBe('low')
  })

  it('classifies tail as low risk', () => {
    expect(classifyCommandRisk('tail -f log.txt')).toBe('low')
  })

  it('classifies pwd as low risk', () => {
    expect(classifyCommandRisk('pwd')).toBe('low')
  })

  it('classifies echo as low risk', () => {
    expect(classifyCommandRisk('echo hello world')).toBe('low')
  })

  it('classifies git status as low risk', () => {
    expect(classifyCommandRisk('git status')).toBe('low')
  })

  it('classifies git log as low risk', () => {
    expect(classifyCommandRisk('git log --oneline')).toBe('low')
  })

  it('classifies which as low risk', () => {
    expect(classifyCommandRisk('which node')).toBe('low')
  })

  it('classifies grep as low risk', () => {
    expect(classifyCommandRisk('grep pattern file.txt')).toBe('low')
  })

  it('classifies find as low risk', () => {
    expect(classifyCommandRisk('find . -name "*.ts"')).toBe('low')
  })

  // Medium risk
  it('classifies cp as medium risk', () => {
    expect(classifyCommandRisk('cp src/file.ts dst/file.ts')).toBe('medium')
  })

  it('classifies mv as medium risk', () => {
    expect(classifyCommandRisk('mv old.txt new.txt')).toBe('medium')
  })

  it('classifies tee as medium risk', () => {
    expect(classifyCommandRisk('tee output.txt')).toBe('medium')
  })

  it('classifies rm (non-critical) as medium risk', () => {
    expect(classifyCommandRisk('rm file.txt')).toBe('medium')
  })

  it('classifies mkdir as medium risk', () => {
    expect(classifyCommandRisk('mkdir newdir')).toBe('medium')
  })

  it('classifies touch as medium risk', () => {
    expect(classifyCommandRisk('touch file.txt')).toBe('medium')
  })

  it('classifies redirect > as medium risk', () => {
    expect(classifyCommandRisk('echo hello > output.txt')).toBe('medium')
  })

  it('classifies redirect >> as medium risk', () => {
    expect(classifyCommandRisk('echo hello >> log.txt')).toBe('medium')
  })

  it('classifies npm install as medium risk', () => {
    expect(classifyCommandRisk('npm install express')).toBe('medium')
  })

  it('classifies pip install as medium risk', () => {
    expect(classifyCommandRisk('pip install requests')).toBe('medium')
  })

  it('classifies cargo build as medium risk', () => {
    expect(classifyCommandRisk('cargo build')).toBe('medium')
  })

  it('classifies apt-get install as medium risk', () => {
    expect(classifyCommandRisk('apt-get install curl')).toBe('medium')
  })

  it('classifies tsc as medium risk', () => {
    expect(classifyCommandRisk('tsc --noEmit')).toBe('medium')
  })

  it('classifies chmod (non-system) as medium risk', () => {
    expect(classifyCommandRisk('chmod 755 script.sh')).toBe('medium')
  })

  it('classifies chown (non-system) as medium risk', () => {
    expect(classifyCommandRisk('chown user file.txt')).toBe('medium')
  })

  it('classifies truncate as medium risk', () => {
    expect(classifyCommandRisk('truncate -s 0 file.txt')).toBe('medium')
  })

  it('classifies yarn as medium risk', () => {
    expect(classifyCommandRisk('yarn add lodash')).toBe('medium')
  })

  it('classifies gem install as medium risk', () => {
    expect(classifyCommandRisk('gem install rails')).toBe('medium')
  })

  // High risk
  it('classifies curl as high risk', () => {
    expect(classifyCommandRisk('curl http://example.com')).toBe('high')
  })

  it('classifies wget as high risk', () => {
    expect(classifyCommandRisk('wget http://example.com/file')).toBe('high')
  })

  it('classifies ssh as high risk', () => {
    expect(classifyCommandRisk('ssh user@host')).toBe('high')
  })

  it('classifies scp as high risk', () => {
    expect(classifyCommandRisk('scp file.txt user@host:/tmp')).toBe('high')
  })

  it('classifies nc (netcat) as high risk', () => {
    expect(classifyCommandRisk('nc localhost 8080')).toBe('high')
  })

  it('classifies rsync as high risk', () => {
    expect(classifyCommandRisk('rsync -av src/ dst/')).toBe('high')
  })

  it('classifies git push --force as high risk', () => {
    expect(classifyCommandRisk('git push --force origin main')).toBe('high')
  })

  it('classifies git push -f as high risk', () => {
    expect(classifyCommandRisk('git push -f origin main')).toBe('high')
  })

  it('classifies export of sensitive AWS env var as high risk', () => {
    expect(classifyCommandRisk('export AWS_SECRET_KEY=abc')).toBe('high')
  })

  it('classifies export of GITHUB_TOKEN as high risk', () => {
    expect(classifyCommandRisk('export GITHUB_TOKEN=abc')).toBe('high')
  })

  it('classifies unset HOME as high risk', () => {
    expect(classifyCommandRisk('unset HOME')).toBe('high')
  })

  // Critical risk
  it('classifies rm -rf / as critical risk', () => {
    expect(classifyCommandRisk('rm -rf /')).toBe('critical')
  })

  it('classifies rm -rf /* as critical risk', () => {
    expect(classifyCommandRisk('rm -rf /*')).toBe('critical')
  })

  it('classifies rm -rf ~ as critical risk', () => {
    expect(classifyCommandRisk('rm -rf ~')).toBe('critical')
  })

  it('classifies rm -rf ~/* as critical risk', () => {
    expect(classifyCommandRisk('rm -rf ~/*')).toBe('critical')
  })

  it('classifies mkfs as critical risk', () => {
    expect(classifyCommandRisk('mkfs.ext4 /dev/sda1')).toBe('critical')
  })

  it('classifies dd if= as critical risk', () => {
    expect(classifyCommandRisk('dd if=/dev/zero of=/dev/sda')).toBe('critical')
  })

  it('classifies chmod 777 on / as critical risk', () => {
    expect(classifyCommandRisk('chmod 777 /')).toBe('critical')
  })

  it('classifies chmod 777 on /etc as critical risk', () => {
    expect(classifyCommandRisk('chmod 777 /etc')).toBe('critical')
  })

  it('classifies curl piped to sh as critical risk', () => {
    expect(classifyCommandRisk('curl http://example.com | sh')).toBe('critical')
  })

  it('classifies wget piped to bash as critical risk', () => {
    expect(classifyCommandRisk('wget http://example.com | bash')).toBe('critical')
  })

  it('classifies curl piped to sudo as critical risk', () => {
    expect(classifyCommandRisk('curl http://example.com | sudo sh')).toBe('critical')
  })

  it('classifies sudo as critical risk', () => {
    expect(classifyCommandRisk('sudo rm file')).toBe('critical')
  })

  it('classifies su as critical risk', () => {
    expect(classifyCommandRisk('su root')).toBe('critical')
  })

  it('classifies passwd as critical risk', () => {
    expect(classifyCommandRisk('passwd')).toBe('critical')
  })

  it('classifies chown on /etc as critical risk', () => {
    expect(classifyCommandRisk('chown root /etc')).toBe('critical')
  })

  // Edge cases
  it('handles extra whitespace correctly', () => {
    expect(classifyCommandRisk('  ls   -la  ')).toBe('low')
  })

  it('is case-insensitive', () => {
    expect(classifyCommandRisk('SUDO rm file')).toBe('critical')
  })

  it('classifies an unknown command as low risk', () => {
    expect(classifyCommandRisk('my-custom-tool run')).toBe('low')
  })
})

// ── shouldEnforceSandbox ─────────────────────────────────────────────────────

describe('shouldEnforceSandbox', () => {
  // always mode
  it('returns true for any command in "always" mode', () => {
    expect(shouldEnforceSandbox('ls', 'always')).toBe(true)
  })

  it('returns true even for low-risk commands in "always" mode', () => {
    expect(shouldEnforceSandbox('echo hello', 'always')).toBe(true)
  })

  it('returns true for critical commands in "always" mode', () => {
    expect(shouldEnforceSandbox('sudo rm -rf /', 'always')).toBe(true)
  })

  // never mode
  it('returns false for any command in "never" mode', () => {
    expect(shouldEnforceSandbox('sudo rm -rf /', 'never')).toBe(false)
  })

  it('returns false for medium-risk commands in "never" mode', () => {
    expect(shouldEnforceSandbox('cp a b', 'never')).toBe(false)
  })

  // auto mode
  it('returns false for low-risk commands in "auto" mode', () => {
    expect(shouldEnforceSandbox('ls -la', 'auto')).toBe(false)
  })

  it('returns true for medium-risk commands in "auto" mode', () => {
    expect(shouldEnforceSandbox('cp src dst', 'auto')).toBe(true)
  })

  it('returns true for high-risk commands in "auto" mode', () => {
    expect(shouldEnforceSandbox('curl http://example.com', 'auto')).toBe(true)
  })

  it('returns true for critical-risk commands in "auto" mode', () => {
    expect(shouldEnforceSandbox('sudo reboot', 'auto')).toBe(true)
  })
})

// ── validateFileAccess ───────────────────────────────────────────────────────

describe('validateFileAccess', () => {
  it('allows read when a matching rule has allowRead: true', () => {
    const rules = [{ path: path.resolve('/project'), allowRead: true, allowWrite: false }]
    const result = validateFileAccess(path.resolve('/project/file.ts'), rules, 'read')
    expect(result.allowed).toBe(true)
    expect(result.matchedRule).toBe(rules[0])
  })

  it('denies write when matching rule has allowWrite: false', () => {
    const rules = [{ path: path.resolve('/project'), allowRead: true, allowWrite: false }]
    const result = validateFileAccess(path.resolve('/project/file.ts'), rules, 'write')
    expect(result.allowed).toBe(false)
  })

  it('denies access when no rule matches (fail-closed)', () => {
    const rules = [{ path: path.resolve('/project'), allowRead: true, allowWrite: true }]
    const result = validateFileAccess(path.resolve('/other/file.ts'), rules, 'read')
    expect(result.allowed).toBe(false)
    expect(result.matchedRule).toBeUndefined()
  })

  it('applies first-match-wins semantics', () => {
    const specificDir = path.resolve('/project/secrets')
    const generalDir = path.resolve('/project')
    const rules = [
      { path: specificDir, allowRead: false, allowWrite: false },
      { path: generalDir, allowRead: true, allowWrite: true },
    ]
    const result = validateFileAccess(path.resolve('/project/secrets/key.pem'), rules, 'read')
    expect(result.allowed).toBe(false)
    expect(result.matchedRule).toBe(rules[0])
  })

  it('matches an exact path', () => {
    const exactPath = path.resolve('/project/exact-file.txt')
    const rules = [{ path: exactPath, allowRead: true, allowWrite: false }]
    const result = validateFileAccess(exactPath, rules, 'read')
    expect(result.allowed).toBe(true)
  })

  it('does not match partial directory names (e.g. /foo should not match /foobar)', () => {
    const rules = [{ path: path.resolve('/project/foo'), allowRead: true, allowWrite: true }]
    const result = validateFileAccess(path.resolve('/project/foobar/file.ts'), rules, 'read')
    expect(result.allowed).toBe(false)
  })

  it('matches glob patterns via minimatch', () => {
    const rules = [{ path: path.resolve('/project/**/*.ts'), allowRead: true, allowWrite: false }]
    const result = validateFileAccess(path.resolve('/project/src/file.ts'), rules, 'read')
    expect(result.allowed).toBe(true)
  })

  it('resolves relative paths to absolute before matching', () => {
    const cwd = process.cwd()
    const rules = [{ path: cwd, allowRead: true, allowWrite: true }]
    const result = validateFileAccess('some-relative-file.txt', rules, 'read')
    expect(result.allowed).toBe(true)
  })

  it('denies write but allows read on the same path depending on rule', () => {
    const rules = [{ path: path.resolve('/readonly'), allowRead: true, allowWrite: false }]
    expect(validateFileAccess(path.resolve('/readonly/file.txt'), rules, 'read').allowed).toBe(true)
    expect(validateFileAccess(path.resolve('/readonly/file.txt'), rules, 'write').allowed).toBe(false)
  })

  it('returns empty allowed with no rules at all', () => {
    const result = validateFileAccess(path.resolve('/any/path'), [], 'read')
    expect(result.allowed).toBe(false)
  })
})

// ── extractFilePaths ─────────────────────────────────────────────────────────

describe('extractFilePaths', () => {
  it('returns empty array for empty string', () => {
    expect(extractFilePaths('')).toEqual([])
  })

  it('returns empty array for whitespace-only string', () => {
    expect(extractFilePaths('   ')).toEqual([])
  })

  it('extracts source and destination from cp', () => {
    const paths = extractFilePaths('cp src/file.txt dst/file.txt')
    expect(paths).toContain('src/file.txt')
    expect(paths).toContain('dst/file.txt')
  })

  it('extracts source and destination from mv', () => {
    const paths = extractFilePaths('mv old/file.txt new/file.txt')
    expect(paths).toContain('old/file.txt')
    expect(paths).toContain('new/file.txt')
  })

  it('extracts file from rm', () => {
    const paths = extractFilePaths('rm file.txt')
    expect(paths).toContain('file.txt')
  })

  it('extracts file from cat', () => {
    const paths = extractFilePaths('cat src/index.ts')
    expect(paths).toContain('src/index.ts')
  })

  it('extracts redirect target with >', () => {
    const paths = extractFilePaths('echo hello > output.txt')
    expect(paths).toContain('output.txt')
  })

  it('extracts redirect target with >>', () => {
    const paths = extractFilePaths('echo hello >> log.txt')
    expect(paths).toContain('log.txt')
  })

  it('handles quoted paths (strips quotes)', () => {
    const paths = extractFilePaths("cat 'my file.txt'")
    expect(paths).toContain('my file.txt')
  })

  it('extracts search path from find', () => {
    const paths = extractFilePaths('find ./src -name "*.ts"')
    expect(paths).toContain('./src')
  })

  it('skips the pattern argument for grep and extracts file paths', () => {
    const paths = extractFilePaths('grep pattern file.txt')
    expect(paths).toContain('file.txt')
    expect(paths).not.toContain('pattern')
  })

  it('does not extract paths from ls', () => {
    const paths = extractFilePaths('ls -la /some/dir')
    expect(paths).toEqual([])
  })

  it('does not extract paths from echo (without redirect)', () => {
    const paths = extractFilePaths('echo hello world')
    expect(paths).toEqual([])
  })

  it('handles commands separated by &&', () => {
    const paths = extractFilePaths('cat file1.txt && cat file2.txt')
    expect(paths).toContain('file1.txt')
    expect(paths).toContain('file2.txt')
  })

  it('handles commands separated by |', () => {
    const paths = extractFilePaths('cat file.txt | grep pattern')
    expect(paths).toContain('file.txt')
  })

  it('extracts tar -f argument', () => {
    const paths = extractFilePaths('tar -x -f archive.tar.gz')
    expect(paths).toContain('archive.tar.gz')
  })

  it('extracts --flag=value path arguments', () => {
    const paths = extractFilePaths('somecmd --output=result/file.txt')
    expect(paths).toContain('result/file.txt')
  })

  it('extracts variable references from known commands (cat extracts all non-flag args)', () => {
    // cat is a single-operand command that extracts all non-flag args
    // The $ prefix check is only applied in generic path extraction
    const paths = extractFilePaths('cat $HOME/file.txt')
    expect(paths).toContain('$HOME/file.txt')
  })
})

// ── sanitizeEnvironment ──────────────────────────────────────────────────────

describe('sanitizeEnvironment', () => {
  it('removes all dangerous GIT_ env vars', () => {
    const env = {
      GIT_DIR: '/some/repo/.git',
      GIT_WORK_TREE: '/some/repo',
      GIT_INDEX_FILE: '/tmp/index',
      GIT_OBJECT_DIRECTORY: '/tmp/objects',
      SAFE_VAR: 'keep-me',
    }
    const result = sanitizeEnvironment(env)
    expect(result).not.toHaveProperty('GIT_DIR')
    expect(result).not.toHaveProperty('GIT_WORK_TREE')
    expect(result).not.toHaveProperty('GIT_INDEX_FILE')
    expect(result).not.toHaveProperty('GIT_OBJECT_DIRECTORY')
    expect(result.SAFE_VAR).toBe('keep-me')
  })

  it('removes LD_PRELOAD and DYLD_INSERT_LIBRARIES', () => {
    const env = {
      LD_PRELOAD: '/lib/evil.so',
      DYLD_INSERT_LIBRARIES: '/lib/evil.dylib',
      HOME: '/home/user',
    }
    const result = sanitizeEnvironment(env)
    expect(result).not.toHaveProperty('LD_PRELOAD')
    expect(result).not.toHaveProperty('DYLD_INSERT_LIBRARIES')
    expect(result.HOME).toBe('/home/user')
  })

  it('removes NODE_OPTIONS, NODE_PATH, and PYTHONPATH', () => {
    const env = {
      NODE_OPTIONS: '--require ./malicious.js',
      NODE_PATH: '/usr/lib/node_modules',
      PYTHONPATH: '/opt/python',
      USER: 'testuser',
    }
    const result = sanitizeEnvironment(env)
    expect(result).not.toHaveProperty('NODE_OPTIONS')
    expect(result).not.toHaveProperty('NODE_PATH')
    expect(result).not.toHaveProperty('PYTHONPATH')
    expect(result.USER).toBe('testuser')
  })

  it('preserves safe environment variables', () => {
    const env = { HOME: '/home/user', USER: 'test', SHELL: '/bin/bash', TERM: 'xterm' }
    const result = sanitizeEnvironment(env)
    expect(result).toEqual(env)
  })

  it('restricts PATH to safe directories when restrictPath is true', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin:/custom/dangerous/bin', HOME: '/home/user' }
    const result = sanitizeEnvironment(env, { restrictPath: true })
    expect(result).toHaveProperty('PATH')
    expect(result.PATH).not.toContain('/custom/dangerous/bin')
    expect(result.HOME).toBe('/home/user')
  })

  it('uses custom allowedPaths when restrictPath is true with allowedPaths', () => {
    const env = { PATH: '/usr/bin', HOME: '/home/user' }
    const customPaths = ['/safe/bin', '/safe/sbin']
    const result = sanitizeEnvironment(env, { restrictPath: true, allowedPaths: customPaths })
    expect(result.PATH).toBe(customPaths.join(path.delimiter))
  })

  it('skips undefined values', () => {
    const env = { DEFINED: 'yes', UNDEFINED_VAR: undefined }
    const result = sanitizeEnvironment(env)
    expect(result).toEqual({ DEFINED: 'yes' })
    expect(result).not.toHaveProperty('UNDEFINED_VAR')
  })

  it('does not mutate the original env object', () => {
    const env = { NODE_OPTIONS: '--bad', SAFE: 'ok' }
    const original = { ...env }
    sanitizeEnvironment(env)
    expect(env).toEqual(original)
  })
})

// ── detectGitInternalAccess ──────────────────────────────────────────────────

describe('detectGitInternalAccess', () => {
  const gitDir = path.resolve('/project/.git')

  it('detects access to .git/HEAD via raw command text', () => {
    const result = detectGitInternalAccess('cat .git/HEAD', gitDir)
    expect(result.accessesInternals).toBe(true)
    expect(result.touchedPaths.length).toBeGreaterThan(0)
  })

  it('detects access to .git/objects via raw command text', () => {
    const result = detectGitInternalAccess('ls .git/objects', gitDir)
    expect(result.accessesInternals).toBe(true)
  })

  it('detects access to .git/config via raw command text', () => {
    const result = detectGitInternalAccess('cat .git/config', gitDir)
    expect(result.accessesInternals).toBe(true)
  })

  it('detects access to .git/hooks via raw command text', () => {
    const result = detectGitInternalAccess('ls .git/hooks', gitDir)
    expect(result.accessesInternals).toBe(true)
  })

  it('detects access to .git/refs via raw command text', () => {
    const result = detectGitInternalAccess('cat .git/refs/heads/main', gitDir)
    expect(result.accessesInternals).toBe(true)
  })

  it('detects backslash variants (Windows-style)', () => {
    const result = detectGitInternalAccess('cat .git\\HEAD', gitDir)
    expect(result.accessesInternals).toBe(true)
  })

  it('does not flag access to .git directory itself (no protected internal)', () => {
    const result = detectGitInternalAccess('ls .git', gitDir)
    expect(result.accessesInternals).toBe(false)
  })

  it('does not flag unrelated commands', () => {
    const result = detectGitInternalAccess('cat src/file.txt', gitDir)
    expect(result.accessesInternals).toBe(false)
    expect(result.touchedPaths).toEqual([])
  })

  it('detects FETCH_HEAD via raw command text', () => {
    const result = detectGitInternalAccess('cat .git/FETCH_HEAD', gitDir)
    expect(result.accessesInternals).toBe(true)
  })

  it('detects MERGE_HEAD via raw command text', () => {
    const result = detectGitInternalAccess('cat .git/MERGE_HEAD', gitDir)
    expect(result.accessesInternals).toBe(true)
  })
})

// ── validateNetworkAccess ────────────────────────────────────────────────────

describe('validateNetworkAccess', () => {
  it('allows exact host match', () => {
    const rules = [{ host: 'api.example.com', allow: true }]
    const result = validateNetworkAccess('api.example.com', rules)
    expect(result.allowed).toBe(true)
    expect(result.matchedRule).toBe(rules[0])
  })

  it('allows glob match (e.g. *.github.com)', () => {
    const rules = [{ host: '*.github.com', allow: true }]
    const result = validateNetworkAccess('api.github.com', rules)
    expect(result.allowed).toBe(true)
  })

  it('denies when no rule matches (fail-closed)', () => {
    const rules = [{ host: 'api.example.com', allow: true }]
    const result = validateNetworkAccess('other.example.com', rules)
    expect(result.allowed).toBe(false)
    expect(result.matchedRule).toBeUndefined()
  })

  it('applies first-match-wins semantics', () => {
    const rules = [
      { host: 'evil.com', allow: false },
      { host: '*', allow: true },
    ]
    const result = validateNetworkAccess('evil.com', rules)
    expect(result.allowed).toBe(false)
    expect(result.matchedRule).toBe(rules[0])
  })

  it('matches wildcard * for any host', () => {
    const rules = [{ host: '*', allow: true }]
    const result = validateNetworkAccess('anything.example.com', rules)
    expect(result.allowed).toBe(true)
  })

  it('is case-insensitive for host comparison', () => {
    const rules = [{ host: 'API.Example.COM', allow: true }]
    const result = validateNetworkAccess('api.example.com', rules)
    expect(result.allowed).toBe(true)
  })

  it('denies when wildcard is set to deny', () => {
    const rules = [{ host: '*', allow: false }]
    const result = validateNetworkAccess('any.host.com', rules)
    expect(result.allowed).toBe(false)
  })

  it('allows specific host then denies all others via wildcard', () => {
    const rules = [
      { host: 'allowed.com', allow: true },
      { host: '*', allow: false },
    ]
    expect(validateNetworkAccess('allowed.com', rules).allowed).toBe(true)
    expect(validateNetworkAccess('blocked.com', rules).allowed).toBe(false)
  })
})
