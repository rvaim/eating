import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { getErrorMessage, getLocale, HostApiError, setLocale } from '@eating/ui-sdk'
import type { AgentTypeDefinition, JsonObject } from '@eating/plugin-sdk'
import { AgentPolicyFields, agentPolicyDraft, parseIdentityText } from './agent-policy-fields'
import { publicConfiguration } from './panel'
import { qqTools } from '../backend/operations'
import { qqAgentTypes, createDefaultAgentPolicy, parseQQAgentPolicy } from '../backend/agent-policy'

const initialLocale = getLocale()
afterEach(() => { setLocale(initialLocale) })
const invalidResponse = expect.objectContaining({ code: 'INVALID_HOST_RESPONSE' })
function currentConfiguration(): JsonObject {
  return { ...createDefaultAgentPolicy(), displayName: 'QQ', endpoint: '', autoConnect: false, forwardToHarness: true, receiveGroups: true, timeoutMs: 10000, tokenConfigured: false,
    instanceId: 'instance-a', defaultInstanceId: 'instance-a', configurationPath: '/test/accounts/instance-a/config.json', dataDirectory: '/test/accounts/instance-a', updatedAt: null,
    instances: [{ instanceId: 'instance-a', label: 'Test QQ', createdAt: '2026-10-29T00:00:00.000Z' }] }
}
function policyMarkup(configuration: JsonObject, agentTypes = qqAgentTypes(createDefaultAgentPolicy())) {
  return renderToStaticMarkup(createElement(AgentPolicyFields, { configuration, agentTypes, tools: qqTools, enabled: true, busy: false, actionLock: { current: false }, onBusy: () => {}, onSaved: () => {}, onFeedback: () => {} }))
}

describe('QQ agent policy form helpers', () => {
  it('accepts newline, comma, full-width comma and whitespace separators and canonicalizes duplicates', () => {
    expect(parseIdentityText('123456\n234567,345678 456789，123456\t567890')).toEqual(['123456', '234567', '345678', '456789', '567890'])
    expect(parseIdentityText(' \n,，\t')).toEqual([])
    for (const invalid of ['0', '-1', '00123', '123.4', '9e5', '9007199254740992', '12345678901234567']) expect(parseIdentityText(invalid)).toBeNull()
    expect(parseIdentityText(Array.from({ length: 101 }, (_, i) => String(i + 1)).join('\n'))).toBeNull()
  })

  it('keeps identity numbers and revision separate from connection drafts and copies explicit current selections', () => {
    const policy = parseQQAgentPolicy({ ...createDefaultAgentPolicy(), owners: ['123', '456'], administrators: ['789'], policyRevision: 7 })
    const types = qqAgentTypes(policy)
    const draft = agentPolicyDraft({ ...policy, endpoint: 'ws://fixture/', tokenConfigured: true }, types)
    expect(draft).toEqual({ owners: '123\n456', administrators: '789', expectedRevision: 7, agentTools: policy.agentTools })
    draft.agentTools['qq.private'].splice(0)
    expect(policy.agentTools['qq.private'].length).toBeGreaterThan(0)
    expect(draft).not.toHaveProperty('accessToken')
    expect(draft).not.toHaveProperty('endpoint')
    expect(agentPolicyDraft({ ...policy, agentTools: { 'qq.private': [], 'qq.group': [] } }, types).agentTools).toEqual({ 'qq.private': [], 'qq.group': [] })
    expect(agentPolicyDraft(policy, []).agentTools).toEqual(policy.agentTools)
  })

  it.each(['owners', 'administrators', 'agentTools', 'policyRevision'])('rejects missing or null %s instead of constructing a policy draft', key => {
    const policy = createDefaultAgentPolicy()
    const missing = Object.fromEntries(Object.entries(policy).filter(([field]) => field !== key))
    for (const invalid of [missing, { ...policy, [key]: null }]) expect(() => agentPolicyDraft(invalid, qqAgentTypes(policy))).toThrowError(invalidResponse)
  })

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '0'])('rejects invalid current revision %j', policyRevision => {
    const policy = createDefaultAgentPolicy()
    expect(() => agentPolicyDraft({ ...policy, policyRevision }, qqAgentTypes(policy))).toThrowError(invalidResponse)
  })

  it.each([
    { 'qq.private': [] }, { 'qq.group': [] }, { 'qq.private': [], 'qq.group': [], old: [] },
    { 'qq.private': null, 'qq.group': [] }, { 'qq.private': ['qq_missing'], 'qq.group': [] },
  ])('rejects incomplete or invalid current tool selections %j', agentTools => {
    const policy = createDefaultAgentPolicy()
    expect(() => agentPolicyDraft({ ...policy, agentTools }, qqAgentTypes(policy))).toThrowError(invalidResponse)
  })

  it('rejects malformed identities and type metadata without filtering them into valid selections', () => {
    const policy = createDefaultAgentPolicy()
    const types = qqAgentTypes(policy)
    for (const owners of [[123], ['01'], ['9007199254740992']]) expect(() => agentPolicyDraft({ ...policy, owners }, types)).toThrowError(invalidResponse)
    for (const invalid of [undefined, null, {}, [types[0], types[0]], [{ ...types[0], availableTools: null }], [{ ...types[0], enabledTools: ['qq_missing'] }], [{ ...types[0], title: null }]]) {
      expect(() => agentPolicyDraft(policy, invalid as unknown as AgentTypeDefinition[])).toThrowError(invalidResponse)
    }
  })

  it('renders only tools registered for each Host role, with translated copy and stable owner numbers', () => {
    setLocale('en-US')
    const policy = parseQQAgentPolicy({ ...createDefaultAgentPolicy(), owners: ['123456789'], administrators: [], agentTools: { 'qq.private': ['qq_get_status'], 'qq.group': ['qq_get_status'] } })
    const types: AgentTypeDefinition[] = qqAgentTypes(policy).map(type => ({ ...type, availableTools: ['qq_get_status'], enabledTools: ['qq_get_status'], defaultTools: ['qq_get_status'] }))
    const html = policyMarkup({ ...policy }, types)
    expect(html).toContain('Agent access')
    expect(html).toContain('Owner QQ numbers')
    expect(html).toContain('QQ private chat')
    expect(html).toContain('QQ group chat')
    expect(html).toContain('123456789')
    expect(html.match(/type="checkbox"/g)).toHaveLength(2)
    expect(html).not.toContain('Cookies')
    expect(html).not.toContain('accessToken')
    expect(html).not.toMatch(/\p{Script=Han}/u)
    expect(html).toContain('fieldset')
    expect(html).toContain('legend')
    expect(html).toContain('aria-describedby=')
  })

  it('shows a local translated error without a writable form for malformed configuration in either locale', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      setLocale(locale)
      const html = policyMarkup({})
      expect(html).toContain('role="alert"')
      expect(html).toContain(getErrorMessage({ code: 'INVALID_HOST_RESPONSE' }))
      expect(html).not.toContain('<form')
      expect(html).not.toContain('<textarea')
      expect(html).not.toContain('type="checkbox"')
    }
  })

  it('preserves the real initialization diagnostic without creating editable default policy', () => {
    const diagnostic = 'QQ 配置格式无效或版本不支持，未覆盖原文件。'
    const configuration = { initializationError: diagnostic }
    expect(() => agentPolicyDraft(configuration, [])).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_CORRUPTED', message: diagnostic }))
    const html = policyMarkup(configuration, [])
    expect(html).toContain(getErrorMessage({ code: 'CONFIGURATION_CORRUPTED' }))
    expect(html).toContain(diagnostic)
    expect(html).not.toContain('<form')
  })
})

describe('QQ current connection response', () => {
  it('accepts complete fresh current defaults and preserves saved token presence', () => {
    const current = currentConfiguration()
    expect(publicConfiguration(current)).toMatchObject({ displayName: 'QQ', endpoint: '', timeoutMs: 10000, tokenConfigured: false, updatedAt: null, instanceId: 'instance-a' })
    expect(publicConfiguration({ ...current, endpoint: 'ws://127.0.0.1:3001/', tokenConfigured: true })).toMatchObject({ endpoint: 'ws://127.0.0.1:3001/', tokenConfigured: true })
    expect(publicConfiguration(current)).not.toHaveProperty('accessToken')
  })

  it.each(Object.keys(currentConfiguration()))('rejects missing current response field %s', key => {
    const missing = Object.fromEntries(Object.entries(currentConfiguration()).filter(([field]) => field !== key))
    expect(() => publicConfiguration(missing)).toThrowError(invalidResponse)
  })

  it.each([
    { displayName: null }, { endpoint: null }, { endpoint: 'http://127.0.0.1:3001/' }, { endpoint: 'ws://127.0.0.1/api' }, { timeoutMs: '10000' }, { timeoutMs: 0 },
    { autoConnect: null }, { forwardToHarness: 1 }, { receiveGroups: 'true' }, { tokenConfigured: null }, { configurationPath: null }, { dataDirectory: null },
    { instanceId: 'missing' }, { defaultInstanceId: 'missing' }, { updatedAt: 'invalid' }, { instances: null }, { instances: [] }, { oldConnection: {} }, { accessToken: 'never-public' },
  ])('rejects invalid connection or metadata fields without defaulting %j', patch => {
    expect(() => publicConfiguration({ ...currentConfiguration(), ...patch })).toThrowError(invalidResponse)
  })

  it('keeps initialization failure distinct from an invalid Host payload', () => {
    expect(() => publicConfiguration({ initializationError: 'Unreadable QQ configuration' })).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_CORRUPTED', message: 'Unreadable QQ configuration' }))
    for (const invalid of [null, {}, [], { initializationError: null }, { initializationError: 'error', endpoint: '' }]) {
      expect(() => publicConfiguration(invalid)).toThrowError(invalidResponse)
    }
    expect(() => publicConfiguration({})).toThrowError(HostApiError)
  })
})
