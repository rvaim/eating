import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DSH_VERSION, DshRuntimeInstallation } from './runtime'

const cleanups: Array<() => void> = []

function fixture(mode: 'success' | 'fail' | 'wait' = 'success') {
  const parent = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(parent, 'eating-dsh-runtime-')))
  const script = join(directory, 'fixture-package-manager.mjs')
  writeFileSync(script, `import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const manifest=JSON.parse(readFileSync('package.json','utf8'));
writeFileSync('observations.json',JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,envKeys:Object.keys(process.env)}));
if (${JSON.stringify(mode)} === 'fail') {process.stderr.write('fixture-secret-install-error');process.exit(9);}
if (${JSON.stringify(mode)} === 'wait') {setInterval(()=>{},1000);} else {
for (const [name,version] of Object.entries(manifest.dependencies)) {
const root=join('node_modules',name);mkdirSync(join(root,'lib'),{recursive:true});
const cli=name==='@deepseek-ai/dsh';
writeFileSync(join(root,'package.json'),JSON.stringify({name,version,type:'module',main:'lib/index.js',exports:{'.':'./lib/index.js','./package.json':'./package.json'},...(cli?{bin:{dsh:'lib/bin.js'}}:{})}));
writeFileSync(join(root,'lib',cli?'bin.js':'index.js'),'export const fixture = true;');
}
writeFileSync('package-lock.json',JSON.stringify({name:manifest.name,lockfileVersion:3,packages:{'':{dependencies:manifest.dependencies}}}));
}
`)
  cleanups.push(() => {
    if (realpathSync(directory) !== directory || dirname(directory) !== parent || !basename(directory).startsWith('eating-dsh-runtime-')) throw new Error('Invalid test cleanup path')
    rmSync(directory, { recursive: true })
  })
  const installation = new DshRuntimeInstallation(directory, { packageManager: { command: process.execPath, args: [script] } })
  cleanups.push(() => installation.dispose())
  const installedDirectory = () => {
    const pointer = JSON.parse(readFileSync(join(directory, 'runtime/current.json'), 'utf8')) as { directory: string }
    return join(directory, 'runtime/versions', pointer.directory)
  }
  return { directory, script, installation, installedDirectory }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.unstubAllEnvs()
})

describe('plugin-owned fixed DSH runtime installation', () => {
  it('does not install implicitly and resolves absolute entries only after explicit installation', async () => {
    const f = fixture()
    expect(f.installation.getStatus()).toEqual({ state: 'missing', version: DSH_VERSION, error: null })
    expect(existsSync(join(f.directory, 'runtime'))).toBe(false)
    expect(() => f.installation.resolve()).toThrow('尚未安装专属 DSH 运行时')
    await f.installation.install()
    const paths = f.installation.resolve()
    const installed = f.installedDirectory()
    expect(paths).toEqual({
      dshBin: join(installed, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
      providerEntry: join(installed, 'node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),
      mcpEntry: join(installed, 'node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js'),
    })
    expect(f.installation.getStatus()).toEqual({ state: 'ready', version: DSH_VERSION, error: null })
    expect(new DshRuntimeInstallation(f.directory).resolve()).toEqual(paths)
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as { dependencies: unknown }
    expect(manifest.dependencies).toEqual({ '@deepseek-ai/dsh': DSH_VERSION, '@deepseek-ai/dsh-llm-pi-ai': DSH_VERSION, '@deepseek-ai/dsh-mcp-client': DSH_VERSION })
    expect(existsSync(join(installed, 'package-lock.json'))).toBe(true)
    const observations = readFileSync(join(installed, 'observations.json'), 'utf8')
    expect(observations).toContain('--ignore-scripts')
    expect(observations).toContain('--workspaces=false')
    expect(existsSync(join(f.directory, 'runtime/install.lock'))).toBe(false)
  })

  it('validates an existing ready runtime idempotently without reinstalling or touching sibling data', async () => {
    const f = fixture()
    writeFileSync(join(f.directory, 'owner-data.json'), 'retained-owner-data')
    await f.installation.install()
    const pointer = readFileSync(join(f.directory, 'runtime/current.json'), 'utf8')
    const versions = readdirSync(join(f.directory, 'runtime/versions'))
    await f.installation.install()
    expect(readFileSync(join(f.directory, 'runtime/current.json'), 'utf8')).toBe(pointer)
    expect(readdirSync(join(f.directory, 'runtime/versions'))).toEqual(versions)
    expect(readFileSync(join(f.directory, 'owner-data.json'), 'utf8')).toBe('retained-owner-data')
    expect(readdirSync(f.directory).sort()).toEqual(['fixture-package-manager.mjs', 'owner-data.json', 'runtime'])
  })

  it('gives the installer an isolated home and a strict environment allowlist', async () => {
    vi.stubEnv('DSH_HOME', '/fixture-parent-dsh-home')
    vi.stubEnv('OPENAI_API_KEY', 'fixture-credential')
    vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-other-credential')
    vi.stubEnv('EATING_TOKEN', 'fixture-mcp-token')
    vi.stubEnv('NODE_OPTIONS', '--fixture-parent-option')
    vi.stubEnv('npm_config_registry', 'https://fixture-parent-registry.invalid')
    const f = fixture()
    await f.installation.install()
    const observations = JSON.parse(readFileSync(join(f.installedDirectory(), 'observations.json'), 'utf8')) as { home: string; envKeys: string[] }
    expect(observations.home).toBe(join(f.installedDirectory(), '.installer-home'))
    expect(observations.envKeys).not.toEqual(expect.arrayContaining(['DSH_HOME']))
    for (const name of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'EATING_TOKEN', 'NODE_OPTIONS', 'npm_config_registry']) expect(observations.envKeys).not.toContain(name)
    expect(process.env.DSH_HOME).toBe('/fixture-parent-dsh-home')
    expect(process.env.OPENAI_API_KEY).toBe('fixture-credential')
  })

  it('rejects a different published version without replacing the active pointer or old contents', async () => {
    const f = fixture()
    await f.installation.install()
    const pointer = readFileSync(join(f.directory, 'runtime/current.json'), 'utf8')
    const manifest = join(f.installedDirectory(), 'node_modules/@deepseek-ai/dsh/package.json')
    const old = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }
    writeFileSync(manifest, JSON.stringify({ ...old, version: '999.0.0' }))
    expect(f.installation.getStatus()).toMatchObject({ state: 'error' })
    expect(() => f.installation.resolve()).toThrow('版本不匹配')
    await expect(f.installation.install()).rejects.toThrow('版本不匹配')
    expect(readFileSync(join(f.directory, 'runtime/current.json'), 'utf8')).toBe(pointer)
    expect(readFileSync(manifest, 'utf8')).toContain('999.0.0')
  })

  it('keeps a failed staging installation, publishes no active runtime and returns only a fixed error', async () => {
    const f = fixture('fail')
    await expect(f.installation.install()).rejects.toThrow('专属 DSH 运行时安装失败')
    expect(f.installation.getStatus()).toMatchObject({ state: 'error', version: DSH_VERSION })
    expect(f.installation.getStatus().error).not.toContain('fixture-secret')
    expect(existsSync(join(f.directory, 'runtime/current.json'))).toBe(false)
    expect(readdirSync(join(f.directory, 'runtime/versions'))).toHaveLength(1)
    expect(existsSync(join(f.directory, 'runtime/install.lock'))).toBe(false)
  })

  it('cancels its installer child without activating it or leaving the installer lock', async () => {
    const f = fixture('wait')
    const controller = new AbortController()
    const promise = f.installation.install(controller.signal)
    const assertion = expect(promise).rejects.toThrow('安装已取消')
    expect(f.installation.getStatus().state).toBe('installing')
    const concurrent = new DshRuntimeInstallation(f.directory, { packageManager: { command: process.execPath, args: [f.script] } })
    await expect(concurrent.install()).rejects.toThrow('另一个安装进程')
    expect(existsSync(join(f.directory, 'runtime/install.lock'))).toBe(true)
    await vi.waitFor(() => {
      const versions = readdirSync(join(f.directory, 'runtime/versions'))
      expect(versions.some(name => existsSync(join(f.directory, 'runtime/versions', name, 'observations.json')))).toBe(true)
    })
    controller.abort()
    await assertion
    expect(existsSync(join(f.directory, 'runtime/current.json'))).toBe(false)
    expect(existsSync(join(f.directory, 'runtime/install.lock'))).toBe(false)
    f.installation.dispose()
    await expect(f.installation.install()).rejects.toThrow('已关闭')
  })

  it('reclaims only a confirmed dead installer lock after an interrupted installation', async () => {
    const f = fixture()
    mkdirSync(join(f.directory, 'runtime'))
    writeFileSync(join(f.directory, 'runtime/install.lock'), JSON.stringify({ schemaVersion: 1, pid: 2147483647 }), { mode: 0o600 })
    await f.installation.install()
    expect(f.installation.getStatus().state).toBe('ready')
    expect(existsSync(join(f.directory, 'runtime/install.lock'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('does not install through a symlink runtime directory', async () => {
    const f = fixture()
    const target = fixture()
    symlinkSync(target.directory, join(f.directory, 'runtime'))
    await expect(f.installation.install()).rejects.toThrow('损坏或版本不匹配')
    expect(readdirSync(target.directory)).toEqual(['fixture-package-manager.mjs'])
  })
})
