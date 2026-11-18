import { request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { PlatformError, isJsonObject } from '@eating/plugin-sdk'
import type { JsonValue } from '@eating/plugin-sdk'
import { OWNER_ACCESS_COOKIE } from './server-access'
import { SESSION_COOKIE, safeError, json } from './security'

export const DSH_WEB_PROXY_PREFIX = '/dsh-web/'

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailers', 'transfer-encoding', 'upgrade',
])
const UPGRADE_STRIP_HEADERS = new Set(['keep-alive', 'proxy-connection', 'te', 'trailers', 'transfer-encoding'])

/** Validate a loopback DSH Web entry URL emitted by the DSH plugin. */
export function validateLoopbackDshWebEntry(value: JsonValue): URL | undefined {
  if (!isJsonObject(value) || typeof value.url !== 'string') return undefined
  try {
    const parsed = new URL(value.url)
    if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port && !parsed.username && !parsed.password && !parsed.hash) return parsed
  } catch {}
  return undefined
}

/** Rewrite the DSH Web entry URL so browsers stay on the same verified Host/Origin as Eating. */
export function rewriteDshWebLaunch(value: JsonValue, requestHost: string, secure: boolean): { readonly result: JsonValue; readonly upstreamOrigin: string } {
  const upstream = validateLoopbackDshWebEntry(value)
  if (!upstream || !isJsonObject(value)) throw new PlatformError('NATIVE_WEB_NOT_READY', 'DSH Web 入口地址无效。', 502, 'failed')
  const scheme = secure ? 'https:' : 'http:'
  return { upstreamOrigin: upstream.origin, result: { ...value, url: `${scheme}//${requestHost}${DSH_WEB_PROXY_PREFIX}${upstream.search}` } }
}

/** Strip Eating Host owner cookies before forwarding browser requests to the DSH loopback listener. */
export function filterForwardedCookies(rawCookie: string | undefined): string | undefined {
  if (!rawCookie) return undefined
  const kept = rawCookie.split(';').map(item => item.trim()).filter(item => {
    if (!item) return false
    const eq = item.indexOf('=')
    const name = eq === -1 ? item : item.slice(0, eq).trim()
    return name !== OWNER_ACCESS_COOKIE && name !== SESSION_COOKIE
  })
  return kept.length ? kept.join('; ') : undefined
}

/** Scope DSH auth cookies cleanly to `/dsh-web/` and enforce `Secure` when served over HTTPS. */
export function rewriteUpstreamSetCookie(headerValue: string, secure: boolean): string {
  let rewritten = headerValue.replace(/(;\s*path=)\/(?=$|\s*;)/i, `$1${DSH_WEB_PROXY_PREFIX}`)
  if (secure && !/;\s*secure(?=$|\s*;)/i.test(rewritten)) rewritten += '; Secure'
  return rewritten
}

function buildUpstreamHeaders(incoming: IncomingHttpHeaders, upstream: URL, upgrade: boolean): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  const stripped = upgrade ? UPGRADE_STRIP_HEADERS : HOP_BY_HOP_HEADERS
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (stripped.has(lower) || lower === 'host' || lower === 'origin' || lower === 'cookie') continue
    headers[key] = value
  }
  headers.host = upstream.host
  if (typeof incoming.origin === 'string') headers.origin = upstream.origin
  const filteredCookie = filterForwardedCookies(typeof incoming.cookie === 'string' ? incoming.cookie : undefined)
  if (filteredCookie) headers.cookie = filteredCookie
  return headers
}

function rewriteLocation(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') ? `/dsh-web${value}` : value
}

function buildClientHeaders(rawHeaders: IncomingHttpHeaders, secure: boolean): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (lower === 'set-cookie') {
      headers[key] = Array.isArray(value) ? value.map(item => rewriteUpstreamSetCookie(item, secure)) : rewriteUpstreamSetCookie(value, secure)
      continue
    }
    headers[key] = lower === 'location' && typeof value === 'string' ? rewriteLocation(value) : value
  }
  return headers
}

function writeRawResponseHead(socket: Duplex, statusCode: number, statusMessage: string, httpVersion: string, rawHeaders: string[], secure: boolean): void {
  const lines = [`HTTP/${httpVersion} ${statusCode} ${statusMessage}`]
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!
    const value = rawHeaders[i + 1]!
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) continue
    const lower = name.toLowerCase()
    const rewritten = lower === 'set-cookie' ? rewriteUpstreamSetCookie(value, secure)
      : lower === 'location' ? rewriteLocation(value) : value
    lines.push(`${name}: ${rewritten}`)
  }
  socket.write(lines.join('\r\n') + '\r\n\r\n')
}

/** Proxy an authenticated browser HTTP request under `/dsh-web/` to the loopback DSH Web server. */
export function proxyDshWebHttp(
  upstreamOrigin: string,
  upstreamPath: string,
  secure: boolean,
  request: IncomingMessage,
  response: ServerResponse,
  activeRequests: Set<ClientRequest>,
): void {
  const upstream = new URL(upstreamOrigin)
  const proxyReq = httpRequest({
    hostname: upstream.hostname,
    port: Number(upstream.port),
    path: upstreamPath,
    method: request.method,
    headers: buildUpstreamHeaders(request.headers, upstream, false),
  }, proxyRes => {
    response.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, buildClientHeaders(proxyRes.headers, secure))
    proxyRes.pipe(response)
    proxyRes.on('error', () => { if (!response.destroyed) response.destroy() })
  })
  activeRequests.add(proxyReq)
  proxyReq.on('close', () => { activeRequests.delete(proxyReq) })
  proxyReq.on('error', error => {
    activeRequests.delete(proxyReq)
    if (response.destroyed || response.writableEnded) return
    if (response.headersSent) { response.destroy(); return }
    const failure = safeError(error instanceof PlatformError ? error : new PlatformError('NATIVE_WEB_UNAVAILABLE', 'DSH Web 服务暂时不可用，请确认 Harness 正在运行。', 502, 'unknown'))
    json(response, failure.statusCode, { ok: false, error: { code: failure.code, message: failure.message, outcome: failure.outcome } })
  })
  response.on('close', () => { if (!proxyReq.destroyed && !response.writableEnded) proxyReq.destroy() })
  request.pipe(proxyReq)
}

/** Proxy an authenticated WebSocket upgrade under `/dsh-web/` to the loopback DSH Web server. */
export function proxyDshWebUpgrade(
  upstreamOrigin: string,
  upstreamPath: string,
  secure: boolean,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  activeSockets: Set<Duplex>,
): void {
  const upstream = new URL(upstreamOrigin)
  activeSockets.add(socket)
  let cleaned = false
  let upstreamSocket: Duplex | undefined
  const teardown = () => {
    if (cleaned) return
    cleaned = true
    activeSockets.delete(socket)
    if (upstreamSocket) activeSockets.delete(upstreamSocket)
    if (!socket.destroyed) socket.destroy()
    if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy()
  }
  socket.on('error', teardown)
  socket.on('close', teardown)

  const proxyReq = httpRequest({
    hostname: upstream.hostname,
    port: Number(upstream.port),
    path: upstreamPath,
    method: request.method ?? 'GET',
    headers: buildUpstreamHeaders(request.headers, upstream, true),
  })
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    upstreamSocket = proxySocket
    activeSockets.add(proxySocket)
    proxySocket.on('error', teardown)
    proxySocket.on('close', teardown)
    if (socket.destroyed) { teardown(); return }
    writeRawResponseHead(socket, proxyRes.statusCode ?? 101, proxyRes.statusMessage ?? 'Switching Protocols', proxyRes.httpVersion, proxyRes.rawHeaders, secure)
    if (proxyHead.length) socket.write(proxyHead)
    if (head.length) proxySocket.write(head)
    proxySocket.pipe(socket)
    socket.pipe(proxySocket)
  })
  proxyReq.on('response', proxyRes => {
    if (socket.destroyed) { proxyRes.resume(); teardown(); return }
    writeRawResponseHead(socket, proxyRes.statusCode ?? 502, proxyRes.statusMessage ?? 'Bad Gateway', proxyRes.httpVersion, proxyRes.rawHeaders, secure)
    proxyRes.pipe(socket)
    proxyRes.on('end', teardown)
    proxyRes.on('error', teardown)
  })
  proxyReq.on('error', () => {
    if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    teardown()
  })
  proxyReq.end()
}
