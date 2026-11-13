import { PlatformError } from '@eating/plugin-sdk'
import type { PrivateConfiguration, OpenAISpeechConfiguration } from './config'
import { synthesizeOpenAI } from './openai'
import { synthesizeDeepSeek } from './deepseek'
export async function synthesize(configuration: PrivateConfiguration, input: string, delivery: string, signal: AbortSignal, authorize: () => void) {
  if (configuration.provider.protocol === 'openai-realtime') return { bytes: await synthesizeOpenAI(configuration as OpenAISpeechConfiguration, input, delivery, signal, authorize), verification: 'provider-transcript' as const }
  if (delivery) throw new PlatformError('SPEECH_UNSUPPORTED_OPTION', 'DeepSeek当前不支持自定义语气；未提交合成。', 400, 'not-sent')
  return { bytes: await synthesizeDeepSeek(configuration, input, signal, authorize), verification: 'provider-completion' as const }
}
