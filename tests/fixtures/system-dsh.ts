import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { locateSystemDsh } from '../../plugins/harness/dsh/src/backend/system-dsh'
import type { SystemDshLocation } from '../../plugins/harness/dsh/src/backend/system-dsh'

/** Resolve only the independent npm cache used by direct Node module PoCs. */
export function testRuntimeBin(directory: string): string {
  const root = join(directory, 'runtime')
  const pointer = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8')) as { directory?: unknown }
  if (typeof pointer.directory !== 'string' || !/^install-[a-f0-9-]{36}$/.test(pointer.directory)) throw new Error('Test runtime pointer is invalid')
  return join(root, 'versions', pointer.directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
}

/** Product-chain tests opt in to one explicit system launcher, with fresh test homes. */
export function testSystemDsh(): SystemDshLocation {
  const bin = process.env.EATING_DSH_TEST_SYSTEM_BIN
  if (!bin || !isAbsolute(bin)) throw new Error('EATING_DSH_TEST_SYSTEM_BIN must name the approved absolute system launcher')
  const location = locateSystemDsh({ EATING_DSH_BIN: bin, PATH: '' })
  if (!location || location.bin !== bin || location.version === null) throw new Error('The explicit test system DSH launcher is unavailable')
  return location
}
