import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QQAccountRegistry } from './accounts'
import { QQConfigurationFile } from './config-file'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

const cleanups: Array<() => void> = []
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const secondId = '00000000-0000-4000-8000-000000000002'
const createdAt = '2026-10-26T12:00:00.000Z'

afterEach(() => {
  vi.mocked(renameSync).mockReset()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture() {
  const temporaryParent = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(temporaryParent, 'eating-accounts-test-')))
  const root = resolve(directory, 'qq-bot')
  cleanups.push(() => {
    const target = realpathSync(directory)
    if (target !== directory || dirname(target) !== temporaryParent || !basename(target).startsWith('eating-accounts-test-')) {
      throw new Error('Refusing to remove a path outside the test mkdtemp directory.')
    }
    rmSync(target, { recursive: true })
  })
  return { directory, root }
}

function index(instances = [{ instanceId: secondId, label: 'Second test account', createdAt }], defaultInstanceId = secondId) {
  return { schemaVersion: 1, defaultInstanceId, instances }
}

function writeIndex(root: string, text: string): string {
  mkdirSync(root, { recursive: true })
  const file = join(root, 'accounts.json')
  writeFileSync(file, text)
  return file
}

describe('QQ stable account instance registry', () => {
  it('creates one stable UUID default and reopens it without rewriting the index', () => {
    const { root } = fixture()
    const first = new QQAccountRegistry(root)
    expect(first.instances).toHaveLength(1)
    expect(first.defaultInstanceId).toMatch(uuid)
    expect(first.instances[0]).toMatchObject({ instanceId: first.defaultInstanceId, label: '默认 QQ 账号' })
    const saved = readFileSync(first.indexPath, 'utf8')
    const reopened = new QQAccountRegistry(root)
    expect(reopened.defaultInstanceId).toBe(first.defaultInstanceId)
    expect(reopened.instances).toEqual(first.instances)
    expect(readFileSync(first.indexPath, 'utf8')).toBe(saved)
    const configuration = new QQConfigurationFile(reopened.directoryFor(reopened.defaultInstanceId))
    expect(configuration.filePath).toBe(join(root, 'accounts', first.defaultInstanceId, 'config.json'))
    expect(configuration.read()).toBeNull()
  })

  it('reads a second valid instance and selects the stored default without changing either identity', () => {
    const { root } = fixture()
    const first = new QQAccountRegistry(root)
    const text = JSON.stringify(index([...first.instances, { instanceId: secondId, label: 'Second test account', createdAt }], secondId))
    writeFileSync(first.indexPath, text)
    const reopened = new QQAccountRegistry(root)
    expect(reopened.instances.map(instance => instance.instanceId)).toEqual([first.defaultInstanceId, secondId])
    expect(reopened.defaultInstanceId).toBe(secondId)
    expect(reopened.directoryFor(secondId)).toBe(join(root, 'accounts', secondId))
    expect(reopened.directoryFor(first.defaultInstanceId)).toBe(join(root, 'accounts', first.defaultInstanceId))
    expect(readFileSync(reopened.indexPath, 'utf8')).toBe(text)
  })

  it('rejects duplicate IDs without overwriting the index', () => {
    const { root } = fixture()
    const entry = { instanceId: secondId, label: 'Duplicate test account', createdAt }
    const text = JSON.stringify(index([entry, entry]))
    const file = writeIndex(root, text)
    expect(() => new QQAccountRegistry(root)).toThrowError(expect.objectContaining({ code: 'ACCOUNT_INDEX_CORRUPTED' }))
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it.each(['../escape', 'nested/escape', '..', 'nested\\escape', '/absolute', ''])('rejects unsafe instance IDs without rewriting: %j', instanceId => {
    const { root, directory } = fixture()
    const text = JSON.stringify(index([{ instanceId, label: 'Invalid test account', createdAt }], instanceId))
    const file = writeIndex(root, text)
    expect(() => new QQAccountRegistry(root)).toThrowError(expect.objectContaining({ code: 'ACCOUNT_INDEX_CORRUPTED' }))
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(readdirSync(directory)).toEqual(['qq-bot'])
  })

  it.each([
    ['invalid JSON', '{'],
    ['unsupported schema', JSON.stringify({ ...index(), schemaVersion: 2 })],
    ['missing default', JSON.stringify(index(undefined, 'missing-instance'))],
    ['empty instance set', JSON.stringify(index([]))],
  ])('rejects a corrupt index and preserves its original bytes: %s', (_name, text) => {
    const { root } = fixture()
    const file = writeIndex(root, text)
    expect(() => new QQAccountRegistry(root)).toThrowError(expect.objectContaining({ code: 'ACCOUNT_INDEX_CORRUPTED' }))
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it('rejects unknown directory lookups, including traversal attempts', () => {
    const registry = new QQAccountRegistry(fixture().root)
    expect(() => registry.directoryFor('../escape')).toThrowError(expect.objectContaining({ code: 'ACCOUNT_INSTANCE_NOT_FOUND' }))
    expect(() => registry.directoryFor('missing-instance')).toThrowError(expect.objectContaining({ code: 'ACCOUNT_INSTANCE_NOT_FOUND' }))
  })

  it('requires explicit migration when a legacy root configuration exists and preserves the data', () => {
    const { root } = fixture()
    mkdirSync(root, { recursive: true })
    const file = join(root, 'config.json')
    const text = JSON.stringify({ endpoint: 'ws://127.0.0.1:1', accessToken: 'test-only-legacy-token' })
    writeFileSync(file, text)
    expect(() => new QQAccountRegistry(root)).toThrowError(expect.objectContaining({ code: 'ACCOUNT_MIGRATION_REQUIRED', statusCode: 409 }))
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(existsSync(join(root, 'accounts.json'))).toBe(false)
    expect(readdirSync(root)).toEqual(['config.json'])
  })
})

describe('QQ per-instance restricted configuration', () => {
  it('atomically replaces and rereads test credentials without leaving temporary files', () => {
    const registry = new QQAccountRegistry(fixture().root)
    const directory = registry.directoryFor(registry.defaultInstanceId)
    const file = new QQConfigurationFile(directory)
    expect(file.read()).toBeNull()
    const first = { displayName: 'First test account', accessToken: 'test-only-first-token', endpoint: 'ws://127.0.0.1:1' }
    file.write(first)
    expect(new QQConfigurationFile(directory).read()).toEqual(first)
    const next = { ...first, displayName: 'Updated test account', accessToken: 'test-only-updated-token' }
    file.write(next)
    const reopened = new QQConfigurationFile(directory)
    expect(reopened.read()).toEqual(next)
    expect(reopened.updatedAt).toBe(file.updatedAt)
    expect(file.updatedAt).toEqual(expect.any(String))
    expect(JSON.parse(readFileSync(file.filePath, 'utf8'))).toEqual({ schemaVersion: 1, updatedAt: file.updatedAt, configuration: next })
    expect(readdirSync(directory)).toEqual(['config.json'])
  })

  it('preserves the previous complete file and removes the temporary file if rename fails', () => {
    const registry = new QQAccountRegistry(fixture().root)
    const file = new QQConfigurationFile(registry.directoryFor(registry.defaultInstanceId))
    const configuration = { accessToken: 'test-only-retained-token', displayName: 'Retained test account' }
    file.write(configuration)
    const originalBytes = readFileSync(file.filePath, 'utf8')
    const originalUpdatedAt = file.updatedAt
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('test-only simulated rename failure') })
    expect(() => file.write({ ...configuration, accessToken: 'test-only-replacement-token' })).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_SAVE_FAILED' }))
    expect(readFileSync(file.filePath, 'utf8')).toBe(originalBytes)
    expect(file.read()).toEqual(configuration)
    expect(file.updatedAt).toBe(originalUpdatedAt)
    expect(readdirSync(file.directory)).toEqual(['config.json'])
  })

  it.skipIf(process.platform === 'win32')('keeps token files at 0600 and owned configuration directories at 0700 on POSIX', () => {
    const registry = new QQAccountRegistry(fixture().root)
    const file = new QQConfigurationFile(registry.directoryFor(registry.defaultInstanceId))
    file.write({ accessToken: 'test-only-permission-token' })
    expect(statSync(file.filePath).mode & 0o777).toBe(0o600)
    expect(statSync(registry.indexPath).mode & 0o777).toBe(0o600)
    for (const directory of [registry.root, join(registry.root, 'accounts'), file.directory]) expect(statSync(directory).mode & 0o777).toBe(0o700)
    chmodSync(file.filePath, 0o644)
    expect(file.read()).toEqual({ accessToken: 'test-only-permission-token' })
    expect(statSync(file.filePath).mode & 0o777).toBe(0o600)
  })

  it('keeps two instance configurations and tokens independent', () => {
    const { root } = fixture()
    const registry = new QQAccountRegistry(root)
    writeFileSync(registry.indexPath, JSON.stringify(index([...registry.instances, { instanceId: secondId, label: 'Second test account', createdAt }], registry.defaultInstanceId)))
    const reopened = new QQAccountRegistry(root)
    const first = new QQConfigurationFile(reopened.directoryFor(reopened.defaultInstanceId))
    const second = new QQConfigurationFile(reopened.directoryFor(secondId))
    first.write({ displayName: 'First', accessToken: 'test-only-instance-one' })
    second.write({ displayName: 'Second', accessToken: 'test-only-instance-two' })
    first.write({ displayName: 'Updated first', accessToken: 'test-only-instance-one-updated' })
    expect(new QQConfigurationFile(first.directory).read()).toEqual({ displayName: 'Updated first', accessToken: 'test-only-instance-one-updated' })
    expect(new QQConfigurationFile(second.directory).read()).toEqual({ displayName: 'Second', accessToken: 'test-only-instance-two' })
    expect(first.directory).not.toBe(second.directory)
    expect(readdirSync(first.directory)).toEqual(['config.json'])
    expect(readdirSync(second.directory)).toEqual(['config.json'])
  })

  it.each([
    ['invalid JSON', '{'],
    ['unsupported schema', JSON.stringify({ schemaVersion: 2, configuration: {} })],
    ['invalid configuration', JSON.stringify({ schemaVersion: 1, configuration: [] })],
  ])('rejects corrupted configuration without overwriting it: %s', (_name, text) => {
    const registry = new QQAccountRegistry(fixture().root)
    const file = new QQConfigurationFile(registry.directoryFor(registry.defaultInstanceId))
    writeFileSync(file.filePath, text)
    expect(() => file.read()).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_CORRUPTED' }))
    expect(readFileSync(file.filePath, 'utf8')).toBe(text)
    expect(readdirSync(file.directory)).toEqual(['config.json'])
  })
})
