import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { createImageFixturePng } from './image'
import type { JsonObject } from '@eating/plugin-sdk'

interface EditCapture { readonly path: string | undefined; readonly headers: IncomingHttpHeaders; readonly fields: JsonObject; readonly image: Buffer; readonly mimeType: string }
function readMultipart(body: Buffer, contentType: string): { fields: JsonObject; image: Buffer; mimeType: string } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.slice(1).find(Boolean)
  if (!boundary) throw new Error('Multipart fixture has no boundary')
  const fields: JsonObject = {}; let image = Buffer.alloc(0), mimeType = ''
  for (const raw of body.toString('latin1').split('--' + boundary)) {
    const section = raw.replace(/^\r\n/, '').replace(/\r\n$/, '')
    if (!section || section === '--') continue
    const split = section.indexOf('\r\n\r\n')
    if (split < 0) continue
    const headers = section.slice(0, split), content = Buffer.from(section.slice(split + 4), 'latin1'), name = /name="([^"]+)"/.exec(headers)?.[1]
    if (!name) continue
    if (/filename="/.test(headers)) { image = content; mimeType = /Content-Type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? '' }
    else fields[name] = content.toString('utf8')
  }
  return { fields, image, mimeType }
}

/** Independent OpenAI Images wire fixture; never a configured product provider. */
export async function startImagesProviderFixture(mode: 'base64' | 'url' = 'base64', options: { defer?: boolean; edit?: boolean; image?: Buffer } = {}) {
  let release!: () => void
  const gate = options.defer ? new Promise<void>(resolve => { release = resolve }) : Promise.resolve()
  if (!options.defer) release = () => {}
  const image = options.image ?? createImageFixturePng(), apiKey = 'images-fixture-only-key'
  const requests: Array<{ path: string | undefined; headers: IncomingHttpHeaders; body: JsonObject }> = []
  const edits: EditCapture[] = []
  const downloads: IncomingHttpHeaders[] = []
  let origin = ''
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/result.png?signature=fixture-private') {
        downloads.push(request.headers)
        response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(image); return
      }
      const generation = request.method === 'POST' && request.url === '/custom/v1/images/generations'
      const edit = options.edit === true && request.method === 'POST' && request.url === '/custom/v1/images/edits'
      if (!generation && !edit) { response.writeHead(404); response.end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks)
      if (edit) {
        const parsed = readMultipart(raw, String(request.headers['content-type'] ?? ''))
        edits.push({ path: request.url, headers: request.headers, ...parsed })
      } else requests.push({ path: request.url, headers: request.headers, body: JSON.parse(raw.toString('utf8')) as JsonObject })
      if (request.headers.authorization !== `Bearer ${apiKey}`) { response.writeHead(401); response.end(); return }
      await gate
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ created: 1, data: [mode === 'base64' ? { b64_json: image.toString('base64') } : { url: origin + '/result.png?signature=fixture-private' }] }))
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port')
  origin = `http://127.0.0.1:${address.port}`
  return { baseUrl: origin + '/custom/v1', apiKey, image, requests, edits, downloads, release, async close() {
    release()
    const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections(); await closing
  } }
}
