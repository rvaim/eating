export const SPEECH_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const
export interface SpeechConfiguration {
  schemaVersion: 1; revision: number; endpoint: string; model: string; voice: string; timeoutMs: number; apiKeyConfigured: boolean; ready: boolean
}
export interface SpeechJob {
  jobId: string; requestId: string; requestHash: string; text: string; delivery: string; model: string; voice: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown'; createdAt: string; updatedAt: string
  assetId: string | null; byteLength: number | null; durationMs: number | null; errorCode: string | null
}
