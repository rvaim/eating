import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { createImageFixturePng } from './image'

export const adbFixturePng = createImageFixturePng()

export interface AdbFixtureDevice {
  readonly serial: string
  readonly state: 'device' | 'offline' | 'unauthorized' | 'unknown'
  readonly model?: string
  readonly product?: string
  readonly device?: string
  readonly usb?: string
  readonly transportId?: string
}

export interface AdbFixtureState {
  devices: AdbFixtureDevice[]
  connectOutcomes?: Record<string, { state: 'device' | 'offline' | 'unauthorized' | 'fail'; message?: string; model?: string; product?: string }>
  pairOutcomes?: Record<string, { ok: boolean; expectedCode?: string; message?: string }>
  invocations?: Array<{ serial: string | null; argv: string[] }>
}

export interface AdbFixtureHandle {
  readonly path: string
  readonly stateFile: string
  readState: () => AdbFixtureState
  writeState: (next: AdbFixtureState) => void
}

/** An executable protocol fixture (also creates companion state JSON). It never discovers or connects real devices. */
export async function writeAdbFixture(
  directory: string,
  initialState: Partial<AdbFixtureState> = {},
  filename = 'fixture-adb.mjs',
): Promise<string> {
  const handle = await createAdbFixture(directory, initialState, filename)
  return handle.path
}

export async function createAdbFixture(
  directory: string,
  initialState: Partial<AdbFixtureState> = {},
  filename = 'fixture-adb.mjs',
): Promise<AdbFixtureHandle> {
  const file = join(directory, filename)
  const stateFile = file + '.state.json'
  const seed: AdbFixtureState = {
    devices: initialState.devices ?? [
      { serial: 'emulator-5554', state: 'device', model: 'Eating_Fixture', product: 'sdk_fixture', device: 'fixture', transportId: '1' },
    ],
    connectOutcomes: initialState.connectOutcomes ?? {},
    pairOutcomes: initialState.pairOutcomes ?? {},
    invocations: [],
  }
  writeFileSync(stateFile, JSON.stringify(seed, null, 2), 'utf8')

  const pngBase64 = adbFixturePng.toString('base64')
  writeFileSync(
    file,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
const STATE_FILE = ${JSON.stringify(stateFile)}
const PNG = Buffer.from(${JSON.stringify(pngBase64)}, 'base64')
const rawArgs = process.argv.slice(2)

function load() {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
}
function save(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

let serial = null
let restIndex = 0
const valueFlags = new Set(['-s', '-H', '-P', '-L', '-t'])
while (restIndex < rawArgs.length) {
  const tok = rawArgs[restIndex]
  if (!tok.startsWith('-')) break
  if (tok === '-s') {
    serial = rawArgs[restIndex + 1] ?? null
    restIndex += 2
    continue
  }
  if (tok.startsWith('-s') && tok.length > 2) {
    serial = tok.slice(2)
    restIndex++
    continue
  }
  if (valueFlags.has(tok)) {
    restIndex += 2
    continue
  }
  restIndex++
}
const args = rawArgs.slice(restIndex)
const cmd = args[0] ?? ''

const state = load()
state.invocations = [...(state.invocations ?? []).slice(-99), { serial, argv: rawArgs }]
save(state)

if (cmd === 'version') {
  process.stdout.write('Android Debug Bridge version 1.0.41\\nVersion 36.0.0-13206524\\nInstalled as ' + process.argv[1] + '\\n')
  process.exit(0)
}

if (cmd === 'devices') {
  const verbose = args.includes('-l')
  process.stdout.write('List of devices attached\\n')
  for (const dev of state.devices ?? []) {
    if (verbose) {
      const attrs = [
        dev.usb ? 'usb:' + dev.usb : null,
        dev.product ? 'product:' + dev.product : null,
        dev.model ? 'model:' + dev.model : null,
        dev.device ? 'device:' + dev.device : null,
        dev.transportId ? 'transport_id:' + dev.transportId : null,
      ].filter(Boolean).join(' ')
      process.stdout.write(dev.serial + '\\t' + dev.state + (attrs ? ' ' + attrs : '') + '\\n')
    } else {
      process.stdout.write(dev.serial + '\\t' + dev.state + '\\n')
    }
  }
  process.exit(0)
}

if (cmd === 'connect') {
  const addr = args[1] ?? ''
  const rule = (state.connectOutcomes && state.connectOutcomes[addr]) || { state: 'device', model: 'Network_Phone', product: 'eating_net' }
  if (rule.state === 'fail') {
    process.stdout.write((rule.message ?? ('cannot connect to ' + addr + ': Connection refused')) + '\\n')
    process.exit(1)
  }
  state.devices = (state.devices ?? []).filter(d => d.serial !== addr)
  state.devices.push({
    serial: addr,
    state: rule.state,
    model: rule.model ?? 'Network_Phone',
    product: rule.product ?? 'eating_net',
    device: 'network',
    transportId: String(state.devices.length + 1),
  })
  save(state)
  process.stdout.write((rule.message ?? ('connected to ' + addr)) + '\\n')
  process.exit(0)
}

if (cmd === 'disconnect') {
  const addr = args[1] ?? ''
  state.devices = addr ? (state.devices ?? []).filter(d => d.serial !== addr) : []
  save(state)
  process.stdout.write((addr ? 'disconnected ' + addr : 'disconnected everything') + '\\n')
  process.exit(0)
}

if (cmd === 'pair') {
  const addr = args[1] ?? ''
  const code = args[2] ?? ''
  const rule = (state.pairOutcomes && state.pairOutcomes[addr]) || { ok: true }
  if (!rule.ok || (rule.expectedCode && rule.expectedCode !== code)) {
    process.stderr.write((rule.message ?? 'Failed: Wrong pairing code') + '\\n')
    process.exit(1)
  }
  process.stdout.write((rule.message ?? ('Successfully paired to ' + addr + ' [guid=fixture-guid]')) + '\\n')
  process.exit(0)
}

if (serial) {
  const found = (state.devices ?? []).find(d => d.serial === serial)
  if (found && found.state !== 'device') {
    process.stderr.write("error: device '" + serial + "' is " + found.state + '\\n')
    process.exit(1)
  }
  if (!found && (state.devices ?? []).length > 0 && cmd === 'exec-out') {
    process.stderr.write("error: device '" + serial + "' not found\\n")
    process.exit(1)
  }
}

if (cmd === 'echo-target') {
  process.stdout.write(JSON.stringify({ serial, args }) + '\\n')
  process.exit(0)
}

if (cmd === 'utf8-boundary') {
  const chunk = Buffer.from('中'.repeat(6000), 'utf8')
  process.stdout.write(chunk)
  process.exit(0)
}

if (cmd === 'screencap' || (cmd === 'exec-out' && args[1] === 'screencap')) {
  process.stdout.write(PNG)
  process.exit(0)
}

if (cmd === 'hold') {
  process.stdout.write('holding:' + (serial ?? 'default') + '\\n')
  process.stdin.on('data', chunk => process.stdout.write('in:' + chunk.toString('utf8')))
  process.stdin.on('end', () => process.exit(0))
  process.on('SIGINT', () => { process.stdout.write('sigint\\n'); process.exit(130) })
  process.on('SIGTERM', () => { process.stdout.write('sigterm\\n'); process.exit(143) })
} else if (cmd === 'logcat') {
  let line = 0
  const maxLines = Number(args.includes('-t') ? args[args.indexOf('-t') + 1] : 0) || 100
  const timer = setInterval(() => {
    line++
    process.stdout.write('log-' + line + ':' + 'x'.repeat(200) + '\\n')
    if (line >= maxLines) { clearInterval(timer); process.exit(0) }
  }, 10)
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0) })
  process.on('SIGINT', () => { clearInterval(timer); process.exit(0) })
} else {
  process.stdout.write(JSON.stringify({ argv: rawArgs, serial }) + '\\n')
  process.exit(0)
}
`,
    { mode: 0o755 },
  )
  chmodSync(file, 0o755)
  return {
    path: file,
    stateFile,
    readState: () => JSON.parse(readFileSync(stateFile, 'utf8')) as AdbFixtureState,
    writeState: next => writeFileSync(stateFile, JSON.stringify(next, null, 2), 'utf8'),
  }
}

export interface ZipEntrySpec {
  readonly name: string
  readonly data?: Buffer | string
  readonly mode?: number
  readonly directory?: boolean
  readonly store?: boolean
  readonly externalAttributes?: number
}

/** Builds a valid ZIP archive buffer cleanly without external tools. */
export function buildZipBuffer(entries: readonly ZipEntrySpec[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const dataBuf = entry.directory ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8')
    const crc = crc32(dataBuf) >>> 0
    const useStore = entry.directory || entry.store
    const method = useStore ? 0 : 8
    const payload = useStore ? dataBuf : deflateRawSync(dataBuf)
    const extAttr = entry.externalAttributes ?? (((entry.directory ? 0o040755 : (0o100000 | (entry.mode ?? 0o644))) << 16) >>> 0)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    localParts.push(local, payload)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(dataBuf.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(extAttr, 38)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centralParts.push(central)

    offset += local.length + payload.length
  }

  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDir, eocd])
}

export async function startPlatformToolsRepoFixture(options: {
  readonly version?: string
  readonly script?: string
  readonly checksumOverride?: string
  readonly sizeOverride?: number
  readonly zipOverride?: Buffer
  readonly failManifestStatus?: number
  readonly failArchiveStatus?: number
  readonly delayMs?: number
} = {}) {
  const version = options.version ?? '36.0.0'
  const [major = '36', minor = '0', micro = '0'] = version.split('.')
  const exeScript = options.script ?? `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "Android Debug Bridge version 1.0.41"
  echo "Version ${version}-fixture"
  exit 0
fi
if [ "$1" = "devices" ]; then
  echo "List of devices attached"
  exit 0
fi
exit 0
`
  const zipBytes = options.zipOverride ?? buildZipBuffer([
    { name: 'platform-tools/', directory: true },
    { name: 'platform-tools/adb', data: exeScript, mode: 0o755 },
    { name: 'platform-tools/fastboot', data: '#!/bin/sh\nexit 0\n', mode: 0o755 },
    { name: 'platform-tools/NOTICE.txt', data: 'Android SDK Platform-Tools Fixture License', mode: 0o644 },
  ])
  const sha256 = options.checksumOverride ?? createHash('sha256').update(zipBytes).digest('hex')
  const size = options.sizeOverride ?? zipBytes.length
  const archiveName = `platform-tools_r${version}.zip`

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03">
  <remotePackage path="platform-tools">
    <revision><major>${major}</major><minor>${minor}</minor><micro>${micro}</micro></revision>
    <uses-license ref="android-sdk-license"/>
    <archives>
      <archive><host-os>macosx</host-os><complete><size>${size}</size><checksum type="sha256">${sha256}</checksum><url>${archiveName}</url></complete></archive>
      <archive><host-os>linux</host-os><complete><size>${size}</size><checksum type="sha256">${sha256}</checksum><url>${archiveName}</url></complete></archive>
      <archive><host-os>windows</host-os><complete><size>${size}</size><checksum type="sha256">${sha256}</checksum><url>${archiveName}</url></complete></archive>
    </archives>
  </remotePackage>
</sdk:sdk-repository>`

  let manifestRequests = 0
  let archiveRequests = 0

  const server = createServer(async (req, res) => {
    if (options.delayMs) await new Promise(r => setTimeout(r, options.delayMs))
    if (req.url === '/repository2-3.xml') {
      manifestRequests++
      if (options.failManifestStatus) { res.writeHead(options.failManifestStatus).end('fail'); return }
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' }).end(xml)
      return
    }
    if (req.url === '/' + archiveName) {
      archiveRequests++
      if (options.failArchiveStatus) { res.writeHead(options.failArchiveStatus).end('fail'); return }
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(zipBytes.length) }).end(zipBytes)
      return
    }
    res.writeHead(404).end('not found')
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => { server.off('error', rejectListen); resolveListen() })
  })
  const addr = server.address() as { port: number }
  return {
    repositoryUrl: `http://127.0.0.1:${addr.port}/repository2-3.xml`,
    sha256,
    sizeBytes: zipBytes.length,
    get manifestRequests() { return manifestRequests },
    get archiveRequests() { return archiveRequests },
    close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
  }
}
