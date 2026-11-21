import { useEffect, useId, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Code2, ListChecks, Plus, Trash2, X } from 'lucide-react'
import { ActionButton } from './action-button.js'
import { useI18n } from './i18n.js'
import './structured-inputs.css'

export function splitTagTokens(raw: string, mode: 'line-or-comma' | 'line-comma-space' = 'line-or-comma'): readonly string[] {
  const splitter = mode === 'line-comma-space' ? /[\r\n,，;；\s]+/ : /[\r\n,，;；]+/
  return raw.split(splitter).map(part => part.trim()).filter(Boolean)
}

export function mergeUniqueTags(
  current: readonly string[],
  incoming: readonly string[],
  allowDuplicates = false,
  maxItems?: number,
): readonly string[] {
  const next = [...current]
  for (const raw of incoming) {
    const item = raw.trim()
    if (!item) continue
    if (!allowDuplicates && next.includes(item)) continue
    if (maxItems !== undefined && next.length >= maxItems) break
    next.push(item)
  }
  return next
}

export interface TagChipsInputProps {
  readonly id?: string
  readonly values: readonly string[]
  readonly onChange: (next: readonly string[]) => void
  readonly validateItem?: (item: string) => string | null
  readonly suggestions?: readonly { readonly label: string; readonly count?: number }[]
  readonly placeholder?: string
  readonly addLabel?: string
  readonly allowDuplicates?: boolean
  readonly delimiter?: 'line-or-comma' | 'line-comma-space'
  readonly commitOnEdit?: boolean
  readonly disabled?: boolean
  readonly maxItems?: number
  readonly className?: string
  readonly onPendingInputChange?: (pendingText: string) => void
  readonly 'aria-label'?: string
  readonly 'aria-describedby'?: string
}

export function TagChipsInput({
  id,
  values,
  onChange,
  validateItem,
  suggestions = [],
  placeholder,
  addLabel,
  allowDuplicates = false,
  delimiter = 'line-or-comma',
  commitOnEdit = true,
  disabled = false,
  maxItems,
  className,
  onPendingInputChange,
  ...aria
}: TagChipsInputProps) {
  const { t } = useI18n('common')
  const generatedId = useId()
  const inputId = id ?? `eating-tags-${generatedId}`
  const [draft, setDraft] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const composing = useRef(false)

  function updateDraft(next: string): void {
    setDraft(next)
    onPendingInputChange?.(next)
  }

  function commitText(raw: string): void {
    const tokens = splitTagTokens(raw, delimiter)
    if (tokens.length === 0) {
      updateDraft('')
      setLocalError(null)
      return
    }
    if (!allowDuplicates && tokens.length === 1 && values.includes(tokens[0]!)) {
      setLocalError(t('structured.duplicate', { item: tokens[0] }))
      return
    }
    if (maxItems !== undefined && values.length >= maxItems) {
      setLocalError(t('structured.limitReached', { max: maxItems }))
      return
    }
    onChange(mergeUniqueTags(values, tokens, allowDuplicates, maxItems))
    updateDraft('')
    setLocalError(null)
  }

  const chipErrors = values
    .map(item => ({ item, error: validateItem ? validateItem(item) : null }))
    .filter((entry): entry is { item: string; error: string } => Boolean(entry.error))

  const unusedSuggestions = suggestions.filter(item => !values.includes(item.label))

  return (
    <div className={`eating-structured${className ? ` ${className}` : ''}`}>
      <div className="eating-chips-entry">
        <input
          id={inputId}
          type="text"
          value={draft}
          disabled={disabled}
          placeholder={placeholder ?? t('structured.inputPlaceholder')}
          aria-label={aria['aria-label']}
          aria-describedby={aria['aria-describedby']}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={event => { composing.current = false; updateDraft(event.currentTarget.value) }}
          onChange={event => {
            const next = event.target.value
            const hasDelimiter = delimiter === 'line-comma-space' ? /[\r\n,，;；\s]/.test(next) : /[\r\n,，;；]/.test(next)
            if (commitOnEdit && !composing.current && hasDelimiter) commitText(next)
            else { updateDraft(next); setLocalError(null) }
          }}
          onPaste={event => {
            const pasted = event.clipboardData.getData('text')
            const hasMulti = delimiter === 'line-comma-space' ? /[\r\n,，;；\s]/.test(pasted) : /[\r\n,，;；]/.test(pasted)
            if (hasMulti) {
              event.preventDefault()
              const start = event.currentTarget.selectionStart ?? draft.length
              const end = event.currentTarget.selectionEnd ?? start
              if (commitOnEdit) commitText(`${draft} ${pasted}`.trim())
              else if (!draft.trim() || start === 0 && end === draft.length) commitText(pasted)
              else {
                updateDraft(draft.slice(0, start) + pasted.replace(/[\r\n]+/g, ',') + draft.slice(end))
                setLocalError(null)
              }
            }
          }}
          onKeyDown={event => {
            if (composing.current || event.nativeEvent.isComposing) return
            if (event.key === 'Enter') {
              event.preventDefault()
              commitText(draft)
            } else if (event.key === 'Backspace' && draft === '' && values.length > 0 && !disabled) {
              onChange(values.slice(0, -1))
            }
          }}
          onBlur={() => {
            if (commitOnEdit && !composing.current && draft.trim()) commitText(draft)
          }}
        />
        <button
          type="button"
          className="button button-secondary eating-chips-add"
          disabled={disabled || !draft.trim()}
          onMouseDown={event => event.preventDefault()}
          onClick={() => commitText(draft)}>
          <Plus size={14} aria-hidden="true" />
          {addLabel ?? t('structured.addItem')}
        </button>
      </div>
      {values.length > 0 && (
        <ul className="eating-chip-list">
          {values.map((item, index) => {
            const itemError = validateItem ? validateItem(item) : null
            return (
              <li key={`${item}-${index}`} className={`eating-chip${itemError ? ' is-invalid' : ''}`} title={itemError ?? undefined}>
                <span>{item}</span>
                <button
                  type="button"
                  className="eating-chip-remove"
                  disabled={disabled}
                  aria-label={t('structured.removeItem', { item })}
                  onClick={() => onChange(values.filter((_, i) => i !== index))}>
                  <X size={13} aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {unusedSuggestions.length > 0 && !disabled && (
        <div className="eating-chip-suggestions">
          {unusedSuggestions.map(suggestion => (
            <button
              key={suggestion.label}
              type="button"
              className="eating-chip-suggestion"
              onClick={() => onChange(mergeUniqueTags(values, [suggestion.label], allowDuplicates, maxItems))}>
              + {suggestion.label}{suggestion.count !== undefined ? ` (${suggestion.count})` : ''}
            </button>
          ))}
        </div>
      )}
      {localError && <p className="eating-structured-error" role="status">{localError}</p>}
      {chipErrors.length > 0 && (
        <p className="eating-structured-error" role="alert">
          {chipErrors[0]!.item}: {chipErrors[0]!.error}
        </p>
      )}
    </div>
  )
}

export type KvValueType = 'string' | 'number' | 'boolean' | 'json'

export interface KvEntry {
  readonly id: number
  readonly key: string
  readonly type: KvValueType
  readonly textValue: string
  readonly boolValue: boolean
}

export function parseKeyValueObject(jsonText: string): { readonly ok: true; readonly entries: readonly KvEntry[] } | { readonly ok: false; readonly errorKey: string } {
  const trimmed = jsonText.trim()
  if (!trimmed) return { ok: true, entries: [] }
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return { ok: false, errorKey: 'structured.jsonInvalidObject' } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, errorKey: 'structured.jsonInvalidObject' }
  const entries = Object.entries(parsed as Record<string, unknown>).map(([key, value], index) => {
    if (typeof value === 'boolean') return { id: index + 1, key, type: 'boolean' as const, textValue: String(value), boolValue: value }
    if (typeof value === 'number') return { id: index + 1, key, type: 'number' as const, textValue: String(value), boolValue: false }
    if (typeof value === 'string') return { id: index + 1, key, type: 'string' as const, textValue: value, boolValue: false }
    return { id: index + 1, key, type: 'json' as const, textValue: JSON.stringify(value), boolValue: false }
  })
  return { ok: true, entries }
}

export function serializeKeyValueRows(rows: readonly KvEntry[], emptyOutput: '' | '{}' = ''): string {
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    if (row.type === 'boolean') out[key] = row.boolValue
    else if (row.type === 'number') {
      const n = Number(row.textValue.trim())
      out[key] = row.textValue.trim() && Number.isFinite(n) ? n : row.textValue
    } else if (row.type === 'json') {
      try { out[key] = JSON.parse(row.textValue) } catch { out[key] = row.textValue }
    } else {
      out[key] = row.textValue
    }
  }
  return Object.keys(out).length === 0 ? emptyOutput : JSON.stringify(out, null, 2)
}

export interface KeyValueSuggestion {
  readonly key: string
  readonly defaultValue: string
  readonly type?: KvValueType
  readonly label?: string
}

export interface KeyValuePairsEditorProps {
  readonly id?: string
  readonly jsonText: string
  readonly onJsonTextChange: (next: string) => void
  readonly reservedKeys?: readonly string[]
  readonly suggestions?: readonly KeyValueSuggestion[]
  readonly emptyOutput?: '' | '{}'
  readonly disabled?: boolean
  readonly 'aria-label'?: string
}

export function KeyValuePairsEditor({
  id,
  jsonText,
  onJsonTextChange,
  reservedKeys = [],
  suggestions = [],
  emptyOutput = '',
  disabled = false,
  ...aria
}: KeyValuePairsEditorProps) {
  const { t } = useI18n('common')
  const generatedId = useId()
  const editorId = id ?? `eating-kv-${generatedId}`
  const nextRowId = useRef(100)
  const parsed = parseKeyValueObject(jsonText)
  const [mode, setMode] = useState<'visual' | 'json'>(() => (parsed.ok ? 'visual' : 'json'))
  const [rows, setRows] = useState<readonly KvEntry[]>(() => (parsed.ok ? parsed.entries : []))

  useEffect(() => {
    if (mode === 'json') {
      const next = parseKeyValueObject(jsonText)
      if (next.ok) setRows(next.entries)
      return
    }
    const serialized = serializeKeyValueRows(rows, emptyOutput)
    const next = parseKeyValueObject(jsonText)
    if (!next.ok) {
      setMode('json')
      return
    }
    const incomingCanonical = serializeKeyValueRows(next.entries, emptyOutput)
    if (incomingCanonical !== serialized) {
      setRows(next.entries.map(item => ({ ...item, id: ++nextRowId.current })))
    }
    // Synchronize external resets without losing uncommitted empty key rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jsonText, mode, emptyOutput])

  function updateRows(nextRows: readonly KvEntry[]): void {
    setRows(nextRows)
    onJsonTextChange(serializeKeyValueRows(nextRows, emptyOutput))
  }

  const seenKeys = new Map<string, number>()
  for (const row of rows) {
    const trimmed = row.key.trim()
    if (trimmed) seenKeys.set(trimmed, (seenKeys.get(trimmed) ?? 0) + 1)
  }

  const visualBlockedReason = !parsed.ok ? t(parsed.errorKey) : undefined

  return (
    <div className="eating-structured">
      <div className="eating-mode-bar">
        <div className="eating-mode-toggle" role="group">
          <ActionButton
            type="button"
            className={`eating-mode-btn${mode === 'visual' ? ' is-selected' : ''}`}
            disabled={!parsed.ok}
            reason={visualBlockedReason}
            aria-pressed={mode === 'visual'}
            onClick={() => {
              const latest = parseKeyValueObject(jsonText)
              if (latest.ok) {
                setRows(latest.entries.map(item => ({ ...item, id: ++nextRowId.current })))
                setMode('visual')
              }
            }}>
            <ListChecks size={14} aria-hidden="true" />
            {t('structured.modeVisual')}
          </ActionButton>
          <button
            type="button"
            className={`eating-mode-btn${mode === 'json' ? ' is-selected' : ''}`}
            aria-pressed={mode === 'json'}
            onClick={() => setMode('json')}>
            <Code2 size={14} aria-hidden="true" />
            {t('structured.modeJson')}
          </button>
        </div>
        {mode === 'visual' && (
          <button
            type="button"
            className="button button-secondary eating-structured-add-btn"
            disabled={disabled}
            onClick={() => updateRows([...rows, { id: ++nextRowId.current, key: '', type: 'string', textValue: '', boolValue: false }])}>
            <Plus size={14} aria-hidden="true" />
            {t('structured.kvAdd')}
          </button>
        )}
      </div>

      {mode === 'visual' ? (
        <div id={editorId} className="eating-kv-list" aria-label={aria['aria-label']}>
          {rows.map(row => {
            const keyTrimmed = row.key.trim()
            let rowError: string | null = null
            if (!keyTrimmed && (row.textValue.trim() || row.type === 'boolean')) rowError = t('structured.kvKeyRequired')
            else if (keyTrimmed && reservedKeys.includes(keyTrimmed)) rowError = t('structured.kvKeyReserved', { key: keyTrimmed })
            else if (keyTrimmed && (seenKeys.get(keyTrimmed) ?? 0) > 1) rowError = t('structured.kvKeyDuplicate', { key: keyTrimmed })
            else if (row.type === 'number' && (!row.textValue.trim() || !Number.isFinite(Number(row.textValue.trim())))) rowError = t('structured.kvInvalidNumber')
            else if (row.type === 'json') {
              try { JSON.parse(row.textValue) } catch { rowError = t('structured.kvInvalidJson') }
            }
            return (
              <div key={row.id} className="eating-kv-item">
                <div className="eating-kv-row">
                  <input
                    type="text"
                    value={row.key}
                    disabled={disabled}
                    placeholder={t('structured.kvKeyPlaceholder')}
                    aria-label={t('structured.kvKeyPlaceholder')}
                    onChange={event => updateRows(rows.map(item => (item.id === row.id ? { ...item, key: event.target.value } : item)))}
                  />
                  <select
                    value={row.type}
                    disabled={disabled}
                    aria-label={t('structured.kvTypeString')}
                    onChange={event => {
                      const nextType = event.target.value as KvValueType
                      updateRows(rows.map(item => (item.id === row.id ? { ...item, type: nextType } : item)))
                    }}>
                    <option value="string">{t('structured.kvTypeString')}</option>
                    <option value="number">{t('structured.kvTypeNumber')}</option>
                    <option value="boolean">{t('structured.kvTypeBoolean')}</option>
                    <option value="json">{t('structured.kvTypeJson')}</option>
                  </select>
                  {row.type === 'boolean' ? (
                    <label className="eating-kv-bool">
                      <input
                        type="checkbox"
                        checked={row.boolValue}
                        disabled={disabled}
                        onChange={event => updateRows(rows.map(item => (item.id === row.id ? { ...item, boolValue: event.target.checked } : item)))}
                      />
                      <span>{row.boolValue ? 'true' : 'false'}</span>
                    </label>
                  ) : (
                    <input
                      type="text"
                      value={row.textValue}
                      disabled={disabled}
                      placeholder={t('structured.kvValuePlaceholder')}
                      aria-label={t('structured.kvValuePlaceholder')}
                      onChange={event => updateRows(rows.map(item => (item.id === row.id ? { ...item, textValue: event.target.value } : item)))}
                    />
                  )}
                  <button
                    type="button"
                    className="icon-button eating-kv-remove"
                    disabled={disabled}
                    aria-label={t('structured.kvRemove')}
                    onClick={() => updateRows(rows.filter(item => item.id !== row.id))}>
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </div>
                {rowError && <p className="eating-structured-error" role="alert">{rowError}</p>}
              </div>
            )
          })}
          {suggestions.length > 0 && !disabled && (
            <div className="eating-chip-suggestions">
              <span className="eating-suggestions-label">{t('structured.kvSuggestions')}</span>
              {suggestions.map(suggestion => {
                const active = rows.some(row => row.key.trim() === suggestion.key)
                return (
                  <button
                    key={suggestion.key}
                    type="button"
                    disabled={active}
                    className={`eating-chip-suggestion${active ? ' is-used' : ''}`}
                    onClick={() => updateRows([
                      ...rows,
                      {
                        id: ++nextRowId.current,
                        key: suggestion.key,
                        type: suggestion.type ?? 'string',
                        textValue: suggestion.defaultValue,
                        boolValue: suggestion.defaultValue === 'true',
                      },
                    ])}>
                    + {suggestion.label ?? `${suggestion.key}=${suggestion.defaultValue}`}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="eating-structured-json-wrap">
          <textarea
            id={editorId}
            className="eating-structured-textarea"
            value={jsonText}
            disabled={disabled}
            rows={5}
            spellCheck={false}
            aria-label={aria['aria-label']}
            onChange={event => onJsonTextChange(event.target.value)}
          />
          {!parsed.ok && <p className="eating-structured-error" role="alert">{t(parsed.errorKey)}</p>}
        </div>
      )}
    </div>
  )
}

export function parseStringArrayJson(jsonText: string): { readonly ok: true; readonly items: readonly string[] } | { readonly ok: false } {
  const trimmed = jsonText.trim()
  if (!trimmed) return { ok: true, items: [] }
  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) return { ok: false }
    return { ok: true, items: parsed }
  } catch {
    return { ok: false }
  }
}

export interface StringListPreset {
  readonly label: string
  readonly items: readonly string[]
}

export interface StringListEditorProps {
  readonly id?: string
  readonly jsonText: string
  readonly onJsonTextChange: (next: string) => void
  readonly presets?: readonly StringListPreset[]
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly 'aria-label'?: string
}

export function StringListEditor({
  id,
  jsonText,
  onJsonTextChange,
  presets = [],
  placeholder,
  disabled = false,
  ...aria
}: StringListEditorProps) {
  const { t } = useI18n('common')
  const generatedId = useId()
  const editorId = id ?? `eating-strlist-${generatedId}`
  const parsed = parseStringArrayJson(jsonText)
  const [mode, setMode] = useState<'visual' | 'json'>(() => (parsed.ok ? 'visual' : 'json'))
  const [draftArg, setDraftArg] = useState('')

  useEffect(() => {
    if (!parsed.ok && mode === 'visual') setMode('json')
  }, [parsed.ok, mode])

  function setItems(next: readonly string[]): void {
    onJsonTextChange(JSON.stringify(next))
  }

  function appendArg(): void {
    const value = draftArg.trim()
    if (!value || !parsed.ok) return
    setItems([...parsed.items, value])
    setDraftArg('')
  }

  return (
    <div className="eating-structured">
      <div className="eating-mode-bar">
        <div className="eating-mode-toggle" role="group">
          <ActionButton
            type="button"
            className={`eating-mode-btn${mode === 'visual' ? ' is-selected' : ''}`}
            disabled={!parsed.ok}
            reason={!parsed.ok ? t('structured.jsonInvalidArray') : undefined}
            aria-pressed={mode === 'visual'}
            onClick={() => setMode('visual')}>
            <ListChecks size={14} aria-hidden="true" />
            {t('structured.modeVisual')}
          </ActionButton>
          <button
            type="button"
            className={`eating-mode-btn${mode === 'json' ? ' is-selected' : ''}`}
            aria-pressed={mode === 'json'}
            onClick={() => setMode('json')}>
            <Code2 size={14} aria-hidden="true" />
            {t('structured.modeJson')}
          </button>
        </div>
      </div>

      {mode === 'visual' && parsed.ok ? (
        <div className="eating-strlist">
          {parsed.items.length > 0 && (
            <ul className="eating-strlist-items">
              {parsed.items.map((item, index) => (
                <li key={index} className="eating-strlist-row">
                  <span className="eating-strlist-index">#{index}</span>
                  <input
                    type="text"
                    value={item}
                    disabled={disabled}
                    aria-label={`${aria['aria-label'] ?? 'arg'} #${index}`}
                    onChange={event => setItems(parsed.items.map((current, i) => (i === index ? event.target.value : current)))}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    disabled={disabled || index === 0}
                    aria-label={t('structured.listMoveUp')}
                    onClick={() => {
                      const copy = [...parsed.items]
                      ;[copy[index - 1], copy[index]] = [copy[index]!, copy[index - 1]!]
                      setItems(copy)
                    }}>
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={disabled || index === parsed.items.length - 1}
                    aria-label={t('structured.listMoveDown')}
                    onClick={() => {
                      const copy = [...parsed.items]
                      ;[copy[index + 1], copy[index]] = [copy[index]!, copy[index + 1]!]
                      setItems(copy)
                    }}>
                    <ArrowDown size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button eating-kv-remove"
                    disabled={disabled}
                    aria-label={t('structured.removeItem', { item })}
                    onClick={() => setItems(parsed.items.filter((_, i) => i !== index))}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="eating-chips-entry">
            <input
              id={editorId}
              type="text"
              value={draftArg}
              disabled={disabled}
              placeholder={placeholder ?? t('structured.listAdd')}
              aria-label={aria['aria-label']}
              onChange={event => setDraftArg(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  appendArg()
                }
              }}
            />
            <button
              type="button"
              className="button button-secondary eating-chips-add"
              disabled={disabled || !draftArg.trim()}
              onClick={appendArg}>
              <Plus size={14} aria-hidden="true" />
              {t('structured.addItem')}
            </button>
          </div>
          {presets.length > 0 && !disabled && (
            <div className="eating-chip-suggestions">
              <span className="eating-suggestions-label">{t('structured.listPresets')}</span>
              {presets.map(preset => (
                <button
                  key={preset.label}
                  type="button"
                  className="eating-chip-suggestion"
                  onClick={() => setItems(preset.items)}>
                  {preset.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="eating-structured-json-wrap">
          <textarea
            id={editorId}
            className="eating-structured-textarea"
            value={jsonText}
            disabled={disabled}
            rows={4}
            spellCheck={false}
            aria-label={aria['aria-label']}
            onChange={event => onJsonTextChange(event.target.value)}
          />
          {!parsed.ok && <p className="eating-structured-error" role="alert">{t('structured.jsonInvalidArray')}</p>}
        </div>
      )}
    </div>
  )
}
