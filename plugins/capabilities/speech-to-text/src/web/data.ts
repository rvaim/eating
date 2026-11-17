import { isJsonObject } from '@eating/plugin-sdk'
import { HostApiError, hostRequest } from '@eating/ui-sdk'
import type { RecognitionConfiguration, RecognitionJobSummary } from '../types'

const invalid = (): never => {
  throw new HostApiError('ASR_RESPONSE_INVALID', '', 'failed')
}

export function readConfig(v: unknown): RecognitionConfiguration {
  if (
    !isJsonObject(v) ||
    v.schemaVersion !== 1 ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 0 ||
    typeof v.endpoint !== 'string' ||
    !isJsonObject(v.provider) ||
    v.provider.protocol !== 'deepseek-asr' ||
    !Number.isSafeInteger(v.timeoutMs) ||
    Number(v.timeoutMs) < 10000 ||
    Number(v.timeoutMs) > 600000 ||
    typeof v.apiKeyConfigured !== 'boolean' ||
    typeof v.ready !== 'boolean'
  ) {
    return invalid()
  }
  return v as unknown as RecognitionConfiguration
}

export function readPage(v: unknown): { items: RecognitionJobSummary[]; total: number; offset: number; limit: number } {
  if (
    !isJsonObject(v) ||
    !Array.isArray(v.items) ||
    v.items.length > 50 ||
    ['total', 'offset', 'limit'].some(k => !Number.isSafeInteger(v[k]) || Number(v[k]) < 0)
  ) {
    return invalid()
  }
  for (const j of v.items) {
    if (
      !isJsonObject(j) ||
      typeof j.jobId !== 'string' ||
      typeof j.createdAt !== 'string' ||
      !['queued', 'running', 'succeeded', 'failed', 'unknown'].includes(String(j.status)) ||
      (j.textPreview !== null && (typeof j.textPreview !== 'string' || j.textPreview.length > 160)) ||
      typeof j.textTruncated !== 'boolean' ||
      (j.errorCode !== null && typeof j.errorCode !== 'string')
    ) {
      return invalid()
    }
  }
  return v as unknown as ReturnType<typeof readPage>
}

export function readTestConnection(v: unknown): { ok: true; latencyMs: number } {
  if (!isJsonObject(v) || v.ok !== true || typeof v.latencyMs !== 'number' || !Number.isFinite(v.latencyMs) || v.latencyMs < 0) {
    return invalid()
  }
  return { ok: true, latencyMs: Math.round(v.latencyMs) }
}

export const manageRecognition = (operation: string, input: object, signal: AbortSignal) =>
  hostRequest<unknown>('/plugins/speech-to-text/manage', { method: 'POST', body: { operation, input }, signal })

export function errorKey(error: unknown): string {
  const code = error instanceof HostApiError ? error.code : typeof error === 'string' ? error : ''
  return code === 'ASR_CONFIGURATION_CONFLICT'
    ? 'conflict'
    : code === 'ASR_AUTH_FAILED'
      ? 'auth'
      : code === 'ASR_RATE_LIMITED'
        ? 'rateLimited'
        : code === 'ASR_TIMEOUT'
          ? 'timeoutError'
          : ['ASR_CONNECTION_FAILED', 'ASR_PROVIDER_REJECTED'].includes(code)
            ? 'connectionFailed'
            : code === 'INVALID_INPUT_AUDIO'
              ? 'invalidAudio'
              : code === 'ASR_NOT_READY' || code === 'PLUGIN_DISABLED'
                ? 'notReady'
                : ['ASR_STORAGE_FAILED', 'ASR_CAPACITY'].includes(code)
                  ? 'storage'
                  : code === 'ASR_BUSY'
                    ? 'busyError'
                    : 'error'
}
