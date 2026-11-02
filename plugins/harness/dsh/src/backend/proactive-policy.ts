import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { HarnessHostServices, JsonObject, ProactiveContactEntry, ProactiveContactPolicy, ProactiveTarget } from '@eating/plugin-sdk'
import { readRestrictedJson, writeRestrictedJson } from './config'
const exact = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const text = (value: unknown, max = 160): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
export const contactIdentity = (value: Pick<ProactiveContactEntry, 'pluginId' | 'instanceId' | 'accountId' | 'agentTypeId' | 'targetId'>) => JSON.stringify([value.pluginId, value.instanceId, value.accountId, value.agentTypeId, value.targetId])
const channelIdentity = (value: Pick<ProactiveContactEntry, 'pluginId' | 'instanceId' | 'accountId' | 'agentTypeId'>) => JSON.stringify([value.pluginId, value.instanceId, value.accountId, value.agentTypeId])
function fail(code = 'PROACTIVE_POLICY_INVALID', status = 400): never { throw new PlatformError(code, '主动联系策略无效，请核对模式和对象名单。', status, 'not-sent') }
export const EMPTY_CONTACT_POLICY: ProactiveContactPolicy = Object.freeze({ schemaVersion: 1, revision: 0, mode: 'allowlist', entries: [] })
export function parseContactPolicy(value: unknown): ProactiveContactPolicy {
  if (!isJsonObject(value) || !exact(value, ['schemaVersion', 'revision', 'mode', 'entries']) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !['all', 'allowlist', 'denylist'].includes(String(value.mode)) || !Array.isArray(value.entries) || value.entries.length > 1000 || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) fail()
  const seen = new Set<string>()
  for (const row of value.entries) {
    if (!isJsonObject(row) || !exact(row, ['pluginId', 'instanceId', 'accountId', 'agentTypeId', 'targetId', 'label']) || !['pluginId', 'instanceId', 'accountId', 'agentTypeId'].every(key => text(row[key])) || !numericId(row.targetId) || !text(row.label, 80)) fail()
    const key = contactIdentity(row as unknown as ProactiveContactEntry)
    if (seen.has(key)) fail()
    seen.add(key)
  }
  return structuredClone(value) as unknown as ProactiveContactPolicy
}

/** One policy controls both private and group targets; tools remain owned by communication role permissions. */
export class DshProactivePolicy {
  readonly filePath: string
  private document: ProactiveContactPolicy
  private epoch = 0
  constructor(directory: string, private readonly host: HarnessHostServices) {
    this.filePath = join(directory, 'proactive-contact-policy.json')
    try { if (statSync(this.filePath).size > 256 * 1024) fail('PROACTIVE_POLICY_CORRUPTED', 500) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const stored = readRestrictedJson(this.filePath)
    try { this.document = stored === null ? structuredClone(EMPTY_CONTACT_POLICY) : parseContactPolicy(stored) } catch { fail('PROACTIVE_POLICY_CORRUPTED', 500) }
  }
  snapshot(): ProactiveContactPolicy { return structuredClone(this.document) }
  /** Model-visible authorization summary; the actual target directory stays behind eating_list_contact_targets. */
  summary(): JsonObject { return { schemaVersion: 1, revision: this.document.revision, mode: this.document.mode, entryCount: this.document.entries.length } }
  prepare(input: unknown): ProactiveContactPolicy {
    if (!isJsonObject(input) || !exact(input, ['expectedRevision', 'mode', 'entries']) || input.expectedRevision !== this.document.revision) fail('PROACTIVE_POLICY_CONFLICT', 409)
    if (this.document.revision >= Number.MAX_SAFE_INTEGER) fail('PROACTIVE_POLICY_EXHAUSTED', 409)
    return parseContactPolicy({ schemaVersion: 1, revision: this.document.revision + 1, mode: input.mode, entries: input.entries })
  }
  commit(prepared: ProactiveContactPolicy): ProactiveContactPolicy {
    if (prepared.revision !== this.document.revision + 1) fail('PROACTIVE_POLICY_CONFLICT', 409)
    const next = parseContactPolicy(prepared)
    this.epoch++
    try { writeRestrictedJson(this.filePath, next as unknown as JsonObject); this.document = next }
    catch { const actual = readRestrictedJson(this.filePath); if (actual !== null) this.document = parseContactPolicy(actual); throw new PlatformError('PROACTIVE_POLICY_SAVE_PAUSED', '自主活动已暂停，联系策略保存结果请重新读取核对。', 500, 'unknown') }
    return this.snapshot()
  }
  async targets(): Promise<readonly ProactiveTarget[]> {
    const { revision, mode, entries } = this.document, epoch = this.epoch
    if (mode === 'allowlist' && entries.length === 0) return []
    const channels = this.host.readProactiveChannels?.() ?? []
    if (!this.host.readProactiveContacts) fail('PROACTIVE_CONTACTS_UNAVAILABLE', 409)
    const selected = new Map(entries.map(entry => [contactIdentity(entry), entry]))
    const result = await Promise.all(channels.map(async channel => {
      if (channel.tools.length === 0) return []
      const relevant = entries.filter(entry => channelIdentity(entry) === channelIdentity(channel))
      if (mode === 'allowlist' && relevant.length === 0) return []
      const directory = await this.host.readProactiveContacts!(channel.pluginId, { instanceId: channel.instanceId, accountId: channel.accountId, agentTypeId: channel.agentTypeId })
      if (!Array.isArray(directory) || directory.length > 1000 || directory.some(entry => !numericId(entry.id) || typeof entry.name !== 'string' || entry.name.length > 200 || /[\u0000-\u001f\u007f]/.test(entry.name)) || new Set(directory.map(entry => entry.id)).size !== directory.length) fail('PROACTIVE_CONTACTS_INVALID', 502)
      const candidates = [...directory]
      if (mode === 'allowlist' && channel.kind === 'private') for (const entry of relevant) if (!candidates.some(candidate => candidate.id === entry.targetId)) candidates.push({ id: entry.targetId, name: entry.label })
      return candidates.flatMap(entry => {
        const target: ProactiveContactEntry = { pluginId: channel.pluginId, instanceId: channel.instanceId, accountId: channel.accountId, agentTypeId: channel.agentTypeId, targetId: entry.id, label: (entry.name || entry.id).slice(0, 80) }
        const key = contactIdentity(target), listed = selected.has(key)
        if (mode === 'allowlist' && !listed || mode === 'denylist' && listed) return []
        return [{ ...target, id: 'contact.' + createHash('sha256').update(key).digest('hex'), toolNames: channel.tools.map(tool => tool.name) }]
      })
    }))
    if (revision !== this.document.revision || epoch !== this.epoch) fail('PROACTIVE_POLICY_CONFLICT', 409)
    const targets = result.flat()
    if (targets.length > 2000) fail('PROACTIVE_CONTACTS_INVALID', 502)
    return targets
  }
}
