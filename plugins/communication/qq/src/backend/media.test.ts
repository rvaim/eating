import { createServer, request as httpRequest } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlatformError } from '@eating/plugin-sdk'
import type { AgentInvocationScope, JsonObject, JsonValue } from '@eating/plugin-sdk'
import { downloadQQImage, isPublicQQImageAddress, qqReceivedMessageSegments, qqViewReceivedImageTool, readQQReceivedImage } from './media'
import type { QQImageNetwork } from './media'
import { qqTools, validateToolInput } from './operations'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64')
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const signedUrl = 'https://cdn.example.test/image.png?signature=fixture-secret'
const scope: AgentInvocationScope = { agentId: 'image-agent', agentTypeId: 'qq.private', pluginId: 'qq', instanceId: 'fixture-instance', accountId: '123456', conversationId: 'qq:123456:private:234567', kind: 'private', targetId: '234567', messageIds: ['-12', '42'], resourceIds: ['image-a', 'image-b'] }
const params: JsonObject = { message_id: '-12', image_id: 'image-a' }
const violation = expect.objectContaining({ code: 'AGENT_SCOPE_VIOLATION', outcome: 'not-sent' })
function received(patch: JsonObject = {}): JsonObject {
  return { message_id: -12, message_type: 'private', sender: { user_id: 234567 }, message: [{ type: 'image', data: { file: 'image-a', url: signedUrl } }], ...patch }
}
function dependencies(message: JsonValue = received()) {
  return { getMessage: vi.fn(async () => message), download: vi.fn(async () => ({ mimeType: 'image/png' as const, bytes: png })), assertActive: vi.fn() }
}

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
async function networkFixture(serve: (response: ServerResponse) => void) {
  const requests: Array<{ authorization?: string; cookie?: string; path?: string }> = []
  const server = createServer((request, response) => { requests.push({ authorization: request.headers.authorization, cookie: request.headers.cookie, path: request.url }); serve(response) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable')
  const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
  const lookups: Array<{ address: string; family: number }> = []
  // Only this test transport connects to loopback. Production source/DNS validation stays enabled.
  const request: QQImageNetwork['request'] = (url, options, listener) => {
    options.lookup?.('cdn.example.test', {}, (error, pinned, family) => { if (error) throw error; lookups.push({ address: String(pinned), family: family! }) })
    return httpRequest(new URL(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`), { ...options, lookup: undefined, family: 4 }, listener)
  }
  return { network: { resolve, request: vi.fn(request) } satisfies QQImageNetwork, requests, lookups }
}

function noNetwork(): QQImageNetwork { return { resolve: vi.fn(async () => []), request: vi.fn(() => { throw new Error('Network must not be used') }) } }

describe('controlled received image extension', () => {
  it('keeps all standard OneBot tools and declares separate content semantics', () => {
    expect(qqTools).toHaveLength(39)
    expect(qqTools.some(tool => tool.name === qqViewReceivedImageTool.name)).toBe(false)
    expect(qqViewReceivedImageTool).toMatchObject({ name: 'qq_view_received_image', title: '查看本会话图片', readOnly: true, destructive: false, resultFormat: 'content' })
    expect(qqViewReceivedImageTool).not.toHaveProperty('protocolAction')
    expect(validateToolInput(qqViewReceivedImageTool, params)).toEqual(params)
    for (const input of [{ ...params, message_id: -12 }, { ...params, image_id: '' }, { ...params, url: signedUrl }, { ...params, path: '/etc/passwd' }, { ...params, onebot_call_mode: 'async' }, { ...params, request_id: 'fixture-request' }]) expect(() => validateToolInput(qqViewReceivedImageTool, input)).toThrow()
  })

  it('queries OneBot once and returns a real image block with safe metadata', async () => {
    const deps = dependencies()
    const result = await readQQReceivedImage(params, { accountId: scope.accountId, scope }, deps)
    expect(deps.getMessage).toHaveBeenCalledExactlyOnceWith(-12)
    expect(deps.download).toHaveBeenCalledExactlyOnceWith(signedUrl)
    expect(result).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('外部消息数据') }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }], structuredContent: { mimeType: 'image/png', bytes: png.length, messageId: '-12', imageId: 'image-a' } })
    expect(JSON.stringify(result.structuredContent)).not.toContain(png.toString('base64'))
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
    expect(deps.assertActive).toHaveBeenCalledTimes(3)
  })

  it.each<JsonObject>([{ message_id: '999' }, { image_id: 'other-image' }])('rejects ungranted references before querying: %j', patch => {
    const deps = dependencies()
    return expect(readQQReceivedImage({ ...params, ...patch }, { accountId: scope.accountId, scope }, deps)).rejects.toEqual(violation).then(() => expect(deps.getMessage).not.toHaveBeenCalled())
  })

  it.each<JsonObject>([
    { message_id: -13 }, { self_id: 999999 }, { self_id: null }, { message_type: 'group', group_id: 777777 },
    { sender: { user_id: 345678 } }, { sender: { user_id: 123456 } }, { sender: {} }, { user_id: 345678 }, { group_id: 777777 },
    { message: [{ type: 'image', data: { file: 'image-b', url: signedUrl } }] },
    { message: [{ type: 'text', data: { text: `[CQ:image,file=image-a,url=${signedUrl}]` } }] },
    { message: [{ type: 'record', data: { file: 'image-a', url: signedUrl } }] },
    { message: [{ type: 'image', data: { file: 'image-a', url: signedUrl } }, { type: 'image', data: { file: 'image-a', url: 'https://other.example.test/image.png' } }] },
  ])('rejects contradictory OneBot identity/message/resource data: %j', async patch => {
    const deps = dependencies(received(patch))
    await expect(readQQReceivedImage(params, { accountId: scope.accountId, scope }, deps)).rejects.toEqual(violation)
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('matches group targets when returned and accepts standard get_msg without optional identity fields', async () => {
    const group: AgentInvocationScope = { ...scope, agentTypeId: 'qq.group', kind: 'group', targetId: '777777', conversationId: 'qq:123456:group:777777' }
    for (const patch of [{}, { self_id: 123456, group_id: 777777 }] as JsonObject[]) await expect(readQQReceivedImage(params, { accountId: group.accountId, scope: group }, dependencies(received({ message_type: 'group', ...patch })))).resolves.toHaveProperty('content')
    const wrong = dependencies(received({ message_type: 'group', group_id: 888888 }))
    await expect(readQQReceivedImage(params, { accountId: group.accountId, scope: group }, wrong)).rejects.toEqual(violation)
    expect(wrong.download).not.toHaveBeenCalled()
  })

  it('lets owners read a verified received image but never treats an input reference as a path or URL to fetch', async () => {
    await expect(readQQReceivedImage(params, { accountId: scope.accountId }, dependencies())).resolves.toHaveProperty('content')
    for (const image_id of ['/etc/passwd', 'file:///etc/passwd', signedUrl]) {
      const deps = dependencies()
      await expect(readQQReceivedImage({ ...params, image_id }, { accountId: scope.accountId }, deps)).rejects.toEqual(violation)
      expect(deps.download).not.toHaveBeenCalled()
    }
    const deps = dependencies(received({ message: [{ type: 'image', data: { file: 'image-a', path: '/remote/images/image-a.png' } }] }))
    await expect(readQQReceivedImage(params, { accountId: scope.accountId }, deps)).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' })
    expect(deps.download).not.toHaveBeenCalled()
    for (const url of ['/remote/images/image-a.png', 'C:\\remote\\image-a.png', 'file:///remote/image-a.png']) {
      const pathOnly = dependencies(received({ message: [{ type: 'image', data: { file: 'image-a', url } }] }))
      await expect(readQQReceivedImage(params, { accountId: scope.accountId }, pathOnly)).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' })
      expect(pathOnly.download).not.toHaveBeenCalled()
    }
  })

  it('does not echo URL-shaped resource IDs or signed URLs in text and structured metadata', async () => {
    const deps = dependencies(received({ message: [{ type: 'image', data: { file: signedUrl, url: signedUrl } }] }))
    const result = await readQQReceivedImage({ ...params, image_id: signedUrl }, { accountId: scope.accountId }, deps)
    expect(result.structuredContent).not.toHaveProperty('imageId')
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
  })

  it('revalidates after OneBot reads and after image download before returning content', async () => {
    for (const revokedAt of [2, 3]) {
      const deps = dependencies()
      deps.assertActive.mockImplementation(() => { if (deps.assertActive.mock.calls.length === revokedAt) throw new PlatformError('AGENT_SCOPE_VIOLATION', 'Revoked', 403, 'not-sent') })
      await expect(readQQReceivedImage(params, { accountId: scope.accountId, scope }, deps)).rejects.toEqual(violation)
      expect(deps.download).toHaveBeenCalledTimes(revokedAt === 2 ? 0 : 1)
    }
  })

  it('reads actual CQ protocol image segments with correct escaping while preserving plain text', async () => {
    const imageId = 'image[a],b&c'
    const cq = 'literal &#91;CQ:image,file=wrong&#93; [CQ:image,file=image&#91;a&#93;&#44;b&amp;c,url=https://cdn.example.test/i?x=1&amp;y=2]'
    expect(qqReceivedMessageSegments(cq)).toEqual([{ type: 'image', data: { file: imageId, url: 'https://cdn.example.test/i?x=1&y=2' } }])
    expect(qqReceivedMessageSegments('[CQ:image,file=a,file=b]')).toEqual([])
    expect(qqReceivedMessageSegments(['[CQ:image,file=not-a-segment]'])).toEqual([])
    expect(qqReceivedMessageSegments('[CQ:image,file=&amp;#91;x&amp;#93;]')[0]?.data).toEqual({ file: '&#91;x&#93;' })
    const deps = dependencies(received({ message: cq }))
    await expect(readQQReceivedImage({ ...params, image_id: imageId }, { accountId: scope.accountId, scope: { ...scope, resourceIds: [imageId] } }, deps)).resolves.toHaveProperty('content')
    expect(deps.download).toHaveBeenCalledExactlyOnceWith('https://cdn.example.test/i?x=1&y=2')
  })
})

describe('public image download boundary', () => {
  it.each(['0.0.0.0', '10.0.0.1', '100.64.0.1', '100.100.100.200', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '168.63.129.16', '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', 'ff02::1', '64:ff9b::a00:1', '2001::1', '2001:db8::1', '2002:7f00:1::', '3fff::1'])('rejects nonpublic/special address %s', address => {
    expect(isPublicQQImageAddress(address)).toBe(false)
  })

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888'])('accepts public address %s', address => {
    expect(isPublicQQImageAddress(address)).toBe(true)
  })

  it.each(['file:///etc/passwd', 'data:image/png;base64,xxx', 'http://user:password@8.8.8.8/image', 'http://127.1/image', 'http://0x7f000001/image', 'http://2130706433/image', 'http://[::1]/image', 'http://[::ffff:127.0.0.1]/image', 'http://metadata.internal/image', 'http://localhost./image', 'http://a.local/image', 'http://a.home.arpa/image', 'https://cdn.example.test/image#secret'])('rejects unsafe URL before networking: %s', async url => {
    const network = noNetwork()
    await expect(downloadQQImage(url, {}, network)).rejects.toMatchObject({ code: 'MEDIA_UNSAFE_SOURCE' })
    expect(network.resolve).not.toHaveBeenCalled()
    expect(network.request).not.toHaveBeenCalled()
  })

  it('rejects mixed/private DNS answers and keeps resolver errors free of credentials', async () => {
    const network = { ...noNetwork(), resolve: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]) }
    await expect(downloadQQImage(signedUrl, {}, network)).rejects.toMatchObject({ code: 'MEDIA_UNSAFE_SOURCE' })
    expect(network.request).not.toHaveBeenCalled()
    const failingNetwork = { ...noNetwork(), resolve: vi.fn(async () => { throw new Error(signedUrl) }) }
    const error = await downloadQQImage(signedUrl, {}, failingNetwork).catch(error => error)
    expect(error.code).toBe('MEDIA_DOWNLOAD_FAILED')
    expect(error.message).not.toContain('fixture-secret')
  })

  it('pins the sole DNS resolution in custom lookup and never sends OneBot credentials', async () => {
    const fixture = await networkFixture(response => { response.writeHead(200, { 'Content-Type': 'image/png; charset=binary' }); response.end(png) })
    const result = await downloadQQImage(signedUrl, {}, fixture.network)
    expect(result).toEqual({ mimeType: 'image/png', bytes: png })
    expect(fixture.network.resolve).toHaveBeenCalledExactlyOnceWith('cdn.example.test')
    expect(fixture.lookups).toEqual([{ address: '93.184.216.34', family: 4 }])
    expect(fixture.requests).toEqual([{ path: '/image.png?signature=fixture-secret', authorization: undefined, cookie: undefined }])
    expect(fixture.network.request.mock.calls[0]?.[1]).toMatchObject({ agent: false, family: 4 })
  })

  it('accepts a real GIF fixture and canonical image bytes', async () => {
    const fixture = await networkFixture(response => { response.writeHead(200, { 'Content-Type': 'image/gif' }); response.end(gif) })
    expect(await downloadQQImage(signedUrl, {}, fixture.network)).toEqual({ mimeType: 'image/gif', bytes: gif })
  })

  it.each([
    { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' }, bytes: png, code: 'MEDIA_DOWNLOAD_FAILED' },
    { status: 200, headers: { 'content-type': 'text/html' }, bytes: png, code: 'MEDIA_INVALID_IMAGE' },
    { status: 200, headers: { 'content-type': 'image/jpeg' }, bytes: png, code: 'MEDIA_INVALID_IMAGE' },
    { status: 200, headers: { 'content-type': 'image/png' }, bytes: Buffer.from('<html>fixture-secret</html>'), code: 'MEDIA_INVALID_IMAGE' },
    { status: 200, headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' }, bytes: png, code: 'MEDIA_INVALID_IMAGE' },
    { status: 200, headers: { 'content-type': 'image/png' }, bytes: png.subarray(0, 20), code: 'MEDIA_INVALID_IMAGE' },
  ])('rejects redirects, MIME mismatch and invalid bytes: $code', async ({ status, headers, bytes, code }) => {
    const fixture = await networkFixture(response => { response.writeHead(status, headers); response.end(bytes) })
    const error = await downloadQQImage(signedUrl, {}, fixture.network).catch(error => error)
    expect(error).toMatchObject({ code })
    expect(error.message).not.toContain('fixture-secret')
    expect(fixture.network.request).toHaveBeenCalledTimes(1)
  })

  it('bounds both declared and streaming body sizes', async () => {
    for (const length of [true, false]) {
      const fixture = await networkFixture(response => { response.writeHead(200, { 'Content-Type': 'image/png', ...(length ? { 'Content-Length': png.length } : {}) }); response.write(png.subarray(0, 40)); response.end(png.subarray(40)) })
      await expect(downloadQQImage(signedUrl, { maxBytes: 32 }, fixture.network)).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' })
    }
  })

  it('bounds DNS resolution and the complete response lifetime', async () => {
    const network = { ...noNetwork(), resolve: (): Promise<[]> => new Promise(() => {}) }
    await expect(downloadQQImage(signedUrl, { timeoutMs: 20 }, network)).rejects.toMatchObject({ code: 'MEDIA_TIMEOUT' })
    expect(network.request).not.toHaveBeenCalled()
    const fixture = await networkFixture(response => { response.writeHead(200, { 'Content-Type': 'image/png' }); response.write(png.subarray(0, 40)) })
    await expect(downloadQQImage(signedUrl, { timeoutMs: 50 }, fixture.network)).rejects.toMatchObject({ code: 'MEDIA_TIMEOUT' })
  })
})
