import { createServer } from 'node:http'
import type { JsonObject } from '@eating/plugin-sdk'

export interface ModelFixtureRequest {
  readonly model?: string
  readonly stream?: boolean
  readonly messages?: readonly { readonly role?: string; readonly content?: unknown; readonly tool_calls?: unknown }[]
  readonly tools?: readonly { readonly type?: string; readonly function?: { readonly name?: string; readonly parameters?: unknown } }[]
}

/** A loopback model protocol fixture; it is never imported by production code. */
export async function startOpenAiFixture(options: { readonly apiKey?: string; readonly chooseReply?: (request: ModelFixtureRequest, index: number) => { readonly target: 'private' | 'group'; readonly text: string; readonly targetId: string; readonly requestId: string } | null } = {}) {
  const requests: ModelFixtureRequest[] = []
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
      const index = requests.length - 1
      const reply = options.chooseReply?.(payload, index) ?? null
      const tool = reply ? payload.tools?.find(item => item.function?.name?.endsWith(reply.target === 'private' ? 'qq_send_private_message' : 'qq_send_group_message'))?.function?.name : undefined
      const id = `chatcmpl-fixture-${requests.length}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      const chunk = (delta: JsonObject, finish: string | null, usage?: JsonObject) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: payload.model ?? 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`)
      if (reply && tool) {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_fixture_${requests.length}`, type: 'function', function: { name: tool, arguments: JSON.stringify({ [reply.target === 'private' ? 'user_id' : 'group_id']: reply.targetId, message: reply.text, request_id: reply.requestId }) } }] }, null)
        chunk({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
      } else {
        // Internal assistant text is deliberately nonempty; it must never auto-send to QQ.
        chunk({ role: 'assistant', content: '这是内部处理结果，由模型决定保持沉默。' }, null)
        chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
      }
      response.end('data: [DONE]\n\n')
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Model fixture did not bind a port')
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, requests, async close(): Promise<void> {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections(); await closed
  } }
}
