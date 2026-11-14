import { startAndroidExecutor } from './server.mjs'
import { isAbsolute } from 'node:path'
const file = process.argv[2]
if (!file || !isAbsolute(file)) throw new Error('请提供项目外、绝对路径的执行端配置文件。')
const executor = await startAndroidExecutor(file)
console.log(JSON.stringify({ ready: true, address: executor.address }))
let stopping = false
const close = async () => { if (stopping) return; stopping = true; await executor.close(); process.exit(0) }
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close())
