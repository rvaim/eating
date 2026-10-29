// Eating 生成的启动转交层：普通 node 执行本文件，再由它启动系统安装的 DSH。
//
// 为什么需要它：@deepseek-ai/dsh-sdk-client 固定用 process.execPath（node）执行
// dshBin，而系统 dsh 是一个 /bin/sh 脚本、其真正的 CLI 位于 app.asar 内。
// node 既不能执行 shell 脚本，也读不了 asar，所以这里转交给系统启动器，
// 并用 stdio: 'inherit' 让 JSON-RPC 双向直通。
import { spawn } from 'node:child_process'

const launcher = process.env.EATING_DSH_SYSTEM_BIN
if (!launcher) {
  console.error('Eating: 未提供系统 DSH 路径（EATING_DSH_SYSTEM_BIN）')
  process.exit(78)
}

const javascript = /\.(?:mjs|cjs|js)$/i.test(launcher)
const windowsScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(launcher)
const child = spawn(javascript ? process.execPath : launcher, javascript ? [launcher, ...process.argv.slice(2)] : process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
  shell: windowsScript,
})

child.on('error', error => {
  console.error(`Eating: 无法启动系统 DSH：${error.message}`)
  process.exit(78)
})
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => { try { child.kill(signal) } catch { /* 子进程可能已退出 */ } })
}
