import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EatingHost } from './app'
import { createImageFixturePng } from '../../../tests/fixtures/image'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop() })
async function setup() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'eating-plugin-http-')))
  cleanups.push(async () => { if (await realpath(home) !== home || dirname(home) !== await realpath(tmpdir()) || !basename(home).startsWith('eating-plugin-http-')) throw new Error('Unsafe test cleanup'); await rm(home, { recursive: true }) })
  const host = new EatingHost({ dataDirectory: home, entries: [], allowedUiOrigins: [], port: 0 }); cleanups.push(() => host.close())
  const url = await host.listen(), bootstrap = await fetch(url + '/api/bootstrap'), payload = await bootstrap.json(), cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
  const request = async (path: string, body?: object) => {
    const response = await fetch(url + '/api' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'X-Eating-CSRF': payload.csrfToken, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { response, value: await response.json() }
  }
  return { home, host, url, request }
}

describe('owner plugin management over real Host HTTP', () => {
  it('installs the sealed preview, activates a panel and MCP, uninstalls while preserving data, then reinstalls the same library', async () => {
    const f = await setup(), source = join(f.home, 'source')
    await cp(fileURLToPath(new URL('../../../plugins/capabilities/stickers/dist/', import.meta.url)), source, { recursive: true })
    expect((await f.request('/plugin-packages')).value.plugins).toEqual([])
    const preview = await f.request('/plugin-packages', { operation: 'preview', input: { sourceDirectory: source } })
    expect(preview.response.status).toBe(200)
    expect(preview.value.manifest).toMatchObject({ id: 'stickers', kind: 'capability', apiVersion: 4 })
    expect(f.host.getWorkspace().plugins).toEqual([])
    const unconfirmed = await f.request('/plugin-packages', { operation: 'install', input: { planId: preview.value.planId } })
    expect(unconfirmed.response.status).toBe(409)
    // Confirming must use the already verified bytes, even after the source disappears.
    if (await realpath(source) !== source || dirname(source) !== f.home) throw new Error('Unsafe test source cleanup')
    await rm(source, { recursive: true })
    const installed = await f.request('/plugin-packages', { operation: 'install', input: { planId: preview.value.planId, confirmed: true } })
    expect(installed.response.status).toBe(200)
    const catalog = (await f.request('/plugin-packages')).value
    expect(catalog.plugins).toEqual([expect.objectContaining({ id: 'stickers', kind: 'capability', enabled: true, frontend: expect.objectContaining({ entry: expect.stringContaining('/plugins/stickers/0.1.0/') }) })])
    expect((await f.request('/mcp')).value.services).toEqual([expect.objectContaining({ id: 'plugin.stickers', tools: expect.any(Array), source: { kind: 'plugin', pluginId: 'stickers', pluginName: '表情包' } })])
    const image = createImageFixturePng().toString('base64')
    const added = await f.request('/plugins/stickers/manage', { operation: 'add', input: { data: image, mimeType: 'image/png', description: '手动添加并保留', tags: ['测试'] } })
    expect(added.response.status).toBe(200)
    const bytes = await readFile(join(f.home, 'capabilities/stickers/library.json'))
    await f.request('/plugins/stickers/disable', {})
    expect((await f.request('/plugins/stickers/manage', { operation: 'list', input: {} })).response.status).toBe(409)
    expect((await f.request('/plugins/stickers/enable', {})).response.status).toBe(200)
    const uninstalled = await f.request('/plugin-packages', { operation: 'uninstall', input: { id: 'stickers', confirmed: true } })
    expect(uninstalled.response.status).toBe(200)
    expect(f.host.getWorkspace().plugins).toEqual([])
    expect(await readFile(join(f.home, 'capabilities/stickers/library.json'))).toEqual(bytes)
    const again = await f.request('/plugin-packages', { operation: 'preview', input: { sourceDirectory: fileURLToPath(new URL('../../../plugins/capabilities/stickers/dist/', import.meta.url)) } })
    expect((await f.request('/plugin-packages', { operation: 'install', input: { planId: again.value.planId, confirmed: true } })).response.status).toBe(200)
    const list = await f.request('/plugins/stickers/manage', { operation: 'list', input: { tags: ['测试'], offset: 0, limit: 20 } })
    expect(list.value.items).toEqual([expect.objectContaining({ assetId: added.value.item.assetId, description: '手动添加并保留' })])
  })
})
