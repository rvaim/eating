import { createServer } from 'node:http'
import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import { readModelFixtureBatch } from './openai'
import type { ModelFixtureRequest } from './openai'

export type FixtureModelAction = string | { readonly name: string; readonly arguments: JsonObject }
export interface FixtureToolTurn {
  readonly name: string
  readonly arguments: JsonObject
  readonly content: unknown
  readonly text: string
}
export function fixtureText(content: unknown): string {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(isJsonObject).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : ''
}

/** Match real model-facing tool results to their actual assistant call, inside the latest Eating batch. */
export function fixtureToolTurns(request: ModelFixtureRequest): FixtureToolTurn[] {
  const batch = readModelFixtureBatch(request)
  if (!batch) throw new Error('Expected a real Eating user envelope')
  const calls = new Map<string, { name: string; arguments: JsonObject }>()
  const turns: FixtureToolTurn[] = []
  for (const message of request.messages?.slice(batch.messageIndex + 1) ?? []) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const value of message.tool_calls) {
        if (!isJsonObject(value) || typeof value.id !== 'string' || !isJsonObject(value.function) || typeof value.function.name !== 'string' || typeof value.function.arguments !== 'string') throw new Error('Unexpected actual tool call wire shape')
        const args: unknown = JSON.parse(value.function.arguments)
        if (!isJsonObject(args)) throw new Error('Actual tool call arguments are not an object')
        calls.set(value.id, { name: value.function.name, arguments: args })
      }
    }
    if (message.role === 'tool') {
      const id: unknown = Reflect.get(message, 'tool_call_id')
      const call = typeof id === 'string' ? calls.get(id) : undefined
      if (!call) throw new Error('Actual tool result has no preceding assistant call in this batch')
      turns.push({ ...call, content: message.content, text: fixtureText(message.content) })
    }
  }
  return turns
}

/** Only the loopback model protocol is fixed; every emitted call must traverse the real native tool executor. */
export async function startStickersModel(choose: (request: ModelFixtureRequest) => FixtureModelAction) {
  const requests: ModelFixtureRequest[] = []
  const actions: FixtureModelAction[] = []
  const errors: string[] = []
  const apiKey = 'stickers-actual-sdk-local-fixture'
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return }
      if (request.headers.authorization !== `Bearer ${apiKey}`) { response.writeHead(401); response.end(); return }
      const chunks: Buffer[] = []; let length = 0
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk); length += bytes.length
        if (length > 4 * 1024 * 1024) throw new Error('Sticker model request exceeds fixture bound')
        chunks.push(bytes)
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelFixtureRequest
      requests.push(payload)
      const action = choose(payload)
      actions.push(action)
      if (typeof action !== 'string' && !payload.tools?.some(tool => tool.function?.name === action.name)) throw new Error(`Fixture attempted a tool absent from the actual request: ${action.name}`)
      const id = `stickers-fixture-${requests.length}`
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      const chunk = (delta: JsonObject, finish: string | null) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: payload.model,
        choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`)
      if (typeof action === 'string') { chunk({ role: 'assistant', content: action }, null); chunk({}, 'stop') }
      else {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_stickers_${requests.length}`, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] }, null)
        chunk({}, 'tool_calls')
      }
      response.end('data: [DONE]\n\n')
    })().catch(error => { errors.push(error instanceof Error ? error.message : String(error)); if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Model fixture did not bind loopback')
  return { apiKey, endpoint: `http://127.0.0.1:${address.port}/v1`, requests, actions, errors, async close() {
    const closed = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()))
    server.closeAllConnections(); await closed
  } }
}
