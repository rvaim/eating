import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveEatingHome } from './paths'

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn(actual.homedir) }
})

let directory: string
let temporaryParent: string
let testHome: string

beforeEach(() => {
  temporaryParent = realpathSync(tmpdir())
  directory = realpathSync(mkdtempSync(join(temporaryParent, 'eating-paths-test-')))
  testHome = join(directory, 'test-user-home')
  vi.mocked(homedir).mockReturnValue(testHome)
  vi.stubEnv('EATING_HOME', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(homedir).mockReset()
  const target = realpathSync(directory)
  if (target !== directory || dirname(target) !== temporaryParent || !basename(target).startsWith('eating-paths-test-')) {
    throw new Error('Refusing to remove a path outside the test mkdtemp directory.')
  }
  rmSync(target, { recursive: true })
})

describe('Eating data directory resolution', () => {
  it('defaults to .eating in the supplied user home without accessing a real user directory', () => {
    expect(resolveEatingHome()).toBe(resolve(testHome, '.eating'))
  })

  it('uses EATING_HOME when no explicit configuration is supplied', () => {
    const configured = join(directory, 'environment-data')
    vi.stubEnv('EATING_HOME', configured)
    expect(resolveEatingHome()).toBe(configured)
  })

  it.each(['', ' ', '\t\n'])('uses the default home for an empty configuration: %j', configured => {
    expect(resolveEatingHome(configured)).toBe(resolve(testHome, '.eating'))
  })

  it('keeps an absolute data path and trims surrounding whitespace', () => {
    const configured = join(directory, 'custom data', 'eating')
    vi.stubEnv('EATING_HOME', join(directory, 'ignored-environment-data'))
    expect(resolveEatingHome(`  ${configured}  `)).toBe(configured)
  })

  it('expands a standalone tilde to the supplied user home', () => {
    expect(resolveEatingHome('~')).toBe(testHome)
  })

  it.each(['~/eating-data', '~\\eating-data'])('expands a home-relative prefix: %s', configured => {
    expect(resolveEatingHome(configured)).toBe(join(testHome, 'eating-data'))
  })

  it('normalizes home-relative components', () => {
    expect(resolveEatingHome('~/old/../eating-data')).toBe(join(testHome, 'eating-data'))
  })

  it('resolves a relative configuration against the working directory', () => {
    const expected = join(directory, 'relative-data')
    expect(resolveEatingHome(relative(process.cwd(), expected))).toBe(expected)
  })
})
