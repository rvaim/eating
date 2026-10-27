import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PluginLogSource } from '@eating/plugin-sdk'

/** One viewer owns one subscription; this transport never stores or replays logs. */
export function servePluginLogStream(request: IncomingMessage, response: ServerResponse, source: PluginLogSource, onClose: () => void): () => void {
  let stopped = false
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (stopped) return
    stopped = true
    if (heartbeat) clearInterval(heartbeat)
    try { unsubscribe?.() }
    catch { process.emitWarning('插件日志订阅清理失败，请检查插件实现。', { code: 'PLUGIN_LOG_UNSUBSCRIBE_FAILED' }) }
    request.off('aborted', stop)
    response.off('close', stop)
    response.off('error', stop)
    onClose()
    if (!response.destroyed && !response.writableEnded) response.end()
  }
  const write = (data: string): boolean => {
    if (stopped || response.destroyed || response.writableEnded) { stop(); return false }
    try {
      // Disconnect a slow viewer instead of growing an unbounded transport queue.
      if (!response.write(data)) { response.destroy(); stop(); return false }
      return true
    } catch { response.destroy(); stop(); return false }
  }
  request.on('aborted', stop)
  response.on('close', stop)
  response.on('error', stop)
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' })
  response.flushHeaders()
  if (!write(': temporary log stream\n\n')) return stop
  try {
    unsubscribe = source.subscribe(entry => {
      if (stopped) return
      let data: string
      try { data = JSON.stringify(entry) }
      catch { stop(); return }
      if (Buffer.byteLength(data) > 16384) { stop(); return }
      write(`event: log\ndata: ${data}\n\n`)
    })
    if (stopped) { unsubscribe(); return stop }
    heartbeat = setInterval(() => { write(': keepalive\n\n') }, 15000)
    heartbeat.unref()
    return stop
  } catch { stop(); return stop }
}
