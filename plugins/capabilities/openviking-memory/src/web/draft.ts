import type { MemoryConfiguration, MemoryConfigurationInput, MemorySettings, ScopeRule } from '../types'
import type { MemoryTranslationKey } from './i18n'

export const numericSettings = ['batchMessages', 'batchChars', 'idleSeconds', 'tokenThreshold', 'recallLimit', 'recallMaxChars', 'scoreThreshold'] as const
export type NumericSetting = typeof numericSettings[number]
export type RuleDraft = Omit<ScopeRule, 'memberIds'> & { memberIdsText: string }
export type SettingsDraft = Omit<MemorySettings, NumericSetting | 'rules'> & Record<NumericSetting, string> & { rules: RuleDraft[] }
export interface ConfigurationDraft {
  endpoint: string; account: string; user: string; apiKey: string; clearApiKey: boolean
  autoConnect: boolean; timeoutMs: string; settings: SettingsDraft
}
export interface FieldIssue { key: MemoryTranslationKey; min?: number; max?: number }
export type FieldIssues = Record<string, FieldIssue>
export const safeSegment = /^[A-Za-z0-9_]{1,96}$/
export const safePlatform = /^[a-z][a-z0-9_]{0,31}$/
export function validServiceIdentity(value: string, account = false): boolean {
  return /^[A-Za-z0-9_.@-]{1,96}$/.test(value) && value !== '.' && value !== '..'
    && value.indexOf('@') === value.lastIndexOf('@') && (!account || !value.startsWith('_'))
}
export const settingBounds: Record<Exclude<NumericSetting, 'scoreThreshold'>, readonly [number, number]> = {
  batchMessages: [1, 100], batchChars: [256, 100_000], idleSeconds: [5, 86_400],
  tokenThreshold: [128, 50_000], recallLimit: [1, 50], recallMaxChars: [256, 50_000],
}
export function makeDraft(value: MemoryConfiguration): ConfigurationDraft {
  const settings: SettingsDraft = { ...value.settings, batchMessages: String(value.settings.batchMessages), batchChars: String(value.settings.batchChars),
    idleSeconds: String(value.settings.idleSeconds), tokenThreshold: String(value.settings.tokenThreshold), recallLimit: String(value.settings.recallLimit),
    recallMaxChars: String(value.settings.recallMaxChars), scoreThreshold: String(value.settings.scoreThreshold),
    rules: value.settings.rules.map(rule => ({ ...rule, memberIdsText: rule.memberIds.join('\n') })) }
  return { endpoint: value.endpoint, account: value.account, user: value.user, apiKey: '', clearApiKey: false,
    autoConnect: value.autoConnect, timeoutMs: String(value.timeoutMs), settings }
}
export function isDirty(draft: ConfigurationDraft | null, config: MemoryConfiguration | null): boolean {
  return Boolean(draft && config && JSON.stringify(draft) !== JSON.stringify(makeDraft(config)))
}
export function validEndpoint(value: string): boolean {
  try { const url = new URL(value); return value.length <= 2048 && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && !/[?#]/.test(value) }
  catch { return false }
}
export function rulePath(user: string, rule: Pick<RuleDraft, 'platform' | 'accountId' | 'kind' | 'targetId'>): string | null {
  if (!validServiceIdentity(user) || !safePlatform.test(rule.platform) || ![rule.accountId, rule.targetId].every(value => safeSegment.test(value))) return null
  return `viking://user/${user}/peers/${rule.platform}-${rule.accountId}-${rule.kind}-${rule.targetId}/memories`
}
export function selfPath(user: string): string | null { return validServiceIdentity(user) ? `viking://user/${user}/peers/self/memories` : null }
export function members(rule: RuleDraft): string[] { return rule.memberIdsText.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }
export function validateDraft(draft: ConfigurationDraft): FieldIssues {
  const errors: FieldIssues = {}
  if (!validEndpoint(draft.endpoint.trim())) errors.endpoint = { key: 'validation.endpoint' }
  if (!validServiceIdentity(draft.user.trim())) errors.user = { key: 'validation.user' }
  if (draft.account.trim() && !validServiceIdentity(draft.account.trim(), true)) errors.account = { key: 'validation.account' }
  const integer = (key: string, value: string, min: number, max: number) => {
    const number = Number(value)
    if (!value.trim() || !Number.isSafeInteger(number) || number < min || number > max) errors[key] = { key: 'validation.number', min, max }
  }
  integer('timeoutMs', draft.timeoutMs, 1000, 120_000)
  for (const key of numericSettings) {
    if (key === 'scoreThreshold') {
      const score = Number(draft.settings[key])
      if (!draft.settings[key].trim() || !Number.isFinite(score) || score < 0 || score > 1) errors[key] = { key: 'validation.score' }
    } else integer(key, draft.settings[key], ...settingBounds[key])
  }
  const identities = new Set<string>()
  for (const rule of draft.settings.rules) {
    const path = `rule-${rule.id}`
    if (rule.label.trim().length > 160) errors[`${path}-label`] = { key: 'validation.label' }
    if (!safePlatform.test(rule.platform.trim())) errors[`${path}-platform`] = { key: 'validation.platform' }
    for (const key of ['accountId', 'targetId'] as const) if (!safeSegment.test(rule[key].trim())) errors[`${path}-${key}`] = { key: 'validation.id' }
    const identity = JSON.stringify([rule.platform.trim(), rule.accountId.trim(), rule.kind, rule.targetId.trim()])
    if (identities.has(identity)) errors[`${path}-targetId`] = { key: 'validation.duplicateRule' }
    identities.add(identity)
    if (rule.kind === 'group' && rule.memberMode !== 'all') {
      const ids = members(rule)
      if (ids.length > 1000 || ids.some(id => !safeSegment.test(id)) || new Set(ids).size !== ids.length) errors[`${path}-memberIdsText`] = { key: 'validation.members' }
    }
  }
  return errors
}
export function configurationInput(draft: ConfigurationDraft, revision: number): MemoryConfigurationInput {
  const settings: MemorySettings = { ...draft.settings,
    batchMessages: Number(draft.settings.batchMessages), batchChars: Number(draft.settings.batchChars), idleSeconds: Number(draft.settings.idleSeconds),
    tokenThreshold: Number(draft.settings.tokenThreshold), recallLimit: Number(draft.settings.recallLimit), recallMaxChars: Number(draft.settings.recallMaxChars),
    scoreThreshold: Number(draft.settings.scoreThreshold), rules: draft.settings.rules.map(({ memberIdsText: _text, ...rule }) => ({ ...rule,
      label: rule.label.trim(), platform: rule.platform.trim(), accountId: rule.accountId.trim(), targetId: rule.targetId.trim(),
      memberMode: rule.kind === 'group' ? rule.memberMode : 'all', memberIds: rule.kind === 'group' && rule.memberMode !== 'all' ? members({ ...rule, memberIdsText: _text }) : [] })) }
  return { expectedRevision: revision, endpoint: draft.endpoint.trim(), account: draft.account.trim(), user: draft.user.trim(),
    autoConnect: draft.autoConnect, timeoutMs: Number(draft.timeoutMs), settings,
    ...(draft.apiKey && !draft.clearApiKey ? { apiKey: draft.apiKey } : {}), ...(draft.clearApiKey ? { clearApiKey: true } : {}) }
}
