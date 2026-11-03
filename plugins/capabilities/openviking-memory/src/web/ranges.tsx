import { useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2, Undo2 } from 'lucide-react'
import { ActionButton, createRequestId, useI18n } from '@eating/ui-sdk'
import type { MemorySettings, ScopeRule } from '../types'
import { DEFAULT_SETTINGS } from '../types'
import type { ConfigurationDraft, FieldIssues, RuleDraft, SettingsDraft } from './draft'
import { numericSettings, rulePath, selfPath, settingBounds } from './draft'
import { CheckField, Field, fieldId, focusAndReveal, TextField } from './fields'

type BooleanSetting = { [K in keyof MemorySettings]: MemorySettings[K] extends boolean ? K : never }[keyof MemorySettings]
export function Ranges({ prefix, draft, errors, locked, expanded, setExpanded, query, setQuery, onChange, onBlur }: {
  prefix: string; draft: ConfigurationDraft; errors: FieldIssues; locked: boolean; expanded: string | null; setExpanded: (id: string | null) => void
  query: string; setQuery: (query: string) => void; onChange: (value: SettingsDraft) => void; onBlur: (name: string) => void
}) {
  const { t, formatNumber } = useI18n('openviking-memory')
  const [removed, setRemoved] = useState<{ rule: RuleDraft; index: number }[]>([])
  const [processingOpen, setProcessingOpen] = useState(false)
  const addPrivate = useRef<HTMLButtonElement>(null)
  const settings = draft.settings
  const update = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => onChange({ ...settings, [key]: value })
  const check = (key: BooleanSetting, hint = true) => <CheckField label={t(`ranges.${key}`)} hint={hint ? t(`ranges.${key}Hint`) : undefined} checked={settings[key]} disabled={locked} onChange={value => update(key, value)} />
  const label = (rule: RuleDraft) => rule.label.trim() || t('rules.unnamed', { kind: t(`ranges.${rule.kind}`) })
  function focus(name: string) { focusAndReveal(() => document.getElementById(fieldId(prefix, name))) }
  function add(kind: ScopeRule['kind']) {
    if (locked || settings.rules.length >= 500) return
    const rule: RuleDraft = { id: createRequestId(), label: t(kind === 'private' ? 'rules.newPrivate' : 'rules.newGroup'), platform: 'qq',
      accountId: '', kind, targetId: '', capture: kind === 'private' ? settings.privateCapture : settings.groupCapture,
      recall: kind === 'private' ? settings.privateRecall : settings.groupRecall, memberMode: 'all', memberIdsText: '' }
    update('rules', [...settings.rules, rule]); setQuery(''); setExpanded(rule.id); focus(`rule-${rule.id}-label`)
  }
  function change(rule: RuleDraft, patch: Partial<RuleDraft>) {
    update('rules', settings.rules.map(entry => entry.id === rule.id ? { ...entry, ...patch } : entry))
  }
  function remove(rule: RuleDraft) {
    const index = settings.rules.findIndex(entry => entry.id === rule.id)
    setRemoved(current => [...current, { rule, index }]); update('rules', settings.rules.filter(entry => entry.id !== rule.id))
    if (expanded === rule.id) setExpanded(null)
    focus('undo-rule')
  }
  function undo() {
    const entry = removed.at(-1)
    if (!entry) return
    const next = [...settings.rules]; next.splice(Math.min(entry.index, next.length), 0, entry.rule)
    update('rules', next); setRemoved(current => current.slice(0, -1)); setQuery(''); setExpanded(entry.rule.id); focus(`rule-${entry.rule.id}-label`)
  }
  const filtered = settings.rules.filter(rule => `${rule.label} ${rule.platform} ${rule.accountId} ${rule.targetId} ${rule.kind}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const hasProcessingError = numericSettings.some(key => Boolean(errors[key]))
  const archiveHint = t('ranges.archiveHint', { min: formatNumber(settingBounds.archiveMaxMiB[0]), max: formatNumber(settingBounds.archiveMaxMiB[1]), default: formatNumber(DEFAULT_SETTINGS.archiveMaxMiB) })
  return <>
    <div className="ov-section-heading"><h3>{t('ranges.title')}</h3><p>{t('ranges.description')}</p></div>
    <div className="ov-permission-list">{check('enabled')}{check('autoCapture')}{check('autoRecall')}{check('globalMemory')}{check('ownerCrossSession')}</div>
    <section className="ov-section" aria-labelledby={`${prefix}-defaults`}><div className="ov-section-heading"><h3 id={`${prefix}-defaults`}>{t('ranges.defaults')}</h3><p>{t('ranges.defaultsHint')}</p></div>
      <div className="ov-defaults"><div className="ov-default-label" aria-hidden="true" /><span aria-hidden="true">{t('ranges.capture')}</span><span aria-hidden="true">{t('ranges.recall')}</span>
        {(['private', 'group'] as const).map(kind => <div className="ov-default-row" key={kind}><strong>{t(`ranges.${kind}`)}</strong>
          <CheckField label={`${t(`ranges.${kind}`)} ${t('ranges.capture')}`} checked={settings[`${kind}Capture`]} disabled={locked} onChange={value => update(`${kind}Capture`, value)} />
          <CheckField label={`${t(`ranges.${kind}`)} ${t('ranges.recall')}`} checked={settings[`${kind}Recall`]} disabled={locked} onChange={value => update(`${kind}Recall`, value)} />
        </div>)}</div>
      <div className="ov-path"><span>{t('ranges.self')}</span><output>{selfPath(draft.user) || 'viking://user/<user>/peers/self/memories'}</output></div>
    </section>
    <section className="ov-section" aria-labelledby={`${prefix}-rules-title`}>
      <div className="ov-section-heading ov-heading-actions"><div><h3 id={`${prefix}-rules-title`}>{t('rules.title')}</h3><p>{t('rules.description')}</p></div><span className="ov-count">{t('rules.count', { value: formatNumber(settings.rules.length) })}</span></div>
      <div className="ov-rule-tools"><div className="ov-search"><label htmlFor={`${prefix}-rule-search`}>{t('rules.search')}</label><input id={`${prefix}-rule-search`} type="search" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <div className="ov-actions"><ActionButton ref={addPrivate} className="button button-secondary" reason={t(locked ? 'reason.busy' : 'reason.rulesMax')} disabled={locked || settings.rules.length >= 500} onClick={() => add('private')}><Plus size={16} aria-hidden="true" />{t('rules.addPrivate')}</ActionButton>
          <ActionButton className="button button-secondary" reason={t(locked ? 'reason.busy' : 'reason.rulesMax')} disabled={locked || settings.rules.length >= 500} onClick={() => add('group')}><Plus size={16} aria-hidden="true" />{t('rules.addGroup')}</ActionButton></div>
      </div>
      {removed.length > 0 && <div className="ov-undo" role="status"><p>{t('rules.removed', { label: label(removed.at(-1)!.rule) })}</p><ActionButton id={fieldId(prefix, 'undo-rule')} className="text-button" disabled={locked} reason={t('reason.busy')} onClick={undo}><Undo2 size={16} aria-hidden="true" />{t('rules.undo')}</ActionButton></div>}
      {!filtered.length && <p className="ov-empty">{t(settings.rules.length ? 'rules.noResults' : 'rules.empty')}</p>}
      <ul className="ov-rules">{filtered.map(rule => {
        const open = expanded === rule.id, path = rulePath(draft.user.trim(), rule), base = `rule-${rule.id}`
        const field = (name: 'label' | 'platform' | 'accountId' | 'targetId' | 'memberIdsText', hint?: string) => <TextField prefix={prefix} name={`${base}-${name}`} label={t(`rules.${name === 'memberIdsText' ? 'memberIds' : name}`)}
          hint={hint} issue={errors[`${base}-${name}`]} value={rule[name]} onChange={value => change(rule, { [name]: value })} onBlur={() => onBlur(`${base}-${name}`)}
          maxLength={name === 'memberIdsText' ? 130_000 : name === 'label' ? 160 : name === 'platform' ? 32 : 96} multiline={name === 'memberIdsText'} disabled={locked} />
        return <li key={rule.id} className={`ov-rule${open ? ' is-expanded' : ''}`}>
          <div className="ov-rule-row"><button type="button" className="ov-rule-toggle" id={fieldId(prefix, `${base}-toggle`)} aria-expanded={open} aria-controls={`${prefix}-${base}-editor`} onClick={() => setExpanded(open ? null : rule.id)}>
            <span className="ov-rule-copy"><strong>{label(rule)}</strong><span>{rule.accountId && rule.targetId ? `${rule.platform} · ${rule.accountId} · ${t(`ranges.${rule.kind}`)} · ${rule.targetId}` : t('rules.incomplete')}</span></span>
            <span className="ov-rule-permissions">{t('ranges.capture')} {t(rule.capture ? 'common.on' : 'common.off')} · {t('ranges.recall')} {t(rule.recall ? 'common.on' : 'common.off')}</span>{open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
          </button><ActionButton className="icon-button ov-remove" aria-label={`${t('rules.remove')}: ${label(rule)}`} disabled={locked} reason={t('reason.busy')} onClick={() => remove(rule)}><Trash2 size={17} aria-hidden="true" /></ActionButton></div>
          {open && <fieldset className="ov-rule-editor" id={`${prefix}-${base}-editor`} disabled={locked} aria-label={label(rule)}>
            {field('label')}
            <Field prefix={prefix} name={`${base}-kind`} label={t('rules.kind')}><select id={fieldId(prefix, `${base}-kind`)} value={rule.kind} onChange={event => change(rule, { kind: event.target.value as ScopeRule['kind'] })}><option value="private">{t('ranges.private')}</option><option value="group">{t('ranges.group')}</option></select></Field>
            {field('platform', t('rules.platformHint'))}{field('accountId', t('rules.tupleHint'))}{field('targetId', t('rules.tupleHint'))}
            <div className="ov-rule-checks"><CheckField label={t('ranges.capture')} checked={rule.capture} onChange={value => change(rule, { capture: value })} /><CheckField label={t('ranges.recall')} checked={rule.recall} onChange={value => change(rule, { recall: value })} /></div>
            {rule.kind === 'group' && <><Field prefix={prefix} name={`${base}-memberMode`} label={t('rules.memberMode')}><select id={fieldId(prefix, `${base}-memberMode`)} value={rule.memberMode} onChange={event => change(rule, { memberMode: event.target.value as ScopeRule['memberMode'] })}>
              {(['all', 'allowlist', 'denylist'] as const).map(mode => <option key={mode} value={mode}>{t(`rules.memberMode.${mode}`)}</option>)}</select></Field>
              {rule.memberMode !== 'all' && field('memberIdsText', t('rules.membersHint'))}</>}
            <div className="ov-path"><span>{t('rules.path')}</span>{path ? <output>{path}</output> : <p className="ov-hint">{t('rules.incomplete')}</p>}<p className="ov-hint">{t('rules.pathHint')}</p></div>
            <ActionButton className="text-button" onClick={() => { setExpanded(null); focus(`${base}-toggle`) }}>{t('rules.collapse')}</ActionButton>
          </fieldset>}
        </li>
      })}</ul>
    </section>
    <section className="ov-section" aria-labelledby={`${prefix}-processing`}>
      <div className="ov-section-heading"><h3 id={`${prefix}-processing`}>{t('ranges.processing')}</h3><p>{t('ranges.processingHint')}</p></div>
      <details className="ov-disclosure" open={processingOpen || hasProcessingError} onToggle={event => setProcessingOpen(event.currentTarget.open)}>
        <summary>{t('ranges.processingAdvanced')}</summary><div className="ov-disclosure-body">
          {numericSettings.map(name => <TextField key={name} prefix={prefix} name={name} label={t(`ranges.${name}`)} hint={name === 'archiveMaxMiB' ? archiveHint : undefined} issue={errors[name]} value={settings[name]}
            inputMode={name === 'scoreThreshold' ? 'decimal' : 'numeric'} disabled={locked} onChange={value => update(name, value)} onBlur={() => onBlur(name)} />)}
        </div>
      </details>
    </section>
  </>
}
