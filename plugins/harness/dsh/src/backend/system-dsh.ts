import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** Where a usable DSH installation was found. */
export type SystemDshSource = 'override' | 'path' | 'common' | 'application'

export interface SystemDshLocation {
  /** Executable the launcher shim hands control to. */
  readonly bin: string
  /** Reported version, or null when the launcher refused to answer. */
  readonly version: string | null
  readonly source: SystemDshSource
}

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/

function executable(file: string): boolean {
  try {
    const stat = statSync(file)
    return stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)
  } catch { return false }
}

/** Ordered candidates; every entry is an absolute path, never a user-supplied command line. */
export function systemDshCandidates(environment: NodeJS.ProcessEnv = process.env): readonly { bin: string; source: SystemDshSource }[] {
  const list: { bin: string; source: SystemDshSource }[] = []
  const override = environment.EATING_DSH_BIN
  if (override && isAbsolute(override)) list.push({ bin: override, source: 'override' })
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
  for (const directory of (environment.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) list.push({ bin: join(directory, name), source: 'path' })
  }
  if (process.platform === 'darwin') {
    list.push({ bin: '/usr/local/bin/dsh', source: 'common' })
    list.push({ bin: '/opt/homebrew/bin/dsh', source: 'common' })
    list.push({ bin: join(homedir(), '.local/bin/dsh'), source: 'common' })
    list.push({ bin: '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh', source: 'application' })
  }
  return list
}

/** Ask the launcher for its version. Returns null instead of guessing. */
export function readSystemDshVersion(bin: string, timeoutMs = 8000): string | null {
  try {
    const result = spawnSync(bin, ['--version'], {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin),
    })
    if (result.status !== 0) return null
    const line = String(result.stdout ?? '').trim().split('\n')[0]?.trim() ?? ''
    const match = line.match(VERSION) ?? `${result.stdout ?? ''}${result.stderr ?? ''}`.match(VERSION)
    return match ? match[0] : null
  } catch { return null }
}

/** Find a usable DSH installation; null means the user has to install it. */
export function locateSystemDsh(environment: NodeJS.ProcessEnv = process.env): SystemDshLocation | null {
  const seen = new Set<string>()
  for (const candidate of systemDshCandidates(environment)) {
    if (seen.has(candidate.bin)) continue
    seen.add(candidate.bin)
    if (!executable(candidate.bin)) continue
    return { bin: candidate.bin, version: readSystemDshVersion(candidate.bin), source: candidate.source }
  }
  return null
}
