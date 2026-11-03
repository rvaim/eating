import { describe, expect, it } from 'vitest'
import { analyzeTemplate } from '@eating/plugin-sdk'
import type { AgentInvocationScope, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { assertQQAgentInvocation, createDefaultAgentPolicy, defaultAgentTools, parseQQAgentPolicy, parseQQAgentPolicySave, parseQQAgentTools, parseQQIdentityList, qqAgentInstructions, qqAgentToolPolicy, qqAgentTypes, qqMessageResourceIds, qqSenderRole } from './agent-policy'
import { qqTools } from './operations'
import { qqViewReceivedImageTool } from './media'

const scope: AgentInvocationScope = { agentId: 'agent-private', agentTypeId: 'qq.private', pluginId: 'qq', instanceId: 'instance-a', accountId: '123456', conversationId: 'qq:123456:private:234567', kind: 'private', targetId: '234567', messageIds: ['-12', '42'], resourceIds: ['image-a', 'forward-a'] }
const active = { instanceId: scope.instanceId, accountId: scope.accountId }
const policy = createDefaultAgentPolicy()
const violation = expect.objectContaining({ code: 'AGENT_SCOPE_VIOLATION', statusCode: 403, outcome: 'not-sent' })

describe('QQ agent identity and permission policy', () => {
  it('creates explicit fresh policy defaults, deduplicates multiple identities, and prefers owners', () => {
    expect(policy).toEqual({ owners: [], administrators: [], agentTools: defaultAgentTools(), policyRevision: 0 })
    expect(parseQQAgentPolicy(policy)).toEqual(policy)
    const separate = createDefaultAgentPolicy()
    separate.owners.push('123')
    separate.agentTools['qq.private'].splice(0)
    expect(createDefaultAgentPolicy()).toEqual(policy)
    const identity = { owners: parseQQIdentityList(['123', '456', '123']), administrators: ['123', '789'] }
    expect(identity.owners).toEqual(['123', '456'])
    expect(qqSenderRole('123', identity)).toBe('owner')
    expect(qqSenderRole('456', identity)).toBe('owner')
    expect(qqSenderRole('789', identity)).toBe('administrator')
    expect(qqSenderRole('999', identity)).toBe('user')
  })

  it.each([null, {}, '123', [123], ['0'], ['-1'], ['01'], ['1.0'], ['9007199254740992'], ['12345678901234567'], Array.from({ length: 101 }, (_, i) => String(i + 1))])('rejects invalid identity lists: %j', input => {
    expect(() => parseQQIdentityList(input)).toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_POLICY' }))
  })

  it('derives OneBot permissions and explicitly registers the controlled image extension', () => {
    for (const role of qqAgentTypes(policy)) {
      expect(role.availableTools.every(name => [...qqTools, qqViewReceivedImageTool].some(tool => tool.name === name))).toBe(true)
      expect(role.availableTools).toContain('qq_view_received_image')
      expect(role.defaultTools).toContain('qq_view_received_image')
      expect(role.defaultTools.every(name => role.availableTools.includes(name))).toBe(true)
      expect(role.availableTools).not.toEqual(expect.arrayContaining(['qq_get_friend_list']))
      for (const forbidden of ['qq_get_friend_list', 'qq_get_group_list', 'qq_get_cookies', 'qq_get_csrf_token', 'qq_get_credentials', 'qq_set_restart', 'qq_clean_cache', 'qq_send_message', 'qq_handle_quick_operation']) expect(role.availableTools).not.toContain(forbidden)
      const template = analyzeTemplate(role.defaultPrompt, 'agent')
      expect(template.valid).toBe(true)
      expect(template.tokens.map(token => token.name)).toEqual(['主人', '管理员', '平台', '机器人账号', '会话编号', '会话类型', '目标编号'])
      expect(role.defaultPrompt).not.toContain('{{当前时间}}')
      expect(role.defaultPrompt).toContain('负责此会话的理解、对话与工具决策')
      expect(role.defaultPrompt).toContain('独立理解用户原话、会话历史和当前人格')
      expect(role.defaultPrompt).toContain('自主决定是否回复、怎样回复与需要哪些工具')
      expect(role.defaultPrompt).toContain('需要时调用生图工具并核对结果')
      expect(role.defaultPrompt).toContain('用户明确要求的逐字内容保留原文')
      expect(role.defaultPrompt).toContain('所有会话都是同一个我在不同地方说话')
      expect(role.defaultPrompt).toContain('核实前不发送')
      expect(role.defaultPrompt).toContain('任务明确只核实并回报、不向会话发言时，不调用发送工具')
      expect(role.defaultPrompt).toContain('独立消息气泡要分别调用 QQ 发送工具')
      expect(role.defaultPrompt).toContain('每条使用不同且稳定的 request_id')
      expect(role.defaultPrompt).toContain('结果未知就停下核对')
      expect(role.defaultPrompt).not.toMatch(/那只手|只能照抄/)
      expect(role.defaultPrompt).not.toMatch(/\{\{(?:消息列表|消息内容|发送者列表)\}\}/)
    }
    const groupPrompt = qqAgentTypes(policy).find(role => role.id === 'qq.group')!.defaultPrompt
    expect(groupPrompt).toContain('判断这句话在对谁说')
    expect(groupPrompt).toContain('有相关内容可以主动加入，不必等点名')
    expect(groupPrompt).toContain('不当主持人、气氛组或每场争执的调解人')
    expect(groupPrompt).toContain('有真实关联才提获准记忆')
    const instructions = qqAgentInstructions.map(instruction => instruction.body).join('\n')
    expect(analyzeTemplate(instructions, 'plugin').valid).toBe(true)
    expect(instructions).toContain('先决定实际执行目标')
    expect(instructions).toContain('优先用 eating_handle_conversation，主先判断事实是否充分')
    expect(instructions).toContain('context_ref、显式 mode 和必要的 context_notes')
    expect(instructions).toContain('verify只核实回报，reply才允许发送')
    expect(instructions).toContain('main 不先写完整文案或预判不能画')
    expect(instructions).toContain('明确执行任务或用户明确要求的逐字内容用 eating_delegate_task')
    expect(instructions).toContain('主人可按当前配置调整')
    expect(instructions).toContain('eating_list_contact_targets')
    expect(instructions).toContain('eating_contact_target')
    expect(instructions).not.toContain('根据 Eating 提供的真实批次来源选择')
    expect(qqAgentToolPolicy['qq.group'].availableTools).not.toContain('qq_send_private_message')
    expect(qqAgentToolPolicy['qq.group'].availableTools).not.toContain('qq_get_stranger_info')
    expect(qqAgentToolPolicy['qq.group'].defaultTools).not.toContain('qq_set_group_kick')
    expect(qqAgentToolPolicy['qq.private'].availableTools).not.toContain('qq_send_group_message')
  })

  it.each(['owners', 'administrators', 'agentTools', 'policyRevision'])('rejects persisted policy with missing or null %s', key => {
    const incomplete = Object.fromEntries(Object.entries(policy).filter(([field]) => field !== key))
    for (const input of [incomplete, { ...policy, [key]: null }]) expect(() => parseQQAgentPolicy(input)).toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_POLICY' }))
  })

  it.each([null, [], {}, { ...policy, extra: true }, { ...policy, policyRevision: -1 }, { ...policy, policyRevision: 0.5 }, { ...policy, policyRevision: Number.MAX_SAFE_INTEGER + 1 }])('rejects noncurrent or malformed persisted policy: %j', input => {
    expect(() => parseQQAgentPolicy(input)).toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_POLICY' }))
  })

  it.each([null, [], {}, { unknown: [] }, { 'qq.private': [] }, { 'qq.group': [] }, { 'qq.private': null, 'qq.group': [] }, { 'qq.private': 'all', 'qq.group': [] }, { 'qq.private': ['qq_missing'], 'qq.group': [] }, { 'qq.private': ['qq_send_group_message'], 'qq.group': [] }, { 'qq.private': [], 'qq.group': ['qq_get_stranger_info'] }])('rejects incomplete, unknown, or cross-role tools: %j', input => {
    expect(() => parseQQAgentTools(input)).toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_POLICY' }))
  })

  it('does not add newly available tools when reading an explicit saved selection', () => {
    const agentTools = Object.fromEntries(Object.entries(defaultAgentTools()).map(([id, tools]) => [id, tools.filter(name => name !== 'qq_view_received_image')]))
    const saved = { ...policy, agentTools }
    expect(parseQQAgentPolicy(saved)).toEqual(saved)
    expect(parseQQAgentTools(agentTools)).toEqual(agentTools)
    expect(qqAgentTypes(parseQQAgentPolicy(saved)).every(type => !type.enabledTools.includes('qq_view_received_image'))).toBe(true)
  })

  it('accepts complete explicit empty permissions and saves only complete policy with CAS', () => {
    const agentTools = { 'qq.private': [], 'qq.group': [] }
    expect(parseQQAgentTools(agentTools)).toEqual(agentTools)
    expect(parseQQAgentPolicy({ ...policy, agentTools })).toEqual({ ...policy, agentTools })
    const input = { expectedRevision: 0, owners: [], administrators: [], agentTools }
    expect(parseQQAgentPolicySave(input, policy).policyRevision).toBe(1)
    expect(() => parseQQAgentPolicySave({ ...input, expectedRevision: 1 }, policy)).toThrowError(expect.objectContaining({ code: 'AGENT_POLICY_CONFLICT' }))
    expect(() => parseQQAgentPolicySave({ ...input, agentTools: { 'qq.private': [] } }, policy)).toThrowError()
    for (const key of ['owners', 'administrators', 'agentTools', 'expectedRevision']) {
      expect(() => parseQQAgentPolicySave(Object.fromEntries(Object.entries(input).filter(([field]) => field !== key)), policy)).toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_POLICY' }))
    }
    expect(() => parseQQAgentPolicySave({ ...input, extra: true }, policy)).toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_POLICY' }))
  })
})

describe('QQ agent runtime scope enforcement', () => {
  it.each([
    { agentTypeId: 'qq.group' }, { pluginId: 'other' }, { instanceId: 'instance-b' }, { accountId: '654321' },
    { conversationId: 'qq:123456:private:345678' }, { targetId: '345678' }, { agentId: '' },
  ])('rejects a different trusted binding: %j', patch => {
    expect(() => assertQQAgentInvocation('qq_get_status', {}, { ...scope, ...patch }, policy, active)).toThrowError(violation)
  })

  it('binds private targets and checks current permissions on each invocation', () => {
    expect(() => assertQQAgentInvocation('qq_send_private_message', { user_id: 234567, message: 'hello' }, scope, policy, active)).not.toThrow()
    const inputs: JsonObject[] = [{ user_id: 345678 }, { user_id: 234567, group_id: 111 }, { user_id: 234567, instance_id: 'other' }]
    for (const input of inputs) expect(() => assertQQAgentInvocation('qq_send_private_message', input, scope, policy, active)).toThrowError(violation)
    expect(() => assertQQAgentInvocation('qq_send_private_message', { user_id: 234567 }, scope, { ...policy, agentTools: { ...policy.agentTools, 'qq.private': [] } }, active)).toThrowError(violation)
    expect(() => assertQQAgentInvocation('qq_get_cookies', {}, scope, policy, active)).toThrowError(violation)
  })

  it('binds group operations and member queries to their own group', () => {
    const group: AgentInvocationScope = { ...scope, agentTypeId: 'qq.group', kind: 'group', targetId: '777777', conversationId: 'qq:123456:group:777777' }
    expect(() => assertQQAgentInvocation('qq_get_group_member_info', { group_id: 777777, user_id: 888888 }, group, policy, active)).not.toThrow()
    expect(() => assertQQAgentInvocation('qq_get_group_member_info', { group_id: 999999, user_id: 888888 }, group, policy, active)).toThrowError(violation)
    expect(() => assertQQAgentInvocation('qq_get_stranger_info', { user_id: 888888 }, group, policy, active)).toThrowError(violation)
    expect(() => assertQQAgentInvocation('qq_send_private_message', { user_id: 234567, message: 'another target' }, group, policy, active)).toThrowError(violation)
    expect(() => assertQQAgentInvocation('qq_send_group_message', { group_id: 777777, message: 'another target' }, scope, policy, active)).toThrowError(violation)
    const enabled = { ...policy, agentTools: { ...policy.agentTools, 'qq.group': ['qq_set_group_kick'] } }
    expect(() => assertQQAgentInvocation('qq_set_group_kick', { group_id: 777777, user_id: 888888 }, group, enabled, active)).not.toThrow()
    expect(() => assertQQAgentInvocation('qq_set_group_kick', { group_id: 999999, user_id: 888888 }, group, enabled, active)).toThrowError(violation)
  })

  it('only reads granted messages and resources, including newly granted successful outputs', () => {
    expect(() => assertQQAgentInvocation('qq_view_received_image', { message_id: '-12', image_id: 'image-a' }, scope, policy, active)).not.toThrow()
    for (const params of [{ message_id: '555', image_id: 'image-a' }, { message_id: '-12', image_id: 'other-image' }]) expect(() => assertQQAgentInvocation('qq_view_received_image', params, scope, policy, active)).toThrowError(violation)
    expect(() => assertQQAgentInvocation('qq_view_received_image', { message_id: '-12', image_id: 'image-a' }, scope, { ...policy, agentTools: { ...policy.agentTools, 'qq.private': [] } }, active)).toThrowError(violation)
    expect(() => assertQQAgentInvocation('qq_get_message', { message_id: -12 }, scope, policy, active)).not.toThrow()
    expect(() => assertQQAgentInvocation('qq_get_message', { message_id: 555 }, scope, policy, active)).toThrowError(violation)
    const withDelete = { ...policy, agentTools: { ...policy.agentTools, 'qq.private': [...policy.agentTools['qq.private'], 'qq_delete_message'] } }
    expect(() => assertQQAgentInvocation('qq_delete_message', { message_id: -12 }, scope, withDelete, active)).not.toThrow()
    expect(() => assertQQAgentInvocation('qq_delete_message', { message_id: 555 }, scope, withDelete, active)).toThrowError(violation)
    expect(() => assertQQAgentInvocation('qq_get_message', { message_id: 555 }, { ...scope, messageIds: [...scope.messageIds, '555'] }, policy, active)).not.toThrow()
    for (const [tool, allowed, denied] of [
      ['qq_get_forward_message', { id: 'forward-a' }, { id: 'other-forward' }],
      ['qq_get_image', { file: 'image-a' }, { file: 'other-image' }],
      ['qq_get_record', { file: 'image-a', out_format: 'mp3' }, { file: '/other/local/file', out_format: 'mp3' }],
    ] as const) {
      expect(() => assertQQAgentInvocation(tool, allowed, scope, policy, active)).not.toThrow()
      expect(() => assertQQAgentInvocation(tool, denied, scope, policy, active)).toThrowError(violation)
    }
  })

  it('checks nested node/reply references and unescaped CQ without treating mentions or display identities as authority', () => {
    const run = (message: JsonValue, auto_escape = false) => assertQQAgentInvocation('qq_send_private_message', { user_id: 234567, message, auto_escape }, scope, policy, active)
    expect(() => run([{ type: 'node', data: { user_id: 999999, nickname: 'owner', content: [{ type: 'reply', data: { id: 42 } }] } }, { type: 'at', data: { qq: 'all' } }])).not.toThrow()
    expect(() => run([{ type: 'node', data: { user_id: 999999, nickname: 'owner', content: [{ type: 'reply', data: { id: 999 } }] } }])).toThrowError(violation)
    expect(() => run({ type: 'node', data: { id: '999' } })).toThrowError(violation)
    expect(() => run('[CQ:reply,id=999]')).toThrowError(violation)
    expect(() => run('[CQ:reply,id=42]')).not.toThrow()
    expect(() => run('[CQ:reply,id=42,id=999]')).toThrowError(violation)
    expect(() => run('[CQ:node,user_id=999,nickname=owner,content=&#91;CQ:reply&#44;id=999&#93;]')).toThrowError(violation)
    expect(() => run('[CQ:reply,id=999]', true)).not.toThrow()
  })
})

describe('QQ receive resource grants', () => {
  it('collects bounded references from structured segments or correctly decoded receive CQ segments', () => {
    expect(qqMessageResourceIds('[CQ:image,file=other]')).toEqual(['other'])
    expect(qqMessageResourceIds('&#91;CQ:image,file=other&#93; https://cdn.example.test/picture')).toEqual([])
    expect(qqMessageResourceIds([{ type: 'text', data: { text: '[CQ:image,file=other]' } }])).toEqual([])
    expect(qqMessageResourceIds('[CQ:image,file=image&#91;a&#93;&#44;b&amp;c]')).toEqual(['image[a],b&c'])
    const found = qqMessageResourceIds([{ type: 'text', data: { text: '/local/secret', file: 'not-media' } }, { type: 'image', data: { file: 'image-a', url: 'https://ignored' } }, { type: 'forward', data: { id: 'forward-a' } }, { type: 'node', data: { content: [{ type: 'record', data: { file: 'record-a' } }] } }])
    expect(found.sort()).toEqual(['image-a', 'forward-a', 'record-a'].sort())
    expect(qqMessageResourceIds(Array.from({ length: 300 }, (_, i) => ({ type: 'image', data: { file: String(i) } })))).toHaveLength(256)
    expect(qqMessageResourceIds({ type: 'image', data: { file: 'a'.repeat(2049) } })).toEqual([])
  })
})
