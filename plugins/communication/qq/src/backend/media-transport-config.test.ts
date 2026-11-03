import { mkdtempSync, realpathSync, rmSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { QQMediaTransportConfiguration } from './media-transport-config'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (realpathSync(root) !== root || dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith('eating-media-settings-')) throw new Error('Unsafe media settings cleanup')
    rmSync(root, { recursive: true })
  }
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-media-settings-'))); roots.push(root)
  const sourceRoot = join(root, 'source'), hostMappingRoot = join(root, 'mapped'); mkdirSync(sourceRoot); mkdirSync(hostMappingRoot)
  const connection = { endpoint: 'ws://onebot.fixture.invalid:3001/', accountId: '123456' }
  const configuration = new QQMediaTransportConfiguration(root)
  const input = { expectedRevision: 0, mode: 'shared-directory', mapping: { sourceRoot, hostMappingRoot, onebotRoot: '/container/media', ownerConfirmed: true } }
  return { root, sourceRoot, hostMappingRoot, connection, configuration, input }
}
describe('private QQ media transport schema1', () => {
  it('keeps a new account automatic without creating a file and saves a separate strict private mapping', () => {
    const f = fixture()
    expect(f.configuration.snapshot(f.connection)).toEqual({ schemaVersion: 1, revision: 0, mode: 'auto', mapping: null, fileEligible: false })
    expect(f.configuration.save(f.input, f.connection)).toMatchObject({ revision: 1, mode: 'shared-directory', fileEligible: true, mapping: f.input.mapping })
    expect(JSON.parse(readFileSync(join(f.root, 'media-transport.json'), 'utf8'))).toMatchObject({ schemaVersion: 1, revision: 1, mapping: { endpoint: f.connection.endpoint, accountId: f.connection.accountId } })
    expect(() => f.configuration.save(f.input, f.connection)).toThrow(expect.objectContaining({ code: 'QQ_MEDIA_CONFIGURATION_CONFLICT' }))
    expect(f.configuration.snapshot({ ...f.connection, endpoint: 'ws://other.fixture.invalid:3001/' }).fileEligible).toBe(false)
    expect(f.configuration.snapshot({ ...f.connection, accountId: '654321' }).fileEligible).toBe(false)
    expect(f.configuration.snapshot({ ...f.connection, accountId: null }).fileEligible).toBe(false)
  })
  it('allows unconfirmed mappings while disconnected and requires an online account for owner confirmation', () => {
    const f = fixture(), disconnected = { ...f.connection, accountId: null }
    expect(() => f.configuration.save(f.input, disconnected)).toThrow(expect.objectContaining({ code: 'QQ_MEDIA_CONNECTION_REQUIRED' }))
    expect(f.configuration.save({ ...f.input, mapping: { ...f.input.mapping, ownerConfirmed: false } }, disconnected)).toMatchObject({ fileEligible: false })
  })
  it.each([0, 2, null, { schemaVersion: 1, revision: 0 }, { schemaVersion: 2, revision: 0, mode: 'auto', mapping: null }])('rejects unsupported or incomplete stored data and preserves the bytes: %j', value => {
    const f = fixture(), path = join(f.root, 'media-transport.json'), original = JSON.stringify(value)
    writeFileSync(path, original)
    expect(() => f.configuration.save(f.input, f.connection)).toThrow(expect.objectContaining({ code: 'QQ_MEDIA_CONFIGURATION_CORRUPTED' }))
    expect(readFileSync(path, 'utf8')).toBe(original)
  })
  it('rejects relative paths, traversal, unknown fields and symlink roots without overwriting data', () => {
    const f = fixture(), symbolic = join(f.root, 'symbolic'); symlinkSync(f.sourceRoot, symbolic)
    for (const patch of [{ sourceRoot: 'relative' }, { onebotRoot: '/container/../private' }, { sourceRoot: symbolic }, { privateToken: 'forbidden' }]) {
      expect(() => f.configuration.save({ ...f.input, mapping: { ...f.input.mapping, ...patch } }, f.connection)).toThrow()
    }
    expect(f.configuration.snapshot(f.connection).revision).toBe(0)
  })
})
