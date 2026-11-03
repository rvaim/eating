import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const marker = '# Managed by Eating server-service.mjs'
const serviceName = 'eating-managed.service'
const outside = path => { const value = relative(repository, path); return value === '..' || value.startsWith('..' + sep) }
const quoted = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"'

function fail(message) { throw new Error(message) }
function symbolic(path) { try { return lstatSync(path).isSymbolicLink() } catch (error) { if (error?.code === 'ENOENT') return false; throw error } }
function command(executable, args, environment) {
  const result = spawnSync(executable, args, { cwd: repository, env: environment, encoding: 'utf8', timeout: 120000 })
  if (result.status !== 0 || result.error) fail('Managed Eating operation failed; raw paths and output are not displayed')
  return result.stdout.trim()
}

try {
  if (process.platform !== 'linux') fail('This service entry requires Linux systemd; nothing is installed automatically')
  if (process.getuid?.() === 0) fail('Use an unprivileged account for the managed service')
  const configPath = process.env.EATING_SERVICE_CONFIG
  if (!configPath || !isAbsolute(configPath) || !outside(resolve(configPath)) || !outside(realpathSync(configPath)) || lstatSync(configPath).isSymbolicLink()) fail('Use an external private service configuration')
  const privateConfigPath = realpathSync(configPath)
  const config = JSON.parse(readFileSync(privateConfigPath, 'utf8'))
  const keys = ['dataDirectory', 'runtimeNode', 'runtimeDsh', 'toolingBin', 'listenHost', 'publicOrigin', 'ownerToken', 'port']
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length !== keys.length || keys.some(key => !Object.hasOwn(config, key))) fail('Invalid service configuration')
  for (const key of ['dataDirectory', 'runtimeNode', 'runtimeDsh', 'toolingBin']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key]) || /[\r\n\0]/.test(config[key])) fail('Service paths must be private absolute values')
    const resolved = existsSync(config[key]) ? realpathSync(config[key]) : resolve(realpathSync(dirname(config[key])), config[key].slice(dirname(config[key]).length + 1))
    if (!outside(resolved)) fail('Private service paths cannot be in the code checkout')
  }
  if (config.listenHost !== '0.0.0.0' || !Number.isSafeInteger(config.port) || config.port < 1024 || config.port > 65535 || typeof config.ownerToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(config.ownerToken)) fail('Explicit listener, port and high-entropy entry token are required')
  const origin = new URL(config.publicOrigin)
  if (origin.origin !== config.publicOrigin || !['http:', 'https:'].includes(origin.protocol) || Number(origin.port || (origin.protocol === 'http:' ? 80 : 443)) !== config.port) fail('Public origin must match the configured service port')
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 })
  chmodSync(config.dataDirectory, 0o700)
  const unitDirectory = resolve(homedir(), '.config/systemd/user')
  if (!outside(unitDirectory)) fail('Private service paths cannot be in the code checkout')
  mkdirSync(unitDirectory, { recursive: true, mode: 0o700 })
  if (!outside(realpathSync(unitDirectory)) || lstatSync(unitDirectory).isSymbolicLink()) fail('Private service paths cannot use a symbolic link')
  const unitPath = resolve(unitDirectory, serviceName)
  if (symbolic(unitPath)) fail('Private service unit cannot use a symbolic link')
  if (existsSync(unitPath) && !readFileSync(unitPath, 'utf8').startsWith(marker + '\n')) fail('An unrelated service already owns the selected unit name')
  const environment = { ...process.env, EATING_HOME: config.dataDirectory, PATH: [dirname(config.runtimeNode), config.toolingBin, '/usr/local/bin', '/usr/bin', '/bin'].join(':') }
  const state = resolve(dirname(privateConfigPath), 'service-state.json')
  if (symbolic(state)) fail('Private service state cannot use a symbolic link')
  if (existsSync(unitPath)) {
    const active = command('systemctl', ['--user', 'show', serviceName, '--property=ActiveState', '--value'], environment)
    if (['active', 'activating', 'deactivating', 'reloading'].includes(active)) command('systemctl', ['--user', 'stop', serviceName], environment)
    else if (!['inactive', 'failed'].includes(active)) fail('Managed Eating service state is not recognized')
  }
  for (const plugin of ['communication/qq', 'harness/dsh', 'capabilities/stickers', 'capabilities/image-generation', 'capabilities/openviking-memory']) command(config.runtimeNode, [resolve(repository, 'apps/host/dist/plugin-cli.mjs'), 'install', resolve(repository, 'plugins', plugin, 'dist')], environment)
  const variables = { EATING_HOME: config.dataDirectory, EATING_HOST_PORT: String(config.port), EATING_LISTEN_HOST: config.listenHost, EATING_PUBLIC_ORIGIN: config.publicOrigin, EATING_OWNER_TOKEN: config.ownerToken, EATING_DSH_BIN: config.runtimeDsh, EATING_AUTO_CONNECT: 'true', PATH: environment.PATH }
  const unit = [marker, '[Unit]', 'Description=Eating managed application', 'After=network.target', '', '[Service]', 'Type=simple', 'WorkingDirectory=' + repository.replaceAll('%', '%%'), 'ExecStart=' + quoted(config.runtimeNode) + ' ' + quoted(resolve(repository, 'apps/host/dist/main.mjs')), ...Object.entries(variables).map(([name, value]) => 'Environment=' + quoted(name + '=' + value)), 'UMask=0077', 'Restart=on-failure', 'RestartSec=5', 'TimeoutStopSec=60', 'KillMode=control-group', 'MemoryMax=1536M', 'CPUQuota=100%', 'Nice=10', '', '[Install]', 'WantedBy=default.target', ''].join('\n')
  writeFileSync(unitPath, unit, { mode: 0o600 })
  chmodSync(unitPath, 0o600)
  command('systemd-analyze', ['--user', 'verify', unitPath], environment)
  command('systemctl', ['--user', 'daemon-reload'], environment)
  command('systemctl', ['--user', 'enable', '--now', serviceName], environment)
  const status = command('systemctl', ['--user', 'is-active', serviceName], environment)
  if (status !== 'active') fail('Eating service did not become active')
  writeFileSync(state, JSON.stringify({ serviceName, release: repository, status, installedPluginCount: 5 }), { mode: 0o600 })
  chmodSync(state, 0o600)
  console.log(JSON.stringify({ managedServiceStarted: true, installedPluginCount: 5, configurationCopiedFromLocalAI: false, firewallChanged: false, otherServicesRestarted: false }))
} catch (error) {
  console.error(error instanceof Error && /^(This service|Use an external|Use an unprivileged|Invalid service|Service paths|Private service|Explicit listener|Public origin|An unrelated|Managed Eating|Eating service)/.test(error.message) ? error.message : 'Eating service setup failed; private configuration is not displayed')
  process.exitCode = 1
}
