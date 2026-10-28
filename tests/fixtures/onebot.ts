import { once } from 'node:events'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import type { VerifyClientCallbackSync } from 'ws'
import type { JsonObject, JsonValue } from '@eating/plugin-sdk'
import { ONEBOT_V11_HIDDEN_ACTIONS, ONEBOT_V11_PUBLIC_ACTIONS } from './onebot-v11-contract.ts'

const knownActions = new Set<string>([...ONEBOT_V11_PUBLIC_ACTIONS, ...ONEBOT_V11_HIDDEN_ACTIONS])
const fixtureCookies = 'eating_test_only_cookie=ONEBOT_FIXTURE_NOT_A_REAL_SECRET'
const fixtureCsrfToken = 19088743
const fixtureGroup = { group_id: 123456, group_name: '夹具测试群', member_count: 2, max_member_count: 200 }
function fixtureMember(groupId: JsonValue = 123456, userId: JsonValue = 987654321): JsonObject {
  return { group_id: groupId, user_id: userId, nickname: '夹具群成员', card: '', sex: 'unknown', age: 0, area: '',
    join_time: 1700000000, last_sent_time: 1700000001, level: '1', role: 'member', unfriendly: false,
    title: '', title_expire_time: 0, card_changeable: true }
}

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
      const baseAction = request.action.replace(/_(?:async|rate_limited)$/, '')
      if (baseAction !== request.action && knownActions.has(baseAction)) {
        replyOneBot(peer, request, null, 'async', 1)
        return
      }
      switch (request.action) {
        case 'get_login_info': replyOneBot(peer, request, options.login ?? { user_id: 123456789, nickname: '本地协议测试账号' }); break
        case 'get_status': replyOneBot(peer, request, options.health ?? { online: true, good: true }); break
        case 'get_version_info': replyOneBot(peer, request, { app_name: 'Eating protocol test fixture', app_version: '1.0.0', protocol_version: 'v11' }); break
        case 'get_friend_list': replyOneBot(peer, request, [{ user_id: 987654321, nickname: '夹具联系人', remark: '' }]); break
        case 'get_group_list': replyOneBot(peer, request, [{ group_id: 123456, group_name: '夹具测试群' }]); break
        case 'get_msg': replyOneBot(peer, request, { message_id: request.params.message_id ?? 1, message_type: 'private', message: '夹具保存的消息' }); break
        case 'get_forward_msg': replyOneBot(peer, request, { message: [{ type: 'node', data: {
          user_id: '987654321', nickname: '夹具转发节点', content: [
            { type: 'image', data: { file: 'fixture-received-image.jpg', url: 'https://fixture.invalid/received-image.jpg', type: 'flash' } },
            { type: 'text', data: { text: '原始 [CQ:face,id=14] & 保留' } },
          ],
        } }] }); break
        case 'get_stranger_info': replyOneBot(peer, request, { user_id: request.params.user_id ?? 987654321, nickname: '夹具陌生人', sex: 'unknown', age: 0 }); break
        case 'get_group_info': replyOneBot(peer, request, { ...fixtureGroup, group_id: request.params.group_id ?? 123456 }); break
        case 'get_group_member_info': replyOneBot(peer, request, fixtureMember(request.params.group_id, request.params.user_id)); break
        case 'get_group_member_list': replyOneBot(peer, request, [fixtureMember(request.params.group_id)]); break
        case 'get_group_honor_info': replyOneBot(peer, request, { group_id: request.params.group_id ?? 123456,
          talkative_list: [], performer_list: [], legend_list: [], strong_newbie_list: [], emotion_list: [] }); break
        case 'get_cookies': replyOneBot(peer, request, { cookies: fixtureCookies }); break
        case 'get_csrf_token': replyOneBot(peer, request, { token: fixtureCsrfToken }); break
        case 'get_credentials': replyOneBot(peer, request, { cookies: fixtureCookies, csrf_token: fixtureCsrfToken }); break
        // These are opaque paths on the simulated OneBot server, never local files.
        case 'get_record': replyOneBot(peer, request, { file: '/onebot-fixture-only/media/record/converted.ogg' }); break
        case 'get_image': replyOneBot(peer, request, { file: '/onebot-fixture-only/media/image/downloaded.jpg' }); break
        case 'can_send_image': case 'can_send_record': replyOneBot(peer, request, { yes: true }); break
        case 'send_private_msg': case 'send_group_msg': case 'send_msg': replyOneBot(peer, request, { message_id: ++messageId }); break
        case 'delete_msg': case 'send_like': case 'set_group_kick': case 'set_group_ban': case 'set_group_anonymous_ban':
        case 'set_group_whole_ban': case 'set_group_admin': case 'set_group_anonymous': case 'set_group_card':
        case 'set_group_name': case 'set_group_leave': case 'set_group_special_title': case 'set_friend_add_request':
        case 'set_group_add_request': case 'clean_cache': case '.handle_quick_operation': replyOneBot(peer, request, null); break
        case 'set_restart': replyOneBot(peer, request, null, 'async', 1); break
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
