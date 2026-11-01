import { describe, expect, it } from 'vitest'
import type { MemoryConfiguration, ScopeRule } from '../types'
import { DEFAULT_SETTINGS } from '../types'
import { configurationInput, isDirty, makeDraft, rulePath, selfPath, validateDraft } from './draft'

const config = (): MemoryConfiguration => ({ schemaVersion: 1, revision: 7, endpoint: 'http://127.0.0.1:1933', account: '', user: 'owner_1',
  apiKeyConfigured: true, autoConnect: false, timeoutMs: 15000, ready: false, settings: { ...DEFAULT_SETTINGS, rules: [] } })
const rule = (patch: Partial<ScopeRule> = {}): ScopeRule => ({ id: 'rule-1', label: 'Private conversation', platform: 'qq', accountId: '10001',
  kind: 'private', targetId: '20002', capture: true, recall: true, memberMode: 'all', memberIds: [], ...patch })

describe('OpenViking configuration drafts', () => {
  it('keeps secrets write-only and uses the exact revision with all settings', () => {
    const saved = config(), draft = makeDraft(saved)
    expect(isDirty(draft, saved)).toBe(false)
    expect(validateDraft(draft)).toEqual({})
    expect(configurationInput(draft, saved.revision)).toEqual({ expectedRevision: 7, endpoint: saved.endpoint, account: '', user: 'owner_1',
      autoConnect: false, timeoutMs: 15000, settings: DEFAULT_SETTINGS })
    expect(configurationInput({ ...draft, apiKey: 'new-secret' }, 7).apiKey).toBe('new-secret')
    expect(configurationInput({ ...draft, apiKey: 'new-secret', clearApiKey: true }, 7)).toMatchObject({ clearApiKey: true })
    expect(configurationInput({ ...draft, apiKey: 'new-secret', clearApiKey: true }, 7)).not.toHaveProperty('apiKey')
  })
  it('uses safe readable peer tuples and the self directory without hashes', () => {
    const current = rule()
    expect(rulePath('owner_1', current)).toBe('viking://user/owner_1/peers/qq-10001-private-20002/memories')
    expect(selfPath('owner_1')).toBe('viking://user/owner_1/peers/self/memories')
    expect(rulePath('owner_1', { ...current, targetId: '../other' })).toBeNull()
    expect(rulePath('owner_1', { ...current, accountId: '100-01' })).toBeNull()
    expect(rulePath('owner_1', { ...current, platform: 'QQ' })).toBeNull()
  })
  it('accepts official service identities without loosening conversation tuple IDs', () => {
    const draft = makeDraft(config())
    draft.user = 'eating-bot'; draft.account = 'team-1'
    expect(validateDraft(draft)).toEqual({})
    expect(configurationInput(draft, 7)).toMatchObject({ user: 'eating-bot', account: 'team-1' })
    expect(rulePath(draft.user, rule())).toBe('viking://user/eating-bot/peers/qq-10001-private-20002/memories')
    expect(selfPath(draft.user)).toBe('viking://user/eating-bot/peers/self/memories')
    for (const user of ['eating.bot', 'owner@example.com', '_owner', 'a'.repeat(96)]) {
      draft.user = user; expect(validateDraft(draft).user).toBeUndefined()
    }
    for (const user of ['.', '..', 'owner@@example', 'owner/other', 'a'.repeat(97)]) {
      draft.user = user; expect(validateDraft(draft).user?.key).toBe('validation.user')
    }
    draft.user = 'eating-bot'
    for (const account of ['team-1', 'team.one', 'team@example.com', '']) {
      draft.account = account; expect(validateDraft(draft).account).toBeUndefined()
    }
    for (const account of ['_team', '.', '..', 'team@@example', 'team/one']) {
      draft.account = account; expect(validateDraft(draft).account?.key).toBe('validation.account')
    }
    draft.account = 'team-1'; draft.settings.rules = [{ ...rule(), accountId: 'team-1', memberIdsText: '' }]
    expect(validateDraft(draft)['rule-rule-1-accountId']?.key).toBe('validation.id')
  })
  it('rejects duplicate exact rules and duplicate or unsafe group member IDs', () => {
    const saved = config(); saved.settings.rules = [rule(), rule({ id: 'rule-2' })]
    const draft = makeDraft(saved)
    expect(validateDraft(draft)['rule-rule-2-targetId']?.key).toBe('validation.duplicateRule')
    draft.settings.rules = [{ ...draft.settings.rules[0]!, kind: 'group', memberMode: 'allowlist', memberIdsText: '123\n123' }]
    expect(validateDraft(draft)['rule-rule-1-memberIdsText']?.key).toBe('validation.members')
    draft.settings.rules[0]!.memberIdsText = '123\n456_7'
    expect(validateDraft(draft)).toEqual({})
    expect(configurationInput(draft, 7).settings.rules[0]!.memberIds).toEqual(['123', '456_7'])
    draft.settings.rules[0]!.memberIdsText = '123\n456-7'
    expect(validateDraft(draft)['rule-rule-1-memberIdsText']?.key).toBe('validation.members')
  })
  it('validates service shape and agreed numeric boundaries without a daily cap', () => {
    const draft = makeDraft(config())
    draft.endpoint = 'https://user:password@example.test/api?key=secret'
    draft.user = 'owner/other'; draft.timeoutMs = '120001'; draft.settings.batchChars = '255'; draft.settings.scoreThreshold = '1.1'
    expect(Object.keys(validateDraft(draft)).sort()).toEqual(['batchChars', 'endpoint', 'scoreThreshold', 'timeoutMs', 'user'])
    draft.endpoint = 'https://example.test/api'; draft.user = 'owner'; draft.timeoutMs = '120000'
    draft.settings.batchChars = '256'; draft.settings.scoreThreshold = '0'
    expect(validateDraft(draft)).toEqual({})
    expect(Object.keys(configurationInput(draft, 7).settings).some(key => /daily|cap/i.test(key) && key !== 'autoCapture' && key !== 'privateCapture' && key !== 'groupCapture')).toBe(false)
  })
})
