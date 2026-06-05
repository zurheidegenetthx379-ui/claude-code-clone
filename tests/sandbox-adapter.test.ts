import { describe, it, expect } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import {
  convertToSandboxRuntimeConfig,
  isSandboxingEnabled,
  type SandboxSettings,
  type PermissionContext,
} from '../src/utils/sandbox/sandbox-adapter.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSettings(overrides?: Partial<SandboxSettings>): SandboxSettings {
  return {
    enabled: true,
    enabledPlatforms: [],
    ...overrides,
  }
}

function makePermissionContext(overrides?: Partial<PermissionContext>): PermissionContext {
  return {
    cwd: path.resolve('/project'),
    ...overrides,
  }
}

// ── isSandboxingEnabled ──────────────────────────────────────────────────────

describe('isSandboxingEnabled', () => {
  it('returns false when settings.enabled is false', () => {
    expect(isSandboxingEnabled(makeSettings({ enabled: false }))).toBe(false)
  })

  it('returns true when enabled is true and enabledPlatforms is empty (all platforms)', () => {
    expect(isSandboxingEnabled(makeSettings({ enabled: true, enabledPlatforms: [] }))).toBe(true)
  })

  it('returns true when current platform is in enabledPlatforms', () => {
    const platform = os.platform()
    expect(
      isSandboxingEnabled(makeSettings({ enabled: true, enabledPlatforms: [platform] })),
    ).toBe(true)
  })

  it('returns false when current platform is NOT in enabledPlatforms', () => {
    // Use a platform that definitely isn't the current one
    const fakePlatform = 'aix' // AIX is unlikely
    const currentPlatform = os.platform()
    const otherPlatforms = ['linux', 'darwin', 'win32', 'freebsd'].filter(p => p !== currentPlatform)
    // Pick one that's not the current platform
    const wrongPlatform = otherPlatforms[0]!
    expect(
      isSandboxingEnabled(makeSettings({ enabled: true, enabledPlatforms: [wrongPlatform] })),
    ).toBe(false)
  })

  it('returns false when enabled is false even if platform matches', () => {
    const platform = os.platform()
    expect(
      isSandboxingEnabled(makeSettings({ enabled: false, enabledPlatforms: [platform] })),
    ).toBe(false)
  })
})

// ── convertToSandboxRuntimeConfig ────────────────────────────────────────────

describe('convertToSandboxRuntimeConfig', () => {
  it('returns empty rules when sandbox is disabled', () => {
    const config = convertToSandboxRuntimeConfig(
      makeSettings({ enabled: false }),
      makePermissionContext(),
    )
    expect(config.enabled).toBe(false)
    expect(config.filesystemRules).toEqual([])
    expect(config.networkRules).toEqual([])
  })

  it('returns enabled: true with rules when sandbox is enabled', () => {
    const config = convertToSandboxRuntimeConfig(
      makeSettings(),
      makePermissionContext(),
    )
    expect(config.enabled).toBe(true)
    expect(config.filesystemRules.length).toBeGreaterThan(0)
    expect(config.networkRules.length).toBeGreaterThan(0)
  })

  it('includes project root as a writable rule', () => {
    const cwd = path.resolve('/my-project')
    const config = convertToSandboxRuntimeConfig(
      makeSettings(),
      makePermissionContext({ cwd }),
    )
    const projectRule = config.filesystemRules.find(r => r.path === cwd)
    expect(projectRule).toBeDefined()
    expect(projectRule!.allowWrite).toBe(true)
    expect(projectRule!.allowRead).toBe(true)
  })

  it('includes OS temp directory as a writable rule', () => {
    const config = convertToSandboxRuntimeConfig(
      makeSettings(),
      makePermissionContext(),
    )
    const tempRule = config.filesystemRules.find(r => r.path === os.tmpdir())
    expect(tempRule).toBeDefined()
    expect(tempRule!.allowWrite).toBe(true)
  })

  it('places deny rules before allow rules (deny takes priority)', () => {
    const config = convertToSandboxRuntimeConfig(
      makeSettings(),
      makePermissionContext(),
    )
    // Find the first deny-write rule and the first allow-write rule
    const firstDenyIdx = config.filesystemRules.findIndex(r => r.allowWrite === false)
    const firstAllowIdx = config.filesystemRules.findIndex(r => r.allowWrite === true)
    expect(firstDenyIdx).toBeLessThan(firstAllowIdx)
  })

  it('protects git internal paths when protectGitInternals is not disabled', () => {
    const cwd = path.resolve('/project')
    const config = convertToSandboxRuntimeConfig(
      makeSettings({ protectGitInternals: true }),
      makePermissionContext({ cwd }),
    )
    const gitDir = path.join(cwd, '.git')
    const headRule = config.filesystemRules.find(r => r.path === path.join(gitDir, 'HEAD'))
    expect(headRule).toBeDefined()
    expect(headRule!.allowWrite).toBe(false)
    expect(headRule!.allowRead).toBe(true)

    const objectsRule = config.filesystemRules.find(r => r.path === path.join(gitDir, 'objects'))
    expect(objectsRule).toBeDefined()
    expect(objectsRule!.allowWrite).toBe(false)
  })

  it('does not add git internal rules when protectGitInternals is false', () => {
    const cwd = path.resolve('/project')
    const config = convertToSandboxRuntimeConfig(
      makeSettings({ protectGitInternals: false }),
      makePermissionContext({ cwd }),
    )
    const gitDir = path.join(cwd, '.git')
    const headRule = config.filesystemRules.find(r => r.path === path.join(gitDir, 'HEAD'))
    expect(headRule).toBeUndefined()
  })

  // Network rules
  it('denies all network when webFetchEnabled is false', () => {
    const config = convertToSandboxRuntimeConfig(
      makeSettings(),
      makePermissionContext({ webFetchEnabled: false }),
    )
    expect(config.networkRules).toHaveLength(1)
    expect(config.networkRules[0]).toEqual({ host: '*', allow: false })
  })

  it('creates allowlist with default-deny when allowedFetchDomains is set', () => {
    const config = convertToSandboxRuntimeConfig(
      makeSettings(),
      makePermissionContext({
        allowedFetchDomains: ['api.example.com', 'docs.example.com'],
      }),
    )
    expect(config.networkRules.length).toBe(3) // 2 allows + 1 deny-all
    expect(config.networkRules[0]).toEqual({ host: 'api.example.com', allow: true })
    expect(config.networkRules[1]).toEqual({ host: 'docs.example.com', allow: true })
    expect(config.networkRules[2]).toEqual({ host: '*', allow: false })
  })

  it('allows all network by default when no webFetch restrictions', () => {
    const config = convertToSandboxRuntimeConfig(
      makeSettings(),
      makePermissionContext(),
    )
    const wildcardRule = config.networkRules.find(r => r.host === '*')
    expect(wildcardRule).toBeDefined()
    expect(wildcardRule!.allow).toBe(true)
  })

  it('uses settings-level network allow/deny rules', () => {
    const config = convertToSandboxRuntimeConfig(
      makeSettings({
        network: {
          allow: ['trusted.com'],
          deny: ['evil.com'],
        },
      }),
      makePermissionContext(),
    )
    expect(config.networkRules).toContainEqual({ host: 'trusted.com', allow: true })
    expect(config.networkRules).toContainEqual({ host: 'evil.com', allow: false })
  })

  // Permission context integration
  it('includes additional permission deny-write paths', () => {
    const cwd = path.resolve('/project')
    const config = convertToSandboxRuntimeConfig(
      makeSettings(),
      makePermissionContext({
        cwd,
        additionalPermissions: { denyWrite: ['secrets'] },
      }),
    )
    const secretsPath = path.join(cwd, 'secrets')
    const rule = config.filesystemRules.find(r => r.path === secretsPath)
    expect(rule).toBeDefined()
    expect(rule!.allowWrite).toBe(false)
    expect(rule!.allowRead).toBe(true)
  })

  it('includes additional permission allow-write paths', () => {
    const cwd = path.resolve('/project')
    const config = convertToSandboxRuntimeConfig(
      makeSettings(),
      makePermissionContext({
        cwd,
        additionalPermissions: { allowWrite: ['extra-dir'] },
      }),
    )
    const extraPath = path.join(cwd, 'extra-dir')
    const rule = config.filesystemRules.find(r => r.path === extraPath)
    expect(rule).toBeDefined()
    expect(rule!.allowWrite).toBe(true)
  })

  it('sets rootPath to the permission context cwd', () => {
    const cwd = path.resolve('/my-project')
    const config = convertToSandboxRuntimeConfig(
      makeSettings(),
      makePermissionContext({ cwd }),
    )
    expect(config.rootPath).toBe(cwd)
  })

  it('sets tempDir to os.tmpdir()', () => {
    const config = convertToSandboxRuntimeConfig(
      makeSettings(),
      makePermissionContext(),
    )
    expect(config.tempDir).toBe(os.tmpdir())
  })

  it('protects .cc-agent/skills directories from writes', () => {
    const cwd = path.resolve('/project')
    const config = convertToSandboxRuntimeConfig(
      makeSettings(),
      makePermissionContext({ cwd }),
    )
    const projectSkillsPath = path.join(cwd, '.cc-agent', 'skills')
    const rule = config.filesystemRules.find(r => r.path === projectSkillsPath)
    expect(rule).toBeDefined()
    expect(rule!.allowWrite).toBe(false)
    expect(rule!.allowRead).toBe(true)
  })
})
