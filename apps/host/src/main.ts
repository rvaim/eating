import { fileURLToPath } from 'node:url'
import { createInstalledHost } from './installed-host'
import { resolveEatingHome } from './paths'

const port = Number(process.env.EATING_HOST_PORT ?? '5181')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('EATING_HOST_PORT 必须是合法端口。')
const dataDirectory = resolveEatingHome()
const autoConnect = process.env.EATING_AUTO_CONNECT ?? 'true'
if (autoConnect !== 'true' && autoConnect !== 'false') throw new Error('EATING_AUTO_CONNECT 必须为 true 或 false。')
const host = await createInstalledHost({ dataDirectory, port, autoConnectOnStartup: autoConnect === 'true',
  staticDirectory: fileURLToPath(new URL('../../../dist/', import.meta.url)) })

try {
  console.log(`Eating Host 已启动：${await host.listen()}`)
  console.log('QQ 使用已配置的 OneBot v11 端点；未配置时不会自动连接。')
} catch (error) {
  await host.close()
  throw error
}
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await host.close()
}
process.once('SIGINT', () => { void stop().then(() => process.exit(0), () => process.exit(1)) })
process.once('SIGTERM', () => { void stop().then(() => process.exit(0), () => process.exit(1)) })
