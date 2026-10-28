import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { getLocale, setLocale } from '@eating/ui-sdk'
import type { AgentTypeDefinition } from '@eating/plugin-sdk'
import { AgentPolicyFields, agentPolicyDraft, parseIdentityText } from './agent-policy-fields'
import { qqTools } from '../backend/operations'
import { qqAgentTypes, parseQQAgentPolicy } from '../backend/agent-policy'

const initialLocale = getLocale()
afterEach(() => { setLocale(initialLocale) })

describe('QQ agent policy form helpers', () => {
  it('accepts newline, comma, full-width comma and whitespace separators and canonicalizes duplicates', () => {
    expect(parseIdentityText('123456\n234567,345678 456789，123456\t567890')).toEqual(['123456', '234567', '345678', '456789', '567890'])
    expect(parseIdentityText(' \n,，\t')).toEqual([])
    for (const invalid of ['0', '-1', '00123', '123.4', '9e5', '9007199254740992', '12345678901234567']) expect(parseIdentityText(invalid)).toBeNull()
    expect(parseIdentityText(Array.from({ length: 101 }, (_, i) => String(i + 1)).join('\n'))).toBeNull()
  })

  it('keeps identity numbers and revision separate from connection form drafts and copies Host tool selections', () => {
    const policy = parseQQAgentPolicy({ owners: ['123', '456'], administrators: ['789'], policyRevision: 7 })
    const types = qqAgentTypes(policy)
    const draft = agentPolicyDraft({ ...policy, endpoint: 'ws://fixture/', tokenConfigured: true }, types)
    expect(draft).toEqual({ owners: '123\n456', administrators: '789', expectedRevision: 7, agentTools: policy.agentTools })
    draft.agentTools['qq.private'].splice(0)
    expect(policy.agentTools['qq.private'].length).toBeGreaterThan(0)
    expect(draft).not.toHaveProperty('accessToken')
    expect(draft).not.toHaveProperty('endpoint')
    expect(agentPolicyDraft({}, types).agentTools['qq.private']).toEqual(types[0]!.enabledTools)
    expect(agentPolicyDraft({ agentTools: { 'qq.private': [], 'qq.group': [] } }, types).agentTools).toEqual({ 'qq.private': [], 'qq.group': [] })
  })

  it('renders only the tools registered for each Host role, with translated copy and stable owner numbers', () => {
    setLocale('en-US')
    const policy = parseQQAgentPolicy({ owners: ['123456789'], administrators: [] })
    const types: AgentTypeDefinition[] = qqAgentTypes(policy).map(type => ({ ...type, availableTools: ['qq_get_status'], enabledTools: ['qq_get_status'], defaultTools: ['qq_get_status'] }))
    const html = renderToStaticMarkup(createElement(AgentPolicyFields, { configuration: { ...policy }, agentTypes: types, tools: qqTools, enabled: true, busy: false, actionLock: { current: false }, onBusy: () => {}, onSaved: () => {}, onFeedback: () => {} }))
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
})
