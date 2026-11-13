import WebSocket from 'ws'
import { isJsonObject, MAX_AUDIO_RESOURCE_BYTES, PlatformError } from '@eating/plugin-sdk'
import type { PrivateConfiguration } from './config'
import { wav } from './audio'

/** A success terminal event is mandatory; a closed connection is never completion. */
export function synthesizeDeepSeek(configuration: PrivateConfiguration, input: string, signal: AbortSignal, authorize: () => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined, submitted = false, settled = false, size = 0
    const chunks: Buffer[] = []
    const error = (code: string, known = false) => new PlatformError(code, 'DeepSeek语音合成未完成，请核对原任务，不自动重试。', 502, submitted && !known ? 'unknown' : submitted ? 'failed' : 'not-sent')
    const finish = (failure?: PlatformError, bytes?: Buffer) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      socket?.terminate()
      if (failure) reject(failure); else resolve(bytes!)
    }
    const abort = () => finish(error('SPEECH_CANCELLED'))
    const timer = setTimeout(() => finish(error('SPEECH_TIMEOUT')), configuration.timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    try {
      authorize(); if (signal.aborted) { abort(); return }
      if (configuration.provider.protocol !== 'deepseek-tts') throw new Error('Wrong adapter')
      const url = new URL(configuration.endpoint)
      url.searchParams.set('voice_id', configuration.provider.voice); url.searchParams.set('format', 'pcm'); url.searchParams.set('filter_markdown', String(configuration.provider.filterMarkdown))
      socket = new WebSocket(url, { headers: { Authorization: 'Bearer ' + configuration.apiKey }, followRedirects: false, maxPayload: MAX_AUDIO_RESOURCE_BYTES, handshakeTimeout: Math.min(15000, configuration.timeoutMs) })
      socket.on('open', () => {
        try { authorize(); if (signal.aborted) { abort(); return }; submitted = true
          socket!.send(JSON.stringify({ event: 'text', text: input })); socket!.send(JSON.stringify({ event: 'finish_text' }))
        } catch { finish(error('SPEECH_CANCELLED')) }
      })
      socket.on('message', (raw, binary) => {
        if (settled) return
        try {
          if (!submitted) throw new Error('Unexpected audio')
          if (binary) {
            const bytes = Buffer.from(raw as Buffer); size += bytes.length
            if (size > MAX_AUDIO_RESOURCE_BYTES - 44) { finish(error('SPEECH_AUDIO_TOO_LONG', true)); return }
            chunks.push(bytes); return
          }
          const event = JSON.parse(raw.toString())
          if (!isJsonObject(event) || event.event !== 'finish' || typeof event.code !== 'string') throw new Error('Invalid terminal')
          if (event.code !== 'success') { finish(error('SPEECH_PROVIDER_REJECTED', true)); return }
          if (!size || size % 2) { finish(error('SPEECH_PROTOCOL_INVALID', true)); return }
          finish(undefined, wav(Buffer.concat(chunks)))
        } catch { finish(error('SPEECH_PROTOCOL_INVALID')) }
      })
      socket.on('unexpected-response', (_request, response) => { response.resume(); finish(error(response.statusCode === 401 || response.statusCode === 403 ? 'SPEECH_AUTH_FAILED' : 'SPEECH_CONNECTION_FAILED', true)) })
      socket.on('error', () => finish(error('SPEECH_CONNECTION_FAILED')))
      socket.on('close', () => { if (!settled) finish(error('SPEECH_CONNECTION_CLOSED')) })
    } catch { finish(error('SPEECH_CONNECTION_FAILED')) }
  })
}
