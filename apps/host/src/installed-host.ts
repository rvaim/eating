import { resolve } from 'node:path'
import { EatingHost } from './app'
import type { HostOptions } from './app'
import { discoverBackendPlugins } from './discovery'
import { acquireWorkspaceLock } from './lock'

/** Acquire the workspace before reading activation and importing executable code. */
export async function createInstalledHost(options: Omit<HostOptions, 'entries' | 'workspaceLock'>): Promise<EatingHost> {
  const release = acquireWorkspaceLock(resolve(options.dataDirectory, 'host'))
  try { return new EatingHost({ ...options, entries: await discoverBackendPlugins(options.dataDirectory), workspaceLock: release }) }
  catch (error) { release(); throw error }
}
