import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { json, readJson, safeError } from './security'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function endpoint() {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const value = await readJson(request, request.url === '/tool' ? 1024 * 1024 : undefined)
        json(response, 200, { accepted: true, isObject: value !== null && typeof value === 'object' })
      } catch (cause) {
        const error = safeError(cause)
        json(response, error.statusCode, { error: { code: error.code, outcome: error.outcome } })
      }
    })()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Input fixture did not bind')
  cleanups.push(async () => {
    const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections(); await closing
  })
  return async (path: string, body: string) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body })
}

describe('bounded structured tool input', () => {
  it('accepts a bounded media payload above 256KiB only on the explicit tool parser limit', async () => {
    const post = await endpoint()
    const body = JSON.stringify({ message: { type: 'image', data: { file: 'base64://' + 'a'.repeat(300000) } } })
    expect((await post('/tool', body)).status).toBe(200)
    const ordinary = await post('/configuration', body)
    expect(ordinary.status).toBe(413)
    expect(await ordinary.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect((await post('/tool', JSON.stringify({ message: 'a'.repeat(1024 * 1024) })))).toHaveProperty('status', 413)
  })
  it('rejects extreme nesting before a recursive schema validator can overflow', async () => {
    const post = await endpoint()
    const response = await post('/tool', '{"value":' + '['.repeat(70) + '0' + ']'.repeat(70) + '}')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_JSON', outcome: 'not-sent' } })
    expect((await post('/tool', '{"value":[{"message":"ordinary"}]}')).status).toBe(200)
  })
  it('rejects oversized object graphs and malformed JSON without echoing input contents', async () => {
    const post = await endpoint()
    const response = await post('/tool', JSON.stringify({ nodes: Array(50001).fill(null) }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_JSON', outcome: 'not-sent' } })
    const malformed = await post('/tool', '{"secret":"do-not-echo"')
    expect(malformed.status).toBe(400)
    expect(await malformed.text()).not.toContain('do-not-echo')
  })
})
