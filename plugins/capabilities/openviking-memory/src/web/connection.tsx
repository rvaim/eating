import { AlertTriangle, ArrowUpRight, Plug, ShieldCheck } from 'lucide-react'
import { ActionButton, DurationInput, PasswordInput, Switch, useI18n } from '@eating/ui-sdk'
import type { MemoryConfiguration } from '../types'
import type { ConfigurationDraft, FieldIssues } from './draft'
import { Field, fieldDescribedBy, fieldId, TextField } from './fields'

export function Connection({
  prefix,
  config,
  draft,
  errors,
  locked,
  canConnect,
  actionReason,
  checking,
  secretClearedOnHide,
  onChange,
  onBlur,
  onConnect,
  onTest,
  onEnableNow,
}: {
  prefix: string
  config: MemoryConfiguration
  draft: ConfigurationDraft
  errors: FieldIssues
  locked: boolean
  canConnect: boolean
  actionReason: string
  checking: boolean
  secretClearedOnHide: boolean
  onChange: <K extends keyof ConfigurationDraft>(key: K, value: ConfigurationDraft[K]) => void
  onBlur: (name: string) => void
  onConnect: () => void
  onTest: () => void
  onEnableNow: () => void
}) {
  const { t } = useI18n('openviking-memory')
  const memoryDisabled = !config.settings.enabled || !draft.settings.enabled
  const apiKeyHint = t(config.apiKeyConfigured ? 'connection.keySaved' : 'connection.keyEmpty')
  const timeoutDescribedBy = fieldDescribedBy(prefix, 'timeoutMs', undefined, errors.timeoutMs)

  return (
    <>
      <div className="ov-section-heading">
        <h3>{t('connection.title')}</h3>
        <p>{t('connection.description')}</p>
      </div>
      {(!config.endpoint || !config.user) && <p className="ov-guidance">{t('connection.firstUse')}</p>}
      {memoryDisabled && (
        <div className="ov-enable-cta" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>{t('banner.disabledTitle')}</strong>
            <p>{t('banner.disabledBody')}</p>
          </div>
          <ActionButton
            className="button button-primary"
            disabled={locked}
            reason={t('reason.busy')}
            onClick={onEnableNow}>
            {t(config.settings.enabled ? 'banner.enableDraft' : 'banner.enableNow')}
          </ActionButton>
        </div>
      )}
      <fieldset className="ov-fields" disabled={locked}>
        <TextField
          prefix={prefix}
          name="endpoint"
          label={t('connection.endpoint')}
          hint={t('connection.endpointHint')}
          issue={errors.endpoint}
          value={draft.endpoint}
          type="url"
          inputMode="url"
          maxLength={2048}
          onChange={value => onChange('endpoint', value)}
          onBlur={() => onBlur('endpoint')}
        />
        <TextField
          prefix={prefix}
          name="user"
          label={t('connection.user')}
          hint={t('connection.userHint')}
          issue={errors.user}
          value={draft.user}
          maxLength={96}
          onChange={value => onChange('user', value)}
          onBlur={() => onBlur('user')}
        />
        <Field prefix={prefix} name="apiKey" label={t('connection.key')} hint={apiKeyHint}>
          <PasswordInput
            id={fieldId(prefix, 'apiKey')}
            value={draft.apiKey}
            saved={config.apiKeyConfigured}
            clear={draft.clearApiKey}
            onClearChange={value => onChange('clearApiKey', value)}
            hiddenClearedNotice={secretClearedOnHide}
            disabled={locked}
            maxLength={4096}
            clearLabel={t('connection.clearKey')}
            aria-label={t('connection.key')}
            aria-describedby={`${fieldId(prefix, 'apiKey')}-hint`}
            onChange={value => onChange('apiKey', value)}
          />
        </Field>
        <div className="ov-subsection">
          <h4>{t('connection.strategyTitle')}</h4>
          <TextField
            prefix={prefix}
            name="account"
            label={t('connection.account')}
            hint={t('connection.accountHint')}
            issue={errors.account}
            value={draft.account}
            maxLength={96}
            onChange={value => onChange('account', value)}
            onBlur={() => onBlur('account')}
          />
          <Field prefix={prefix} name="timeoutMs" label={t('connection.timeout')} issue={errors.timeoutMs}>
            <DurationInput
              id={fieldId(prefix, 'timeoutMs')}
              valueMs={draft.timeoutMs}
              presetsSeconds={[10, 15, 30, 60]}
              disabled={locked}
              aria-invalid={errors.timeoutMs ? true : undefined}
              aria-describedby={timeoutDescribedBy}
              onChangeMs={value => {
                onChange('timeoutMs', value)
                onBlur('timeoutMs')
              }}
            />
          </Field>
          <div className="ov-switch-row">
            <Switch
              id={fieldId(prefix, 'autoConnect')}
              checked={draft.autoConnect}
              disabled={locked}
              label={t('connection.autoConnect')}
              description={t('connection.autoConnectHint')}
              onChange={value => onChange('autoConnect', value)}
            />
          </div>
        </div>
      </fieldset>
      <p className="ov-hint ov-save-explainer">{t('connection.savedOnly')}</p>
      <div className="ov-actions">
        <ActionButton className="button button-secondary" disabled={!canConnect} reason={actionReason} onClick={onConnect}>
          <Plug size={16} aria-hidden="true" />
          {t(checking ? 'connection.checking' : 'connection.connect')}
        </ActionButton>
        <ActionButton className="button button-secondary" disabled={!canConnect} reason={actionReason} onClick={onTest}>
          <ShieldCheck size={16} aria-hidden="true" />
          {t('connection.test')}
        </ActionButton>
      </div>
      <p className="ov-permissions">
        {t('connection.manualTools')}{' '}
        <a href="#mcp">
          {t('connection.mcpLink')}
          <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </p>
    </>
  )
}
