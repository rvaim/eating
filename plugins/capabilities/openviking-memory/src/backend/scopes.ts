import type { MemoryScope } from '@eating/plugin-sdk'
import type { MemorySettings, ScopeRule } from '../types'
import { bool, error, identity, object, platform, serviceIdentity, text } from './validation'

export const SELF_SCOPE: MemoryScope = { kind: 'self', platform: '', accountId: '', targetId: '', owner: false }
export function scope(value: unknown): MemoryScope {
  const input = object(value, ['kind', 'platform', 'accountId', 'targetId', 'owner'])
  if (input.kind === 'self') return { kind: 'self', platform: text(input.platform, 32, true), accountId: text(input.accountId, 96, true), targetId: text(input.targetId, 96, true), owner: bool(input.owner) }
  if (input.kind !== 'private' && input.kind !== 'group') throw error('MEMORY_INVALID_INPUT')
  return { kind: input.kind, platform: platform(input.platform), accountId: identity(input.accountId), targetId: identity(input.targetId), owner: bool(input.owner) }
}
export function peerId(value: MemoryScope): string { return value.kind === 'self' ? 'self' : `${value.platform}-${value.accountId}-${value.kind}-${value.targetId}` }
export function parsePeer(value: unknown): MemoryScope {
  if (value === 'self') return { ...SELF_SCOPE }
  if (typeof value !== 'string') throw error('MEMORY_INVALID_INPUT')
  const match = /^([a-z][a-z0-9_]{0,31})-([A-Za-z0-9_]{1,96})-(private|group)-([A-Za-z0-9_]{1,96})$/.exec(value)
  if (!match) throw error('MEMORY_INVALID_INPUT')
  return { platform: match[1]!, accountId: match[2]!, kind: match[3] as 'private' | 'group', targetId: match[4]!, owner: false }
}
export function ruleFor(settings: MemorySettings, current: MemoryScope): ScopeRule | undefined {
  return current.kind === 'self' ? undefined : settings.rules.find(rule => rule.platform === current.platform && rule.accountId === current.accountId && rule.kind === current.kind && rule.targetId === current.targetId)
}
export function policy(settings: MemorySettings, current: MemoryScope) {
  const rule = ruleFor(settings, current)
  return { capture: settings.enabled && (current.kind === 'self' || (rule?.capture ?? (current.kind === 'group' ? settings.groupCapture : settings.privateCapture))),
    recall: settings.enabled && (current.kind === 'self' || (rule?.recall ?? (current.kind === 'group' ? settings.groupRecall : settings.privateRecall))),
    memberMode: rule?.memberMode ?? 'all', memberIds: rule?.memberIds ?? [] }
}
export function crossSession(settings: MemorySettings, current: MemoryScope): boolean {
  return settings.ownerCrossSession && current.owner && (current.kind === 'private' || current.kind === 'self')
}
export function globalRoot(user: string): string { return `viking://user/${serviceIdentity(user)}/memories` }
export function peerRoot(user: string, peer: string): string { parsePeer(peer); return `viking://user/${serviceIdentity(user)}/peers/${peer}/memories` }
export interface MemoryLocation { readonly uri: string; readonly peer: string | null }
/** Only canonical memory files. No home aliases, sidecars, escapes, archives or directories. */
export function memoryLocation(value: unknown, user: string): MemoryLocation {
  const uri = text(value, 768), prefix = `viking://user/${serviceIdentity(user)}/`
  if (!uri.startsWith(prefix) || /[%?#\\]/.test(uri)) throw error('MEMORY_URI_DENIED', 403)
  let remainder = uri.slice(prefix.length), peer: string | null = null
  if (remainder.startsWith('peers/')) {
    const parts = remainder.split('/'); peer = parts[1] ?? ''; parsePeer(peer); remainder = parts.slice(2).join('/')
  }
  const parts = remainder.split('/')
  if (parts.length < 3 || parts[0] !== 'memories' || !['preferences', 'entities', 'events'].includes(parts[1]!) || parts.slice(2).some(part => !part || part.length > 192 || part.startsWith('.') || part.trim() !== part || /[\u0000-\u001f\u007f%?#\\/]/.test(part)) || !parts.at(-1)!.endsWith('.md')) throw error('MEMORY_URI_DENIED', 403)
  return { uri, peer }
}
export function allowedLocation(value: unknown, user: string, settings: MemorySettings, current: MemoryScope, all = false): string {
  const location = memoryLocation(value, user)
  if (location.peer === null ? !settings.globalMemory : location.peer !== peerId(current) && !all) throw error('MEMORY_SCOPE_DENIED', 403)
  return location.uri
}
