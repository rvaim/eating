import { describe, expect, it } from 'vitest'
import { clearNativeDraftSecrets, readNativeSnapshot } from './native-data'
import { defaultNativeCapabilities } from '../native-capabilities'

describe('native panel private drafts and response validation', () => {
  it('clears new credentials and signed URLs while preserving ordinary fields and saved placeholders', () => {
    const saved = { service: { apiKey: '<stored-secret>' } }
    const cleared = JSON.parse(clearNativeDraftSecrets(JSON.stringify({ service: { apiKey: 'new-private-key', password: 'new-private-password', apiKeyEnv: 'EXPLICIT_ENV', timeoutMs: 30000, url: 'https://fixture.invalid/path?token=private', headers: { Authorization: 'Bearer private-header' } } }), saved))
    expect(cleared).toEqual({ service: { apiKey: '<stored-secret>', apiKeyEnv: 'EXPLICIT_ENV', timeoutMs: 30000, headers: {} } })
    expect(JSON.stringify(cleared)).not.toMatch(/new-private|token=private|Bearer/)
  })
  it('retains nonsecret invalid JSON drafts and clears incomplete secret drafts', () => {
    expect(clearNativeDraftSecrets('{ "timeoutMs":', {})).toBe('{ "timeoutMs":')
    expect(clearNativeDraftSecrets('{ "apiKey": "incomplete-private', { service: {} })).not.toContain('incomplete-private')
  })
  it('requires truthful automatic access summaries and excludes reserved communication names', () => {
    const tool = { name: 'mcp__profile__find', description: 'Profile capability', fingerprint: 'a'.repeat(64), automaticAccess: 'all' }
    const snapshot = { configuration: defaultNativeCapabilities([]), agentTypes: [], catalog: { schemaVersion: 1, features: [], tools: [tool], plugins: [], bundles: [], runtime: { running: false, appliedRevision: null, errorCode: null, mounted: [], agents: [] } } }
    expect(readNativeSnapshot(snapshot).catalog.tools[0]?.automaticAccess).toBe('all')
    const withTool = (overrides: object) => ({ ...snapshot, catalog: { ...snapshot.catalog, tools: [{ ...tool, ...overrides }] } })
    expect(() => readNativeSnapshot(withTool({ automaticAccess: 'main' }))).toThrow()
    expect(() => readNativeSnapshot(withTool({ name: 'native_echo', automaticAccess: 'all' }))).toThrow()
    expect(() => readNativeSnapshot(withTool({ name: 'mcp__qq__send' }))).toThrow()
    expect(() => readNativeSnapshot(withTool({ name: 'eating_delegate_task', automaticAccess: 'main' }))).toThrow()
    expect(() => readNativeSnapshot(withTool({ automaticAccess: undefined }))).toThrow()
  })
  it('rejects malformed native snapshots instead of presenting unchecked capability state', () => {
    expect(() => readNativeSnapshot({ configuration: {}, agentTypes: [], catalog: { schemaVersion: 1, tools: [] } })).toThrow()
  })
})
