import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createOwnerTokenVerifier, parseServerAccess, validateServerAccess } from './server-access'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const token = randomBytes(32).toString('base64url')
const publicOrigin = 'http://example.test:5181'

describe('explicit Host server access configuration', () => {
  it('keeps an unconfigured Host loopback-only without an owner token', () => {
    expect(parseServerAccess({})).toEqual({ listenHost: '127.0.0.1' })
    expect(validateServerAccess({})).toEqual({ listenHost: '127.0.0.1' })
  })

  it('parses public binding and allows optional token protection on loopback', () => {
    expect(parseServerAccess({ EATING_LISTEN_HOST: '0.0.0.0', EATING_PUBLIC_ORIGIN: publicOrigin, EATING_OWNER_TOKEN: token })).toEqual({ listenHost: '0.0.0.0', publicOrigin, ownerToken: token })
    expect(parseServerAccess({ EATING_OWNER_TOKEN: token })).toEqual({ listenHost: '127.0.0.1', ownerToken: token })
    expect(parseServerAccess({ EATING_LISTEN_HOST: '0.0.0.0', EATING_PUBLIC_ORIGIN: 'https://example.test', EATING_OWNER_TOKEN: token })).toEqual({ listenHost: '0.0.0.0', publicOrigin: 'https://example.test', ownerToken: token })
  })

  it.each([
    {}, { EATING_PUBLIC_ORIGIN: publicOrigin }, { EATING_OWNER_TOKEN: token },
  ])('rejects public binding with incomplete access configuration case %#', values => {
    expect(() => parseServerAccess({ ...values, EATING_LISTEN_HOST: '0.0.0.0' })).toThrow('必须同时配置')
  })

  it.each(['', 'localhost', '::', '::1', '192.0.2.1', '0.0.0.0 ', ' 127.0.0.1'])('rejects unsupported binding case %#', listenHost => {
    expect(() => validateServerAccess({ listenHost, publicOrigin, ownerToken: token })).toThrow('EATING_LISTEN_HOST')
  })

  it.each(['', 'ftp://example.test', 'http://example.test/', 'http://example.test/path', 'http://example.test?query=1', 'http://example.test#fragment', 'http://owner@example.test', 'http://example.test:80', 'http://EXAMPLE.test', 'http://example.test\n'])('rejects non-origin URLs case %# without echoing supplied data', origin => {
    expect(() => parseServerAccess({ EATING_PUBLIC_ORIGIN: origin })).toThrow('EATING_PUBLIC_ORIGIN')
  })

  it.each(['', 'short-private-fixture', 'a'.repeat(31), 'a'.repeat(257), 'a'.repeat(32) + ' ', 'a'.repeat(32) + ':', 'a'.repeat(32) + '\n'])('rejects invalid tokens case %# without echoing supplied values', ownerToken => {
    let failure: unknown
    try { validateServerAccess({ ownerToken }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    const message = String(failure)
    expect(message).toContain('EATING_OWNER_TOKEN')
    if (ownerToken) expect(message).not.toContain(ownerToken)
  })

  it('compares exact bounded tokens and rejects prefixes, whitespace, and missing values', () => {
    const verify = createOwnerTokenVerifier(token)
    expect(verify(token)).toBe(true)
    for (const candidate of [null, '', token.slice(1), token + 'x', token + ' ', 'x'.repeat(token.length), 'x'.repeat(10000)]) expect(verify(candidate)).toBe(false)
  })

  it('fails the real main entry before workspace creation without printing secrets', async () => {
    const parent = await realpath(tmpdir()), home = await realpath(await mkdtemp(join(parent, 'eating-access-main-')))
    cleanups.push(async () => {
      if (await realpath(home) !== home || dirname(home) !== parent || !basename(home).startsWith('eating-access-main-')) throw new Error('Unsafe test cleanup')
      await rm(home, { recursive: true })
    })
    const invalidToken = 'short-private-fixture'
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./main.ts', import.meta.url))], {
      env: { PATH: process.env.PATH, EATING_HOME: home, EATING_LISTEN_HOST: '0.0.0.0', EATING_PUBLIC_ORIGIN: publicOrigin, EATING_OWNER_TOKEN: invalidToken }, encoding: 'utf8', timeout: 10000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain('EATING_OWNER_TOKEN')
    expect(result.stdout + result.stderr).not.toContain(invalidToken)
    expect(await readdir(home)).toEqual([])
  })
})
