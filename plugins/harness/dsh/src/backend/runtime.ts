import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const DSH_VERSION = '0.2.1-rc.4'

const DEPENDENCIES = {
  '@deepseek-ai/dsh': DSH_VERSION,
  '@deepseek-ai/dsh-llm-pi-ai': DSH_VERSION,
  '@deepseek-ai/dsh-mcp-client': DSH_VERSION,
} as const

export interface DshRuntimeStatus {
  state: 'missing' | 'installing' | 'ready' | 'error'
  version: string
  error: string | null
}

export interface DshRuntimePaths {
  dshBin: string
  providerEntry: string
  mcpEntry: string
}

/** Only tests supply a fixture CLI. Production chooses the installed npm/pnpm CLI. */
export interface DshRuntimeInstallationOptions {
  packageManager?: { command: string; args?: readonly string[]; kind?: 'npm' | 'pnpm' }
}

type PackageManager = { command: string; args: readonly string[]; kind: 'npm' | 'pnpm' }

const MESSAGES = {
  invalid: '专属 DSH 运行时损坏或版本不匹配，请检查运行时安装状态。',
  missing: '尚未安装专属 DSH 运行时，请先执行安装。',
  unavailable: '未找到可用的 npm 或 pnpm，请安装 Node.js 自带的 npm 后重试。',
  install: '专属 DSH 运行时安装失败，请检查网络和 Node.js 包管理器后重试。',
  busy: '专属 DSH 运行时正在由另一个安装进程处理。',
  canceled: '专属 DSH 运行时安装已取消。',
  timeout: '专属 DSH 运行时安装超时，请检查网络后重试。',
  disposed: '专属 DSH 运行时安装器已关闭。',
} as const

function inside(root: string, target: string): boolean {
  const value = relative(root, target)
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

function readObject(file: string): Record<string, unknown> {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error(MESSAGES.invalid)
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(MESSAGES.invalid)
    return value as Record<string, unknown>
  } finally { closeSync(fd) }
}

function regularFile(file: string): boolean {
  try { return statSync(file).isFile() } catch { return false }
}

function choosePackageManager(): PackageManager {
  // npm_execpath is a CLI location, never a command line supplied by a configuration form.
  const cli = process.env.npm_execpath
  if (cli && isAbsolute(cli) && regularFile(cli)) {
    const name = basename(cli).toLowerCase()
    if (/^pnpm\.(?:cjs|mjs|js)$/.test(name)) return { command: process.execPath, args: [cli], kind: 'pnpm' }
    if (name === 'npm-cli.js') return { command: process.execPath, args: [cli], kind: 'npm' }
  }
  const nodeDir = dirname(process.execPath)
  for (const candidate of [join(nodeDir, 'node_modules/npm/bin/npm-cli.js'), resolve(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')]) {
    if (regularFile(candidate)) return { command: process.execPath, args: [candidate], kind: 'npm' }
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (process.platform === 'win32') {
      const candidate = join(directory, 'node_modules/npm/bin/npm-cli.js')
      if (regularFile(candidate)) return { command: process.execPath, args: [candidate], kind: 'npm' }
    } else {
      const candidate = resolve(directory, 'npm')
      try {
        if (regularFile(candidate) && (statSync(candidate).mode & 0o111) !== 0) return { command: candidate, args: [], kind: 'npm' }
      } catch { /* Continue to the next PATH directory. */ }
    }
  }
  throw new Error(MESSAGES.unavailable)
}

/** Owns only dataDirectory/runtime; versions and failed attempts are never deleted. */
export class DshRuntimeInstallation {
  private readonly root: string
  private readonly options: DshRuntimeInstallationOptions
  private installing: Promise<void> | undefined
  private controller: AbortController | undefined
  private terminateTimer: ReturnType<typeof setTimeout> | undefined
  private error: string | null = null
  private disposed = false

  constructor(dataDirectory: string, options: DshRuntimeInstallationOptions = {}) {
    if (!isAbsolute(dataDirectory)) throw new Error(MESSAGES.invalid)
    this.root = join(resolve(dataDirectory), 'runtime')
    this.options = options
  }

  getStatus(): DshRuntimeStatus {
    if (this.installing) return { state: 'installing', version: DSH_VERSION, error: null }
    try {
      this.resolve()
      return { state: 'ready', version: DSH_VERSION, error: null }
    } catch {
      const state = this.error || existsSync(join(this.root, 'current.json')) ? 'error' : 'missing'
      return { state, version: DSH_VERSION, error: this.error ?? (state === 'error' ? MESSAGES.invalid : null) }
    }
  }

  resolve(): DshRuntimePaths {
    try {
      this.assertRoot()
      const pointer = readObject(join(this.root, 'current.json'))
      if (pointer.schemaVersion !== 1 || pointer.version !== DSH_VERSION || typeof pointer.directory !== 'string' || !/^install-[a-f0-9-]{36}$/.test(pointer.directory)) throw new Error(MESSAGES.invalid)
      return this.resolveDirectory(join(this.root, 'versions', pointer.directory))
    } catch {
      throw new Error(existsSync(join(this.root, 'current.json')) ? MESSAGES.invalid : MESSAGES.missing)
    }
  }

  install(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.reject(new Error(MESSAGES.disposed))
    if (signal?.aborted) return Promise.reject(new Error(MESSAGES.canceled))
    if (this.installing) return this.installing
    if (this.getStatus().state === 'ready') return Promise.resolve()
    if (existsSync(join(this.root, 'current.json'))) return Promise.reject(new Error(MESSAGES.invalid))
    const controller = new AbortController()
    this.controller = controller
    let timedOut = false
    const deadline = setTimeout(() => { timedOut = true; controller.abort() }, 10 * 60 * 1000)
    deadline.unref()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    this.error = null
    this.installing = this.performInstall(controller.signal).catch((error: unknown) => {
      this.error = timedOut ? MESSAGES.timeout : controller.signal.aborted ? MESSAGES.canceled : error instanceof Error && Object.values(MESSAGES).includes(error.message as typeof MESSAGES[keyof typeof MESSAGES]) ? error.message : MESSAGES.install
      throw new Error(this.error)
    }).finally(() => {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
      this.controller = undefined
      this.installing = undefined
    })
    return this.installing
  }

  cancelInstaller(): void { this.controller?.abort() }

  dispose(): void {
    this.disposed = true
    this.cancelInstaller()
  }

  private assertRoot(): void {
    const stat = lstatSync(this.root)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(MESSAGES.invalid)
  }

  private resolveDirectory(directory: string): DshRuntimePaths {
    this.assertRoot()
    const canonicalRoot = realpathSync(this.root)
    const canonicalDirectory = realpathSync(directory)
    if (!inside(canonicalRoot, canonicalDirectory) || lstatSync(directory).isSymbolicLink()) throw new Error(MESSAGES.invalid)
    const manifestPath = join(directory, 'package.json')
    const manifest = readObject(manifestPath)
    const dependencies = manifest.dependencies as Record<string, unknown> | undefined
    if (!dependencies || Object.keys(dependencies).length !== 3 || Object.entries(DEPENDENCIES).some(([name, version]) => dependencies[name] !== version)) throw new Error(MESSAGES.invalid)
    const req = createRequire(manifestPath)
    const checked = (file: string): string => {
      const absolute = realpathSync(file)
      if (!inside(canonicalDirectory, absolute) || !statSync(absolute).isFile()) throw new Error(MESSAGES.invalid)
      return absolute
    }
    const dshManifestPath = checked(req.resolve('@deepseek-ai/dsh/package.json'))
    const dsh = readObject(dshManifestPath)
    if (dsh.name !== '@deepseek-ai/dsh' || dsh.version !== DSH_VERSION || !dsh.bin || typeof dsh.bin !== 'object' || (dsh.bin as Record<string, unknown>).dsh !== 'lib/bin.js') throw new Error(MESSAGES.invalid)
    for (const name of ['@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-mcp-client'] as const) {
      const value = readObject(checked(req.resolve(`${name}/package.json`)))
      if (value.name !== name || value.version !== DSH_VERSION) throw new Error(MESSAGES.invalid)
    }
    if (!['package-lock.json', 'pnpm-lock.yaml'].some((name) => regularFile(join(directory, name)) && statSync(join(directory, name)).size > 0)) throw new Error(MESSAGES.invalid)
    return {
      dshBin: checked(join(dirname(dshManifestPath), 'lib/bin.js')),
      providerEntry: checked(req.resolve('@deepseek-ai/dsh-llm-pi-ai')),
      mcpEntry: checked(req.resolve('@deepseek-ai/dsh-mcp-client')),
    }
  }

  private claimInstallerLock(canonicalRoot: string): number {
    const lockPath = join(this.root, 'install.lock')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let lock: number
      try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600) }
      catch {
        if (attempt !== 0) throw new Error(MESSAGES.busy)
        let previous: Record<string, unknown>
        let observed: ReturnType<typeof lstatSync> | undefined
        try {
          observed = lstatSync(lockPath)
          previous = readObject(lockPath)
          if (!observed.isFile() || observed.isSymbolicLink() || previous.schemaVersion !== 1 || !Number.isSafeInteger(previous.pid) || Number(previous.pid) <= 0) throw new Error(MESSAGES.busy)
          process.kill(Number(previous.pid), 0)
          throw new Error(MESSAGES.busy)
        } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH') throw new Error(MESSAGES.busy)
        }
        // A confirmed dead owner's lock is the only pre-existing entry we remove.
        const target = resolve(lockPath)
        const actual = lstatSync(target)
        if (!observed || dirname(target) !== resolve(this.root) || realpathSync(this.root) !== canonicalRoot || !actual.isFile() || actual.isSymbolicLink() || actual.ino !== observed.ino || actual.dev !== observed.dev) throw new Error(MESSAGES.busy)
        unlinkSync(target)
        continue
      }
      try {
        writeFileSync(lock, JSON.stringify({ schemaVersion: 1, pid: process.pid }))
        fsyncSync(lock)
      } catch (error) { closeSync(lock); throw error }
      return lock
    }
    throw new Error(MESSAGES.busy)
  }

  private async performInstall(signal: AbortSignal): Promise<void> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    this.assertRoot()
    const canonicalRoot = realpathSync(this.root)
    const lockPath = join(this.root, 'install.lock')
    const lock = this.claimInstallerLock(canonicalRoot)
    try {
      if (signal.aborted) throw new Error(MESSAGES.canceled)
      const manager: PackageManager = this.options.packageManager ? {
        command: this.options.packageManager.command,
        args: this.options.packageManager.args ?? [],
        kind: this.options.packageManager.kind ?? 'npm',
      } : choosePackageManager()
      const versions = join(this.root, 'versions')
      mkdirSync(versions, { recursive: true, mode: 0o700 })
      if (lstatSync(versions).isSymbolicLink() || !inside(canonicalRoot, realpathSync(versions))) throw new Error(MESSAGES.invalid)
      const directoryName = `install-${randomUUID()}`
      const directory = join(versions, directoryName)
      mkdirSync(directory, { mode: 0o700 })
      writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name: 'eating-dsh-runtime', private: true, version: '1.0.0', dependencies: DEPENDENCIES }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      const home = join(directory, '.installer-home')
      mkdirSync(home, { mode: 0o700 })
      const npmrc = join(home, 'npmrc')
      const globalNpmrc = join(home, 'global-npmrc')
      for (const file of [npmrc, globalNpmrc]) writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
      const env: NodeJS.ProcessEnv = {}
      for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
      }
      Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'), npm_config_userconfig: npmrc, npm_config_globalconfig: globalNpmrc, npm_config_cache: join(home, 'npm-cache'), npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false', COREPACK_ENABLE_PROJECT_SPEC: '0', COREPACK_ENABLE_AUTO_PIN: '0' })
      const args = manager.kind === 'pnpm'
        ? ['install', '--ignore-scripts', '--ignore-workspace', '--prod']
        : ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=true', '--workspaces=false']
      await this.runInstaller(manager.command, [...manager.args, ...args], directory, env, signal)
      if (signal.aborted) throw new Error(MESSAGES.canceled)
      this.resolveDirectory(directory)
      if (existsSync(join(this.root, 'current.json'))) throw new Error(MESSAGES.busy)
      const temporary = join(this.root, `.current-${randomUUID()}.tmp`)
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, version: DSH_VERSION, directory: directoryName })}\n`)
        fsyncSync(fd)
      } finally { closeSync(fd) }
      if (dirname(resolve(temporary)) !== resolve(this.root) || realpathSync(this.root) !== canonicalRoot) throw new Error(MESSAGES.invalid)
      renameSync(temporary, join(this.root, 'current.json'))
    } finally {
      const own = fstatSync(lock)
      closeSync(lock)
      const target = resolve(lockPath)
      if (dirname(target) === resolve(this.root) && realpathSync(this.root) === canonicalRoot) {
        const actual = lstatSync(target)
        if (actual.isFile() && actual.ino === own.ino && actual.dev === own.dev) unlinkSync(target)
      }
    }
  }

  private runInstaller(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
    return new Promise((resolveInstall, reject) => {
      if (signal.aborted) { reject(new Error(MESSAGES.canceled)); return }
      const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: 'ignore' })
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        if (this.terminateTimer) clearTimeout(this.terminateTimer)
        this.terminateTimer = undefined
        if (error) reject(error)
        else resolveInstall()
      }
      const abort = () => {
        child.kill('SIGTERM')
        this.terminateTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
        this.terminateTimer.unref()
      }
      signal.addEventListener('abort', abort, { once: true })
      child.once('error', () => finish(new Error(MESSAGES.install)))
      child.once('close', (code) => finish(signal.aborted ? new Error(MESSAGES.canceled) : code === 0 ? undefined : new Error(MESSAGES.install)))
      if (signal.aborted) abort()
    })
  }
}
