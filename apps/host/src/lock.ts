import { openSync, readFileSync, closeSync, unlinkSync, chmodSync, mkdirSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { hostname } from 'node:os'
import { PlatformError } from '@eating/plugin-sdk'

export function acquireWorkspaceLock(directory: string): () => void {
  const root = resolve(directory)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  const path = join(root, 'host.lock')
  if (dirname(path) !== root) throw new Error('Invalid lock path')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      const lockId = randomUUID()
      const contents = JSON.stringify({ pid: process.pid, machine: hostname(), lockId, createdAt: new Date().toISOString() })
      writeSync(fd, contents)
      closeSync(fd)
      return () => {
        try {
          const existing = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; machine?: string; lockId?: string }
          if (existing.pid === process.pid && existing.machine === hostname() && existing.lockId === lockId && dirname(resolve(path)) === root) unlinkSync(path)
        } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      let previous: { pid?: number; machine?: string }
      try { previous = JSON.parse(readFileSync(path, 'utf8')) as typeof previous }
      catch { throw new PlatformError('WORKSPACE_LOCKED', '运行锁不可读取，请核对工作区后处理。', 409) }
      if (previous.machine !== hostname() || !previous.pid || !Number.isInteger(previous.pid)) throw new PlatformError('WORKSPACE_LOCKED', '工作区被其他实例或设备占用。', 409)
      try { process.kill(previous.pid, 0); throw new PlatformError('WORKSPACE_LOCKED', '同一工作区已有 Host 在运行。', 409) }
      catch (check) {
        if (check instanceof PlatformError) throw check
        if (!(check instanceof Error && 'code' in check && check.code === 'ESRCH')) throw new PlatformError('WORKSPACE_LOCKED', '无法确认旧 Host 已退出。', 409)
      }
      if (dirname(resolve(path)) !== root) throw new Error('Invalid lock path')
      unlinkSync(path)
    }
  }
  throw new PlatformError('WORKSPACE_LOCKED', '无法取得工作区运行锁。', 409)
}
