import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIGURATION, DshConfigurationFile, DshSessionFile, parseConfiguration } from './config'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

const cleanups: Array<() => void> = []
function fixture() {
  const parent = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(parent, 'eating-dsh-config-')))
  cleanups.push(() => {
    if (realpathSync(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-dsh-config-')) throw new Error('Invalid test cleanup path')
    rmSync(directory, { recursive: true })
  })
  return directory
}

afterEach(() => { vi.mocked(renameSync).mockReset(); for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

describe('DSH configuration validation', () => {
  it('allows empty drafts and preserves a write-only key unless explicitly cleared', () => {
    expect(parseConfiguration({})).toEqual(DEFAULT_CONFIGURATION)
    const previous = parseConfiguration({ endpoint: ' http://127.0.0.1:1234/v1 ', model: ' fixture-model ', apiKey: 'fixture-only-key' })
    expect(previous).toMatchObject({ endpoint: 'http://127.0.0.1:1234/v1', model: 'fixture-model' })
    expect(parseConfiguration({ apiKey: '' }, previous).apiKey).toBe('fixture-only-key')
    expect(parseConfiguration({ clearApiKey: true, apiKey: 'ignored-fixture-key' }, previous).apiKey).toBe('')
    expect(parseConfiguration({ endpoint: ' ', model: ' ' }, previous)).toMatchObject({ endpoint: '', model: '' })
  })

  it.each(['file:///tmp/model', 'https://name:pass@example.test/v1', 'https://example.test/v1?key=fixture', 'https://example.test/v1#fixture', 'https://example.test/v1?', 'https://example.test/v1#'])('rejects an unsafe endpoint without echoing it: %s', endpoint => {
    expect(() => parseConfiguration({ endpoint })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
    try { parseConfiguration({ endpoint }) } catch (error) { expect(String(error)).not.toContain(endpoint) }
  })

  it.each([{ maxTokens: 0 }, { maxTokens: 131073 }, { timeoutMs: 999 }, { timeoutMs: 120001 }, { model: 'x'.repeat(161) }, { apiKey: 'fixture\nkey' }, { autoConnect: 'yes' }, { model: 1 }])('rejects invalid configuration fields: %j', input => {
    expect(() => parseConfiguration(input)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
  })
})

describe('DSH restricted persistence', () => {
  it('atomically writes and reopens complete configuration without temporary files', () => {
    const directory = fixture()
    const file = new DshConfigurationFile(directory)
    expect(file.read()).toEqual(DEFAULT_CONFIGURATION)
    const configuration = parseConfiguration({ endpoint: 'https://model.example.test/v1', model: 'fixture', apiKey: 'fixture-only-key' })
    file.write(configuration)
    expect(new DshConfigurationFile(directory).read()).toEqual(configuration)
    expect(readdirSync(directory)).toEqual(['config.json'])
    if (process.platform !== 'win32') {
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(file.filePath).mode & 0o777).toBe(0o600)
      chmodSync(file.filePath, 0o644)
      file.read()
      expect(statSync(file.filePath).mode & 0o777).toBe(0o600)
    }
  })

  it('keeps previous bytes and timestamp when atomic replacement fails', () => {
    const file = new DshConfigurationFile(fixture())
    file.write(DEFAULT_CONFIGURATION)
    const bytes = readFileSync(file.filePath, 'utf8')
    const updatedAt = file.updatedAt
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('fixture disk failure containing fixture-secret') })
    expect(() => file.write(parseConfiguration({ apiKey: 'fixture-new-key' }))).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_SAVE_FAILED' }))
    expect(readFileSync(file.filePath, 'utf8')).toBe(bytes)
    expect(file.updatedAt).toBe(updatedAt)
    expect(readdirSync(file.directory)).toEqual(['config.json'])
  })

  it('rejects damaged configuration without replacing it', () => {
    const file = new DshConfigurationFile(fixture())
    const bytes = '{broken-fixture-only'
    writeFileSync(file.filePath, bytes)
    expect(() => file.read()).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_CORRUPTED' }))
    expect(readFileSync(file.filePath, 'utf8')).toBe(bytes)
  })

  it.each(['wrong-version', 'missing-timestamp', 'missing-current-field', 'unsupported-field'] as const)('rejects %s configuration without migration or rewriting', mode => {
    const file = new DshConfigurationFile(fixture())
    const configuration = mode === 'missing-current-field' ? { ...DEFAULT_CONFIGURATION, timeoutMs: undefined }
      : mode === 'unsupported-field' ? { ...DEFAULT_CONFIGURATION, messageTemplate: 'obsolete' } : DEFAULT_CONFIGURATION
    const bytes = JSON.stringify({ schemaVersion: mode === 'wrong-version' ? 0 : 1, updatedAt: mode === 'missing-timestamp' ? undefined : '2026-10-28T00:00:00Z', configuration })
    writeFileSync(file.filePath, bytes)
    expect(() => file.read()).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_CORRUPTED' }))
    expect(readFileSync(file.filePath, 'utf8')).toBe(bytes)
  })

  it('rejects an unsupported configuration API field before saving', () => {
    expect(() => parseConfiguration({ messageTemplate: 'obsolete' })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }))
  })

  it.each(['schema-0', 'missing-created', 'incomplete-batch'] as const)('rejects %s session metadata while preserving its original bytes', mode => {
    const file = new DshSessionFile(fixture())
    const bytes = JSON.stringify({ schemaVersion: mode === 'schema-0' ? 0 : 1, sessionId: '00000000-0000-4000-8000-000000000001', ...(mode !== 'missing-created' ? { created: true } : {}), ...(mode === 'incomplete-batch' ? { activeBatchId: 'a'.repeat(64) } : {}) })
    writeFileSync(file.filePath, bytes)
    expect(() => file.read()).toThrowError(expect.objectContaining({ code: 'SESSION_METADATA_CORRUPTED' }))
    expect(readFileSync(file.filePath, 'utf8')).toBe(bytes)
  })

  it.skipIf(process.platform === 'win32')('rejects symlink files without reading or replacing their target', () => {
    const directory = fixture()
    const target = join(directory, 'fixture-target')
    writeFileSync(target, 'fixture-retained')
    const file = new DshConfigurationFile(join(directory, 'dsh'))
    symlinkSync(target, file.filePath)
    expect(() => file.read()).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION_FILE' }))
    expect(() => file.write(DEFAULT_CONFIGURATION)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIGURATION_FILE' }))
    expect(readFileSync(target, 'utf8')).toBe('fixture-retained')
  })

  it('keeps fixed session metadata small and rejects invalid identities', () => {
    const file = new DshSessionFile(fixture())
    expect(file.read()).toBeNull()
    const metadata = { sessionId: '00000000-0000-4000-8000-000000000001', created: true, activeBatchId: 'a'.repeat(64), digest: 'b'.repeat(64), nonce: '00000000-0000-4000-8000-000000000002', lastOutcome: 'pending' as const }
    file.write(metadata)
    expect(file.read()).toEqual(metadata)
    expect(readFileSync(file.filePath, 'utf8')).not.toContain('events')
    writeFileSync(file.filePath, JSON.stringify({ schemaVersion: 1, ...metadata, sessionId: '../escape' }))
    expect(() => file.read()).toThrowError(expect.objectContaining({ code: 'SESSION_METADATA_CORRUPTED' }))
  })
})
