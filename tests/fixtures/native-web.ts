import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'

function object(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected an official native Web object')
  return value
}

export interface NativeWebSession extends JsonObject {
  readonly sessionId: string
}

/** Real owner entry exchange and official RPCs, without an Eating session projection. */
export async function connectNativeWeb(value: unknown, expectedRootId: string) {
  const entry = object(value)
  if (Object.keys(entry).sort().join(',') !== 'rootSessionId,url' || entry.rootSessionId !== expectedRootId || typeof entry.url !== 'string') throw new Error('Native Web entry does not identify the expected test root')
  const url = new URL(entry.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('Native Web fixture requires the isolated loopback entry')
  const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  const cookie = auth.headers.get('set-cookie')?.split(';')[0]
  await auth.arrayBuffer()
  if (auth.status !== 303 || !cookie) throw new Error(`Native Web owner entry exchange failed (${auth.status})`)
  const origin = url.origin
  const rpc = async (method: string, args: JsonObject): Promise<JsonObject> => {
    const response = await fetch(new URL('/api/' + method, origin), { method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })
    const body = object(await response.json()), result = object(body.result)
    if (!response.ok || result.ok !== true) throw new Error(`Official native Web RPC ${method} failed (${response.status}): ${JSON.stringify(result)}`)
    return object(result.value)
  }
  return {
    origin, rootSessionId: expectedRootId, rpc,
    async listSessions(): Promise<NativeWebSession[]> {
      const result = await rpc('session/list', { _request: {} })
      if (!Array.isArray(result.items)) throw new Error('Official session/list did not return items')
      return result.items.map(value => {
        const item = object(value)
        if (typeof item.sessionId !== 'string' || !item.sessionId) throw new Error('Official session/list item has no sessionId')
        return item as NativeWebSession
      })
    },
    async events(sessionId: string, parentSessionId?: string): Promise<JsonObject[]> {
      const projections = await rpc('session/projections', { request: { sessionId } })
      if (projections.kind !== 'sequenced' || typeof projections.asOfSeq !== 'number' || !Number.isSafeInteger(projections.asOfSeq)) throw new Error('Official session projections have no exact event sequence')
      let address: JsonObject = { kind: 'session', sessionId }
      if (parentSessionId !== undefined) {
        const identity = object(object(projections.values).subagent)
        if (identity.mode !== 'one-shot' && identity.mode !== 'continuable') throw new Error('Official child projection has no subagent identity')
        address = { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: identity.mode }
      }
      const page = await rpc('session/page', { request: { address, throughSeq: projections.asOfSeq, maxMessages: 200 } })
      if (!Array.isArray(page.records) || page.hasMore !== false) throw new Error('Expected the complete bounded official test history page')
      return page.records.map(value => {
        const record = object(value), event = object(record.event)
        if (record.type !== 'event' || typeof event.type !== 'string' || typeof event.seq !== 'number') throw new Error('Official session/page returned an invalid event record')
        return event
      })
    },
  }
}

/** Read only bindings generated inside the calling test's fresh temporary Eating home. */
export async function readTestAgentBindings(home: string): Promise<JsonObject[]> {
  const document = object(JSON.parse(await readFile(join(home, 'harness/dsh/agent-bindings.json'), 'utf8')))
  if (document.schemaVersion !== 2 || !Array.isArray(document.bindings)) throw new Error('Expected current temporary Agent bindings')
  return document.bindings.map(object)
}
