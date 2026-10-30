import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import { IMAGE_GENERATION_LIMITS } from '../types'
import type { ImageGenerationParameters } from '../types'
import type { PrivateImageConfiguration } from './config'
import { base64Image, imageBytes } from './image'
import type { GeneratedImageBytes } from './image'

function failure(code: string, message: string, outcome: 'failed' | 'unknown' = 'unknown'): PlatformError { return new PlatformError(code, message, 502, outcome) }
function canceled(): PlatformError { return failure('IMAGE_GENERATION_CANCELLED', '生图任务已取消或授权已撤销；请求可能已计费，未自动重放。') }

/** One request, no redirects, retries, ambient cookies or proxy credential forwarding. */
function requestBytes(url: URL, signal: AbortSignal, maximum: number, body?: Buffer, apiKey?: string): Promise<{ bytes: Buffer; mime?: string }> {
  return new Promise((accept, reject) => {
    let request: ClientRequest | undefined, response: IncomingMessage | undefined, done = false
    const finish = (error?: unknown, value?: { bytes: Buffer; mime?: string }) => {
      if (done) return
      done = true; signal.removeEventListener('abort', abort)
      if (error) { response?.destroy(); request?.destroy(); reject(error) } else accept(value!)
    }
    const abort = () => finish(canceled())
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try {
      request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: body ? 'POST' : 'GET', agent: false,
        headers: body ? { Authorization: 'Bearer ' + apiKey!, 'Content-Type': 'application/json', 'Content-Length': body.length, Accept: 'application/json', 'Accept-Encoding': 'identity' }
          : { Accept: 'image/png,image/jpeg,image/webp,image/gif', 'Accept-Encoding': 'identity' } }, incoming => {
        response = incoming
        const status = incoming.statusCode ?? 0
        if (status !== 200) {
          if (status >= 300 && status < 400) finish(failure('IMAGE_GENERATION_REDIRECT_REFUSED', '生成或图片服务返回重定向，未跟随；请求可能已计费。'))
          else if (body && status >= 400 && status < 500) finish(failure(`IMAGE_GENERATION_HTTP_${status}`, `生成服务拒绝请求（HTTP ${status}），请核对配置、权限与额度。`, 'failed'))
          else finish(failure(body ? `IMAGE_GENERATION_HTTP_${status || 'FAILED'}` : 'IMAGE_GENERATION_DOWNLOAD_FAILED', '生成或图片服务未返回成功响应；请先核对任务，未自动重试。'))
          return
        }
        const length = incoming.headers['content-length']
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum) || incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') { finish(failure('IMAGE_GENERATION_RESPONSE_TOO_LARGE', '生成服务响应超过允许大小或编码不受支持。')); return }
        const chunks: Buffer[] = []; let received = 0
        incoming.on('data', (value: Buffer) => { received += value.length; if (received > maximum) finish(failure('IMAGE_GENERATION_RESPONSE_TOO_LARGE', '生成服务响应超过允许大小。')); else chunks.push(Buffer.from(value)) })
        incoming.once('aborted', () => finish(failure('IMAGE_GENERATION_NETWORK_ERROR', '生成服务响应中断；请求可能已计费。')))
        incoming.once('error', () => finish(failure('IMAGE_GENERATION_NETWORK_ERROR', '生成服务响应中断；请求可能已计费。')))
        incoming.once('end', () => {
          const mime = incoming.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
          finish(undefined, { bytes: Buffer.concat(chunks), ...(mime ? { mime } : {}) })
        })
      })
      request.once('error', () => finish(failure('IMAGE_GENERATION_NETWORK_ERROR', '生成服务连接中断或不可用；请求可能已计费，未自动重放。')))
      request.end(body)
    } catch { finish(failure('IMAGE_GENERATION_NETWORK_ERROR', '生成服务请求未完成，请核对任务后再继续。')) }
  })
}

export async function generateImage(configuration: PrivateImageConfiguration, input: ImageGenerationParameters, signal: AbortSignal, assertBeforePost: () => void = () => {}): Promise<GeneratedImageBytes> {
  const timeout = new AbortController(), combined = AbortSignal.any([signal, timeout.signal])
  const timer = setTimeout(() => timeout.abort(), configuration.timeoutMs)
  try {
    const size = input.size ?? configuration.size, quality = input.quality ?? configuration.quality, format = input.response_format ?? configuration.responseFormat
    const body = Buffer.from(JSON.stringify({ model: configuration.model, prompt: input.prompt, n: 1, ...(size ? { size } : {}), ...(quality ? { quality } : {}), ...(format ? { response_format: format } : {}) }))
    const endpoint = new URL(configuration.baseUrl.replace(/\/+$/, '') + '/images/generations')
    assertBeforePost()
    const response = await requestBytes(endpoint, combined, 8 * 1024 * 1024, body, configuration.apiKey)
    let value: unknown
    try { value = JSON.parse(response.bytes.toString('utf8')) } catch { throw failure('IMAGE_GENERATION_INVALID_RESPONSE', '生成服务成功响应格式无效；请求可能已计费。') }
    if (!isJsonObject(value) || !Array.isArray(value.data) || !isJsonObject(value.data[0])) throw failure('IMAGE_GENERATION_INVALID_RESPONSE', '生成服务未返回有效图片；请求可能已计费。')
    combined.throwIfAborted()
    const item = value.data[0]
    if (item.b64_json !== undefined) return base64Image(item.b64_json)
    if (typeof item.url !== 'string' || !item.url || item.url.length > 16384) throw failure('IMAGE_GENERATION_INVALID_RESPONSE', '生成服务未返回有效图片；请求可能已计费。')
    let source: URL
    try { source = new URL(item.url) } catch { throw failure('IMAGE_GENERATION_INVALID_RESPONSE', '生成图片地址格式无效；请求可能已计费。') }
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || source.hash) throw failure('IMAGE_GENERATION_INVALID_RESPONSE', '生成图片地址不受支持；请求可能已计费。')
    const downloaded = await requestBytes(source, combined, IMAGE_GENERATION_LIMITS.imageBytes)
    combined.throwIfAborted()
    if (!downloaded.mime) throw failure('IMAGE_GENERATION_INVALID_IMAGE', '生成图片没有有效媒体类型；请求可能已计费。')
    return imageBytes(downloaded.bytes, downloaded.mime)
  } catch (error) {
    if (timeout.signal.aborted) throw failure('IMAGE_GENERATION_TIMEOUT', '生成任务超时；请求可能已计费，未自动重放。')
    if (signal.aborted) throw canceled()
    if (error instanceof PlatformError) throw error
    throw failure('IMAGE_GENERATION_INVALID_RESPONSE', '生成响应未能安全读取；请求可能已计费，未自动重放。')
  } finally { clearTimeout(timer) }
}
