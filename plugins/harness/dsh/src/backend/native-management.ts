import { PlatformError, isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import { readRestrictedJson } from './config'
import { join } from 'node:path'

export async function requestNativeManagement(directory: string, nonce: string, token: string, operation: string, input: JsonObject, signal: AbortSignal): Promise<JsonObject> {
  const record = readRestrictedJson(join(directory, 'native-control.json'))
  if (record?.schemaVersion !== 1 || record.nonce !== nonce || typeof record.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(record.url)) throw new PlatformError('NATIVE_CONTROL_NOT_READY', '原生能力管理接口尚未就绪，请重新读取目录。', 409, 'not-sent')
  let response: Response
  try { response = await fetch(record.url, { method: 'POST', redirect: 'error', signal, headers: { Authorization: `Bearer ${token}`, 'X-Eating-Runtime': nonce, ...(operation === 'append-delivery' ? { 'X-Eating-Delivery': 'true' } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify({ protocolVersion: 1, operation, input }) }) }
  catch { throw new PlatformError('NATIVE_CONTROL_UNKNOWN', '原生管理请求结果尚未确认，请重新读取当前状态后再操作。', 504, ['list', 'inspect', 'validate'].includes(operation) ? 'failed' : 'unknown') }
  const chunks: Uint8Array[] = []; let bytes = 0
  if (!response.body) throw new PlatformError('NATIVE_CONTROL_INVALID', '原生管理接口返回了无效响应。', 502)
  const reader = response.body.getReader()
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new PlatformError('NATIVE_RESULT_TOO_LARGE', '原生能力目录超过读取上限。', 502) } chunks.push(value) }
  } finally { reader.releaseLock() }
  let body: unknown
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new PlatformError('NATIVE_CONTROL_INVALID', '原生管理接口返回了无效响应。', 502) }
  if (!isJsonObject(body) || body.protocolVersion !== 1) throw new PlatformError('NATIVE_CONTROL_INVALID', '原生管理接口协议不匹配。', 502)
  if (!response.ok || body.error) {
    const code = isJsonObject(body.error) && typeof body.error.code === 'string' && /^NATIVE_[A-Z_]+$/.test(body.error.code) ? body.error.code : 'NATIVE_OPERATION_FAILED'
    throw new PlatformError(code, '原生 DSH 未完成此操作，请核对目录、依赖和当前状态。', 409, code === 'NATIVE_OPERATION_FAILED' && !['list', 'inspect', 'validate'].includes(operation) ? 'unknown' : 'failed')
  }
  if (!isJsonObject(body.result)) throw new PlatformError('NATIVE_CONTROL_INVALID', '原生管理接口结果格式无效。', 502)
  return body.result
}
