import { describe, expect, it } from 'vitest'
import { clearNativeDraftSecrets, readNativeSnapshot } from './native-data'

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
  it('rejects malformed native snapshots instead of presenting unchecked capability state', () => {
    expect(() => readNativeSnapshot({ configuration: {}, agentTypes: [], catalog: { schemaVersion: 1, tools: [] } })).toThrow()
  })
})
