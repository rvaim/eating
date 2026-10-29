import { createServer, request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { deflateSync } from 'node:zlib'
import type { QQImageNetwork } from '../../plugins/communication/qq/src/backend/media'

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length)
  result.write(type, 4, 4, 'ascii')
  data.copy(result, 8)
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4)
  return result
}

/** One real opaque green pixel, with a lossless scanline and valid CRC for every chunk. */
export function createImageFixturePng(): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 38, 165, 94, 255]))), chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Test-only transport routes an authorized source to the independent loopback fixture. */
export async function startImageFixture() {
  const bytes = createImageFixturePng()
  const source = 'https://cdn.example.test/received-pixel.png?signature=fixture-image-only'
  const requests: Array<{ readonly path: string | undefined; readonly headers: IncomingHttpHeaders }> = []
  const server = createServer((request, response) => {
    requests.push({ path: request.url, headers: request.headers })
    if (request.url !== '/received-pixel.png?signature=fixture-image-only') { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' })
    response.end(bytes)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Image fixture has no loopback port')
  const network: QQImageNetwork = {
    // The fixture keeps the request shape the product uses and only redirects the
    // socket to loopback; production resolves and routes through the host stack.
    request: (url, options, listener) => {
      if (url.href !== source || options.agent !== false) throw new Error('Image fixture received an unexpected source')
      return httpRequest(new URL(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`), { ...options, agent: false }, listener)
    },
  }
  return { source, bytes, requests, network, async close() {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closed
  } }
}
