import { existsSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultNativeCapabilities } from '../native-capabilities'
import { DshNativeConfigurationFile, parseNativeCapabilities, publicNativeConfiguration } from './native-configuration'

const directories: string[] = []
afterEach(() => { const parent = realpathSync(tmpdir()); for (const directory of directories.splice(0)) { if (realpathSync(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-native-config-')) throw new Error('Unsafe fixture cleanup'); rmSync(directory, { recursive: true }) } })
function fixture() { const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-native-config-'))); directories.push(directory); return new DshNativeConfigurationFile(directory, () => ['qq.private', 'qq.group']) }
const input = (file: DshNativeConfigurationFile) => { const value = file.read(); return { expectedRevision: value.revision, features: value.features, toolGrants: value.toolGrants } }

describe('native capabilities current configuration and owner grants', () => {
  it('defaults main to all platform-native features while preserving child time scopes', () => {
    const file = fixture(), value = file.read()
    expect(value.features.filter(feature => feature.enabled).map(feature => feature.id)).toEqual(['time', 'files', 'search', 'directory', process.platform === 'win32' ? 'powershell' : 'bash', 'jobs', 'web', 'skills', 'schedule', 'goal', 'todo', 'questions', 'deliverables'])
    for (const feature of value.features) expect(feature.agentTypeIds).toEqual(!feature.enabled ? [] : feature.id === 'time' ? ['main', 'qq.private', 'qq.group'] : ['main'])
    expect(value.features.find(feature => feature.id === 'time')!.config).toEqual({ 'time-context': { timeZone: 'Asia/Shanghai', refreshIntervalMs: 600000 } })
    expect(value.features.find(feature => feature.id === 'files')!.config).toEqual({ 'tool-fs': { read: true, readImage: true, write: true, edit: true } })
    expect(value.features.find(feature => feature.id === 'web')!.config['tool-web']).toEqual({ search: true, fetch: true, fetchTimeoutMs: 30000, searchTimeoutMs: 60000 })
    expect(value.toolGrants).toEqual([])
  })
  it.each(['darwin', 'linux', 'win32'] as const)('enables only the supported shell by default on %s', platform => {
    const value = defaultNativeCapabilities(['qq.private', 'qq.group'], platform)
    expect(value.features.find(feature => feature.id === 'bash')).toMatchObject({ enabled: platform !== 'win32', agentTypeIds: platform !== 'win32' ? ['main'] : [] })
    expect(value.features.find(feature => feature.id === 'powershell')).toMatchObject({ enabled: platform === 'win32', agentTypeIds: platform === 'win32' ? ['main'] : [] })
    expect(value.features.filter(feature => feature.enabled)).toHaveLength(13)
  })
  it('leaves the optional automatic policy absent when reading fresh or persisted current configurations', () => {
    const file = fixture(), current = file.read()
    expect(Object.hasOwn(current, 'toolAccessOverrides')).toBe(false)
    expect(existsSync(file.filePath)).toBe(false)
    const bytes = JSON.stringify({ ...current, revision: 7 }, null, 2) + '\n'
    writeFileSync(file.filePath, bytes)
    expect(Object.hasOwn(file.read(), 'toolAccessOverrides')).toBe(false)
    expect(Object.hasOwn(publicNativeConfiguration(file.read()), 'toolAccessOverrides')).toBe(false)
    expect(file.prepare(input(file))).toEqual({ ...current, revision: 7 })
    expect(readFileSync(file.filePath, 'utf8')).toBe(bytes)
    const prepared = file.prepare({ ...input(file), features: current.features.map(feature => feature.id === 'todo' ? { ...feature, enabled: false } : feature) })
    file.commit(prepared, 7)
    expect(Object.hasOwn(file.read(), 'toolAccessOverrides')).toBe(false)
  })
  it('persists exact custom main and child scopes, an empty disable, and explicit restoration while PATCH omission preserves policy', () => {
    const file = fixture(), native = { name: 'native_echo', fingerprint: 'a'.repeat(64), agentTypeIds: ['qq.private'] }, mcp = { name: 'mcp__profile__find', fingerprint: 'b'.repeat(64), agentTypeIds: ['main', 'qq.group'] }
    const saved = file.commit(file.prepare({ ...input(file), toolGrants: [native], toolAccessOverrides: [{ ...native, agentTypeIds: [] }, mcp] }), 0)
    expect(file.read().toolAccessOverrides).toEqual([{ ...native, agentTypeIds: [] }, mcp])
    expect(publicNativeConfiguration(file.read()).toolAccessOverrides).toEqual(saved.toolAccessOverrides)
    expect(file.prepare(input(file))).toEqual(saved)
    const disabled = file.commit(file.prepare({ ...input(file), toolAccessOverrides: [{ ...mcp, agentTypeIds: [] }] }), saved.revision)
    expect(file.read().toolAccessOverrides).toEqual([{ ...mcp, agentTypeIds: [] }])
    expect(() => file.prepare({ expectedRevision: 0, features: saved.features, toolGrants: [], toolAccessOverrides: [] })).toThrow(expect.objectContaining({ code: 'NATIVE_CAPABILITIES_CONFLICT' }))
    const restored = file.prepare({ ...input(file), toolAccessOverrides: [] })
    expect(() => file.commit(restored, 0)).toThrow(expect.objectContaining({ code: 'NATIVE_CAPABILITIES_CONFLICT' }))
    file.commit(restored, disabled.revision)
    expect(file.read()).toMatchObject({ toolGrants: [native], toolAccessOverrides: [], revision: 3 })
  })
  it('strictly validates the optional current policy without reserving native MCP names or granting communication tools', () => {
    const file = fixture(), grant = { name: 'mcp__profile__find', fingerprint: 'c'.repeat(64), agentTypeIds: ['main'] }
    expect(file.prepare({ ...input(file), toolAccessOverrides: [grant] }).toolAccessOverrides).toEqual([grant])
    for (const toolAccessOverrides of [null, {}, [grant, grant], [{ ...grant, fingerprint: 'old' }], [{ ...grant, agentTypeIds: ['main', 'main'] }], [{ ...grant, agentTypeIds: ['invented-owner'] }], [{ ...grant, extra: true }]]) expect(() => file.prepare({ ...input(file), toolAccessOverrides })).toThrow()
    for (const name of ['eating_delegate_task', 'qq_send_private_message', 'mcp__qq__send']) {
      expect(() => file.prepare({ ...input(file), toolAccessOverrides: [{ ...grant, name }] })).toThrow()
      expect(() => file.prepare({ ...input(file), toolGrants: [{ ...grant, name }] })).toThrow()
    }
    expect(() => parseNativeCapabilities({ ...file.read(), toolAccessOverrides: undefined })).toThrow()
    expect(() => parseNativeCapabilities({ ...file.read(), unknownPolicy: [] })).toThrow()
  })
  it('requires a complete current shape and preserves rejected files byte for byte', () => {
    const file = fixture(), damaged = JSON.stringify({ schemaVersion: 0, revision: 9, features: [] })
    writeFileSync(file.filePath, damaged)
    expect(() => file.read()).toThrow(expect.objectContaining({ code: 'NATIVE_CAPABILITIES_CORRUPTED' }))
    expect(() => file.prepare(input(file))).toThrow()
    expect(readFileSync(file.filePath, 'utf8')).toBe(damaged)
  })
  it('uses CAS across validation and commit, without overwriting another page', () => {
    const file = fixture(), initial = input(file), first = { ...initial, features: initial.features.map(feature => feature.id === 'todo' ? { ...feature, enabled: false, agentTypeIds: ['main'] } : feature) }
    const next = file.prepare(first)
    expect(next.revision).toBe(1)
    file.commit(next, 0)
    expect(() => file.prepare(first)).toThrow(expect.objectContaining({ code: 'NATIVE_CAPABILITIES_CONFLICT' }))
    expect(() => file.commit({ ...next, revision: 2 }, 0)).toThrow(expect.objectContaining({ code: 'NATIVE_CAPABILITIES_CONFLICT' }))
    expect(file.read()).toEqual(next)
  })
  it('rejects fabricated types, empty enabled scopes and reserved bridge tool names', () => {
    const file = fixture(), value = input(file)
    expect(() => file.prepare({ ...value, features: value.features.map(feature => feature.id === 'todo' ? { ...feature, enabled: true, agentTypeIds: ['invented-owner'] } : feature) })).toThrow()
    expect(() => file.prepare({ ...value, features: value.features.map(feature => feature.id === 'todo' ? { ...feature, enabled: true, agentTypeIds: [] } : feature) })).toThrow(expect.objectContaining({ code: 'NATIVE_SCOPE_REQUIRED' }))
    for (const name of ['eating_delegate_task', 'mcp__qq__send']) expect(() => file.prepare({ ...value, toolGrants: [{ name, fingerprint: 'a'.repeat(64), agentTypeIds: ['main'] }] })).toThrow()
  })
  it('redacts private fields and signed URLs while preserving same-path saved secrets through edits', () => {
    const file = fixture(), current = input(file)
    const next = file.prepare({ ...current, features: current.features.map(feature => feature.id === 'files' ? { ...feature, config: { 'tool-fs': { apiKey: 'native-private-canary', url: 'https://fixture.invalid/image?token=private', apiKeyEnv: 'EXPLICIT_ENV_NAME', headers: { Authorization: 'Bearer private-header' } } } } : feature) })
    file.commit(next, 0)
    const visible = publicNativeConfiguration(next)
    expect(JSON.stringify(visible)).not.toMatch(/native-private-canary|Bearer private-header|token=private/)
    expect(JSON.stringify(visible)).toContain('EXPLICIT_ENV_NAME')
    const prepared = file.prepare({ expectedRevision: next.revision, features: visible.features, toolGrants: visible.toolGrants })
    expect(prepared).toEqual(next)
    expect(() => file.prepare({ ...input(file), features: current.features.map(feature => feature.id === 'files' ? { ...feature, config: { 'tool-fs': { invented: '<stored-secret>' } } } : feature) })).toThrow()
  })
  it('rejects duplicate features, unrecognized module configs and malformed tool fingerprints', () => {
    const current = defaultNativeCapabilities([])
    expect(() => parseNativeCapabilities({ ...current, features: current.features.map(() => current.features[0]) })).toThrow()
    expect(() => parseNativeCapabilities({ ...current, features: current.features.map(feature => feature.id === 'time' ? { ...feature, config: { arbitrary: {} } } : feature) })).toThrow()
    expect(() => parseNativeCapabilities({ ...current, toolGrants: [{ name: 'echo', fingerprint: 'old', agentTypeIds: [] }] })).toThrow()
  })
})
