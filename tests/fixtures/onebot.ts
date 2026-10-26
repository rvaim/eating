import { once } from 'node:events'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import type { VerifyClientCallbackSync } from 'ws'
import type { JsonObject, JsonValue } from '../../packages/platform-contract/src/index.ts'

export interface OneBotFixtureRequest {
  readonly action: string
  readonly params: JsonObject
  readonly echo: string
}

export interface OneBotFixtureOptions {
  readonly accessToken?: string
  readonly login?: JsonValue
  readonly health?: JsonValue
  /** Return true when the test handled (or deliberately withheld) this reply. */
  readonly onRequest?: (request: OneBotFixtureRequest, peer: WebSocket) => boolean | void
}

export function replyOneBot(peer: WebSocket, request: OneBotFixtureRequest, data: JsonValue, status = 'ok', retcode = 0): void {
  peer.send(JSON.stringify({ status, retcode, data, echo: request.echo }))
}

/** Loopback-only protocol fixture. It is imported exclusively by automated tests. */
export async function startOneBotFixture(options: OneBotFixtureOptions = {}) {
  const verifyClient: VerifyClientCallbackSync = ({ req }) => options.accessToken === undefined
    || req.headers.authorization === `Bearer ${options.accessToken}`
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient })
  const connections: WebSocket[] = []
  const handshakes: Array<{ readonly url: string | undefined; readonly headers: IncomingHttpHeaders }> = []
  const requests: Array<OneBotFixtureRequest & { readonly peer: WebSocket }> = []
  let messageId = 1000
  server.on('connection', (peer, handshake) => {
    connections.push(peer)
    handshakes.push({ url: handshake.url, headers: handshake.headers })
    peer.on('error', () => { /* Deliberate transport failures stay inside the test fixture. */ })
    peer.on('message', raw => {
      const request = JSON.parse(raw.toString()) as OneBotFixtureRequest
      requests.push({ ...request, peer })
      if (options.onRequest?.(request, peer)) return
      switch (request.action) {
        case 'get_login_info': replyOneBot(peer, request, options.login ?? { user_id: 123456789, nickname: '本地协议测试账号' }); break
        case 'get_status': replyOneBot(peer, request, options.health ?? { online: true, good: true }); break
        case 'get_version_info': replyOneBot(peer, request, { app_name: 'Eating protocol test fixture', app_version: '1.0.0', protocol_version: 'v11' }); break
        case 'get_friend_list': replyOneBot(peer, request, [{ user_id: 987654321, nickname: '夹具联系人', remark: '' }]); break
        case 'get_group_list': replyOneBot(peer, request, [{ group_id: 123456, group_name: '夹具测试群' }]); break
        case 'get_msg': replyOneBot(peer, request, { message_id: request.params.message_id ?? 1, message_type: 'private', message: '夹具保存的消息' }); break
        case 'send_private_msg': case 'send_group_msg': replyOneBot(peer, request, { message_id: ++messageId }); break
        case 'delete_msg': replyOneBot(peer, request, null); break
        default: replyOneBot(peer, request, null, 'failed', 1404)
      }
    })
  })
  await once(server, 'listening')
  const endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`
  let closePromise: Promise<void> | undefined
  return {
    endpoint, requests, connections, handshakes,
    emitEvent(event: JsonObject): void {
      for (const peer of server.clients) if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(event))
    },
    close(): Promise<void> {
      closePromise ??= new Promise<void>((resolveClose, reject) => {
        for (const peer of server.clients) peer.terminate()
        server.close(error => error ? reject(error) : resolveClose())
      })
      return closePromise
    },
  }
}
