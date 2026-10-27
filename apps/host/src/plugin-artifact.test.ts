import { cp, mkdtemp, readFile, writeFile, rm, realpath, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { installPluginPackage, uninstallPluginPackage } from './plugin-installation'
import { createInstalledHost } from './installed-host'
import { discoverBackendPlugins } from './discovery'
import { startOneBotFixture } from '../../../tests/fixtures/onebot'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const roots: string[] = []
const cleanups: Array<() => Promise<unknown>> = []
async function temporary() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_artifact_')))
  roots.push(directory); return directory
}
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) await stop()
  for (const root of roots.splice(0)) {
    if (await realpath(root) !== root || dirname(root) !== await realpath(tmpdir()) || !root.split('/').at(-1)?.startsWith('Eating_artifact_')) throw new Error('Unsafe test cleanup')
    await rm(root, { recursive: true })
  }
})

describe('独立QQ插件产物', () => {
  it('脱离源码安装、MCP调用、升级和卸载都保留同一账号数据', async () => {
    const home = await temporary(), source = join(await temporary(), 'qq')
    await cp(fileURLToPath(new URL('../../../plugins/communication/qq/dist/', import.meta.url)), source, { recursive: true })
    await installPluginPackage(home, source)
    const versionFile = join(source, 'server.mjs')
    const compiled = await readFile(versionFile, 'utf8')
    expect(compiled).toContain('version = "0.4.0"')
    await writeFile(versionFile, compiled.replace('version = "0.4.0"', 'version = "0.4.1"'))
    const manifestPath = join(source, 'eating-plugin.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string; integrity: Record<string, string> }
    manifest.version = '0.4.1'
    manifest.integrity['server.mjs'] = createHash('sha256').update(await readFile(versionFile)).digest('hex')
    const uiPath = join(source, 'ui/index.js')
    const ui = await readFile(uiPath, 'utf8')
    await writeFile(uiPath, ui.replace('version:"0.4.0"', 'version:"0.4.1"'))
    manifest.integrity['ui/index.js'] = createHash('sha256').update(await readFile(uiPath)).digest('hex')
    await writeFile(manifestPath, JSON.stringify(manifest))
    const fixture = await startOneBotFixture()
    cleanups.push(() => fixture.close())
    let host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [] })
    cleanups.push(() => host.close())
    let url = await host.listen()
    let bootstrap = await fetch(url + '/api/bootstrap')
    let csrf = (await bootstrap.json() as { csrfToken: string }).csrfToken
    let cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
    const api = async (path: string, body?: unknown) => fetch(url + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'X-Eating-CSRF': csrf, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    expect((await api('/plugins/qq/configuration', { displayName: '产物安装账号', endpoint: fixture.endpoint, timeoutMs: 1000, autoConnect: false, forwardToHarness: true, receiveGroups: true })).status).toBe(200)
    expect((await api('/plugins/qq/connect', {})).status).toBe(200)
    const indexPath = join(home, 'bot/qq-bot/accounts.json')
    const originalIndex = await readFile(indexPath, 'utf8')
    const instance = (JSON.parse(originalIndex) as { defaultInstanceId: string }).defaultInstanceId
    const configPath = join(home, 'bot/qq-bot/accounts', instance, 'config.json')
    const originalConfig = await readFile(configPath, 'utf8')
    const registration = await (await api('/plugins/qq/mcp-registration', {})).json() as { url: string; headers: { Authorization: string } }
    const client = new Client({ name: 'artifact-test', version: '1.0.0' })
    cleanups.push(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL(registration.url), { requestInit: { headers: registration.headers } }))
    expect((await client.callTool({ name: 'qq_get_friend_list', arguments: {} })).isError).toBe(false)
    expect((await client.callTool({ name: 'qq_send_private_message', arguments: { user_id: '987654321', message: 'missing-key' } })).isError).toBe(true)
    expect(fixture.requests.filter(request => request.action === 'send_private_msg')).toHaveLength(0)
    await client.close(); await host.close()
    await installPluginPackage(home, source)
    // Remove the isolated build source: subsequent imports must resolve from installed files only.
    if (await realpath(source) !== source || dirname(source) !== roots[1]) throw new Error('Unsafe source cleanup')
    await rm(source, { recursive: true })
    host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [] })
    expect(host.getWorkspace()).toMatchObject({ plugins: [{ id: 'qq', version: '0.4.1' }] })
    expect(await readFile(indexPath, 'utf8')).toBe(originalIndex)
    expect(await readFile(configPath, 'utf8')).toBe(originalConfig)
    url = await host.listen(); bootstrap = await fetch(url + '/api/bootstrap'); csrf = (await bootstrap.json() as { csrfToken: string }).csrfToken; cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
    expect((await api('/plugins/qq/connect', {})).status).toBe(200)
    await host.close()
    await uninstallPluginPackage(home, 'qq')
    expect(await discoverBackendPlugins(home)).toEqual([])
    expect(await readFile(indexPath, 'utf8')).toBe(originalIndex)
    expect(await readFile(configPath, 'utf8')).toBe(originalConfig)
  })

  it('空安装目录不加载仓库中的QQ源码', async () => {
    const home = await temporary()
    await mkdir(join(home, 'plugins'))
    const host = await createInstalledHost({ dataDirectory: home, port: 0, allowedUiOrigins: [] })
    cleanups.push(() => host.close())
    expect(host.getWorkspace()).toMatchObject({ plugins: [] })
  })
})
