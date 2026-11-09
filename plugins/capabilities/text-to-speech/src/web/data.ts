import { checkedAudioBytes, isJsonObject, MAX_AUDIO_RESOURCE_BYTES } from '@eating/plugin-sdk'
import { HostApiError, hostRequest } from '@eating/ui-sdk'
import type { SpeechConfiguration, SpeechJob } from '../types'
import { SPEECH_VOICES } from '../types'
const invalid = (): never => { throw new HostApiError('SPEECH_RESPONSE_INVALID', '', 'failed') }
export function readConfig(value: unknown): SpeechConfiguration {
  if (!isJsonObject(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.endpoint !== 'string' || typeof value.model !== 'string' || !SPEECH_VOICES.includes(value.voice as typeof SPEECH_VOICES[number]) || !Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 10000 || Number(value.timeoutMs) > 300000 || typeof value.apiKeyConfigured !== 'boolean' || typeof value.ready !== 'boolean') return invalid()
  return value as unknown as SpeechConfiguration
}
export function readPage(value: unknown): { items: SpeechJob[]; total: number; offset: number; limit: number } {
  if (!isJsonObject(value) || !Array.isArray(value.items) || value.items.length > 50 || ['total', 'offset', 'limit'].some(k => !Number.isSafeInteger(value[k]) || Number(value[k]) < 0)) return invalid()
  for (const job of value.items) if (!isJsonObject(job) || !['queued', 'running', 'succeeded', 'failed', 'unknown'].includes(String(job.status)) || ['jobId', 'text', 'voice', 'createdAt', 'updatedAt'].some(k => typeof job[k] !== 'string') || job.assetId !== null && (typeof job.assetId !== 'string' || !/^[a-f0-9]{64}$/.test(job.assetId)) || job.durationMs !== null && (typeof job.durationMs !== 'number' || job.durationMs < 0 || job.durationMs > 60000) || job.errorCode !== null && typeof job.errorCode !== 'string') return invalid()
  return value as unknown as ReturnType<typeof readPage>
}
export function audioBlob(value: unknown): Blob {
  if (!isJsonObject(value) || value.mimeType !== 'audio/wav' || typeof value.data !== 'string' || value.data.length > Math.ceil(MAX_AUDIO_RESOURCE_BYTES / 3) * 4 || value.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return invalid()
  const raw = atob(value.data); if (btoa(raw) !== value.data) return invalid()
  const bytes = checkedAudioBytes(Uint8Array.from(raw, c => c.charCodeAt(0)), 'audio/wav')
  return new Blob([new Uint8Array(bytes)], { type: 'audio/wav' })
}
export const manageSpeech = (operation: string, input: object, signal: AbortSignal) => hostRequest<unknown>('/plugins/text-to-speech/manage', { method: 'POST', body: { operation, input }, signal })
export function errorKey(error: unknown): string {
  const code = error instanceof HostApiError ? error.code : typeof error === 'string' ? error : ''
  return code === 'SPEECH_CONFIGURATION_CONFLICT' ? 'conflict' : code === 'SPEECH_AUTH_FAILED' ? 'auth' : code === 'SPEECH_TEXT_MISMATCH' ? 'mismatch' : code === 'SPEECH_AUDIO_TOO_LONG' ? 'tooLong' : code === 'SPEECH_NOT_READY' ? 'notReady' : ['SPEECH_STORAGE_FAILED', 'SPEECH_CAPACITY'].includes(code) ? 'storage' : 'error'
}
