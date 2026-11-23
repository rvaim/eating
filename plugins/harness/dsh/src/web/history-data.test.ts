import { afterEach, describe, expect, it } from 'vitest'
import { getLocale, HostApiError, setLocale, translate } from '@eating/ui-sdk'
import { readDshResetPreview, readDshResetResult } from './history-data'
import { sessionHistoryTranslations } from './history-i18n'

const previewId = '47989de8-a773-4aa9-bfea-b8115625a2e6'
const requestId = '28ca55cc-c63a-43eb-9b6e-d0661bbed70f'
const preview = {
  previewId,
  expiresAt: '2026-11-04T13:00:00.000Z',
  runtimeRunning: false,
  sessionCount: 6,
  rootCount: 2,
  childCount: 4,
  scheduledCount: 1,
  workspaceEntryCount: 3,
  residualStateCount: 5,
  hasResettableData: true,
  hasPendingQueue: false,
  pendingQueueCount: 0,
  uncertainQueueCount: 0,
}
const startingLocale = getLocale()
afterEach(() => setLocale(startingLocale))

describe('DSH reset response verification', () => {
  it('accepts complete current previews including zero counts and queue totals', () => {
    expect(readDshResetPreview(preview)).toEqual(preview)
    const queued = {
      ...preview,
      runtimeRunning: true,
      sessionCount: 0,
      rootCount: 0,
      childCount: 0,
      scheduledCount: 0,
      workspaceEntryCount: 0,
      residualStateCount: 0,
      hasResettableData: false,
      hasPendingQueue: true,
      pendingQueueCount: 2,
      uncertainQueueCount: 1,
    }
    expect(readDshResetPreview(queued)).toEqual(queued)
  })

  it('rejects inconsistent, fractional, negative, or unsafe counts', () => {
    for (const invalid of [
      { sessionCount: 5 },
      { childCount: 1.5 },
      { rootCount: -1 },
      { sessionCount: Number.MAX_SAFE_INTEGER + 1 },
      { workspaceEntryCount: -1 },
      { hasPendingQueue: true, pendingQueueCount: 0, uncertainQueueCount: 0 },
      { hasPendingQueue: false, pendingQueueCount: 1, uncertainQueueCount: 0 },
      { rootCount: '2' },
    ]) {
      expect(() => readDshResetPreview({ ...preview, ...invalid })).toThrow(HostApiError)
    }
  })

  it('requires a bounded current response with a UUID and timezone-qualified expiry', () => {
    for (const invalid of [
      null,
      {},
      { ...preview, previewId: 'arbitrary-path' },
      { ...preview, expiresAt: '2026-11-04' },
      { ...preview, expiresAt: 'invalid' },
      { ...preview, path: '/private/fixture' },
    ]) {
      expect(() => readDshResetPreview(invalid)).toThrow()
    }
  })

  it('only accepts the completed reset receipt for this request', () => {
    const receipt = {
      requestId,
      status: 'completed' as const,
      deletedSessions: 6,
      clearedWorkspaceEntries: 3,
      clearedScheduledCount: 1,
      clearedQueueCount: 2,
      queueAction: 'clear' as const,
      wasRunning: true,
      restarted: true,
    }
    expect(readDshResetResult(receipt, requestId)).toEqual(receipt)
    for (const invalid of [
      { ...receipt, requestId: previewId },
      { ...receipt, status: 'pending' },
      { ...receipt, deletedSessions: -1 },
      { ...receipt, queueAction: 'drop' },
      { ...receipt, path: '/private/fixture' },
    ]) {
      try {
        readDshResetResult(invalid, requestId)
        expect.fail('Accepted an unverified reset receipt')
      } catch (error) {
        expect(error).toMatchObject({ code: 'DSH_RESET_RESPONSE_INVALID', outcome: 'unknown' })
      }
    }
  })
})

describe('DSH reset localization', () => {
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
    setLocale('en-US')
    expect(translate('dsh-history', 'tab')).toBe('Reset DSH')
    setLocale('zh-CN')
    expect(translate('dsh-history', 'tab')).toBe('重置 DSH')
  })
})
