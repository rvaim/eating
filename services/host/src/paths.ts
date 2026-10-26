import { homedir } from 'node:os'
import { resolve } from 'node:path'

export function resolveEatingHome(configured = process.env.EATING_HOME): string {
  if (!configured?.trim()) return resolve(homedir(), '.eating')
  const value = configured.trim()
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(homedir(), value.slice(2))
  return resolve(value)
}
