import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { PlatformError } from '../../../packages/platform-contract/src/index'

export const SESSION_COOKIE = 'EatingOwnerSession'

export function secret(): string { return randomBytes(32).toString('base64url') }

export function sameSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function getBearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined
}

export function validateLocalRequest(request: IncomingMessage, allowedHosts: ReadonlySet<string>, allowedOrigins: ReadonlySet<string>): void {
  if (!request.headers.host || !allowedHosts.has(request.headers.host)) throw new PlatformError('INVALID_HOST', '不允许的 Host。', 403)
  const origin = request.headers.origin
  if (origin && !allowedOrigins.has(origin)) throw new PlatformError('INVALID_ORIGIN', '不允许跨站访问本地管理服务。', 403)
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new PlatformError('CROSS_SITE_REQUEST', '拒绝跨站请求。', 403)
}

export function requireSession(request: IncomingMessage, sessionSecret: string): void {
  const cookies = String(request.headers.cookie ?? '').split(';').map(value => value.trim())
  const value = cookies.find(cookie => cookie.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1)
  if (!sameSecret(value, sessionSecret)) throw new PlatformError('UNAUTHENTICATED', '本地管理会话失效，请刷新页面。', 401)
}

export async function readJson(request: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  const type = request.headers['content-type']?.split(';')[0]?.trim()
  if (type !== 'application/json') throw new PlatformError('INVALID_CONTENT_TYPE', '请求需使用 application/json。', 415)
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += chunk.length
    if (size > limit) throw new PlatformError('PAYLOAD_TOO_LARGE', '请求内容超出大小限制。', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new PlatformError('INVALID_JSON', '请求不是有效 JSON。') }
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
  response.end(JSON.stringify(value))
}

export function safeError(error: unknown): PlatformError {
  return error instanceof PlatformError ? error : new PlatformError('INTERNAL_ERROR', '服务内部错误，请检查运行日志或重试。', 500)
}
