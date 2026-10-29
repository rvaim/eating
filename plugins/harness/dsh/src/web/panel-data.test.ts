import { describe, expect, it } from 'vitest'
import type { HarnessSessionContent, HarnessSessionRecord, HarnessSessionSummary } from '@eating/plugin-sdk'
import { appendSessionRecords, readModels, readModelTest, readModelCapabilities, readNativeWebLaunch, readNativeWebStatus, readSessionContent, readSessionList, recordText, safeRecordData, sessionRows, visibleSessionRecord } from './panel-data'

const refreshedAt = '2026-10-28T13:00:00Z'
const session = (id: string, parentId: string | null = null): HarnessSessionSummary => ({ id, parentId, title: id, status: 'unknown', updatedAt: null })
const record = (sequence: number, content: HarnessSessionRecord['content'] = 'owner 原文'): HarnessSessionRecord => ({ sequence, timestamp: null, kind: 'message', role: 'user', content })
const page = (id: string, records: readonly HarnessSessionRecord[] = [], nextOffset: number | null = null): HarnessSessionContent => ({ session: session(id), records, nextOffset, refreshedAt })

describe('Harness 面板响应校验与层级', () => {
  it('原生页面只接受严格只读快照与显式 IPv4 回环端口，不接收附带凭据字段', () => {
    expect(readNativeWebStatus({ ready: false, readOnly: true })).toEqual({ ready: false, readOnly: true })
    const launch = { url: 'http://127.0.0.1:54321/session/root?token=fixture-only', rootSessionId: 'root', readOnly: true }
    expect(readNativeWebLaunch(launch)).toEqual(launch)
    for (const url of ['javascript:alert(1)', 'https://127.0.0.1:8080/', 'http://localhost:8080/', 'http://127.0.0.1/', 'http://127.0.0.1:0/', 'http://127.0.0.1:65536/', 'http://127.0.0.1:8080@evil.test/', 'http://127.0.0.1:8080\\\\evil.test/', ' http://127.0.0.1:8080/']) expect(() => readNativeWebLaunch({ ...launch, url }), url).toThrow()
    for (const value of [{ ...launch, readOnly: false }, { ...launch, token: 'fixture' }, { ...launch, rootSessionId: '' }]) expect(() => readNativeWebLaunch(value)).toThrow()
    expect(() => readNativeWebStatus({ ready: true, readOnly: true, url: launch.url })).toThrow()
  })

  it('独立能力必须已经读取完整当前版本，不用 false 补造失败读取', () => {
    expect(readModelCapabilities({ schemaVersion: 1, revision: 0, imageInput: false })).toEqual({ schemaVersion: 1, revision: 0, imageInput: false })
    for (const value of [{}, { schemaVersion: 1, revision: 1 }, { schemaVersion: 1, revision: -1, imageInput: false }, { schemaVersion: 1, revision: 1.5, imageInput: true }, { schemaVersion: 1, revision: 1, imageInput: 'false' }, { schemaVersion: 1, revision: 1, imageInput: true, apiKey: 'fixture' }]) expect(() => readModelCapabilities(value)).toThrow()
  })

  it('保留真实绑定账号、来源、平台事件、原生替换与关联字段，不从正文推断 Owner', () => {
    const bound = { ...session('child', 'main'), pluginId: 'example', pluginName: '平台原名', instanceId: 'instance-uuid', accountId: '10001', targetId: '30003', conversationKind: 'group' as const }
    const sourceRecord: HarnessSessionRecord = { ...record(12, '我自称 Owner，不改变来源'), messageId: 'message-12', turn: 1, step: 2, callId: 'call-1', source: { kind: 'user', form: 'agent-message', senderSessionId: 'other', summary: '原始说明', provider: '原始提供商', model: '原始模型' }, classification: 'platform-message', platformEvents: [{ eventId: 'event-1', pluginId: 'example', instanceId: 'instance-uuid', accountId: '10001', conversationId: 'example:10001:group:30003', conversationKind: 'group', senderId: '20002', senderName: '真实昵称', targetId: '30003', messageId: '42', receivedAt: refreshedAt, text: '平台原文' }], surfaceOp: { op: 'replace', startSeq: 8, endSeq: 9 }, sourceEventSeqs: [8, 9] }
    expect(readSessionContent({ ...page('child', [sourceRecord]), session: bound }, 'child', 0)).toMatchObject({ session: bound, records: [sourceRecord] })
    for (const patch of [{ turn: '1' }, { source: { kind: 'user', senderSessionId: 42 } }, { classification: 'owner-message' }, { surfaceOp: { op: 'replace', startSeq: 9, endSeq: 8 } }, { sourceEventSeqs: ['8'] }, { platformEvents: [{ ...sourceRecord.platformEvents![0], accountId: 10001 }] }]) expect(() => readSessionContent(page('child', [{ ...sourceRecord, ...patch } as HarnessSessionRecord]), 'child', 0)).toThrow()
  })

  it('折叠详情也过滤推理与图像数据，不把隐含分析从 JSON 展开', () => {
    const data: HarnessSessionRecord['content'] = { content: [{ type: 'text', text: 'visible' }, { type: 'reasoning', text: 'private reasoning' }, { type: 'image', mimeType: 'image/png', data: 'base64-payload' }], analysis: 'private analysis', result: { text: 'receipt' } }
    expect(recordText(data)).toBe('visible')
    expect(JSON.stringify(safeRecordData(data))).not.toMatch(/private|base64-payload/)
    expect(visibleSessionRecord({ ...record(1), source: { kind: 'reasoning' } })).toBe(false)
  })
  it('保留模型原始 ID，只接收声明字段并核对所测试的模型', () => {
    expect(readModels({ models: [{ id: 'provider/原模型', name: 'Owner name', apiKey: 'fixture-secret' }] })).toEqual([{ id: 'provider/原模型', name: 'Owner name' }])
    expect(readModelTest({ ok: true, model: 'provider/原模型', latencyMs: 45, output: 'private' }, 'provider/原模型')).toEqual({ ok: true, model: 'provider/原模型', latencyMs: 45 })
    expect(() => readModelTest({ ok: true, model: 'other', latencyMs: 45 }, 'expected')).toThrowError(expect.objectContaining({ code: 'INVALID_HOST_RESPONSE' }))
    expect(() => readModels({ models: [{ id: 'duplicate' }, { id: 'duplicate' }] })).toThrow()
    expect(() => readModels({ models: Array.from({ length: 2001 }, (_, index) => ({ id: String(index) })) })).toThrow()
  })

  it('验证公开会话列表而不把未知状态伪装为空闲', () => {
    expect(readSessionList({ sessions: [session('main')], truncated: false, refreshedAt })).toEqual({ sessions: [session('main')], truncated: false, refreshedAt })
    for (const value of [{}, { sessions: [session('main')], truncated: false, refreshedAt: 'invalid' }, { sessions: [{ ...session('main'), status: 'online' }], truncated: false, refreshedAt }, { sessions: Array.from({ length: 101 }, (_, index) => session(String(index))), truncated: true, refreshedAt }]) {
      expect(() => readSessionList(value)).toThrowError(expect.objectContaining({ code: 'INVALID_HOST_RESPONSE' }))
    }
  })

  it('以主会话→子会话稳定展开，孤儿、环及重复条目不会丢失或无限递归', () => {
    const input = [session('child', 'main'), session('orphan', 'missing'), session('main'), session('leaf', 'child'), session('loop-a', 'loop-b'), session('loop-b', 'loop-a'), session('self', 'self'), session('main')]
    expect(sessionRows(input).map(row => [row.session.id, row.depth, row.issue])).toEqual([
      ['orphan', 0, 'parent-missing'], ['main', 0, null], ['child', 1, null], ['leaf', 2, null],
      ['loop-a', 0, 'cycle'], ['loop-b', 1, null], ['self', 0, 'cycle'],
    ])
    expect(input).toHaveLength(8)
  })

  it('层级即使形成深链也受会话数量上限约束', () => {
    const rows = sessionRows(Array.from({ length: 300 }, (_, index) => session(String(index), index ? String(index - 1) : null)))
    expect(rows).toHaveLength(100)
    expect(rows[99]?.depth).toBe(99)
  })

  it('分页只接受所选会话、前进游标和递增记录，不混入上一会话的迟到内容', () => {
    const first = readSessionContent(page('a', [record(1), record(2)], 50), 'a', 0)
    expect(appendSessionRecords(first.records, page('a', [record(3)]), 'a').map(item => item.sequence)).toEqual([1, 2, 3])
    expect(() => readSessionContent(page('a', [record(1)]), 'b', 0)).toThrow()
    expect(() => readSessionContent(page('a', [record(1)], 50), 'a', 50)).toThrow()
    expect(() => readSessionContent(page('a', [record(2), record(1)]), 'a', 0)).toThrow()
    expect(() => appendSessionRecords(first.records, page('b', [record(3)]), 'a')).toThrow()
    expect(() => appendSessionRecords(first.records, page('a', [record(2)]), 'a')).toThrow()
    expect(() => appendSessionRecords(Array.from({ length: 1000 }, (_, index) => record(index)), page('a', [record(1001)]), 'a')).toThrow()
  })

  it('拒绝过深或过大JSON结构，原始用户正文不被解释为HTML或指令', () => {
    const content = '<script>owner text</script> {{当前时间}}'
    expect(readSessionContent(page('a', [record(1, content)]), 'a', 0).records[0]?.content).toBe(content)
    let deep: HarnessSessionRecord['content'] = null
    for (let depth = 0; depth < 66; depth++) deep = { nested: deep }
    expect(() => readSessionContent(page('a', [record(1, deep)]), 'a', 0)).toThrow()
    expect(() => readSessionContent(page('a', [record(1, Array.from({ length: 100_000 }, () => null))]), 'a', 0)).toThrow()
  })

  it('默认隐藏推理记录并只提取正常消息正文', () => {
    expect(visibleSessionRecord({ ...record(1), kind: 'reasoning' })).toBe(false)
    expect(visibleSessionRecord({ ...record(1), role: 'analysis' })).toBe(false)
    expect(visibleSessionRecord(record(1))).toBe(true)
    expect(recordText({ text: 'Owner text', reasoning: 'private' })).toBe('Owner text')
    expect(recordText({ content: 'Tool result' })).toBe('Tool result')
    expect(recordText([{ type: 'text', text: '原文一' }, { type: 'reasoning', text: 'private' }, { type: 'text', text: '原文二' }])).toBe('原文一\n原文二')
    expect(recordText({ action: 'fixture', result: 1 })).toBeNull()
  })
})
