import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CheckCircle2, Code2, ListChecks, RefreshCw, Sparkles } from 'lucide-react'
import { ActionButton, FormSaveBar, InlineConfirm, KeyValuePairsEditor, useI18n } from '@eating/ui-sdk'
import type { ImageRequestParameters, ImageRequestParametersConfiguration } from '../types'
import { DEFAULT_REQUEST_PARAMETERS, parseRequestParameters, REQUEST_PARAMETERS_MAX_BYTES } from '../request-parameters'
import { errorTextFrom, manage, readRequestParameters } from './data'
import { it } from './i18n'

const RESERVED_KEYS = [
  'model', 'prompt', 'n', 'image', 'image_url', 'images', 'mask', 'source',
  'size', 'quality', 'response_format', 'stream', 'partial_images', 'request_id',
  'api_key', 'apikey', 'authorization', 'headers', 'base_url', 'baseurl', 'endpoint', 'url',
]

export function RequestParameters({
  enabled,
  blocked,
  onDirtyChange,
  onReadyChange,
}: {
  readonly enabled: boolean
  readonly blocked: boolean
  readonly onDirtyChange: (dirty: boolean) => void
  readonly onReadyChange: (ready: boolean) => void
}) {
  const { t } = useI18n('image-generation')
  const id = useId()
  const [configuration, setConfiguration] = useState<ImageRequestParametersConfiguration | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'json' | 'visual'>('json')
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [formattedOk, setFormattedOk] = useState(false)
  const [saved, setSaved] = useState(false)
  const [discard, setDiscard] = useState(false)

  const dirtyRef = useRef(false)
  const mounted = useRef(false)
  const enabledRef = useRef(enabled)
  const action = useRef<AbortController | null>(null)
  const saving = useRef(false)
  const discardHostRef = useRef<HTMLDivElement | null>(null)
  const callbacks = useRef({ onDirtyChange, onReadyChange })

  enabledRef.current = enabled
  callbacks.current = { onDirtyChange, onReadyChange }

  function edit(value: string) {
    setDraft(value)
    dirtyRef.current = true
    setDirty(true)
    setSaved(false)
    setFormattedOk(false)
    setFailure(null)
    callbacks.current.onDirtyChange(true)
  }

  function accept(value: ImageRequestParametersConfiguration) {
    setConfiguration(value)
    setDraft(JSON.stringify(value.parameters, null, 2))
    setFailure(null)
    setFormattedOk(false)
    setConflict(false)
    dirtyRef.current = false
    setDirty(false)
    setDiscard(false)
    callbacks.current.onDirtyChange(false)
    callbacks.current.onReadyChange(true)
  }

  const load = useCallback(async (force = false) => {
    if (!enabledRef.current || document.hidden || saving.current) return
    action.current?.abort()
    const controller = new AbortController()
    action.current = controller
    setBusy(true)
    try {
      const result = readRequestParameters(await manage('request-parameters', {}, controller.signal))
      if (!mounted.current || controller.signal.aborted || !enabledRef.current || (dirtyRef.current && !force)) return
      accept(result)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && enabledRef.current) {
        setFailure(errorTextFrom(error, it('common.loadFailed')))
        callbacks.current.onReadyChange(false)
      }
    } finally {
      if (action.current === controller) {
        action.current = null
        if (mounted.current) setBusy(false)
      }
    }
  }, [])

  function validateAndFormat(): ImageRequestParameters | null {
    try {
      const parsed = parseRequestParameters(JSON.parse(draft))
      const pretty = JSON.stringify(parsed, null, 2)
      if (pretty !== draft) {
        edit(pretty)
      }
      setFailure(null)
      setFormattedOk(true)
      return parsed
    } catch {
      setFormattedOk(false)
      setFailure(it('parameters.invalid'))
      return null
    }
  }

  async function save() {
    if (!enabledRef.current || !configuration || saving.current || blocked || !dirtyRef.current) return
    let parameters: ImageRequestParameters
    try {
      parameters = parseRequestParameters(JSON.parse(draft))
    } catch {
      setFormattedOk(false)
      setFailure(it('parameters.invalid'))
      return
    }
    saving.current = true
    setBusy(true)
    setSaved(false)
    setFormattedOk(false)
    setFailure(null)
    action.current?.abort()
    const controller = new AbortController()
    action.current = controller
    try {
      const result = readRequestParameters(await manage('save-request-parameters', { expectedRevision: configuration.revision, parameters }, controller.signal))
      if (result.revision !== configuration.revision + 1) throw new Error('Unexpected request parameter revision')
      if (!mounted.current || controller.signal.aborted) return
      accept(result)
      setSaved(true)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        const message = errorTextFrom(error, it('parameters.unknown'))
        setFailure(message)
        if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'IMAGE_REQUEST_PARAMETERS_CONFLICT') {
          setConflict(true)
        }
      }
    } finally {
      saving.current = false
      if (action.current === controller) {
        action.current = null
        if (mounted.current) setBusy(false)
      }
    }
  }

  useEffect(() => {
    mounted.current = true
    const visibility = () => {
      if (document.hidden) {
        action.current?.abort()
        action.current = null
        if (mounted.current) setBusy(false)
      } else if (enabledRef.current) {
        void load()
      }
    }
    const pagehide = () => action.current?.abort()
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', pagehide)
    return () => {
      mounted.current = false
      action.current?.abort()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', pagehide)
    }
  }, [load])

  useEffect(() => {
    if (!enabled) {
      action.current?.abort()
      action.current = null
      setBusy(false)
      setDiscard(false)
      setFailure(null)
      setFormattedOk(false)
      callbacks.current.onReadyChange(false)
      return
    }
    void load()
  }, [enabled, load])

  useEffect(() => {
    if (!discard) return
    requestAnimationFrame(() => {
      discardHostRef.current?.querySelector('button')?.focus()
    })
  }, [discard])

  return (
    <section
      className="image-block image-parameters"
      aria-labelledby={`${id}-heading`}
      onKeyDown={event => {
        if (event.key === 'Escape' && discard) {
          event.stopPropagation()
          setDiscard(false)
        }
      }}>
      <div className="image-block-heading">
        <div>
          <h3 id={`${id}-heading`}>{t('parameters.label')}</h3>
          <p>{t('parameters.help')}</p>
        </div>
      </div>

      {!enabled ? (
        <p className="image-hint">{t('config.disabledParameters')}</p>
      ) : (
        <form className="image-form" onSubmit={event => { event.preventDefault(); void save() }}>
          <div className="image-parameters-toolbar">
            <div className="image-mode-toggle" role="group" aria-label={t('parameters.label')}>
              <button
                type="button"
                className={`image-mode-btn${mode === 'json' ? ' is-selected' : ''}`}
                aria-pressed={mode === 'json'}
                onClick={() => setMode('json')}>
                <Code2 size={14} aria-hidden="true" />
                {t('parameters.modeJson')}
              </button>
              <button
                type="button"
                className={`image-mode-btn${mode === 'visual' ? ' is-selected' : ''}`}
                aria-pressed={mode === 'visual'}
                onClick={() => setMode('visual')}>
                <ListChecks size={14} aria-hidden="true" />
                {t('parameters.modeVisual')}
              </button>
            </div>
            <div className="image-preset-chips">
              <ActionButton
                reasonCode="busy"
                type="button"
                className="image-chip-btn"
                disabled={!configuration || busy || blocked}
                onClick={() => edit(JSON.stringify(DEFAULT_REQUEST_PARAMETERS, null, 2))}>
                {t('parameters.defaults')}
              </ActionButton>
              <button
                type="button"
                className="image-chip-btn"
                disabled={!configuration || busy || blocked}
                onClick={() => edit(JSON.stringify({ moderation: 'low', background: 'transparent' }, null, 2))}>
                {t('parameters.presetTransparent')}
              </button>
              <button
                type="button"
                className="image-chip-btn"
                disabled={!configuration || busy || blocked}
                onClick={() => edit('{}')}>
                {t('parameters.presetEmpty')}
              </button>
              {mode === 'json' && (
                <button
                  type="button"
                  className="image-chip-btn"
                  disabled={!configuration || busy}
                  onClick={() => { void validateAndFormat() }}>
                  <Sparkles size={13} aria-hidden="true" />
                  {t('parameters.format')}
                </button>
              )}
            </div>
          </div>

          {mode === 'json' ? (
            <div className="image-field">
              <label htmlFor={id}>{t('parameters.label')}</label>
              <div>
                <textarea
                  id={id}
                  className="image-parameters-editor"
                  value={draft}
                  rows={6}
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={REQUEST_PARAMETERS_MAX_BYTES}
                  disabled={!configuration || busy}
                  aria-describedby={`${id}-help`}
                  onChange={event => edit(event.target.value)}
                />
                <p className="image-hint" id={`${id}-help`}>{t('parameters.example')}</p>
              </div>
            </div>
          ) : (
            <div className="image-field">
              <span>{t('parameters.label')}</span>
              <div>
                <KeyValuePairsEditor
                  id={id}
                  aria-label={t('parameters.label')}
                  jsonText={draft}
                  emptyOutput="{}"
                  reservedKeys={RESERVED_KEYS}
                  disabled={!configuration || busy}
                  suggestions={[
                    { key: 'moderation', defaultValue: 'low', type: 'string', label: 'moderation = low' },
                    { key: 'background', defaultValue: 'transparent', type: 'string', label: 'background = transparent' },
                    { key: 'output_format', defaultValue: 'png', type: 'string', label: 'output_format = png' },
                  ]}
                  onJsonTextChange={edit}
                />
                <p className="image-hint" id={`${id}-help`}>{t('parameters.example')}</p>
              </div>
            </div>
          )}

          {dirty && <p className="image-hint">{t('parameters.dirty')}</p>}
          {formattedOk && !failure && (
            <p className="image-success" role="status">
              <CheckCircle2 size={14} aria-hidden="true" />
              {t('parameters.formatted')}
            </p>
          )}
          {failure && <p className="image-error" role="alert">{failure}</p>}

          <FormSaveBar
            alwaysVisible
            dirty={dirty}
            saving={busy && saving.current}
            disabled={!configuration || busy || blocked}
            disabledReason={blocked ? t('error.busy') : undefined}
            conflict={conflict}
            saveLabel={t(busy && saving.current ? 'parameters.saving' : 'parameters.save')}
            savingLabel={t('parameters.saving')}
            discardLabel={t('parameters.reload')}
            reloadLabel={t('parameters.reload')}
            notice={saved ? t('parameters.saved') : null}
            onSave={() => void save()}
            onDiscard={conflict ? undefined : () => {
              setSaved(false)
              setFormattedOk(false)
              setDiscard(true)
            }}
            onReload={() => {
              setSaved(false)
              setFormattedOk(false)
              if (dirtyRef.current) setDiscard(true)
              else void load(true)
            }}
            extraActions={
              !dirty && !conflict ? (
                <ActionButton
                  reasonCode="busy"
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => {
                    setSaved(false)
                    setFormattedOk(false)
                    void load(true)
                  }}>
                  <RefreshCw size={14} aria-hidden="true" />
                  {t('parameters.reload')}
                </ActionButton>
              ) : undefined
            }
          />

          {discard && (
            <div ref={discardHostRef} className="image-inline-confirm">
              <InlineConfirm
                variant="warning"
                title={t('parameters.discardTitle')}
                description={t('parameters.discardHelp')}
                confirmLabel={t('config.discardConfirm')}
                cancelLabel={t('generate.cancel')}
                busy={busy}
                onCancel={() => setDiscard(false)}
                onConfirm={() => void load(true)}
              />
            </div>
          )}
        </form>
      )}
    </section>
  )
}
