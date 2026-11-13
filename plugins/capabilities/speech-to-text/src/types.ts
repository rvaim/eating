export interface RecognitionConfiguration { schemaVersion: 1; revision: number; endpoint: string; provider: { protocol: 'deepseek-asr' }; timeoutMs: number; apiKeyConfigured: boolean; ready: boolean }
export type RecognitionSource = { kind: 'received'; messageId: string; audioId: string } | { kind: 'upload' }
export interface RecognitionJob {
  jobId: string; requestId: string; requestHash: string; owner: string | null; source: RecognitionSource
  protocol: 'deepseek-asr'; audioSha256: string; byteLength: number; mimeType: 'audio/wav' | 'audio/ogg'; inputDurationMs: number
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown'; createdAt: string; updatedAt: string
  text: string | null; durationMs: number | null; providerRequestId: string | null; errorCode: string | null
}

export type RecognitionJobSummary = Omit<RecognitionJob, 'text'> & { textPreview: string | null; textTruncated: boolean }
