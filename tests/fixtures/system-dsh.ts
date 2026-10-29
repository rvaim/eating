import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SystemDshLocation } from '../../plugins/harness/dsh/src/backend/system-dsh'

/** Resolve the CLI entry of a prepared EATING_DSH_TEST_RUNTIME cache. */
export function testRuntimeBin(directory: string): string {
  const root = join(directory, 'runtime')
  const pointer = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8')) as { directory?: unknown }
  if (typeof pointer.directory !== 'string' || !/^install-[a-f0-9-]{36}$/.test(pointer.directory)) throw new Error('Test runtime pointer is invalid')
  return join(root, 'versions', pointer.directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
}

/** Location value describing the prepared test runtime. */
export function testSystemDsh(directory: string): SystemDshLocation {
  return { bin: testRuntimeBin(directory), version: '0.0.0-test', source: 'override' }
}
