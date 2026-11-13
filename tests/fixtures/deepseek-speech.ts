import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
export type DeepSeekSpeechMode = 'success' | 'close' | 'reject' | 'hold' | 'oversize' | 'malformed' | 'long'
export async function startDeepSeekSpeechFixture(mode: DeepSeekSpeechMode = 'success') {
  const synthesis: Array<{ text: string; parameters: Record<string, string> }> = [], recognition: Array<{ fields: string[]; bytes: Uint8Array; mimeType: string; authorization: string | undefined }> = []
  const pending: Array<() => void> = [], sockets = new Set<WebSocket>()
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== '/v1/tools/asr' || request.method !== 'POST') { response.writeHead(404).end(); return }
      if (request.headers.authorization !== 'Bearer fixture-deepseek-key') { response.writeHead(401).end(); return }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': String(request.headers['content-type']) } }).formData(), file = form.get('file')
      if (!(file instanceof File)) throw new Error('Missing fixture audio')
      recognition.push({ fields: [...form.keys()], bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type, authorization: request.headers.authorization })
      const send = () => {
        if (mode === 'reject') { response.writeHead(400).end('Fixture provider rejection'); return }
        if (mode === 'close') { response.destroy(); return }
        response.writeHead(200, { 'content-type': 'application/json' }).end(mode === 'malformed' ? '{' : JSON.stringify({ request_id: 'fixture-deepseek-receipt', text: mode === 'long' ? '长'.repeat(32000) : mode === 'oversize' ? '长'.repeat(32001) : '上海今天天气怎么样？', duration_ms: 100 }))
      }
      if (mode === 'hold') pending.push(send); else send()
    } catch { response.writeHead(500).end('Fixture request invalid') }
  }), wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (request.headers.authorization !== 'Bearer fixture-deepseek-key') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return }
    const params = Object.fromEntries(new URL(request.url!, 'http://fixture.invalid').searchParams)
    wss.handleUpgrade(request, socket, head, peer => {
      sockets.add(peer); peer.on('close', () => sockets.delete(peer)); let text = ''
      peer.on('message', raw => {
        const event = JSON.parse(raw.toString())
        if (event.event === 'text') { text += event.text; return }
        if (event.event !== 'finish_text') throw new Error('Unexpected fixture event')
        synthesis.push({ text, parameters: params })
        const output = () => {
          if (peer.readyState !== 1) return
          if (mode === 'reject') { peer.send(JSON.stringify({ event: 'finish', code: 'content_filter', message: 'Fixture rejection' })); return }
          const pcm = Buffer.alloc(4800), count = mode === 'oversize' ? 601 : 1
          for (let i = 0; i < count; i++) peer.send(pcm)
          if (mode === 'close') { peer.close(); return }
          peer.send(JSON.stringify({ event: 'finish', code: mode === 'malformed' ? null : 'success', message: '' }))
        }
        if (mode === 'hold') pending.push(output); else output()
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing DeepSeek fixture address')
  return { ttsEndpoint: `ws://127.0.0.1:${address.port}/v1/tools/tts`, asrEndpoint: `http://127.0.0.1:${address.port}/v1/tools/asr`, synthesis, recognition, release: () => pending.splice(0).forEach(f => f()),
    close: async () => { pending.splice(0).forEach(f => f()); for (const peer of sockets) peer.terminate(); server.closeAllConnections(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
