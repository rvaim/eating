import { describe, expect, it } from 'vitest'
import { HostApiError, setLocale } from '@eating/ui-sdk'
import { DEFAULT_SETTINGS } from '../types'
import { errorKey, failure, readConfiguration, readMemory, readSearch, readSnapshot } from './data'
import { memoryResources, mt } from './i18n'

const configuration = { schemaVersion: 3, revision: 0, endpoint: '', account: '', user: '', apiKeyConfigured: false, autoConnect: false,
  timeoutMs: 15000, ready: false, settings: DEFAULT_SETTINGS }
const snapshot = { ready: false, lastErrorCode: null, lastRecallAt: null, lastCaptureAt: null, todayExtractions: 0, pending: 0, jobs: [], scopes: [] }

describe('OpenViking public UI data', () => {
  it('accepts the current unconfigured public response and refuses secret echoes', () => {
    expect(readConfiguration(configuration)).toEqual(configuration)
    expect(() => readConfiguration({ ...configuration, apiKey: 'must-never-render' })).toThrow(HostApiError)
    expect(() => readConfiguration({ ...configuration, schemaVersion: 1 })).toThrow(expect.objectContaining({ code: 'MEMORY_CONFIGURATION_CORRUPTED' }))
    expect(() => readConfiguration({ ...configuration, schemaVersion: 0 })).toThrow(HostApiError)
    expect(() => readConfiguration({ ...configuration, settings: { ...DEFAULT_SETTINGS, recallLimit: '6' } })).toThrow(HostApiError)
    expect(() => readConfiguration({ ...configuration, schemaVersion: 2 })).toThrow(HostApiError)
    expect(() => readConfiguration({ ...configuration, settings: { ...DEFAULT_SETTINGS, archiveMaxMiB: 8 } })).toThrow(HostApiError)
    for (const commitTokenThreshold of [undefined, '20000', 0, 1000001, 8.5, Number.NaN]) {
      expect(() => readConfiguration({ ...configuration, settings: { ...DEFAULT_SETTINGS, commitTokenThreshold } })).toThrow(HostApiError)
    }
    for (const commitTokenThreshold of [1, 20000, 1000000]) {
      expect(readConfiguration({ ...configuration, settings: { ...DEFAULT_SETTINGS, commitTokenThreshold } }).settings.commitTokenThreshold).toBe(commitTokenThreshold)
    }
  })
  it('keeps only task metadata from a runtime response and checks memory URI/read data', () => {
    const data = readSnapshot({ ...snapshot, jobs: [{ id: 'job-1', kind: 'append', trigger: null, peerId: 'qq-1-private-2', sessionId: 'session-1', commitId: null, taskId: null,
      archiveUri: null, status: 'unknown', createdAt: '2026-11-01T15:00:00Z', updatedAt: '2026-11-01T15:00:00Z', messages: 8, syncedMessages: 0,
      pendingTokens: null, errorCode: 'MEMORY_INTERRUPTED', body: 'private body should not be retained' }] })
    expect(data.jobs[0]).not.toHaveProperty('body')
    expect(() => readSnapshot({ ...snapshot, jobs: [{ status: 'pretend-success' }] })).toThrow()
    expect(readSearch({ items: [{ uri: 'viking://user/owner/memories/facts.md', text: 'Fact', score: 0.8 }] })).toHaveLength(1)
    expect(() => readSearch({ items: [{ uri: 'https://other.test', text: 'Fact', score: 0.8 }] })).toThrow()
    expect(() => readMemory({ uri: 'viking://user/owner/memories/facts.md', text: 3 })).toThrow()
  })
  it('distinguishes synchronization from official commit completion without inventing memory diff counts', () => {
    const job = { id: 'job-2', kind: 'append', trigger: null, peerId: 'self', sessionId: 'fixed-session', commitId: null, taskId: null, archiveUri: null, status: 'synced',
      createdAt: '2026-11-02T05:00:00Z', updatedAt: '2026-11-02T05:00:00Z', messages: 2, syncedMessages: 2, pendingTokens: 500, errorCode: null }
    expect(readSnapshot({ ...snapshot, jobs: [job] }).jobs[0]).toMatchObject({ status: 'synced', archiveUri: null, taskId: null })
    const archiveUri = 'viking://user/owner/sessions/fixed-session/history/archive_001'
    const completed = readSnapshot({ ...snapshot, jobs: [{ ...job, kind: 'commit', trigger: 'manual', status: 'completed', taskId: 'task-2', archiveUri }] }).jobs[0]!
    expect(completed).toMatchObject({ status: 'completed', archiveUri }); expect(completed).not.toHaveProperty('changes')
    expect(() => readSnapshot({ ...snapshot, jobs: [{ ...job, status: 'submitting' }] })).toThrow(HostApiError)
  })
  it('translates fixed failure keys and never promotes a raw server message to a UI claim', () => {
    const error = new HostApiError('MEMORY_HTTP_401', 'RAW_SERVER_SECRET_MESSAGE')
    expect(failure(error)).toEqual({ key: 'error.auth', code: 'MEMORY_HTTP_401' })
    expect(errorKey('MEMORY_CONFIGURATION_CONFLICT')).toBe('error.conflict')
    expect(failure(new HostApiError('MEMORY_TASK_UNKNOWN', 'RAW_PROVIDER_SECRET'))).toEqual({ key: 'error.unknown', code: 'MEMORY_TASK_UNKNOWN' })
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
