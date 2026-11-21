import { afterEach, describe, expect, it } from 'vitest'
import { getLocale, HostApiError, setLocale, translate } from '@eating/ui-sdk'
import { readSessionHistoryPreview, readSessionHistoryResult } from './history-data'
import { sessionHistoryTranslations } from './history-i18n'

const previewId = '47989de8-a773-4aa9-bfea-b8115625a2e6'
const requestId = '28ca55cc-c63a-43eb-9b6e-d0661bbed70f'
const preview = { previewId, expiresAt: '2026-11-04T13:00:00.000Z', sessionCount: 6, rootCount: 2, childCount: 4 }
const startingLocale = getLocale()
afterEach(() => setLocale(startingLocale))

describe('session history response verification', () => {
  it('accepts complete current previews including truthful zero counts and itemized sessions', () => {
    expect(readSessionHistoryPreview(preview)).toMatchObject(preview)
    expect(readSessionHistoryPreview({ ...preview, sessionCount: 0, rootCount: 0, childCount: 0, residualStateCount: 3, runtimeRunning: true, hasPendingQueue: true, sessions: [] })).toMatchObject({ sessionCount: 0, residualStateCount: 3, runtimeRunning: true, hasPendingQueue: true })
    const item = {
      id: previewId,
      parentId: null,
      isRoot: true,
      isCurrentRoot: true,
      role: 'root',
      label: 'DSH Root',
      agentTypeId: null,
      live: true,
      archived: false,
      pinned: true,
      scheduled: false,
      deletable: true,
      requiresRestart: true,
      blockReason: null,
      sizeBytes: 2048,
      createdAt: '2026-11-04T12:00:00.000Z',
      updatedAt: '2026-11-04T12:30:00.000Z',
    }
    expect(readSessionHistoryPreview({ ...preview, sessionCount: 1, rootCount: 1, childCount: 0, sessions: [item] }).sessions).toEqual([item])
    expect(() => readSessionHistoryPreview({ ...preview, sessions: [{ ...item, role: 'unknown-role' }] })).toThrow(HostApiError)
  })
  it('rejects inconsistent, fractional, negative, or unsafe counts before showing a deletion total', () => {
    for (const invalid of [{ sessionCount: 5 }, { childCount: 1.5 }, { rootCount: -1 }, { sessionCount: Number.MAX_SAFE_INTEGER + 1 }, { rootCount: '2' }, { rootCount: undefined }]) expect(() => readSessionHistoryPreview({ ...preview, ...invalid })).toThrow(HostApiError)
  })
  it('requires a bounded current response with a UUID and timezone-qualified expiry', () => {
    for (const invalid of [null, {}, { ...preview, previewId: 'arbitrary-path' }, { ...preview, expiresAt: '2026-11-04' }, { ...preview, expiresAt: 'invalid' }, { ...preview, path: '/private/fixture' }, { ...preview, sessionIds: [previewId] }]) expect(() => readSessionHistoryPreview(invalid)).toThrow()
  })
  it('only accepts the clear receipt for this request and the full scanned count', () => {
    const receipt = { requestId, status: 'completed', deletedCount: 6, mode: 'selected-online', restarted: false, clearedResidualCount: 0 }
    expect(readSessionHistoryResult(receipt, requestId, 6)).toEqual(receipt)
    expect(readSessionHistoryResult({ requestId, status: 'completed', deletedCount: 0, mode: 'residual', clearedResidualCount: 4 }, requestId, 0)).toMatchObject({ mode: 'residual', clearedResidualCount: 4 })
    for (const invalid of [{ ...receipt, requestId: previewId }, { ...receipt, status: 'pending' }, { ...receipt, deletedCount: 5 }, { ...receipt, deletedCount: -1 }, { ...receipt, path: '/private/fixture' }]) {
      try { readSessionHistoryResult(invalid, requestId, 6); expect.fail('Accepted an unverified clearing receipt') }
      catch (error) { expect(error).toMatchObject({ code: 'SESSION_HISTORY_RESPONSE_INVALID', outcome: 'unknown' }) }
    }
  })
})

describe('session history localization', () => {
  it('provides both languages with matching keys and interpolation parameters', () => {
    const keys = Object.keys(sessionHistoryTranslations['zh-CN']) as (keyof typeof sessionHistoryTranslations['zh-CN'])[]
    const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort()
    expect(Object.keys(sessionHistoryTranslations['en-US']).sort()).toEqual([...keys].sort())
    for (const key of keys) {
      expect(placeholders(sessionHistoryTranslations['en-US'][key])).toEqual(placeholders(sessionHistoryTranslations['zh-CN'][key]))
      for (const locale of ['zh-CN', 'en-US'] as const) {
        setLocale(locale)
        expect(translate('dsh-history', key)).not.toBe(key)
        expect(sessionHistoryTranslations[locale][key].trim()).not.toBe('')
      }
    }
    setLocale('en-US'); expect(translate('dsh-history', 'confirm', { value: '6' })).toBe('Confirm clearing 6 sessions')
    setLocale('zh-CN'); expect(translate('dsh-history', 'confirm', { value: '6' })).toBe('确认清理 6 个会话')
  })
})
