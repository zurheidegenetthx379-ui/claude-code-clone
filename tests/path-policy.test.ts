/**
 * PathPolicy regression tests (V4)
 *
 * Covers the bare `.env` absolute-path bypass discovered in the V4 review:
 *   checkPathAccessSync('C:/Users/x/.env', { allowOutsideCwd: true }) was
 *   returning `allowed: true` because the `.env` branch fell through when
 *   no `.env.*` variant segment was present.
 */
import { describe, it, expect } from 'vitest'
import {
  checkPathAccess,
  checkPathAccessSync,
} from '../src/utils/PathPolicy.js'

const CWD = process.cwd()

/** Run the same assertion against both the sync and async implementations. */
function itBoth(
  name: string,
  inputPath: string,
  opts: { allowOutsideCwd?: boolean; allowedDirs?: string[] },
  expected: boolean,
) {
  it(`[sync]  ${name}`, () => {
    const result = checkPathAccessSync(inputPath, { cwd: CWD, ...opts })
    expect(result.allowed).toBe(expected)
  })

  it(`[async] ${name}`, async () => {
    const result = await checkPathAccess(inputPath, { cwd: CWD, ...opts })
    expect(result.allowed).toBe(expected)
  })
}

describe('PathPolicy V4 — .env absolute-path regression', () => {
  // Bare .env on an absolute path must be DENIED even when allowOutsideCwd is true
  itBoth(
    'bare .env absolute path with allowOutsideCwd → deny',
    // Construct an absolute path to .env outside cwd
    `${CWD.replace(/[/\\][^/\\]*$/, '')}/.env`,
    { allowOutsideCwd: true },
    false,
  )

  itBoth(
    'bare .env inside cwd → deny',
    '.env',
    { allowOutsideCwd: false },
    false,
  )

  // .env.example should be ALLOWED
  itBoth(
    '.env.example → allow (safe variant)',
    '.env.example',
    { allowOutsideCwd: false },
    true,
  )

  itBoth(
    '.env.local.example → allow (nested variant)',
    '.env.local.example',
    { allowOutsideCwd: false },
    true,
  )

  // .env.local and .env.production are themselves protected
  itBoth(
    '.env.local bare → deny',
    '.env.local',
    { allowOutsideCwd: false },
    false,
  )

  itBoth(
    '.env.production bare → deny',
    '.env.production',
    { allowOutsideCwd: false },
    false,
  )
})

describe('PathPolicy — other protected paths still work', () => {
  itBoth(
    '.ssh directory → deny',
    '.ssh',
    { allowOutsideCwd: false },
    false,
  )

  itBoth(
    '.git/config → deny',
    '.git/config',
    { allowOutsideCwd: false },
    false,
  )

  itBoth(
    '.npmrc → deny',
    '.npmrc',
    { allowOutsideCwd: false },
    false,
  )

  itBoth(
    'credentials → deny',
    'credentials',
    { allowOutsideCwd: false },
    false,
  )

  itBoth(
    'normal file → allow',
    'README.md',
    { allowOutsideCwd: false },
    true,
  )

  itBoth(
    'subdirectory file → allow',
    'src/index.ts',
    { allowOutsideCwd: false },
    true,
  )
})
