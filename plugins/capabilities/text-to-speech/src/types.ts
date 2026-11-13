export const OPENAI_SPEECH_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const
export const DEEPSEEK_SPEECH_VOICES = ['stella', 'tide'] as const
export type SpeechProvider = { protocol: 'openai-realtime'; model: string; voice: string } | { protocol: 'deepseek-tts'; voice: 'stella' | 'tide'; filterMarkdown: boolean }
export interface SpeechConfiguration {
  schemaVersion: 2; revision: number; endpoint: string; provider: SpeechProvider; timeoutMs: number; apiKeyConfigured: boolean; ready: boolean
}
export interface SpeechJob {
  jobId: string; requestId: string; requestHash: string; text: string; delivery: string; protocol: SpeechProvider['protocol']; model: string | null; voice: string
  verification: 'provider-transcript' | 'provider-completion' | null
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown'; createdAt: string; updatedAt: string
  assetId: string | null; byteLength: number | null; durationMs: number | null; errorCode: string | null
}
export function speechDefaults(protocol: SpeechProvider['protocol']): { endpoint: string; provider: SpeechProvider } {
  return protocol === 'deepseek-tts' ? { endpoint: 'wss://api.deepseek.com/v1/tools/tts', provider: { protocol, voice: 'stella', filterMarkdown: true } }
    : { endpoint: 'wss://api.openai.com/v1/realtime', provider: { protocol, model: 'gpt-realtime-2.1-mini', voice: 'marin' } }
}
export function speechVoices(protocol: SpeechProvider['protocol']): readonly string[] { return protocol === 'deepseek-tts' ? DEEPSEEK_SPEECH_VOICES : OPENAI_SPEECH_VOICES }
