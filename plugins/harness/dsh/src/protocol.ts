export type DshApiProtocol = 'openai-completions' | 'openai-responses' | 'google-generative-ai'

export const DSH_API_PROTOCOLS: readonly DshApiProtocol[] = [
  'openai-completions',
  'openai-responses',
  'google-generative-ai',
] as const
export const DEFAULT_DSH_API_PROTOCOL: DshApiProtocol = 'openai-completions'
export const GOOGLE_GEMINI_DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta'

export function isDshApiProtocol(value: unknown): value is DshApiProtocol {
  return value === 'openai-completions' || value === 'openai-responses' || value === 'google-generative-ai'
}

export function dshRuntimeProviderId(protocol: DshApiProtocol): 'eating-openai' | 'google' {
  return protocol === 'google-generative-ai' ? 'google' : 'eating-openai'
}

export function protocolRequiresApiKey(protocol: DshApiProtocol): boolean {
  return protocol === 'google-generative-ai'
}
