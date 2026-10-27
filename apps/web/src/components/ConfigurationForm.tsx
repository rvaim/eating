import { useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Check, Info, Save, ShieldCheck } from 'lucide-react'
import type { PluginConfiguration } from '@eating/plugin-core'
import type { ConfigurationValidation, PluginPanelProps, WorkspaceActionResult } from '@eating/ui-sdk'
import { formatNumber, translate, useI18n } from '@eating/ui-sdk'
import '../i18n/app'

interface ConfigurationFormProps extends PluginPanelProps {
  readonly title: string
  readonly description: string
  readonly validate: (values: PluginConfiguration) => ConfigurationValidation
  readonly children: (context: {
    readonly values: PluginConfiguration
    readonly update: (key: string, value: string | boolean) => void
    readonly errors: Readonly<Record<string, string>>
  }) => ReactNode
}

type FormResult =
  | { readonly kind: 'validation' | 'saved' | 'checked' }
  | { readonly kind: 'error'; readonly response: Extract<WorkspaceActionResult, { readonly ok: false }> }

export function ConfigurationForm({ saved, initialValues, onSave, onFeedback, validate, title, description, children }: ConfigurationFormProps) {
  const { t } = useI18n('app')
  const [values, setValues] = useState<PluginConfiguration>(() => ({ ...initialValues, ...saved?.values }))
  const [errorFields, setErrorFields] = useState<readonly string[]>([])
  const [result, setResult] = useState<FormResult | null>(null)
  const validationErrors = errorFields.length ? validate(values).errors : {}
  const errors = Object.fromEntries(errorFields.flatMap(key => validationErrors[key] ? [[key, validationErrors[key]]] : []))
  const changed = JSON.stringify(values) !== JSON.stringify({ ...initialValues, ...saved?.values })
  const success = result?.kind === 'saved' || result?.kind === 'checked'
  const message = !result ? '' : result.kind === 'error' ? result.response.error : t(result.kind === 'validation' ? 'form.fixErrors' : result.kind === 'saved' ? 'form.savedMessage' : 'form.checkedMessage')

  function check(): boolean {
    const validation = validate(values)
    setErrorFields(Object.keys(validation.errors))
    if (!validation.valid) {
      setResult({ kind: 'validation' })
      return false
    }
    return true
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!check()) return
    const response = await onSave(values)
    if (!response.ok) {
      setResult({ kind: 'error', response })
      return
    }
    setResult({ kind: 'saved' })
    onFeedback(t('form.savedFeedback'))
  }

  return <form onSubmit={save} noValidate className="configuration-form">
    <div className="section-heading"><h3>{title}</h3><p>{description}</p></div>
    <div className="form-fields">{children({
      values,
      update: (key, value) => {
        setValues(current => ({ ...current, [key]: value }))
        setErrorFields(current => current.filter(field => field !== key))
        setResult(null)
      },
      errors,
    })}</div>
    <div className="form-actions">
      <button className="button button-primary" type="submit"><Save size={16} />{t('form.save')}</button>
      <button className="button button-secondary" type="button" onClick={() => {
        if (check()) setResult({ kind: 'checked' })
      }}><ShieldCheck size={16} />{t('form.validate')}</button>
      <span className="save-indicator">{changed ? t('form.unsaved') : saved ? <><Check size={14} /> {t('form.saved')}</> : t('form.notSaved')}</span>
    </div>
    {result && <p className={`form-result ${success ? 'result-success' : 'result-error'}`} role={success ? 'status' : 'alert'}>
      {success ? <Check size={17} /> : <Info size={17} />}{message}
    </p>}
  </form>
}

interface FieldProps {
  readonly label: string
  readonly hint?: string
  readonly error?: string
  readonly children: (attributes: { id: string; 'aria-describedby'?: string; 'aria-invalid': boolean }) => ReactNode
}

export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId()
  return <div className={`field ${error ? 'field-invalid' : ''}`}>
    <label htmlFor={id}>{label}</label>
    {children({ id, 'aria-describedby': error || hint ? `${id}-help` : undefined, 'aria-invalid': Boolean(error) })}
    {(error || hint) && <p id={`${id}-help`} className={error ? 'field-error' : 'field-hint'}>{error || hint}</p>}
  </div>
}

export function TextValue(values: PluginConfiguration, key: string, fallback = ''): string {
  const value = values[key]
  return typeof value === 'string' ? value : fallback
}

export function validateDisplayName(values: PluginConfiguration): string | undefined {
  const name = TextValue(values, 'displayName').trim()
  if (!name) return translate('app', 'validation.nameRequired')
  if (name.length > 40) return translate('app', 'validation.nameLength', { limit: formatNumber(40) })
  return undefined
}

export function validateLocalAddress(value: string, protocols: readonly string[]): string | undefined {
  try {
    const url = new URL(value)
    if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('address')
    return undefined
  } catch {
    return translate('app', 'validation.address', { protocols: protocols.map(protocol => protocol.slice(0, -1)).join(' / ') })
  }
}
