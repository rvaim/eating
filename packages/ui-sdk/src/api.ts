export class HostApiError extends Error {
  constructor(readonly code: string, message: string, readonly outcome: string = 'failed') { super(message); this.name = 'HostApiError' }
}

let initialization: Promise<string> | null = null

async function initialize(): Promise<string> {
  if (!initialization) initialization = fetch('/api/bootstrap', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) }).then(async response => {
    if (!response.ok) throw new HostApiError('HOST_UNAVAILABLE', 'Eating Host 不可用，请确认后台服务已启动。')
    const value = await response.json() as { csrfToken?: unknown }
    if (typeof value.csrfToken !== 'string') throw new HostApiError('INVALID_HOST_RESPONSE', 'Host 初始化响应不兼容。')
    return value.csrfToken
  }).catch(error => { initialization = null; throw error })
  return initialization
}

export async function hostRequest<T>(path: string, options: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const csrfToken = await initialize()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 65000)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(`/api${path}`, { method: options.method ?? 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Eating-Csrf': csrfToken },
      ...(options.method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}), signal: controller.signal })
    const result = await response.json() as { error?: { code?: string; message?: string; outcome?: string } }
    if (!response.ok) {
      if (response.status === 401 || result.error?.code === 'INVALID_CSRF_TOKEN') initialization = null
      throw new HostApiError(result.error?.code ?? 'HOST_ERROR', result.error?.message ?? 'Host 请求失败。', result.error?.outcome)
    }
    return result as T
  } catch (error) {
    if (error instanceof HostApiError) throw error
    if (controller.signal.aborted) throw new HostApiError('REQUEST_INTERRUPTED', '请求中断，动作可能已经发送。请先查询真实状态，不要直接重试。', 'unknown')
    throw new HostApiError('HOST_UNAVAILABLE', '无法连接 Eating Host，请检查后台运行状态。', 'unknown')
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
