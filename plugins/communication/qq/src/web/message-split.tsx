import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { ArrowDown, ArrowUp, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { isJsonObject } from '@eating/plugin-sdk'
import {
  ActionButton,
  FormSaveBar,
  HostApiError,
  hostRequest,
  registerTranslations,
  Switch,
  useI18n,
} from '@eating/ui-sdk'
import {
  MAX_SPLIT_DELAY_MS,
  MAX_SPLIT_PATTERN_LENGTH,
  MAX_SPLIT_RULE_ID_LENGTH,
  MAX_SPLIT_RULE_NAME_LENGTH,
  MAX_SPLIT_RULES,
  MAX_SPLIT_SEGMENTS,
  MIN_SPLIT_DELAY_MS,
  MIN_SPLIT_SEGMENTS,
  normalizeSplitFlags,
  qqMessageSplitPresets,
  qqMessageSplitRecommendedPresetIds,
  SPLIT_DELIMITER_MODES,
  splitTextByRules,
  validateSplitRulePattern,
} from '../message-split'
import type {
  QQMessageSplitDelimiterMode,
  QQMessageSplitPreset,
  QQMessageSplitRule,
  QQMessageSplitSettings,
} from '../message-split'

const zh = {
  title: 'Harness 消息正则拆分',
  description: '按正则规则将 Harness 子代理发出的长文本拆分为多条独立 QQ 消息依次发送。默认仅对 Harness（子代理）生效，面板手动测试、图片、语音、合并转发及含 CQ 码的消息保持原样发送。',
  independentNote: '此分区有独立的保存与版本控制；点击下方保存按钮后才会对实际发送生效。',
  badgeSaved: '已保存',
  badgeDirty: '有未保存更改',
  enabledLabel: '启用 Harness 消息正则拆分',
  enabledHelp: '开启后，纯文本及带回复／@前缀的文本消息会按下方规则顺序切分；若规则全匹配导致结果为空，将保留原文单条发送。',
  maxSegmentsLabel: '单次最大拆分条数',
  maxSegmentsHelp: '范围 {{min}} 至 {{max}} 条。超出上限时，剩余内容将按原文合并到最后一条发出，避免刷屏且不丢字。',
  delayMsLabel: '每条消息发送间隔（毫秒）',
  delayMsHelp: '范围 {{min}} 至 {{max}} 毫秒。拆成多条时相邻两条之间的等待时间，0 表示立即连发。',
  delayPresetZero: '不延迟',
  trimSegmentsLabel: '自动去除每段首尾空白',
  trimSegmentsHelp: '拆分后去掉每条消息开头和结尾的空格与换行，并自动忽略空段。',
  presetsTitle: '常用规则预设（点一下即可填入）',
  presetsHelp: '支持按中文或英文标点、空行、换行拆分；问号与感叹号预设默认保留符号在句尾。',
  applyRecommended: '一键套用推荐组合',
  recommendedApplied: '已填入推荐组合（空行 + 中英文句号去号 + 问号感叹号保号），点击保存即可生效。',
  presetAdded: '已添加预设规则：{{name}}。',
  presetExists: '规则列表中已存在相同预设：{{name}}。',
  presetLimit: '规则数量已达上限（最多 {{max}} 条）。',
  'preset.blank-lines.name': '空行分段',
  'preset.blank-lines.badge': '去空行',
  'preset.newlines.name': '单换行分段',
  'preset.newlines.badge': '去换行',
  'preset.zh-period.name': '中文句号',
  'preset.zh-period.badge': '去句号',
  'preset.zh-en-period.name': '中英文句号',
  'preset.zh-en-period.badge': '去句号 · 避小数/网址',
  'preset.zh-en-exclaim-question.name': '中英文问号／感叹号',
  'preset.zh-en-exclaim-question.badge': '保留在句尾',
  'preset.zh-en-semicolon.name': '中英文分号',
  'preset.zh-en-semicolon.badge': '去分号',
  rulesTitle: '正则拆分规则（按顺序依次执行）',
  rulesCount: '已配置 {{count}} / {{max}} 条',
  addRule: '添加自定义规则',
  clearRules: '清空规则',
  emptyRules: '还没有拆分规则。你可以点击上方预设快速填入，或添加自定义正则表达式。',
  ruleIndex: '规则 #{{index}}',
  ruleEnabled: '启用',
  ruleNameLabel: '规则名称',
  ruleNamePlaceholder: '例如：按句号分隔',
  rulePatternLabel: '正则表达式',
  rulePatternPlaceholder: '例如：。+ 或 \\r?\\n(?:[ \\t]*\\r?\\n)+',
  ruleModeLabel: '匹配内容处理',
  'mode.drop': '去掉匹配内容（不保留）',
  'mode.keep-end': '保留在上一条末尾',
  'mode.keep-start': '保留在下一条开头',
  ruleFlagsLabel: '正则标志',
  'flag.i': 'i 忽略大小写',
  'flag.m': 'm 多行 (^/$)',
  'flag.s': 's 点号匹配换行',
  'flag.u': 'u Unicode',
  moveUp: '上移规则',
  moveDown: '下移规则',
  removeRule: '删除规则',
  patternEmpty: '请填写正则表达式。',
  patternTooLong: '正则表达式长度不能超过 {{max}} 字符。',
  patternInvalid: '正则表达式语法无效：{{detail}}',
  previewTitle: '实时试拆预览',
  previewHelp: '与后端使用完全一致的拆分引擎。修改规则或下方示例文本即可即时查看最终发出的气泡效果。',
  previewInputLabel: '示例文本',
  previewReset: '恢复默认示例',
  previewDefaultText: '你好呀！今天天气真不错。\n\n圆周率大概是 3.14，网址 https://example.com 不会被误拆。你说是不是？太棒了！',
  previewDisabledHint: '当前总开关未开启，实际发送暂不拆分；下方为开启总开关后的模拟预览：',
  previewCount: '将拆分为 {{count}} 条消息',
  previewSingle: '保持为 1 条消息发送',
  previewEmptyInput: '输入文本后将在此实时显示拆分结果。',
  previewNoActiveRules: '当前没有启用的规则，消息将保持原样单条发送。',
  previewTruncated: '已达到最大拆分条数（{{max}} 条），超出部分已按原文合并到最后一条。',
  previewFallback: '所有内容均被匹配为空，实际发送时会兜底保留原文单条发出。',
  previewInvalidNotice: '部分已启用规则的正则语法无效，预览中已跳过这些规则；保存前请先修正。',
  save: '保存拆分设置',
  saving: '正在保存…',
  read: '重新读取',
  saved: '消息拆分设置已保存。',
  fixBeforeSave: '请先修正表单中的无效参数或正则表达式后再保存。',
  invalidMaxSegments: '单次最大拆分条数需为 {{min}} 至 {{max}} 的整数。',
  invalidDelayMs: '发送间隔需为 {{min}} 至 {{max}} 毫秒的整数。',
  conflict: '消息拆分设置已在其他页面更改，当前草稿已保留。请重新读取并核对后再保存。',
  corrupted: '消息拆分私有配置文件损坏，原文件未被覆盖。请检查 message-split.json。',
  error: '消息拆分设置操作未完成，请核对后重试。',
  disabledReason: '请先启用 QQ 插件。',
}

const en: Record<keyof typeof zh, string> = {
  title: 'Harness regex message splitting',
  description: 'Split long text messages sent by Harness subagents into multiple QQ messages using regex rules. Applies only to Harness (subagent) sends by default; manual panel tests, images, audio, forward nodes, and CQ-code messages stay intact.',
  independentNote: 'This section is saved and versioned separately. Click Save below to apply changes.',
  badgeSaved: 'Saved',
  badgeDirty: 'Unsaved changes',
  enabledLabel: 'Enable regex message splitting for Harness',
  enabledHelp: 'When enabled, plain text and text messages with leading reply/@ segments are split in rule order. If all text is stripped, the original message is sent intact.',
  maxSegmentsLabel: 'Max split messages per call',
  maxSegmentsHelp: 'Range {{min}} to {{max}}. Any overflow is merged back into the final message verbatim to avoid flooding or losing text.',
  delayMsLabel: 'Delay between split messages (ms)',
  delayMsHelp: 'Range {{min}} to {{max}} ms. Wait time between consecutive messages; 0 sends immediately.',
  delayPresetZero: 'No delay',
  trimSegmentsLabel: 'Trim whitespace around each part',
  trimSegmentsHelp: 'Remove leading and trailing spaces/newlines from each split message and drop empty parts.',
  presetsTitle: 'Common presets (click to add)',
  presetsHelp: 'Covers Chinese and English punctuation, blank lines, and line breaks. Exclamation and question marks stay attached to the end of each message.',
  applyRecommended: 'Apply recommended set',
  recommendedApplied: 'Applied recommended rules (blank lines + Chinese/English periods + ?/! kept at end). Save to take effect.',
  presetAdded: 'Added preset rule: {{name}}.',
  presetExists: 'Preset rule is already in the list: {{name}}.',
  presetLimit: 'Rule limit reached (max {{max}}).',
  'preset.blank-lines.name': 'Blank lines',
  'preset.blank-lines.badge': 'Drop blank lines',
  'preset.newlines.name': 'Line breaks',
  'preset.newlines.badge': 'Drop newlines',
  'preset.zh-period.name': 'Chinese period (。)',
  'preset.zh-period.badge': 'Drop period',
  'preset.zh-en-period.name': 'Chinese & English periods',
  'preset.zh-en-period.badge': 'Drop · skips decimals/URLs',
  'preset.zh-en-exclaim-question.name': 'Chinese & English ? / !',
  'preset.zh-en-exclaim-question.badge': 'Keep at end',
  'preset.zh-en-semicolon.name': 'Chinese & English semicolons',
  'preset.zh-en-semicolon.badge': 'Drop semicolon',
  rulesTitle: 'Regex rules (applied in order)',
  rulesCount: '{{count}} / {{max}} rules',
  addRule: 'Add custom rule',
  clearRules: 'Clear rules',
  emptyRules: 'No split rules yet. Pick a preset above or add a custom regex rule.',
  ruleIndex: 'Rule #{{index}}',
  ruleEnabled: 'Enabled',
  ruleNameLabel: 'Rule name',
  ruleNamePlaceholder: 'e.g. Split by period',
  rulePatternLabel: 'Regular expression',
  rulePatternPlaceholder: 'e.g. 。+ or \\r?\\n(?:[ \\t]*\\r?\\n)+',
  ruleModeLabel: 'Matched delimiter',
  'mode.drop': 'Remove delimiter',
  'mode.keep-end': 'Keep at end of previous message',
  'mode.keep-start': 'Keep at start of next message',
  ruleFlagsLabel: 'Flags',
  'flag.i': 'i ignore case',
  'flag.m': 'm multiline',
  'flag.s': 's dotAll',
  'flag.u': 'u unicode',
  moveUp: 'Move rule up',
  moveDown: 'Move rule down',
  removeRule: 'Remove rule',
  patternEmpty: 'Enter a regular expression.',
  patternTooLong: 'Regular expression must be at most {{max}} characters.',
  patternInvalid: 'Invalid regular expression: {{detail}}',
  previewTitle: 'Live split preview',
  previewHelp: 'Uses the exact same splitting engine as the backend. Edit rules or sample text below to inspect resulting bubbles.',
  previewInputLabel: 'Sample message',
  previewReset: 'Reset sample',
  previewDefaultText: 'Hey there! The weather is great today.\n\nPi is roughly 3.14 and https://example.com stays intact. Right? Awesome!',
  previewDisabledHint: 'Master switch is off so live sends are not split yet. Simulated preview if enabled:',
  previewCount: 'Will send as {{count}} messages',
  previewSingle: 'Will send as 1 message',
  previewEmptyInput: 'Enter sample text to preview split results.',
  previewNoActiveRules: 'No active rules; message will be sent as a single bubble.',
  previewTruncated: 'Reached the max limit ({{max}}); remaining text is kept verbatim in the last message.',
  previewFallback: 'All text matched delimiters; the original message will be sent unchanged as a fallback.',
  previewInvalidNotice: 'Some enabled rules have invalid regex syntax and are skipped in preview. Fix them before saving.',
  save: 'Save split settings',
  saving: 'Saving…',
  read: 'Reload',
  saved: 'Message split settings saved.',
  fixBeforeSave: 'Fix invalid fields or regular expressions before saving.',
  invalidMaxSegments: 'Max split messages must be an integer between {{min}} and {{max}}.',
  invalidDelayMs: 'Delay must be an integer between {{min}} and {{max}} ms.',
  conflict: 'Message split settings changed elsewhere. Your draft is kept. Reload and review before saving.',
  corrupted: 'Message split configuration file is corrupted and was not overwritten. Check message-split.json.',
  error: 'Operation did not complete. Review settings and try again.',
  disabledReason: 'Enable the QQ plugin first.',
}

registerTranslations('qq-message-split', { 'zh-CN': zh, 'en-US': en })

const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DELAY_PRESETS = [0, 300, 500, 1000] as const
const FLAG_OPTIONS = ['i', 'm', 's', 'u'] as const

export function parseMessageSplitSettings(value: unknown): QQMessageSplitSettings {
  if (
    !isJsonObject(value)
    || Object.keys(value).length !== 7
    || value.schemaVersion !== 1
    || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || typeof value.enabled !== 'boolean'
    || typeof value.maxSegments !== 'number'
    || !Number.isInteger(value.maxSegments)
    || value.maxSegments < MIN_SPLIT_SEGMENTS
    || value.maxSegments > MAX_SPLIT_SEGMENTS
    || typeof value.delayMs !== 'number'
    || !Number.isInteger(value.delayMs)
    || value.delayMs < MIN_SPLIT_DELAY_MS
    || value.delayMs > MAX_SPLIT_DELAY_MS
    || typeof value.trimSegments !== 'boolean'
    || !Array.isArray(value.rules)
    || value.rules.length > MAX_SPLIT_RULES
  ) {
    throw new HostApiError('INVALID_HOST_RESPONSE', 'Invalid message split configuration response')
  }
  const seenIds = new Set<string>()
  const rules: QQMessageSplitRule[] = value.rules.map(entry => {
    if (
      !isJsonObject(entry)
      || Object.keys(entry).length !== 6
      || typeof entry.id !== 'string'
      || entry.id.length > MAX_SPLIT_RULE_ID_LENGTH
      || !RULE_ID_PATTERN.test(entry.id)
      || seenIds.has(entry.id)
      || typeof entry.name !== 'string'
      || entry.name.length > MAX_SPLIT_RULE_NAME_LENGTH
      || typeof entry.enabled !== 'boolean'
      || typeof entry.pattern !== 'string'
      || entry.pattern.length === 0
      || entry.pattern.length > MAX_SPLIT_PATTERN_LENGTH
      || typeof entry.flags !== 'string'
      || normalizeSplitFlags(entry.flags) === null
      || typeof entry.delimiterMode !== 'string'
      || !(SPLIT_DELIMITER_MODES as readonly string[]).includes(entry.delimiterMode)
    ) {
      throw new HostApiError('INVALID_HOST_RESPONSE', 'Invalid message split rule response')
    }
    seenIds.add(entry.id)
    return {
      id: entry.id,
      name: entry.name,
      enabled: entry.enabled,
      pattern: entry.pattern,
      flags: normalizeSplitFlags(entry.flags)!,
      delimiterMode: entry.delimiterMode as QQMessageSplitDelimiterMode,
    }
  })
  return {
    schemaVersion: 1,
    revision: value.revision,
    enabled: value.enabled,
    maxSegments: value.maxSegments,
    delayMs: value.delayMs,
    trimSegments: value.trimSegments,
    rules,
  }
}

interface DraftState {
  revision: number
  enabled: boolean
  maxSegments: string
  delayMs: string
  trimSegments: boolean
  rules: QQMessageSplitRule[]
}

function toDraft(settings: QQMessageSplitSettings): DraftState {
  return {
    revision: settings.revision,
    enabled: settings.enabled,
    maxSegments: String(settings.maxSegments),
    delayMs: String(settings.delayMs),
    trimSegments: settings.trimSegments,
    rules: settings.rules.map(rule => ({ ...rule })),
  }
}

function makeUniqueRuleId(base: string, existing: readonly QQMessageSplitRule[]): string {
  const used = new Set(existing.map(rule => rule.id))
  if (!used.has(base)) return base
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
  return `rule-${Date.now()}`
}

function samePresetSignature(rule: QQMessageSplitRule, preset: QQMessageSplitPreset): boolean {
  return rule.pattern === preset.pattern && rule.flags === preset.flags && rule.delimiterMode === preset.delimiterMode
}

interface Props {
  active: boolean
  enabled: boolean
  busy: boolean
  actionLock: MutableRefObject<boolean>
  onBusy: (busy: boolean) => void
  onFeedback: (message: string) => void
  onDirtyChange?: (dirty: boolean) => void
}

export function MessageSplitFields({ active, enabled, busy, actionLock, onBusy, onFeedback, onDirtyChange }: Props) {
  const { t, locale } = useI18n('qq-message-split')
  const prefix = useId()
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState(false)
  const [saved, setSaved] = useState(false)
  const [errorKey, setErrorKey] = useState<'conflict' | 'corrupted' | 'fixBeforeSave' | 'error' | null>(null)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [sampleText, setSampleText] = useState(() => t('previewDefaultText'))
  const sampleEdited = useRef(false)
  const previousLocale = useRef(locale)
  const controller = useRef<AbortController | null>(null)
  const modeRef = useRef<'read' | 'save' | null>(null)
  const callbacks = useRef({ onBusy, onFeedback, onDirtyChange })
  const previousActive = useRef(false)
  const needsLoad = useRef(true)
  callbacks.current = { onBusy, onFeedback, onDirtyChange }

  useEffect(() => {
    callbacks.current.onDirtyChange?.(dirty)
  }, [dirty])

  useEffect(() => {
    if (previousLocale.current !== locale) {
      previousLocale.current = locale
      if (!sampleEdited.current) setSampleText(t('previewDefaultText'))
    }
  }, [locale, t])

  const parsedMaxSegments = draft ? Number(draft.maxSegments.trim()) : NaN
  const maxSegmentsError = draft && (!draft.maxSegments.trim() || !Number.isInteger(parsedMaxSegments) || parsedMaxSegments < MIN_SPLIT_SEGMENTS || parsedMaxSegments > MAX_SPLIT_SEGMENTS)
    ? t('invalidMaxSegments', { min: MIN_SPLIT_SEGMENTS, max: MAX_SPLIT_SEGMENTS })
    : null

  const parsedDelayMs = draft ? Number(draft.delayMs.trim()) : NaN
  const delayMsError = draft && (!draft.delayMs.trim() || !Number.isInteger(parsedDelayMs) || parsedDelayMs < MIN_SPLIT_DELAY_MS || parsedDelayMs > MAX_SPLIT_DELAY_MS)
    ? t('invalidDelayMs', { min: MIN_SPLIT_DELAY_MS, max: MAX_SPLIT_DELAY_MS })
    : null

  const ruleErrors = useMemo(() => {
    if (!draft) return {} as Record<string, string>
    const errors: Record<string, string> = {}
    for (const rule of draft.rules) {
      const issue = validateSplitRulePattern(rule.pattern, rule.flags)
      if (issue === 'empty') errors[rule.id] = t('patternEmpty')
      else if (issue === 'tooLong') errors[rule.id] = t('patternTooLong', { max: MAX_SPLIT_PATTERN_LENGTH })
      else if (issue !== null) errors[rule.id] = t('patternInvalid', { detail: issue })
    }
    return errors
  }, [draft, t])

  const hasValidationErrors = Boolean(maxSegmentsError || delayMsError || Object.keys(ruleErrors).length > 0)

  const preview = useMemo(() => {
    if (!draft) return null
    const maxSegments = !maxSegmentsError ? parsedMaxSegments : 8
    return splitTextByRules(sampleText, {
      enabled: true,
      maxSegments,
      trimSegments: draft.trimSegments,
      rules: draft.rules,
    })
  }, [draft, sampleText, maxSegmentsError, parsedMaxSegments])

  async function request(save: boolean) {
    if (!enabled || document.hidden || pending || (save ? actionLock.current || !draft : busy || actionLock.current)) return
    if (save && draft && hasValidationErrors) {
      setErrorKey('fixBeforeSave')
      setErrorDetail(null)
      return
    }
    const current = new AbortController()
    controller.current = current
    modeRef.current = save ? 'save' : 'read'
    if (!save) needsLoad.current = false
    if (save) {
      actionLock.current = true
      callbacks.current.onBusy(true)
    }
    setPending(true)
    setErrorKey(null)
    setErrorDetail(null)
    setSaved(false)
    try {
      const response = await hostRequest<unknown>('/plugins/qq/manage', {
        method: 'POST',
        signal: current.signal,
        body: save && draft
          ? {
            operation: 'save-message-split',
            input: {
              expectedRevision: draft.revision,
              enabled: draft.enabled,
              maxSegments: Number(draft.maxSegments.trim()),
              delayMs: Number(draft.delayMs.trim()),
              trimSegments: draft.trimSegments,
              rules: draft.rules.map(rule => ({
                id: rule.id,
                name: rule.name.trim(),
                enabled: rule.enabled,
                pattern: rule.pattern,
                flags: rule.flags,
                delimiterMode: rule.delimiterMode,
              })),
            },
          }
          : { operation: 'message-split', input: {} },
      })
      if (current.signal.aborted) return
      const parsed = parseMessageSplitSettings(response)
      setDraft(toDraft(parsed))
      setDirty(false)
      setSaved(save)
      if (save) callbacks.current.onFeedback(t('saved'))
    } catch (error) {
      if (!current.signal.aborted) {
        if (error instanceof HostApiError && error.code === 'QQ_MESSAGE_SPLIT_CONFLICT') setErrorKey('conflict')
        else if (error instanceof HostApiError && error.code === 'QQ_MESSAGE_SPLIT_CORRUPTED') setErrorKey('corrupted')
        else setErrorKey('error')
        setErrorDetail(error instanceof HostApiError ? error.message : null)
      }
    } finally {
      if (controller.current === current) {
        const wasSave = modeRef.current === 'save'
        controller.current = null
        modeRef.current = null
        if (wasSave) {
          actionLock.current = false
          callbacks.current.onBusy(false)
        }
        setPending(false)
      }
    }
  }

  useEffect(() => {
    if (busy && modeRef.current === 'read' && controller.current) {
      controller.current.abort()
      controller.current = null
      modeRef.current = null
      setPending(false)
      needsLoad.current = true
    }
  }, [busy])

  useEffect(() => {
    const activated = active && !previousActive.current
    if (activated && !dirty) needsLoad.current = true
    previousActive.current = active
    if (active && enabled && !dirty && !busy && !pending && !document.hidden && needsLoad.current) {
      void request(false)
    }
  }, [active, enabled, busy, dirty, pending])

  const stateRef = useRef({ active, enabled, dirty, busy, pending, request })
  stateRef.current = { active, enabled, dirty, busy, pending, request }

  useEffect(() => {
    const stop = () => {
      if (controller.current) {
        controller.current.abort()
        const wasSave = modeRef.current === 'save'
        controller.current = null
        modeRef.current = null
        setPending(false)
        if (wasSave) {
          actionLock.current = false
          callbacks.current.onBusy(false)
        } else {
          needsLoad.current = true
        }
      }
    }
    const onVisibilityChange = () => {
      const s = stateRef.current
      if (document.hidden) stop()
      else if (s.active && s.enabled && !s.dirty && !s.busy && !s.pending && needsLoad.current) void s.request(false)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      stop()
      callbacks.current.onDirtyChange?.(false)
    }
  }, [actionLock])

  function update(mutator: (current: DraftState) => DraftState) {
    setDraft(current => (current ? mutator(current) : current))
    setDirty(true)
    setSaved(false)
    if (errorKey !== 'conflict') {
      setErrorKey(null)
      setErrorDetail(null)
    }
  }

  function addPreset(preset: QQMessageSplitPreset) {
    if (!draft) return
    const presetName = t(`preset.${preset.id}.name` as keyof typeof zh)
    if (draft.rules.some(rule => samePresetSignature(rule, preset))) {
      callbacks.current.onFeedback(t('presetExists', { name: presetName }))
      return
    }
    if (draft.rules.length >= MAX_SPLIT_RULES) {
      callbacks.current.onFeedback(t('presetLimit', { max: MAX_SPLIT_RULES }))
      return
    }
    const nextRule: QQMessageSplitRule = {
      id: makeUniqueRuleId(`preset-${preset.id}`, draft.rules),
      name: presetName,
      enabled: true,
      pattern: preset.pattern,
      flags: preset.flags,
      delimiterMode: preset.delimiterMode,
    }
    update(current => ({
      ...current,
      enabled: current.rules.length === 0 ? true : current.enabled,
      rules: [...current.rules, nextRule],
    }))
    callbacks.current.onFeedback(t('presetAdded', { name: presetName }))
  }

  function applyRecommendedSet() {
    if (!draft) return
    const nextRules = [...draft.rules]
    for (const presetId of qqMessageSplitRecommendedPresetIds) {
      const preset = qqMessageSplitPresets.find(item => item.id === presetId)
      if (!preset) continue
      if (nextRules.some(rule => samePresetSignature(rule, preset))) continue
      if (nextRules.length >= MAX_SPLIT_RULES) break
      nextRules.push({
        id: makeUniqueRuleId(`preset-${preset.id}`, nextRules),
        name: t(`preset.${preset.id}.name` as keyof typeof zh),
        enabled: true,
        pattern: preset.pattern,
        flags: preset.flags,
        delimiterMode: preset.delimiterMode,
      })
    }
    update(current => ({ ...current, enabled: true, rules: nextRules }))
    callbacks.current.onFeedback(t('recommendedApplied'))
  }

  function addCustomRule() {
    if (!draft || draft.rules.length >= MAX_SPLIT_RULES) return
    const nextRule: QQMessageSplitRule = {
      id: makeUniqueRuleId('custom-rule', draft.rules),
      name: '',
      enabled: true,
      pattern: '',
      flags: '',
      delimiterMode: 'drop',
    }
    update(current => ({ ...current, rules: [...current.rules, nextRule] }))
  }

  function updateRule(index: number, patch: Partial<QQMessageSplitRule>) {
    update(current => ({
      ...current,
      rules: current.rules.map((rule, idx) => (idx === index ? { ...rule, ...patch } : rule)),
    }))
  }

  function toggleRuleFlag(index: number, flag: string) {
    update(current => ({
      ...current,
      rules: current.rules.map((rule, idx) => {
        if (idx !== index) return rule
        const hasFlag = rule.flags.includes(flag)
        const raw = hasFlag ? rule.flags.replace(flag, '') : `${rule.flags}${flag}`
        return { ...rule, flags: normalizeSplitFlags(raw) ?? '' }
      }),
    }))
  }

  function moveRule(index: number, delta: -1 | 1) {
    update(current => {
      const target = index + delta
      if (target < 0 || target >= current.rules.length) return current
      const next = [...current.rules]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved!)
      return { ...current, rules: next }
    })
  }

  function removeRule(index: number) {
    update(current => ({
      ...current,
      rules: current.rules.filter((_, idx) => idx !== index),
    }))
  }

  const blocked = busy || pending
  const conflict = errorKey === 'conflict'

  return (
    <section className="qq-message-split qq-subcard" aria-labelledby={`${prefix}-title`}>
      <div className="qq-subcard-header">
        <div className="section-heading">
          <h3 id={`${prefix}-title`}>{t('title')}</h3>
          <p>{t('description')}</p>
        </div>
        <span className={`qq-subcard-badge${dirty ? ' is-dirty' : ''}`}>
          {t(dirty ? 'badgeDirty' : 'badgeSaved')}
        </span>
      </div>
      <p className="qq-help qq-subcard-note">{t('independentNote')}</p>

      {draft && (
        <form
          className="form-fields"
          noValidate
          onSubmit={event => {
            event.preventDefault()
            void request(true)
          }}
        >
          <fieldset className="qq-fieldset" disabled={blocked || !enabled}>
            <div className="qq-switch-row">
              <Switch
                id={`${prefix}-enabled`}
                checked={draft.enabled}
                disabled={blocked || !enabled}
                reasonCode={blocked ? 'busy' : 'enable'}
                label={t('enabledLabel')}
                description={t('enabledHelp')}
                onChange={checked => update(current => ({ ...current, enabled: checked }))}
              />
            </div>

            <div className={`field${maxSegmentsError ? ' field-invalid' : ''}`}>
              <label htmlFor={`${prefix}-maxSegments`}>{t('maxSegmentsLabel')}</label>
              <input
                id={`${prefix}-maxSegments`}
                type="number"
                inputMode="numeric"
                min={MIN_SPLIT_SEGMENTS}
                max={MAX_SPLIT_SEGMENTS}
                step={1}
                value={draft.maxSegments}
                aria-invalid={Boolean(maxSegmentsError)}
                aria-describedby={`${prefix}-maxSegments-hint${maxSegmentsError ? ` ${prefix}-maxSegments-error` : ''}`}
                onChange={event => update(current => ({ ...current, maxSegments: event.target.value }))}
              />
              <p className="field-hint" id={`${prefix}-maxSegments-hint`}>
                {t('maxSegmentsHelp', { min: MIN_SPLIT_SEGMENTS, max: MAX_SPLIT_SEGMENTS })}
              </p>
              {maxSegmentsError && (
                <p className="field-error" id={`${prefix}-maxSegments-error`}>{maxSegmentsError}</p>
              )}
            </div>

            <div className={`field${delayMsError ? ' field-invalid' : ''}`}>
              <label htmlFor={`${prefix}-delayMs`}>{t('delayMsLabel')}</label>
              <div className="qq-split-delay-control">
                <input
                  id={`${prefix}-delayMs`}
                  type="number"
                  inputMode="numeric"
                  min={MIN_SPLIT_DELAY_MS}
                  max={MAX_SPLIT_DELAY_MS}
                  step={50}
                  value={draft.delayMs}
                  aria-invalid={Boolean(delayMsError)}
                  aria-describedby={`${prefix}-delayMs-hint${delayMsError ? ` ${prefix}-delayMs-error` : ''}`}
                  onChange={event => update(current => ({ ...current, delayMs: event.target.value }))}
                />
                <div className="qq-filter-pills" role="group" aria-label={t('delayMsLabel')}>
                  {DELAY_PRESETS.map(presetMs => (
                    <button
                      key={presetMs}
                      type="button"
                      className={`qq-filter-pill${draft.delayMs.trim() === String(presetMs) ? ' is-selected' : ''}`}
                      onClick={() => update(current => ({ ...current, delayMs: String(presetMs) }))}
                    >
                      {presetMs === 0 ? t('delayPresetZero') : `${presetMs} ms`}
                    </button>
                  ))}
                </div>
              </div>
              <p className="field-hint" id={`${prefix}-delayMs-hint`}>
                {t('delayMsHelp', { min: MIN_SPLIT_DELAY_MS, max: MAX_SPLIT_DELAY_MS })}
              </p>
              {delayMsError && (
                <p className="field-error" id={`${prefix}-delayMs-error`}>{delayMsError}</p>
              )}
            </div>

            <div className="qq-switch-row">
              <Switch
                id={`${prefix}-trimSegments`}
                checked={draft.trimSegments}
                disabled={blocked || !enabled}
                reasonCode={blocked ? 'busy' : 'enable'}
                label={t('trimSegmentsLabel')}
                description={t('trimSegmentsHelp')}
                onChange={checked => update(current => ({ ...current, trimSegments: checked }))}
              />
            </div>

            <div className="qq-split-section">
              <div className="qq-split-section-head">
                <div>
                  <h4>{t('presetsTitle')}</h4>
                  <p>{t('presetsHelp')}</p>
                </div>
                <ActionButton
                  type="button"
                  className="button button-secondary"
                  reasonCode={blocked ? 'busy' : 'enable'}
                  disabled={blocked || !enabled}
                  onClick={applyRecommendedSet}
                >
                  <Sparkles size={14} aria-hidden="true" />
                  {t('applyRecommended')}
                </ActionButton>
              </div>
              <div className="qq-split-presets">
                {qqMessageSplitPresets.map(preset => {
                  const alreadyAdded = draft.rules.some(rule => samePresetSignature(rule, preset))
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={`qq-split-preset-chip${alreadyAdded ? ' is-added' : ''}`}
                      onClick={() => addPreset(preset)}
                    >
                      <strong>{t(`preset.${preset.id}.name` as keyof typeof zh)}</strong>
                      <span>{t(`preset.${preset.id}.badge` as keyof typeof zh)}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="qq-split-section">
              <div className="qq-split-section-head">
                <div>
                  <h4>{t('rulesTitle')}</h4>
                  <p>{t('rulesCount', { count: draft.rules.length, max: MAX_SPLIT_RULES })}</p>
                </div>
                <div className="qq-split-rules-actions">
                  {draft.rules.length > 0 && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => update(current => ({ ...current, rules: [] }))}
                    >
                      {t('clearRules')}
                    </button>
                  )}
                  <ActionButton
                    type="button"
                    className="button button-secondary"
                    reasonCode={blocked ? 'busy' : 'enable'}
                    disabled={blocked || !enabled || draft.rules.length >= MAX_SPLIT_RULES}
                    onClick={addCustomRule}
                  >
                    <Plus size={14} aria-hidden="true" />
                    {t('addRule')}
                  </ActionButton>
                </div>
              </div>

              {draft.rules.length === 0 ? (
                <p className="qq-split-empty">{t('emptyRules')}</p>
              ) : (
                <ol className="qq-split-rule-list">
                  {draft.rules.map((rule, index) => {
                    const patternError = ruleErrors[rule.id]
                    return (
                      <li key={rule.id} className={`qq-split-rule-card${rule.enabled ? '' : ' is-disabled'}`}>
                        <div className="qq-split-rule-head">
                          <div className="qq-split-rule-title">
                            <span className="qq-segment-badge">{t('ruleIndex', { index: index + 1 })}</span>
                            <label className="qq-split-rule-toggle">
                              <input
                                type="checkbox"
                                checked={rule.enabled}
                                onChange={event => updateRule(index, { enabled: event.target.checked })}
                              />
                              <span>{t('ruleEnabled')}</span>
                            </label>
                            <input
                              type="text"
                              className="qq-split-rule-name"
                              aria-label={t('ruleNameLabel')}
                              placeholder={t('ruleNamePlaceholder')}
                              maxLength={MAX_SPLIT_RULE_NAME_LENGTH}
                              value={rule.name}
                              onChange={event => updateRule(index, { name: event.target.value })}
                            />
                          </div>
                          <div className="qq-segment-row-controls">
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={t('moveUp')}
                              disabled={index === 0}
                              onClick={() => moveRule(index, -1)}
                            >
                              <ArrowUp size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={t('moveDown')}
                              disabled={index === draft.rules.length - 1}
                              onClick={() => moveRule(index, 1)}
                            >
                              <ArrowDown size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={t('removeRule')}
                              onClick={() => removeRule(index)}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                            </button>
                          </div>
                        </div>

                        <div className="qq-split-rule-body">
                          <div className={`qq-split-field${patternError ? ' is-invalid' : ''}`}>
                            <label htmlFor={`${prefix}-rule-${rule.id}-pattern`}>{t('rulePatternLabel')}</label>
                            <input
                              id={`${prefix}-rule-${rule.id}-pattern`}
                              type="text"
                              className="qq-split-pattern-input"
                              placeholder={t('rulePatternPlaceholder')}
                              maxLength={MAX_SPLIT_PATTERN_LENGTH}
                              autoComplete="off"
                              spellCheck={false}
                              value={rule.pattern}
                              aria-invalid={Boolean(patternError)}
                              onChange={event => updateRule(index, { pattern: event.target.value })}
                            />
                            {patternError && <p className="field-error">{patternError}</p>}
                          </div>

                          <div className="qq-split-field">
                            <label htmlFor={`${prefix}-rule-${rule.id}-mode`}>{t('ruleModeLabel')}</label>
                            <select
                              id={`${prefix}-rule-${rule.id}-mode`}
                              value={rule.delimiterMode}
                              onChange={event => updateRule(index, { delimiterMode: event.target.value as QQMessageSplitDelimiterMode })}
                            >
                              {SPLIT_DELIMITER_MODES.map(mode => (
                                <option key={mode} value={mode}>
                                  {t(`mode.${mode}` as keyof typeof zh)}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <div className="qq-split-flags" role="group" aria-label={t('ruleFlagsLabel')}>
                          <span className="qq-split-flags-label">{t('ruleFlagsLabel')}</span>
                          {FLAG_OPTIONS.map(flag => {
                            const activeFlag = rule.flags.includes(flag)
                            return (
                              <button
                                key={flag}
                                type="button"
                                className={`qq-filter-pill${activeFlag ? ' is-selected' : ''}`}
                                aria-pressed={activeFlag}
                                onClick={() => toggleRuleFlag(index, flag)}
                              >
                                {t(`flag.${flag}` as keyof typeof zh)}
                              </button>
                            )
                          })}
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>
          </fieldset>

          <div className="qq-split-section qq-split-preview">
            <div className="qq-split-section-head">
              <div>
                <h4>{t('previewTitle')}</h4>
                <p>{t('previewHelp')}</p>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  sampleEdited.current = false
                  setSampleText(t('previewDefaultText'))
                }}
              >
                <RotateCcw size={13} aria-hidden="true" />
                {t('previewReset')}
              </button>
            </div>
            <div className="qq-split-preview-grid">
              <div className="qq-split-field">
                <label htmlFor={`${prefix}-preview-input`}>{t('previewInputLabel')}</label>
                <textarea
                  id={`${prefix}-preview-input`}
                  className="qq-split-preview-textarea"
                  rows={5}
                  value={sampleText}
                  onChange={event => {
                    sampleEdited.current = true
                    setSampleText(event.target.value)
                  }}
                />
              </div>
              <div className="qq-split-preview-output" aria-live="polite">
                {!draft.enabled && <p className="qq-split-preview-note">{t('previewDisabledHint')}</p>}
                {!sampleText ? (
                  <p className="qq-help">{t('previewEmptyInput')}</p>
                ) : preview && preview.appliedRules === 0 ? (
                  <p className="qq-help">{t('previewNoActiveRules')}</p>
                ) : preview ? (
                  <>
                    <div className="qq-split-preview-summary">
                      <strong>
                        {preview.parts.length > 1
                          ? t('previewCount', { count: preview.parts.length })
                          : t('previewSingle')}
                      </strong>
                    </div>
                    {preview.invalidRuleIds.length > 0 && (
                      <p className="qq-split-preview-warn">{t('previewInvalidNotice')}</p>
                    )}
                    {preview.truncated && (
                      <p className="qq-split-preview-note">
                        {t('previewTruncated', { max: !maxSegmentsError ? parsedMaxSegments : 8 })}
                      </p>
                    )}
                    {preview.fallbackToOriginal && (
                      <p className="qq-split-preview-note">{t('previewFallback')}</p>
                    )}
                    <ol className="qq-split-bubble-list">
                      {preview.parts.map((part, idx) => (
                        <li key={`${idx}-${part.slice(0, 16)}`} className="qq-split-bubble">
                          <span className="qq-split-bubble-index">{idx + 1}</span>
                          <span className="qq-split-bubble-text">{part}</span>
                        </li>
                      ))}
                    </ol>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <FormSaveBar
            alwaysVisible
            dirty={dirty}
            saving={pending}
            disabled={!enabled || blocked || conflict}
            disabledReason={blocked ? undefined : !enabled ? t('disabledReason') : conflict ? t('conflict') : undefined}
            conflict={conflict}
            saveLabel={t('save')}
            savingLabel={t('saving')}
            reloadLabel={t('read')}
            onSave={() => void request(true)}
            onReload={() => void request(false)}
            extraActions={!conflict ? (
              <ActionButton
                type="button"
                className="button button-secondary"
                disabled={!enabled || blocked}
                reasonCode={blocked ? 'busy' : 'enable'}
                onClick={() => void request(false)}
              >
                {t('read')}
              </ActionButton>
            ) : undefined}
          />
        </form>
      )}

      {!draft && (
        <ActionButton
          type="button"
          className="button button-secondary"
          disabled={!enabled || blocked}
          reasonCode={blocked ? 'busy' : 'enable'}
          onClick={() => void request(false)}
        >
          {t('read')}
        </ActionButton>
      )}
      {errorKey && (
        <p className="qq-error" role="alert">
          {t(errorKey)}
          {errorDetail && errorKey === 'error' ? ` (${errorDetail})` : ''}
        </p>
      )}
      {saved && <p className="qq-operation-result" role="status">{t('saved')}</p>}
    </section>
  )
}
