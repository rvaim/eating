import { describe, expect, it } from 'vitest'
import { HostApiError, setLocale } from '@eating/ui-sdk'
import { DEFAULT_SETTINGS } from '../types'
import { errorKey, failure, readConfiguration, readMemory, readSearch, readSnapshot } from './data'
import { memoryResources, mt } from './i18n'

const configuration = { schemaVersion: 1, revision: 0, endpoint: '', account: '', user: '', apiKeyConfigured: false, autoConnect: false,
  timeoutMs: 15000, ready: false, settings: DEFAULT_SETTINGS }
const snapshot = { ready: false, lastErrorCode: null, lastRecallAt: null, lastCaptureAt: null, todayExtractions: 0, pending: 0, jobs: [], scopes: [] }

describe('OpenViking public UI data', () => {
  it('accepts the current unconfigured public response and refuses secret echoes', () => {
    expect(readConfiguration(configuration)).toEqual(configuration)
    expect(() => readConfiguration({ ...configuration, apiKey: 'must-never-render' })).toThrow(HostApiError)
    expect(() => readConfiguration({ ...configuration, schemaVersion: 0 })).toThrow(HostApiError)
    expect(() => readConfiguration({ ...configuration, settings: { ...DEFAULT_SETTINGS, recallLimit: '6' } })).toThrow(HostApiError)
  })
  it('keeps only task metadata from a runtime response and checks memory URI/read data', () => {
    const data = readSnapshot({ ...snapshot, jobs: [{ id: 'job-1', peerId: 'qq-1-private-2', sessionId: 'session-1', taskId: null,
      archiveUri: null, status: 'unknown', createdAt: '2026-11-01T15:00:00Z', updatedAt: '2026-11-01T15:00:00Z', messages: 8,
      changes: null, errorCode: 'MEMORY_INTERRUPTED', body: 'private body should not be retained' }] })
    expect(data.jobs[0]).not.toHaveProperty('body')
    expect(() => readSnapshot({ ...snapshot, jobs: [{ status: 'pretend-success' }] })).toThrow()
    expect(readSearch({ items: [{ uri: 'viking://user/owner/memories/facts.md', text: 'Fact', score: 0.8 }] })).toHaveLength(1)
    expect(() => readSearch({ items: [{ uri: 'https://other.test', text: 'Fact', score: 0.8 }] })).toThrow()
    expect(() => readMemory({ uri: 'viking://user/owner/memories/facts.md', text: 3 })).toThrow()
  })
  it('translates fixed failure keys and never promotes a raw server message to a UI claim', () => {
    const error = new HostApiError('MEMORY_HTTP_401', 'RAW_SERVER_SECRET_MESSAGE')
    expect(failure(error)).toEqual({ key: 'error.auth', code: 'MEMORY_HTTP_401' })
    expect(errorKey('MEMORY_CONFIGURATION_CONFLICT')).toBe('error.conflict')
    expect(failure(new HostApiError('untrusted body key=secret', 'secret'))).toEqual({ key: 'error.generic' })
    setLocale('en-US'); expect(mt(failure(error).key)).toContain('rejected authentication')
    expect(mt(failure(error).key)).not.toContain(error.message)
    setLocale('zh-CN')
  })
  it('provides matching nonempty Chinese and English resources', () => {
    expect(Object.keys(memoryResources['en-US']).sort()).toEqual(Object.keys(memoryResources['zh-CN']).sort())
    for (const text of Object.values(memoryResources['en-US'])) expect(text.trim()).not.toBe('')
  })
})
