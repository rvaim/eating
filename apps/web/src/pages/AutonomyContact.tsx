import { useState } from 'react'
import { ChevronDown, Search, Trash2, UserRound, Users } from 'lucide-react'
import type { ProactiveChannel, ProactiveTarget } from '@eating/plugin-sdk'
import { ActionButton, useI18n } from '@eating/ui-sdk'
import { channelKey } from './autonomy-data'

type ContactField = 'label' | 'channel' | 'targetId' | 'tools'
export const contactFieldId = (id: string, field: ContactField) => `autonomy-contact-${id}-${field}`
export function AutonomyContact({ target, channels, expanded, disabled, errors, onToggle, onChange, onRemove, onValidate }: {
  readonly target: ProactiveTarget
  readonly channels: readonly ProactiveChannel[]
  readonly expanded: boolean
  readonly disabled: boolean
  readonly errors: Readonly<Record<string, string>>
  readonly onToggle: () => void
  readonly onChange: (values: Partial<ProactiveTarget>) => void
  readonly onRemove: () => void
  readonly onValidate: (field: ContactField) => void
}) {
  const { t, formatNumber } = useI18n('autonomy')
  const [search, setSearch] = useState('')
  const [showIdentifiers, setShowIdentifiers] = useState(false)
  const disabledReason = t('why.busy')
  const key = channelKey(target)
  const channel = channels.find(channel => channelKey(channel) === key)
  const tools = channel?.tools ?? target.toolNames.map(name => ({ name, title: name }))
  const filtered = tools.filter(tool => `${tool.title} ${tool.name}`.toLowerCase().includes(search.toLowerCase()))
  const summaryId = `autonomy-contact-${target.id}-summary`, editorId = `autonomy-contact-${target.id}-editor`
  const error = (field: ContactField) => errors[contactFieldId(target.id, field)]
  const errorElement = (field: ContactField) => error(field) ? <p className="autonomy-field-error" id={`${contactFieldId(target.id, field)}-error`}>{t(error(field)!)}</p> : null
  const GroupIcon = channel?.kind === 'group' ? Users : UserRound

  return <section className={`autonomy-contact${expanded ? ' is-expanded' : ''}`} aria-labelledby={summaryId}>
    <div className="autonomy-contact-summary">
      <ActionButton reason={disabledReason} type="button" className="autonomy-contact-expand" id={summaryId} aria-expanded={expanded} aria-controls={editorId} disabled={disabled} onClick={onToggle}>
        <GroupIcon size={19} aria-hidden="true" />
        <span className="autonomy-contact-summary-copy"><strong>{target.label || t('newContact')}</strong><span>{target.accountId ? `${channel?.pluginName ?? target.pluginId} · ${target.accountId} → ${target.targetId || t('contact.missingTarget')}` : t('contact.incomplete')}</span></span>
        <span className="autonomy-contact-count">{t('contact.toolCount', { count: target.toolNames.length, formatted: formatNumber(target.toolNames.length) })}</span>
        <ChevronDown className="autonomy-contact-chevron" size={17} aria-hidden="true" />
      </ActionButton>
      <ActionButton reason={disabledReason} type="button" className="icon-button autonomy-contact-remove" aria-label={t('contact.removeNamed', { name: target.label || t('newContact') })} disabled={disabled} onClick={onRemove}><Trash2 size={17} aria-hidden="true" /></ActionButton>
    </div>
    <div id={editorId} hidden={!expanded} className="autonomy-contact-editor">
      <div className="autonomy-contact-fields">
        <div className="autonomy-input-group">
          <label htmlFor={contactFieldId(target.id, 'label')}>{t('contact.label')}</label>
          <input id={contactFieldId(target.id, 'label')} maxLength={80} value={target.label} disabled={disabled} onChange={event => onChange({ label: event.target.value })} onBlur={() => onValidate('label')} aria-invalid={Boolean(error('label'))} aria-describedby={error('label') ? `${contactFieldId(target.id, 'label')}-error` : undefined} />
          {errorElement('label')}
        </div>
        <div className="autonomy-input-group">
          <label htmlFor={contactFieldId(target.id, 'channel')}>{t('contact.channel')}</label>
          <select id={contactFieldId(target.id, 'channel')} value={key} disabled={disabled} aria-invalid={Boolean(error('channel'))} aria-describedby={error('channel') ? `${contactFieldId(target.id, 'channel')}-error` : undefined} onBlur={() => onValidate('channel')} onChange={event => {
            const next = channels.find(channel => channelKey(channel) === event.target.value)
            if (next) { onChange({ pluginId: next.pluginId, instanceId: next.instanceId, accountId: next.accountId, agentTypeId: next.agentTypeId, toolNames: [] }); setSearch('') }
          }}>
            {!channel && <option value={key}>{target.accountId ? `${target.pluginId} · ${target.accountId} · ${t('channelOffline')}` : t('selectChannel')}</option>}
            {channels.map(channel => <option value={channelKey(channel)} key={channelKey(channel)}>{channel.pluginName} · {channel.accountId} · {channel.title}</option>)}
          </select>
          {errorElement('channel')}
          {!channel && target.accountId && <p className="autonomy-field-hint">{t('contact.offlineHint')} <a href={`#robots/${encodeURIComponent(target.pluginId)}`}>{t('contact.openConnection')}</a></p>}
        </div>
        <div className="autonomy-input-group">
          <label htmlFor={contactFieldId(target.id, 'targetId')}>{t('contact.target')}</label>
          <input id={contactFieldId(target.id, 'targetId')} maxLength={160} value={target.targetId} disabled={disabled} aria-invalid={Boolean(error('targetId'))} aria-describedby={`${contactFieldId(target.id, 'targetId')}-hint${error('targetId') ? ` ${contactFieldId(target.id, 'targetId')}-error` : ''}`} onBlur={() => onValidate('targetId')} onChange={event => onChange({ targetId: event.target.value })} />
          <p id={`${contactFieldId(target.id, 'targetId')}-hint`} className="autonomy-field-hint">{t('contact.targetHint')}</p>
          {errorElement('targetId')}
        </div>
      </div>
      <fieldset className="autonomy-tools" disabled={disabled} aria-describedby={error('tools') ? `${contactFieldId(target.id, 'tools')}-error` : undefined}>
        <legend>{t('contact.tools')} <span>{t('contact.selected', { count: target.toolNames.length, formatted: formatNumber(target.toolNames.length) })}</span></legend>
        {!channel && !target.accountId ? <p className="autonomy-field-hint">{t('contact.chooseChannelFirst')}</p> : <>
          <p className="autonomy-field-hint">{t('contact.allowList')}</p>
          <div className="autonomy-tool-bulk"><ActionButton type="button" className="text-button" reason={disabled ? disabledReason : t('why.channel')} disabled={disabled || !channel || tools.length === 0} onClick={() => onChange({ toolNames: tools.map(tool => tool.name) })}>{t('contact.allowAll')}</ActionButton><ActionButton type="button" className="text-button" reason={disabled ? disabledReason : t('why.empty')} disabled={disabled || target.toolNames.length === 0} onClick={() => onChange({ toolNames: [] })}>{t('contact.clearAll')}</ActionButton></div>
          <div className="autonomy-tool-toolbar">
            <label className="autonomy-tool-search"><Search size={15} aria-hidden="true" /><input aria-label={t('contact.searchTools')} placeholder={t('contact.searchTools')} value={search} onChange={event => setSearch(event.target.value)} /></label>
            <label className="autonomy-identifier-toggle"><input type="checkbox" checked={showIdentifiers} onChange={event => setShowIdentifiers(event.target.checked)} /><span>{t('contact.showIdentifiers')}</span></label>
          </div>
          <div className="autonomy-tool-choices" id={contactFieldId(target.id, 'tools')} tabIndex={-1}>
            {filtered.map(tool => <label key={tool.name}><input type="checkbox" checked={target.toolNames.includes(tool.name)} aria-describedby={error('tools') ? `${contactFieldId(target.id, 'tools')}-error` : undefined} onChange={event => onChange({ toolNames: event.target.checked ? [...target.toolNames, tool.name] : target.toolNames.filter(name => name !== tool.name) })} /><span>{tool.title}<code hidden={!showIdentifiers || tool.title === tool.name}>{tool.name}</code></span></label>)}
          </div>
          {!filtered.length && <p className="autonomy-field-hint">{t('contact.noMatchingTools')}</p>}
        </>}
        {errorElement('tools')}
      </fieldset>
      <ActionButton reason={disabledReason} type="button" className="button button-secondary autonomy-contact-done" disabled={disabled} onClick={onToggle}>{t('contact.done')}</ActionButton>
    </div>
  </section>
}
