import { useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Check, Info, Save, ShieldCheck } from 'lucide-react'
import type { PluginConfiguration } from '@eating/plugin-core'
import type { ConfigurationValidation, PluginPanelProps } from '@eating/ui-sdk'

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

export function ConfigurationForm({ saved, initialValues, onSave, onFeedback, validate, title, description, children }: ConfigurationFormProps) {
  const [values, setValues] = useState<PluginConfiguration>(() => ({ ...initialValues, ...saved?.values }))
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [result, setResult] = useState<{ readonly success: boolean; readonly message: string } | null>(null)
  const changed = JSON.stringify(values) !== JSON.stringify({ ...initialValues, ...saved?.values })

  function check(): boolean {
    const validation = validate(values)
    setErrors(validation.errors)
    if (!validation.valid) {
      setResult({ success: false, message: '请修正已标出的配置，再重试。' })
      return false
    }
    return true
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!check()) return
    const response = await onSave(values)
    if (!response.ok) {
      setResult({ success: false, message: response.error })
      return
    }
    setResult({ success: true, message: '配置已保存在此浏览器中，尚未连接真实平台。' })
    onFeedback('配置已保存')
  }

  return <form onSubmit={save} noValidate className="configuration-form">
    <div className="section-heading"><h3>{title}</h3><p>{description}</p></div>
    <div className="form-fields">{children({
      values,
      update: (key, value) => {
        setValues(current => ({ ...current, [key]: value }))
        setErrors(current => { const next = { ...current }; delete next[key]; return next })
        setResult(null)
      },
      errors,
    })}</div>
    <div className="form-actions">
      <button className="button button-primary" type="submit"><Save size={16} />保存配置</button>
      <button className="button button-secondary" type="button" onClick={() => {
        if (check()) setResult({ success: true, message: '配置格式正确。本地校验不会向外部平台发起连接。' })
      }}><ShieldCheck size={16} />本地校验</button>
      <span className="save-indicator">{changed ? '有未保存的更改' : saved ? <><Check size={14} /> 已保存</> : '尚未保存'}</span>
    </div>
    {result && <p className={`form-result ${result.success ? 'result-success' : 'result-error'}`} role={result.success ? 'status' : 'alert'}>
      {result.success ? <Check size={17} /> : <Info size={17} />}{result.message}
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
  if (!name) return '请填写显示名称。'
  if (name.length > 40) return '显示名称最多 40 个字符。'
  return undefined
}

export function validateLocalAddress(value: string, protocols: readonly string[]): string | undefined {
  try {
    const url = new URL(value)
    if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('address')
    return undefined
  } catch {
    return `请填写有效的 ${protocols.map(protocol => protocol.slice(0, -1)).join(' / ')} 地址，不要包含账号或密码。`
  }
}
