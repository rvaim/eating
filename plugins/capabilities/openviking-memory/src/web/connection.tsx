import { useState } from 'react'
import { ArrowUpRight, Plug, ShieldCheck } from 'lucide-react'
import { ActionButton, useI18n } from '@eating/ui-sdk'
import type { MemoryConfiguration } from '../types'
import type { ConfigurationDraft, FieldIssues } from './draft'
import { CheckField, TextField } from './fields'

export function Connection({ prefix, config, draft, errors, locked, canConnect, actionReason, checking, onChange, onBlur, onConnect, onTest }: {
  prefix: string; config: MemoryConfiguration; draft: ConfigurationDraft; errors: FieldIssues; locked: boolean; canConnect: boolean
  actionReason: string; checking: boolean; onChange: <K extends keyof ConfigurationDraft>(key: K, value: ConfigurationDraft[K]) => void
  onBlur: (name: string) => void; onConnect: () => void; onTest: () => void
}) {
  const { t } = useI18n('openviking-memory')
  const [advanced, setAdvanced] = useState(false)
  return <>
    <div className="ov-section-heading"><h3>{t('connection.title')}</h3><p>{t('connection.description')}</p></div>
    {(!config.endpoint || !config.user) && <p className="ov-guidance">{t('connection.firstUse')}</p>}
    <fieldset className="ov-fields" disabled={locked}>
      <TextField prefix={prefix} name="endpoint" label={t('connection.endpoint')} hint={t('connection.endpointHint')} issue={errors.endpoint}
        value={draft.endpoint} type="url" inputMode="url" maxLength={2048} onChange={value => onChange('endpoint', value)} onBlur={() => onBlur('endpoint')} />
      <TextField prefix={prefix} name="user" label={t('connection.user')} hint={t('connection.userHint')} issue={errors.user}
        value={draft.user} maxLength={96} onChange={value => onChange('user', value)} onBlur={() => onBlur('user')} />
      <TextField prefix={prefix} name="apiKey" label={t('connection.key')} hint={t(config.apiKeyConfigured ? 'connection.keySaved' : 'connection.keyEmpty')}
        value={draft.apiKey} type="password" maxLength={4096} disabled={draft.clearApiKey} onChange={value => onChange('apiKey', value)} />
      {config.apiKeyConfigured && <div className="ov-key-clear"><CheckField label={t('connection.clearKey')} checked={draft.clearApiKey} onChange={value => onChange('clearApiKey', value)} /></div>}
      <details className="ov-disclosure" open={advanced || Boolean(errors.account || errors.timeoutMs)} onToggle={event => setAdvanced(event.currentTarget.open)}>
        <summary>{t('connection.advanced')}</summary><div className="ov-disclosure-body">
          <TextField prefix={prefix} name="account" label={t('connection.account')} hint={t('connection.accountHint')} issue={errors.account}
            value={draft.account} maxLength={96} onChange={value => onChange('account', value)} onBlur={() => onBlur('account')} />
          <TextField prefix={prefix} name="timeoutMs" label={t('connection.timeout')} issue={errors.timeoutMs} value={draft.timeoutMs}
            inputMode="numeric" onChange={value => onChange('timeoutMs', value)} onBlur={() => onBlur('timeoutMs')} />
          <CheckField label={t('connection.autoConnect')} hint={t('connection.autoConnectHint')} checked={draft.autoConnect} onChange={value => onChange('autoConnect', value)} />
        </div>
      </details>
    </fieldset>
    <p className="ov-hint ov-save-explainer">{t('connection.savedOnly')}</p>
    <div className="ov-actions"><ActionButton className="button button-secondary" disabled={!canConnect} reason={actionReason} onClick={onConnect}>
      <Plug size={16} aria-hidden="true" />{t(checking ? 'connection.checking' : 'connection.connect')}</ActionButton>
      <ActionButton className="button button-secondary" disabled={!canConnect} reason={actionReason} onClick={onTest}>
        <ShieldCheck size={16} aria-hidden="true" />{t('connection.test')}</ActionButton></div>
    <p className="ov-permissions">{t('connection.manualTools')} <a href="#mcp">{t('connection.mcpLink')}<ArrowUpRight size={14} aria-hidden="true" /></a></p>
  </>
}
