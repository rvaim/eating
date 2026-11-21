import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject, JsonValue } from '@eating/plugin-sdk'

export type QQMessageSplitDelimiterMode = 'drop' | 'keep-end' | 'keep-start'

export interface QQMessageSplitRule {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly pattern: string
  readonly flags: string
  readonly delimiterMode: QQMessageSplitDelimiterMode
}

export interface QQMessageSplitSettings {
  readonly schemaVersion: 1
  readonly revision: number
  readonly enabled: boolean
  readonly maxSegments: number
  readonly delayMs: number
  readonly trimSegments: boolean
  readonly rules: readonly QQMessageSplitRule[]
}

export interface QQMessageSplitPreset {
  readonly id: string
  readonly pattern: string
  readonly flags: string
  readonly delimiterMode: QQMessageSplitDelimiterMode
}

export interface QQMessageSplitPreview {
  readonly parts: readonly string[]
  readonly truncated: boolean
  readonly fallbackToOriginal: boolean
  readonly appliedRules: number
  readonly invalidRuleIds: readonly string[]
}

export const MAX_SPLIT_RULES = 20
export const MAX_SPLIT_RULE_ID_LENGTH = 64
export const MAX_SPLIT_RULE_NAME_LENGTH = 60
export const MAX_SPLIT_PATTERN_LENGTH = 512
export const MIN_SPLIT_SEGMENTS = 1
export const MAX_SPLIT_SEGMENTS = 20
export const DEFAULT_MAX_SPLIT_SEGMENTS = 8
export const MIN_SPLIT_DELAY_MS = 0
export const MAX_SPLIT_DELAY_MS = 10000
export const DEFAULT_SPLIT_DELAY_MS = 400
export const SPLIT_DELIMITER_MODES: readonly QQMessageSplitDelimiterMode[] = ['drop', 'keep-end', 'keep-start']
const ALLOWED_FLAGS = ['i', 'm', 's', 'u'] as const
const MAX_MATCH_ITERATIONS = 10000

export const qqMessageSplitPresets: readonly QQMessageSplitPreset[] = [
  { id: 'blank-lines', pattern: '\\r?\\n(?:[ \\t]*\\r?\\n)+', flags: '', delimiterMode: 'drop' },
  { id: 'newlines', pattern: '\\r?\\n+', flags: '', delimiterMode: 'drop' },
  { id: 'zh-period', pattern: '。+', flags: '', delimiterMode: 'drop' },
  { id: 'zh-en-period', pattern: '。+|(?<!\\d|\\.)\\.(?![A-Za-z0-9_./-])', flags: '', delimiterMode: 'drop' },
  { id: 'zh-en-exclaim-question', pattern: '[？！]+|[?!]+(?![A-Za-z0-9_=&/%-])', flags: '', delimiterMode: 'keep-end' },
  { id: 'zh-en-semicolon', pattern: '[；;]+', flags: '', delimiterMode: 'drop' },
]

export const qqMessageSplitRecommendedPresetIds: readonly string[] = [
  'blank-lines',
  'zh-en-period',
  'zh-en-exclaim-question',
]

export function defaultQQMessageSplitSettings(): QQMessageSplitSettings {
  return {
    schemaVersion: 1,
    revision: 0,
    enabled: false,
    maxSegments: DEFAULT_MAX_SPLIT_SEGMENTS,
    delayMs: DEFAULT_SPLIT_DELAY_MS,
    trimSegments: true,
    rules: [],
  }
}

export function normalizeSplitFlags(flags: string): string | null {
  const seen = new Set<string>()
  for (const ch of flags) {
    if (!(ALLOWED_FLAGS as readonly string[]).includes(ch) || seen.has(ch)) return null
    seen.add(ch)
  }
  return ALLOWED_FLAGS.filter(flag => seen.has(flag)).join('')
}

export function compileSplitRuleRegex(pattern: string, flags: string): RegExp | null {
  if (!pattern || pattern.length > MAX_SPLIT_PATTERN_LENGTH) return null
  const normalizedFlags = normalizeSplitFlags(flags)
  if (normalizedFlags === null) return null
  try {
    return new RegExp(pattern, `${normalizedFlags}g`)
  } catch {
    return null
  }
}

export function validateSplitRulePattern(pattern: string, flags: string): string | null {
  if (!pattern) return 'empty'
  if (pattern.length > MAX_SPLIT_PATTERN_LENGTH) return 'tooLong'
  const normalizedFlags = normalizeSplitFlags(flags)
  if (normalizedFlags === null) return 'invalidFlags'
  try {
    new RegExp(pattern, `${normalizedFlags}g`)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'invalidPattern'
  }
}

interface Span {
  readonly start: number
  readonly end: number
}

function advanceIndex(text: string, index: number, unicode: boolean): number {
  if (index >= text.length) return text.length + 1
  if (unicode) {
    const code = text.codePointAt(index)
    if (code !== undefined && code > 0xffff) return index + 2
  }
  return index + 1
}

function applyRegexToSpan(source: string, span: Span, regex: RegExp, mode: QQMessageSplitDelimiterMode): Span[] {
  const chunk = source.slice(span.start, span.end)
  if (!chunk) return []
  regex.lastIndex = 0
  const output: Span[] = []
  let cursor = 0
  let iterations = 0
  const unicode = regex.flags.includes('u')

  while (iterations < MAX_MATCH_ITERATIONS) {
    iterations++
    const match = regex.exec(chunk)
    if (!match) break
    const matchStart = match.index
    const matchLength = match[0].length
    const matchEnd = matchStart + matchLength

    if (matchLength === 0) {
      if (matchStart > cursor && matchStart < chunk.length) {
        output.push({ start: span.start + cursor, end: span.start + matchStart })
        cursor = matchStart
      }
      regex.lastIndex = advanceIndex(chunk, matchStart, unicode)
      continue
    }

    if (mode === 'drop') {
      if (matchStart > cursor) output.push({ start: span.start + cursor, end: span.start + matchStart })
      cursor = matchEnd
    } else if (mode === 'keep-end') {
      if (matchEnd > cursor) output.push({ start: span.start + cursor, end: span.start + matchEnd })
      cursor = matchEnd
    } else {
      // keep-start: delimiter begins the next segment; skip if already at current cursor to avoid empty split/loop.
      if (matchStart > cursor) {
        output.push({ start: span.start + cursor, end: span.start + matchStart })
        cursor = matchStart
      }
      if (regex.lastIndex <= matchStart) regex.lastIndex = matchEnd
    }
  }

  if (cursor < chunk.length) output.push({ start: span.start + cursor, end: span.end })
  return output
}

function trimSpan(source: string, span: Span): Span {
  let start = span.start
  let end = span.end
  while (start < end && /\s/u.test(source[start]!)) start++
  while (end > start && /\s/u.test(source[end - 1]!)) end--
  return { start, end }
}

export function splitTextByRules(
  text: string,
  settings: Pick<QQMessageSplitSettings, 'enabled' | 'maxSegments' | 'trimSegments' | 'rules'>,
): QQMessageSplitPreview {
  if (!settings.enabled || !text) {
    return { parts: text ? [text] : [], truncated: false, fallbackToOriginal: false, appliedRules: 0, invalidRuleIds: [] }
  }
  const activeRules = settings.rules.filter(rule => rule.enabled)
  if (activeRules.length === 0) {
    return { parts: [text], truncated: false, fallbackToOriginal: false, appliedRules: 0, invalidRuleIds: [] }
  }

  let spans: Span[] = [{ start: 0, end: text.length }]
  let appliedRules = 0
  const invalidRuleIds: string[] = []

  for (const rule of activeRules) {
    const regex = compileSplitRuleRegex(rule.pattern, rule.flags)
    if (!regex) {
      invalidRuleIds.push(rule.id)
      continue
    }
    appliedRules++
    const next: Span[] = []
    for (const span of spans) {
      for (const piece of applyRegexToSpan(text, span, regex, rule.delimiterMode)) {
        if (piece.end > piece.start) next.push(piece)
      }
    }
    spans = next
  }

  if (appliedRules === 0) {
    return { parts: [text], truncated: false, fallbackToOriginal: false, appliedRules: 0, invalidRuleIds }
  }

  const normalized = spans
    .map(span => (settings.trimSegments ? trimSpan(text, span) : span))
    .filter(span => span.end > span.start)

  if (normalized.length === 0) {
    return { parts: [text], truncated: false, fallbackToOriginal: true, appliedRules, invalidRuleIds }
  }

  const limit = Math.max(MIN_SPLIT_SEGMENTS, Math.min(MAX_SPLIT_SEGMENTS, Math.trunc(settings.maxSegments) || DEFAULT_MAX_SPLIT_SEGMENTS))
  if (normalized.length > limit) {
    const head = normalized.slice(0, limit - 1).map(span => text.slice(span.start, span.end))
    const tailStart = normalized[limit - 1]!.start
    const tailSpan = settings.trimSegments ? trimSpan(text, { start: tailStart, end: text.length }) : { start: tailStart, end: text.length }
    const tail = tailSpan.end > tailSpan.start ? text.slice(tailSpan.start, tailSpan.end) : text.slice(tailStart)
    return { parts: [...head, tail], truncated: true, fallbackToOriginal: false, appliedRules, invalidRuleIds }
  }

  return {
    parts: normalized.map(span => text.slice(span.start, span.end)),
    truncated: false,
    fallbackToOriginal: false,
    appliedRules,
    invalidRuleIds,
  }
}

function isLeadingPrefixSegment(segment: JsonValue): segment is JsonObject {
  return isJsonObject(segment) && (segment.type === 'reply' || segment.type === 'at')
}

function isTextSegment(segment: JsonValue): segment is JsonObject & { data: { text: string } } {
  return isJsonObject(segment) && segment.type === 'text' && isJsonObject(segment.data) && typeof segment.data.text === 'string'
}

/**
 * Split an already-validated outgoing OneBot message into multiple messages when configured.
 * Non-text media segments (image, record, video, node, face, etc.) and auto_escape=false (CQ code) stay intact.
 */
export function splitOutgoingQQMessage(
  message: JsonValue | undefined,
  autoEscape: boolean,
  settings: Pick<QQMessageSplitSettings, 'enabled' | 'maxSegments' | 'trimSegments' | 'rules'>,
): JsonValue[] {
  if (message === undefined) return []
  if (!settings.enabled || !autoEscape) return [message]

  if (typeof message === 'string') {
    const preview = splitTextByRules(message, settings)
    if (preview.appliedRules === 0 || preview.fallbackToOriginal || preview.parts.length === 0) return [message]
    if (preview.parts.length === 1 && preview.parts[0] === message) return [message]
    return [...preview.parts]
  }

  if (isJsonObject(message)) {
    if (!isTextSegment(message)) return [message]
    const preview = splitTextByRules(message.data.text, settings)
    if (preview.appliedRules === 0 || preview.fallbackToOriginal || preview.parts.length === 0) return [message]
    if (preview.parts.length === 1 && preview.parts[0] === message.data.text) return [message]
    return preview.parts.map(chunk => ({ type: 'text', data: { text: chunk } }))
  }

  if (Array.isArray(message)) {
    let prefixEnd = 0
    while (prefixEnd < message.length && isLeadingPrefixSegment(message[prefixEnd]!)) prefixEnd++
    const rest = message.slice(prefixEnd)
    if (rest.length === 0 || !rest.every(isTextSegment)) return [message]
    const combinedText = rest.map(segment => segment.data.text).join('')
    const preview = splitTextByRules(combinedText, settings)
    if (preview.appliedRules === 0 || preview.fallbackToOriginal || preview.parts.length === 0) return [message]
    if (preview.parts.length === 1 && preview.parts[0] === combinedText) return [message]
    const prefix = message.slice(0, prefixEnd)
    return preview.parts.map((chunk, index) => (
      index === 0 && prefix.length > 0
        ? [...prefix, { type: 'text', data: { text: chunk } }]
        : [{ type: 'text', data: { text: chunk } }]
    ))
  }

  return [message]
}
