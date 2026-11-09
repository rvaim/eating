import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
export type SpeechFixtureMode = 'success' | 'mismatch' | 'close' | 'hold' | 'oversize' | 'auth' | 'bad-voice'
export async function startSpeechFixture(mode: SpeechFixtureMode = 'success') {
  const server = createServer(), wss = new WebSocketServer({ noServer: true })
  const sessions: Record<string, unknown>[] = [], requests: Record<string, unknown>[] = [], pending: Array<() => void> = []
  const sockets = new Set<WebSocket>()
  let connections = 0, active = 0
  server.on('upgrade', (request, socket, head) => {
    connections++
    if (mode === 'auth') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return }
    if (request.headers.authorization !== 'Bearer fixture-speech-key') { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws))
  })
  wss.on('connection', socket => {
    sockets.add(socket); active++; socket.once('close', () => { sockets.delete(socket); active-- })
    socket.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture-session' } }))
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString())
      if (event.type === 'session.update') {
        sessions.push(event.session)
        const session = structuredClone(event.session)
        if (mode === 'bad-voice') session.audio.output.voice = 'alloy'
        socket.send(JSON.stringify({ type: 'session.updated', session })); return
      }
      if (event.type !== 'response.create') return
      requests.push(event.response)
      if (mode === 'close') { socket.close(); return }
      const output = () => {
        if (socket.readyState !== 1) return
        const base = { response_id: 'fixture-response', item_id: 'fixture-audio', output_index: 0, content_index: 0 }
        const send = (value: object) => socket.send(JSON.stringify(value))
        send({ type: 'response.created', response: { id: base.response_id, status: 'in_progress' } })
        const pcm = Buffer.alloc(4800)
        for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 0.1) * 300), i * 2)
        const count = mode === 'oversize' ? 601 : 1
        for (let i = 0; i < count; i++) send({ ...base, type: 'response.output_audio.delta', delta: pcm.toString('base64') })
        send({ ...base, type: 'response.output_audio.done' })
        send({ ...base, type: 'response.output_audio_transcript.done', transcript: mode === 'mismatch' ? 'Changed content' : event.response.input[0].content[0].text })
        send({ type: 'response.done', response: { id: base.response_id, status: 'completed' } })
      }
      if (mode === 'hold') pending.push(output); else output()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing speech fixture address')
  return { endpoint: `ws://127.0.0.1:${address.port}/v1/realtime`, sessions, requests, connections: () => connections, active: () => active, release: () => pending.splice(0).forEach(fn => fn()),
    close: async () => { for (const socket of sockets) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
