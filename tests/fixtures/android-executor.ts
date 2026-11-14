import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

/** Runs the actual sealed executor launcher, entirely inside a test directory. */
export async function startPackagedAndroidExecutor(directory: string, adbPath: string) {
  const config = join(directory, 'executor-fixture.json'), token = randomBytes(32).toString('base64url')
  await writeFile(config, JSON.stringify({ schemaVersion: 1, host: '127.0.0.1', port: 0, token, adbPath, workspace: join(directory, 'remote-work') }), { mode: 0o600 })
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../plugins/capabilities/android-control/dist/executor.mjs', import.meta.url)), config], { stdio: ['ignore', 'pipe', 'pipe'] })
  const ended = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  let text = '', diagnostic = ''
  const ready = new Promise<number>((accept, reject) => {
    child.once('error', reject)
    child.stdout.on('data', (bytes: Buffer) => { text += bytes.toString('utf8'); const first = text.split('\n')[0]; if (first) try { const value = JSON.parse(first); if (value.ready && typeof value.address?.port === 'number') accept(value.address.port) } catch { reject(Error('Executor fixture returned invalid startup data')) } })
    void ended.then(() => reject(Error('Packaged executor exited before startup: ' + diagnostic.slice(-2500))))
  })
  child.stderr.on('data', (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString('utf8')).slice(-4000) })
  let timer: ReturnType<typeof setTimeout> | undefined
  let port: number
  try { port = await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Packaged executor startup timed out')), 10000) })]) }
  catch (error) { child.kill('SIGKILL'); throw error }
  finally { clearTimeout(timer) }
  return { endpoint: `http://127.0.0.1:${port}/mcp`, token, close: async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 10000); try { await ended } finally { clearTimeout(force) } } }
}
