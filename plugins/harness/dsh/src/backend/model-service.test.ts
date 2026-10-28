import { once } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlatformError } from '@eating/plugin-sdk'
import { listModels, testModelConnection } from './model-service'

interface CapturedRequest { readonly method: string; readonly url: string; readonly authorization: string | undefined; readonly body: string }
type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
const cleanups: Array<() => Promise<void>> = []
const fixtureKey = 'fixture-only-model-key'
const completion = { choices: [{ index: 0, message: { role: 'assistant', content: 'fixture-only-output' }, finish_reason: 'length' }] }

async function fixture(handler: Handler) {
  const requests: CapturedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({ method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization, body: Buffer.concat(chunks).toString('utf8') })
      Promise.resolve(handler(request, response)).catch(() => response.destroy())
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closed
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Invalid loopback fixture address')
  const base = `http://127.0.0.1:${address.port}`
  return { base, requests, configuration: { endpoint: `${base}/v1`, apiKey: fixtureKey, timeoutMs: 3000, model: 'fixture-selected-model' } }
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function failure(promise: Promise<unknown>, code: string, outcome = 'failed'): Promise<PlatformError> {
  const error: unknown = await promise.then(() => { throw new Error('Unexpected model-service success') }, (reason: unknown) => reason)
  expect(error).toBeInstanceOf(PlatformError)
  expect(error).toMatchObject({ code, outcome })
  expect(String(error)).not.toContain(fixtureKey)
  expect(JSON.stringify(error)).not.toContain(fixtureKey)
  return error as PlatformError
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('DSH model list', () => {
  it.each(['/v1', '/v1/', '/custom/api/', '/custom/api///', ''])('appends to the full base prefix %s with only the saved Bearer key', async prefix => {
    const upstream = await fixture((_request, response) => json(response, { data: [{ id: 'provider/model-原名', name: 'Provider name' }] }))
    const configuration = Object.freeze({ ...upstream.configuration, endpoint: `${upstream.base}${prefix}` })
    expect(await listModels(configuration)).toEqual({ models: [{ id: 'provider/model-原名', name: 'Provider name' }] })
    expect(upstream.requests).toEqual([{ method: 'GET', url: `${prefix.replace(/\/+$/, '')}/models`, authorization: `Bearer ${fixtureKey}`, body: '' }])
    expect(configuration.endpoint).toBe(`${upstream.base}${prefix}`)
  })

  it.each(['', '   '])('omits authorization for a blank local-provider key', async apiKey => {
    const upstream = await fixture((_request, response) => json(response, { data: [{ id: 'local-model' }] }))
    expect(await listModels({ ...upstream.configuration, apiKey })).toEqual({ models: [{ id: 'local-model' }] })
    expect(upstream.requests[0]?.authorization).toBeUndefined()
  })

  it('filters unusable ids and unsafe metadata, and keeps first-seen deduplicated order', async () => {
    const upstream = await fixture((_request, response) => json(response, { data: [
      { id: 'z-model', name: 'Safe name', apiKey: fixtureKey, extra: { nested: true } },
      { id: 'a-model', name: { unsafe: fixtureKey } }, { id: 'z-model', name: 'duplicate' },
      null, 'wrong', { id: '' }, { id: '   ' }, { id: 4 }, { id: 'x'.repeat(161) }, { id: 'bad\nmodel' }, { id: ' padded-model ' },
      { id: 'b-model', name: 'bad\nname' }, { id: 'c-model', name: 123 }, { id: 'd-model', name: 'x'.repeat(257) },
      { id: `reflected-${fixtureKey}` }, { id: 'e-model', name: `reflected-${fixtureKey}` },
    ] }))
    expect(await listModels(upstream.configuration)).toEqual({ models: [
      { id: 'z-model', name: 'Safe name' }, { id: 'a-model' }, { id: 'b-model' }, { id: 'c-model' }, { id: 'd-model' }, { id: 'e-model' },
    ] })
  })

  it('bounds distinct choices to 2000 without reordering or adding fake models', async () => {
    const upstream = await fixture((_request, response) => json(response, { data: Array.from({ length: 2100 }, (_, index) => ({ id: `model-${index}` })) }))
    const { models } = await listModels(upstream.configuration)
    expect(models).toHaveLength(2000)
    expect(models[0]).toEqual({ id: 'model-0' })
    expect(models[1999]).toEqual({ id: 'model-1999' })
  })

  it.each([null, [], {}, { models: ['invented'] }, { data: {} }, { data: [] }, { data: [{ id: null }, { id: ' ' }] }])('rejects incompatible or empty lists instead of reporting fake success: %j', async value => {
    const upstream = await fixture((_request, response) => json(response, value))
    await failure(listModels(upstream.configuration), 'MODEL_RESPONSE_INVALID')
  })
})

describe('DSH model connection test', () => {
  it('sends one real, tiny selected-model request and exposes only requested model and latency', async () => {
    const upstream = await fixture((_request, response) => json(response, { ...completion, model: 'provider-response-alias', apiKey: fixtureKey }))
    const configuration = Object.freeze({ ...upstream.configuration, endpoint: `${upstream.base}/custom/api/` })
    const result = await testModelConnection(configuration)
    expect(result).toEqual({ ok: true, model: 'fixture-selected-model', latencyMs: expect.any(Number) })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.latencyMs).toBeLessThan(3000)
    expect(JSON.stringify(result)).not.toContain('fixture-only-output')
    expect(JSON.stringify(result)).not.toContain(fixtureKey)
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]).toMatchObject({ method: 'POST', url: '/custom/api/chat/completions', authorization: `Bearer ${fixtureKey}` })
    expect(JSON.parse(upstream.requests[0]!.body)).toEqual({ model: 'fixture-selected-model', messages: [{ role: 'user', content: 'Ping.' }], max_tokens: 1, stream: false })
    expect(configuration.model).toBe('fixture-selected-model')
  })

  it.each([
    { role: 'assistant', content: null, reasoning_content: 'fixture-only-reasoning' },
    { role: 'assistant', content: '', reasoning: 'fixture-only-reasoning' },
    { role: 'assistant', tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'fixture', arguments: '{}' } }] },
  ])('accepts compatible nullable or tool-call responses without returning model output: %j', async message => {
    const upstream = await fixture((_request, response) => json(response, { choices: [{ message }] }))
    expect(await testModelConnection(upstream.configuration)).toMatchObject({ ok: true, model: 'fixture-selected-model' })
  })

  it.each([{}, { choices: [] }, { choices: [null] }, { choices: [{ text: 'legacy' }] },
    { choices: [{ message: { role: 'user', content: 'wrong role' } }] },
    { choices: [{ message: { role: 'assistant', content: 3 } }] },
    { choices: [{ message: { role: 'assistant', content: {}, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'fixture', arguments: '{}' } }] } }] },
    { choices: [{ message: { role: 'assistant', tool_calls: [] } }] },
    { choices: [{ message: { role: 'assistant', tool_calls: [{}] } }] },
  ])('rejects HTTP-200 responses that are not actual compatible model responses: %j', async value => {
    const upstream = await fixture((_request, response) => json(response, value))
    await failure(testModelConnection(upstream.configuration), 'MODEL_RESPONSE_INVALID')
  })

  it('reports a provider model rejection without retrying or changing max_tokens', async () => {
    const upstream = await fixture((_request, response) => json(response, { error: { code: 'unsupported_value', message: `fixture provider requires more tokens ${fixtureKey}` } }, 400))
    await failure(testModelConnection(upstream.configuration), 'MODEL_CONNECTION_FAILED')
    expect(upstream.requests).toHaveLength(1)
    expect(JSON.parse(upstream.requests[0]!.body).max_tokens).toBe(1)
  })
})

describe('DSH model request boundaries', () => {
  it.each([
    [401, 'MODEL_AUTH_FAILED', 502], [403, 'MODEL_AUTH_FAILED', 502], [429, 'MODEL_RATE_LIMITED', 503],
    [404, 'MODEL_LIST_UNSUPPORTED', 502], [405, 'MODEL_LIST_UNSUPPORTED', 502], [501, 'MODEL_LIST_UNSUPPORTED', 502], [500, 'MODEL_LIST_FAILED', 502],
  ] as const)('maps list HTTP %s to a stable sanitized error', async (status, code, statusCode) => {
    const upstream = await fixture((_request, response) => json(response, { error: { code: fixtureKey, message: `unsafe ${fixtureKey}` } }, status))
    expect(await failure(listModels(upstream.configuration), code)).toMatchObject({ statusCode })
    expect(upstream.requests).toHaveLength(1)
  })

  it.each([[401, 'MODEL_AUTH_FAILED'], [429, 'MODEL_RATE_LIMITED'], [404, 'MODEL_CONNECTION_FAILED']] as const)('maps completion HTTP %s as an actual test failure', async (status, code) => {
    const upstream = await fixture((_request, response) => json(response, { error: { message: fixtureKey } }, status))
    await failure(testModelConnection(upstream.configuration), code)
  })

  it.each([['invalid_api_key', 'MODEL_AUTH_FAILED'], ['insufficient_quota', 'MODEL_RATE_LIMITED'], [fixtureKey, 'MODEL_CONNECTION_FAILED']] as const)('only classifies allowlisted remote error codes on HTTP 200', async (code, expected) => {
    const upstream = await fixture((_request, response) => json(response, { error: { code, message: fixtureKey } }))
    await failure(testModelConnection(upstream.configuration), expected)
  })

  it('rejects HTML and invalid UTF-8 without returning their contents', async () => {
    const upstream = await fixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(`<html>${fixtureKey}</html>`) })
    await failure(listModels(upstream.configuration), 'MODEL_RESPONSE_INVALID')
    const binary = await fixture((_request, response) => { response.end(Buffer.from([0xff, 0xfe])) })
    await failure(testModelConnection(binary.configuration), 'MODEL_RESPONSE_INVALID')
  })

  it('rejects an excessive advertised content length before waiting for the body', async () => {
    const upstream = await fixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 1024 * 1024 + 1 }); response.flushHeaders() })
    const started = performance.now()
    await failure(listModels(upstream.configuration), 'MODEL_RESPONSE_INVALID')
    expect(performance.now() - started).toBeLessThan(1500)
  })

  it('bounds chunked bodies to 1 MiB and stops reading the stream', async () => {
    const upstream = await fixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write('{"data":[')
      response.write(' '.repeat(1024 * 1024))
      response.end(']}')
    })
    await failure(listModels(upstream.configuration), 'MODEL_RESPONSE_INVALID')
  })

  it('applies the byte limit after decompression', async () => {
    const { gzipSync } = await import('node:zlib')
    const bytes = gzipSync(JSON.stringify({ data: [{ id: 'local' }], ignored: 'x'.repeat(1024 * 1024) }))
    const upstream = await fixture((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': bytes.length }); response.end(bytes) })
    await failure(listModels(upstream.configuration), 'MODEL_RESPONSE_INVALID')
  })

  it('never follows redirects or forwards a saved key to the redirect destination', async () => {
    const destination = await fixture((_request, response) => json(response, { data: [{ id: 'should-not-be-called' }] }))
    const upstream = await fixture((_request, response) => { response.writeHead(307, { Location: `${destination.base}/stolen?key=${fixtureKey}` }); response.end(fixtureKey) })
    await failure(listModels(upstream.configuration), 'MODEL_REQUEST_FAILED')
    await failure(testModelConnection(upstream.configuration), 'MODEL_REQUEST_FAILED')
    expect(upstream.requests).toHaveLength(2)
    expect(destination.requests).toHaveLength(0)
  })

  it('sanitizes connection failures and performs no retry', async () => {
    const upstream = await fixture((request, _response) => { request.socket.destroy(new Error(fixtureKey)) })
    await failure(listModels(upstream.configuration), 'MODEL_REQUEST_FAILED')
    expect(upstream.requests).toHaveLength(1)
  })

  it.each(['?token=fixture', '?', '#fixture', '#', '/?token=fixture'])('rejects endpoint query or fragment parts %s before sending', async suffix => {
    const upstream = await fixture((_request, response) => json(response, completion))
    await failure(listModels({ ...upstream.configuration, endpoint: `${upstream.configuration.endpoint}${suffix}` }), 'INVALID_CONFIGURATION', 'not-sent')
    expect(upstream.requests).toHaveLength(0)
  })

  it('rejects credentials and non-http endpoints, and empty endpoint/model drafts before sending', async () => {
    const upstream = await fixture((_request, response) => json(response, completion))
    for (const endpoint of [upstream.base.replace('http://', 'http://fixture@'), upstream.base.replace('http://', 'http://:fixture@'), 'file:///tmp/fixture']) {
      await failure(listModels({ ...upstream.configuration, endpoint }), 'INVALID_CONFIGURATION', 'not-sent')
    }
    await failure(listModels({ ...upstream.configuration, endpoint: '' }), 'NOT_CONFIGURED', 'not-sent')
    await failure(testModelConnection({ ...upstream.configuration, model: ' ' }), 'NOT_CONFIGURED', 'not-sent')
    expect(upstream.requests).toHaveLength(0)
  })

  it('honors a caller cancellation before sending without exposing its reason', async () => {
    const upstream = await fixture((_request, response) => json(response, completion))
    const controller = new AbortController()
    controller.abort(new Error(fixtureKey))
    await failure(testModelConnection(upstream.configuration, controller.signal), 'MODEL_REQUEST_ABORTED', 'not-sent')
    expect(upstream.requests).toHaveLength(0)
  })

  it.each(['headers', 'body'])('cancels an in-flight request while waiting for %s', async phase => {
    let received!: () => void
    const entered = new Promise<void>(resolve => { received = resolve })
    const upstream = await fixture((_request, response) => {
      if (phase === 'body') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"choices":[') }
      received()
    })
    const controller = new AbortController()
    const pending = failure(testModelConnection(upstream.configuration, controller.signal), 'MODEL_REQUEST_ABORTED')
    await entered
    const started = performance.now()
    controller.abort(new Error(fixtureKey))
    await pending
    expect(performance.now() - started).toBeLessThan(1500)
    expect(upstream.requests).toHaveLength(1)
  })

  it.each(['headers', 'body'])('bounds the entire request when %s stalls', async phase => {
    const upstream = await fixture((_request, response) => {
      if (phase === 'body') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"data":[') }
    })
    const started = performance.now()
    await failure(listModels({ ...upstream.configuration, timeoutMs: 1000 }), 'MODEL_REQUEST_TIMEOUT')
    expect(performance.now() - started).toBeLessThan(2500)
    expect(upstream.requests).toHaveLength(1)
  })

  it('caps a saved 120-second timeout at 15 seconds and clears its timer after failure', async () => {
    let received!: () => void
    const entered = new Promise<void>(resolve => { received = resolve })
    const upstream = await fixture(() => received())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = failure(listModels({ ...upstream.configuration, timeoutMs: 120_000 }), 'MODEL_REQUEST_TIMEOUT')
    await entered
    await vi.advanceTimersByTimeAsync(15_000)
    await pending
    expect(upstream.requests).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
