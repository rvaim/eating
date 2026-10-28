import { createServer } from 'node:http'
import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'

export interface ModelFixtureRequest {
  readonly model?: string
  readonly stream?: boolean
  readonly messages?: readonly { readonly role?: string; readonly content?: unknown; readonly tool_calls?: unknown }[]
  readonly tools?: readonly { readonly type?: string; readonly function?: { readonly name?: string; readonly parameters?: unknown } }[]
}

interface ModelFixtureReply {
  readonly target: 'private' | 'group'
  readonly text: string
  readonly targetId: string
  readonly requestId: string
}

export interface ModelFixtureBatch {
  readonly kind: 'root' | 'child'
  readonly contextRef: string
  readonly agentTypeId: 'qq.private' | 'qq.group'
  readonly payload: JsonObject
  readonly messageIndex: number
  readonly nativeParentId?: string
}

/** Read the latest whole user envelope, never JSON nested inside external message text. */
export function readModelFixtureBatch(request: ModelFixtureRequest): ModelFixtureBatch | null {
  for (const [messageIndex, message] of [...(request.messages ?? []).entries()].reverse()) {
    if (message.role !== 'user') continue
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.filter(isJsonObject).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : ''
    // Native subagents.sendMessage wraps resumed-child text with its actual sender UUID.
    const native = /^Agent ([a-f0-9-]{36}) sent a message: ([\s\S]+)$/i.exec(text)
    let payload: unknown
    try { payload = JSON.parse(native?.[2] ?? text) } catch { continue }
    if (!isJsonObject(payload) || !isJsonObject(payload.eating) || !isJsonObject(payload.context) || !Array.isArray(payload.events)) continue
    const eating = payload.eating, context = payload.context
    if (eating.protocolVersion !== 1 || !['qq.private', 'qq.group'].includes(String(context.agentTypeId))) continue
    const kind = eating.magic === 'eating-harness-delivery' ? 'root' : 'child'
    const contextRef = kind === 'root' ? eating.batchId : eating.contextRef
    if (typeof contextRef !== 'string' || !/^[a-f0-9]{64}$/.test(contextRef) || context.contextRef !== contextRef
      || kind === 'child' && eating.agentTypeId !== context.agentTypeId) continue
    return { kind, contextRef, agentTypeId: context.agentTypeId as ModelFixtureBatch['agentTypeId'], payload, messageIndex, ...(native ? { nativeParentId: native[1]! } : {}) }
  }
  return null
}

/** A loopback model protocol fixture; it is never imported by production code. */
export async function startOpenAiFixture(options: {
  readonly apiKey?: string
  readonly nativeDelegation?: boolean
  /** With native delegation, invoked once per fresh root batch; continuations use the saved plan. */
  readonly chooseReply?: (request: ModelFixtureRequest, index: number) => ModelFixtureReply | null
} = {}) {
  const requests: ModelFixtureRequest[] = []
  const errors: string[] = []
  const plans = new Map<string, { readonly reply: ModelFixtureReply | null; readonly rootId: string; childSent: boolean }>()
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return }
      if (options.apiKey && request.headers.authorization !== `Bearer ${options.apiKey}`) { response.writeHead(401); response.end(); return }
      const parts: Buffer[] = []; let length = 0
      for await (const part of request) {
        const bytes = Buffer.from(part); length += bytes.length
        if (length > 4 * 1024 * 1024) { response.writeHead(413); response.end(); return }
        parts.push(bytes)
      }
      const payload = JSON.parse(Buffer.concat(parts).toString('utf8')) as ModelFixtureRequest
      requests.push(payload)
      let toolCall: { readonly name: string; readonly arguments: JsonObject } | undefined
      // Nonempty final text is intentional: the Host must never auto-send it to QQ.
      let text = '这是内部处理结果，由模型决定保持沉默。'
      if (options.nativeDelegation) {
        const batch = readModelFixtureBatch(payload)
        if (!batch) throw new Error('Native delegation fixture requires a real Eating user batch envelope')
        const names = payload.tools?.map(item => item.function?.name) ?? []
        if (names.includes('eating_delegate_task')) {
          if (batch.kind !== 'root') throw new Error('Root model request has no root delivery envelope')
          const previous = plans.get(batch.contextRef)
          if (previous) {
            if (previous.reply && !JSON.stringify(payload.messages?.slice(batch.messageIndex + 1).filter(message => message.role === 'tool')).includes(`CHILD-SUMMARY:${batch.contextRef}`)) throw new Error('Root continuation is missing its actual child summary tool result')
            text = previous.reply ? `MAIN-SUMMARY:${batch.contextRef}` : text
          } else {
            const reply = options.chooseReply?.(payload, requests.length - 1) ?? null
            const eating = batch.payload.eating
            if (!isJsonObject(eating) || typeof eating.sessionId !== 'string') throw new Error('Root batch has no native session id')
            plans.set(batch.contextRef, { reply, rootId: eating.sessionId, childSent: false })
            if (reply) {
              if (batch.agentTypeId !== `qq.${reply.target}`) throw new Error('Reply plan disagrees with the verified batch Agent type')
              toolCall = { name: 'eating_delegate_task', arguments: { type_id: batch.agentTypeId, context_ref: batch.contextRef, task: '处理本批绑定会话，依据真实消息决定回复，并向主 Agent 报告工具结果。' } }
            }
          }
        } else {
          if (batch.kind !== 'child') throw new Error('Child model request has no child task envelope')
          const plan = plans.get(batch.contextRef)
          if (!plan?.reply) throw new Error('Child has no reply plan from its actual root delegation')
          if (batch.nativeParentId && batch.nativeParentId !== plan.rootId) throw new Error('Resumed child task sender differs from its actual root')
          const reply = plan.reply
          const name = `mcp__qq__qq_send_${reply.target}_message`
          if (!names.includes(name)) throw new Error('The scoped child does not expose its planned send tool')
          if (plan.childSent) {
            const result = payload.messages?.slice(batch.messageIndex + 1).find(message => message.role === 'tool')
            const received: unknown = typeof result?.content === 'string' ? JSON.parse(result.content) : null
            if (!isJsonObject(received) || typeof received.message_id !== 'number') throw new Error('Child continuation is missing its actual successful send tool result')
            text = `CHILD-SUMMARY:${batch.contextRef}`
          } else {
            plan.childSent = true
            toolCall = { name, arguments: { [reply.target === 'private' ? 'user_id' : 'group_id']: reply.targetId, message: reply.text, request_id: reply.requestId } }
          }
        }
      } else {
        const reply = options.chooseReply?.(payload, requests.length - 1) ?? null
        const name = reply ? payload.tools?.find(item => item.function?.name?.endsWith(reply.target === 'private' ? 'qq_send_private_message' : 'qq_send_group_message'))?.function?.name : undefined
        if (reply && name) toolCall = { name, arguments: { [reply.target === 'private' ? 'user_id' : 'group_id']: reply.targetId, message: reply.text, request_id: reply.requestId } }
      }
      const id = `chatcmpl-fixture-${requests.length}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      const chunk = (delta: JsonObject, finish: string | null, usage?: JsonObject) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: payload.model ?? 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`)
      if (toolCall) {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_fixture_${requests.length}`, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) } }] }, null)
        chunk({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
      } else {
        chunk({ role: 'assistant', content: text }, null)
        chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
      }
      response.end('data: [DONE]\n\n')
    })().catch(error => { errors.push(error instanceof Error ? error.message : String(error)); if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Model fixture did not bind a port')
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, requests, errors, async close(): Promise<void> {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections(); await closed
  } }
}
