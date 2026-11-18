import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export interface ServerAccessOptions {
  readonly listenHost?: string
  readonly publicOrigin?: string
  readonly extraOrigins?: readonly string[]
  readonly ownerToken?: string
}

export interface ServerAccessConfiguration extends ServerAccessOptions {
  readonly listenHost: '127.0.0.1' | '0.0.0.0'
}

export const OWNER_ACCESS_COOKIE = 'EatingOwnerAccess'

/** Parse and strictly validate a canonical HTTP(S) Origin string without leaking values. */
export function parseCanonicalOrigin(value: unknown, label: string): URL {
  if (typeof value === 'string' && value.length <= 2048) {
    try {
      const parsed = new URL(value)
      if (['http:', 'https:'].includes(parsed.protocol) && value === parsed.origin) return parsed
    } catch {}
  }
  throw new Error(`${label} 必须是规范的 HTTP(S) Origin，仅含协议、主机与可选端口，不含路径、尾斜线或凭据。`)
}

export function validateServerAccess(options: ServerAccessOptions): ServerAccessConfiguration {
  const listenHost = options.listenHost === undefined ? '127.0.0.1' : options.listenHost
  if (listenHost !== '127.0.0.1' && listenHost !== '0.0.0.0') throw new Error('EATING_LISTEN_HOST 仅支持 127.0.0.1 或 0.0.0.0。')
  const schemesByHost = new Map<string, string>()
  const trackOrigin = (value: unknown, label: string): URL => {
    const parsed = parseCanonicalOrigin(value, label)
    const previous = schemesByHost.get(parsed.host)
    if (previous && previous !== parsed.protocol) throw new Error('EATING_PUBLIC_ORIGIN 与 EATING_EXTRA_ORIGINS 不能为同一主机同时指定 HTTP 与 HTTPS。')
    schemesByHost.set(parsed.host, parsed.protocol)
    return parsed
  }
  const publicOrigin = options.publicOrigin
  if (publicOrigin !== undefined) trackOrigin(publicOrigin, 'EATING_PUBLIC_ORIGIN')
  let extraOrigins: readonly string[] | undefined
  if (options.extraOrigins !== undefined) {
    if (!Array.isArray(options.extraOrigins)) throw new Error('EATING_EXTRA_ORIGINS 必须是规范的 HTTP(S) Origin 列表。')
    const seen = new Set<string>()
    const validated: string[] = []
    for (const candidate of options.extraOrigins) {
      const parsed = trackOrigin(candidate, 'EATING_EXTRA_ORIGINS')
      if (!seen.has(parsed.origin)) { seen.add(parsed.origin); validated.push(parsed.origin) }
    }
    extraOrigins = validated
  }
  const ownerToken = options.ownerToken
  if (ownerToken !== undefined && (typeof ownerToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/u.test(ownerToken))) throw new Error('EATING_OWNER_TOKEN 必须为32至256字符的随机 URL 安全文本，仅支持字母、数字、下划线与短横线。')
  if (listenHost === '0.0.0.0' && (!publicOrigin || !ownerToken)) throw new Error('EATING_LISTEN_HOST=0.0.0.0 必须同时配置 EATING_PUBLIC_ORIGIN 与 EATING_OWNER_TOKEN。')
  return {
    listenHost,
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(extraOrigins === undefined ? {} : { extraOrigins }),
    ...(ownerToken === undefined ? {} : { ownerToken }),
  }
}

export function parseServerAccess(env: Readonly<Record<string, string | undefined>>): ServerAccessConfiguration {
  const rawExtra = env.EATING_EXTRA_ORIGINS
  const extraOrigins = rawExtra === undefined ? undefined : rawExtra.split(',').map(value => value.trim())
  return validateServerAccess({
    ...(env.EATING_LISTEN_HOST === undefined ? {} : { listenHost: env.EATING_LISTEN_HOST }),
    ...(env.EATING_PUBLIC_ORIGIN === undefined ? {} : { publicOrigin: env.EATING_PUBLIC_ORIGIN }),
    ...(extraOrigins === undefined ? {} : { extraOrigins }),
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
