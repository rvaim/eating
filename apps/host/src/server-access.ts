import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export interface ServerAccessOptions {
  readonly listenHost?: string
  readonly publicOrigin?: string
  readonly ownerToken?: string
}

export interface ServerAccessConfiguration extends ServerAccessOptions {
  readonly listenHost: '127.0.0.1' | '0.0.0.0'
}

export const OWNER_ACCESS_COOKIE = 'EatingOwnerAccess'

export function validateServerAccess(options: ServerAccessOptions): ServerAccessConfiguration {
  const listenHost = options.listenHost === undefined ? '127.0.0.1' : options.listenHost
  if (listenHost !== '127.0.0.1' && listenHost !== '0.0.0.0') throw new Error('EATING_LISTEN_HOST 仅支持 127.0.0.1 或 0.0.0.0。')
  const publicOrigin = options.publicOrigin
  if (publicOrigin !== undefined) {
    let valid = false
    if (typeof publicOrigin === 'string' && publicOrigin.length <= 2048) {
      try {
        const parsed = new URL(publicOrigin)
        valid = ['http:', 'https:'].includes(parsed.protocol) && publicOrigin === parsed.origin
      } catch {}
    }
    if (!valid) throw new Error('EATING_PUBLIC_ORIGIN 必须是规范的 HTTP(S) Origin，仅含协议、主机与可选端口，不含路径、尾斜线或凭据。')
  }
  const ownerToken = options.ownerToken
  if (ownerToken !== undefined && (typeof ownerToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/u.test(ownerToken))) throw new Error('EATING_OWNER_TOKEN 必须为32至256字符的随机 URL 安全文本，仅支持字母、数字、下划线与短横线。')
  if (listenHost === '0.0.0.0' && (!publicOrigin || !ownerToken)) throw new Error('EATING_LISTEN_HOST=0.0.0.0 必须同时配置 EATING_PUBLIC_ORIGIN 与 EATING_OWNER_TOKEN。')
  return { listenHost, ...(publicOrigin === undefined ? {} : { publicOrigin }), ...(ownerToken === undefined ? {} : { ownerToken }) }
}

export function parseServerAccess(env: Readonly<Record<string, string | undefined>>): ServerAccessConfiguration {
  return validateServerAccess({
    ...(env.EATING_LISTEN_HOST === undefined ? {} : { listenHost: env.EATING_LISTEN_HOST }),
    ...(env.EATING_PUBLIC_ORIGIN === undefined ? {} : { publicOrigin: env.EATING_PUBLIC_ORIGIN }),
    ...(env.EATING_OWNER_TOKEN === undefined ? {} : { ownerToken: env.EATING_OWNER_TOKEN }),
  })
}

export function createOwnerTokenVerifier(ownerToken: string): (candidate: string | null) => boolean {
  const expected = createHash('sha256').update(ownerToken).digest()
  return candidate => typeof candidate === 'string' && candidate.length <= 256
    && timingSafeEqual(createHash('sha256').update(candidate).digest(), expected)
}

export function ownerAccessCookie(request: IncomingMessage): string | undefined {
  const cookies = String(request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${OWNER_ACCESS_COOKIE}=`))
  return cookies.length === 1 ? cookies[0]!.slice(OWNER_ACCESS_COOKIE.length + 1) : undefined
}
