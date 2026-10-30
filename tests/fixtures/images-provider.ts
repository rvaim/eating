import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { createImageFixturePng } from './image'
import type { JsonObject } from '@eating/plugin-sdk'

/** Independent OpenAI Images wire fixture; never a configured product provider. */
export async function startImagesProviderFixture(mode: 'base64' | 'url' = 'base64', options: { defer?: boolean } = {}) {
  let release!: () => void
  const gate = options.defer ? new Promise<void>(resolve => { release = resolve }) : Promise.resolve()
  if (!options.defer) release = () => {}
  const image = createImageFixturePng(), apiKey = 'images-fixture-only-key'
  const requests: Array<{ path: string | undefined; headers: IncomingHttpHeaders; body: JsonObject }> = []
  const downloads: IncomingHttpHeaders[] = []
  let origin = ''
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/result.png?signature=fixture-private') {
        downloads.push(request.headers)
        response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(image); return
      }
      if (request.method !== 'POST' || request.url !== '/custom/v1/images/generations') { response.writeHead(404); response.end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject
      requests.push({ path: request.url, headers: request.headers, body })
      if (request.headers.authorization !== `Bearer ${apiKey}`) { response.writeHead(401); response.end(); return }
      await gate
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ created: 1, data: [mode === 'base64' ? { b64_json: image.toString('base64') } : { url: origin + '/result.png?signature=fixture-private' }] }))
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port')
  origin = `http://127.0.0.1:${address.port}`
  return { baseUrl: origin + '/custom/v1', apiKey, image, requests, downloads, release, async close() {
    release()
    const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections(); await closing
  } }
}
