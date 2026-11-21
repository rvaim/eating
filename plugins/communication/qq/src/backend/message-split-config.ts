import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import {
  compileSplitRuleRegex,
  defaultQQMessageSplitSettings,
  MAX_SPLIT_DELAY_MS,
  MAX_SPLIT_PATTERN_LENGTH,
  MAX_SPLIT_RULE_ID_LENGTH,
  MAX_SPLIT_RULE_NAME_LENGTH,
  MAX_SPLIT_RULES,
  MAX_SPLIT_SEGMENTS,
  MIN_SPLIT_DELAY_MS,
  MIN_SPLIT_SEGMENTS,
  normalizeSplitFlags,
  SPLIT_DELIMITER_MODES,
} from '../message-split'
import type { QQMessageSplitDelimiterMode, QQMessageSplitRule, QQMessageSplitSettings } from '../message-split'
import { writeRestrictedJson } from './config-file'

const MAX_FILE_BYTES = 65536
const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const exact = (value: JsonObject, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

function invalid(detail: string): never {
  throw new PlatformError('QQ_MESSAGE_SPLIT_INVALID', `消息拆分设置无效：${detail}`, 400, 'not-sent')
}

function corrupted(): never {
  throw new PlatformError('QQ_MESSAGE_SPLIT_CORRUPTED', '消息拆分私有配置不是当前 schema1 或文件已损坏，原文件未覆盖。', 500, 'not-sent')
}

function parseRule(entry: unknown, index: number, onError: (detail: string) => never): QQMessageSplitRule {
  if (!isJsonObject(entry) || !exact(entry, ['id', 'name', 'enabled', 'pattern', 'flags', 'delimiterMode'])) {
    onError(`第 ${index + 1} 条规则字段不完整或包含未知字段。`)
  }
  if (typeof entry.id !== 'string' || entry.id.length > MAX_SPLIT_RULE_ID_LENGTH || !RULE_ID_PATTERN.test(entry.id)) {
    onError(`第 ${index + 1} 条规则的 ID 无效。`)
  }
  if (typeof entry.name !== 'string' || entry.name.length > MAX_SPLIT_RULE_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(entry.name)) {
    onError(`第 ${index + 1} 条规则的名称无效或超过 ${MAX_SPLIT_RULE_NAME_LENGTH} 字。`)
  }
  if (typeof entry.enabled !== 'boolean') {
    onError(`第 ${index + 1} 条规则的启用状态必须为布尔值。`)
  }
  if (typeof entry.pattern !== 'string' || entry.pattern.length === 0 || entry.pattern.length > MAX_SPLIT_PATTERN_LENGTH || /[\u0000\r\n]/.test(entry.pattern)) {
    onError(`第 ${index + 1} 条规则的正则表达式需为 1 至 ${MAX_SPLIT_PATTERN_LENGTH} 字符的单行正则。`)
  }
  if (typeof entry.flags !== 'string') {
    onError(`第 ${index + 1} 条规则的正则标志必须为字符串。`)
  }
  const normalizedFlags = normalizeSplitFlags(entry.flags)
  if (normalizedFlags === null) {
    onError(`第 ${index + 1} 条规则的正则标志仅允许 i、m、s、u 组合。`)
  }
  if (typeof entry.delimiterMode !== 'string' || !(SPLIT_DELIMITER_MODES as readonly string[]).includes(entry.delimiterMode)) {
    onError(`第 ${index + 1} 条规则的分隔符保留模式无效。`)
  }
  if (!compileSplitRuleRegex(entry.pattern, normalizedFlags)) {
    onError(`第 ${index + 1} 条规则的正则表达式语法无效。`)
  }
  return {
    id: entry.id,
    name: entry.name.trim(),
    enabled: entry.enabled,
    pattern: entry.pattern,
    flags: normalizedFlags,
    delimiterMode: entry.delimiterMode as QQMessageSplitDelimiterMode,
  }
}

function parseRules(value: unknown, onError: (detail: string) => never): QQMessageSplitRule[] {
  if (!Array.isArray(value) || value.length > MAX_SPLIT_RULES) {
    onError(`规则列表需为最多 ${MAX_SPLIT_RULES} 条的数组。`)
  }
  const seenIds = new Set<string>()
  return value.map((entry, index) => {
    const parsed = parseRule(entry, index, onError)
    if (seenIds.has(parsed.id)) onError(`存在重复的规则 ID：${parsed.id}。`)
    seenIds.add(parsed.id)
    return parsed
  })
}

function parseBodyFields(value: JsonObject, onError: (detail: string) => never): Omit<QQMessageSplitSettings, 'schemaVersion' | 'revision'> {
  if (typeof value.enabled !== 'boolean') onError('enabled 必须为布尔值。')
  if (typeof value.maxSegments !== 'number' || !Number.isInteger(value.maxSegments) || value.maxSegments < MIN_SPLIT_SEGMENTS || value.maxSegments > MAX_SPLIT_SEGMENTS) {
    onError(`最大拆分条数需为 ${MIN_SPLIT_SEGMENTS} 至 ${MAX_SPLIT_SEGMENTS} 的整数。`)
  }
  if (typeof value.delayMs !== 'number' || !Number.isInteger(value.delayMs) || value.delayMs < MIN_SPLIT_DELAY_MS || value.delayMs > MAX_SPLIT_DELAY_MS) {
    onError(`每条消息间隔需为 ${MIN_SPLIT_DELAY_MS} 至 ${MAX_SPLIT_DELAY_MS} 毫秒的整数。`)
  }
  if (typeof value.trimSegments !== 'boolean') onError('trimSegments 必须为布尔值。')
  const rules = parseRules(value.rules, onError)
  return {
    enabled: value.enabled,
    maxSegments: value.maxSegments,
    delayMs: value.delayMs,
    trimSegments: value.trimSegments,
    rules,
  }
}

export class QQMessageSplitConfiguration {
  readonly filePath: string

  constructor(directory: string) {
    this.filePath = join(resolve(directory), 'message-split.json')
  }

  private read(): QQMessageSplitSettings {
    let descriptor: number | undefined
    try {
      const stat = lstatSync(this.filePath, { throwIfNoEntry: false })
      if (!stat) return defaultQQMessageSplitSettings()
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES || stat.size < 1) corrupted()
      descriptor = openSync(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES || opened.size < 1) corrupted()
      const value: unknown = JSON.parse(readFileSync(descriptor, 'utf8'))
      if (!isJsonObject(value) || !exact(value, ['schemaVersion', 'revision', 'enabled', 'maxSegments', 'delayMs', 'trimSegments', 'rules'])) corrupted()
      if (value.schemaVersion !== 1 || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) corrupted()
      const fields = parseBodyFields(value, () => corrupted())
      return { schemaVersion: 1, revision: value.revision, ...fields }
    } catch (error) {
      if (error instanceof PlatformError && error.code === 'QQ_MESSAGE_SPLIT_CORRUPTED') throw error
      return corrupted()
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }

  snapshot(): QQMessageSplitSettings {
    return this.read()
  }

  save(input: unknown): QQMessageSplitSettings {
    const current = this.read()
    if (!isJsonObject(input) || !exact(input, ['expectedRevision', 'enabled', 'maxSegments', 'delayMs', 'trimSegments', 'rules'])) {
      invalid('请求参数不完整或包含未知字段。')
    }
    if (typeof input.expectedRevision !== 'number' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      invalid('缺少有效的版本号 expectedRevision。')
    }
    if (current.revision !== input.expectedRevision || current.revision === Number.MAX_SAFE_INTEGER) {
      throw new PlatformError('QQ_MESSAGE_SPLIT_CONFLICT', '消息拆分设置已在其他页面更新，请保留草稿并重新读取后再保存。', 409, 'not-sent')
    }
    const fields = parseBodyFields(input, invalid)
    const next: QQMessageSplitSettings = {
      schemaVersion: 1,
      revision: current.revision + 1,
      ...fields,
    }
    writeRestrictedJson(this.filePath, next as unknown as JsonObject)
    return this.read()
  }
}
