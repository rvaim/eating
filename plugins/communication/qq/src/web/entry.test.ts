import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import plugin from './entry'

describe('installed QQ configuration panel contract', () => {
  it('matches the installed manifest and package before the strict catalog loader mounts it', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../plugin.json', import.meta.url), 'utf8'))
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(manifest.version).toBe(pkg.version)
    expect({ id: plugin.id, version: plugin.version, kind: plugin.kind, apiVersion: plugin.apiVersion }).toEqual({ id: manifest.id, version: manifest.version, kind: manifest.kind, apiVersion: manifest.apiVersion })
    expect(typeof plugin.Panel).toBe('function')
  })
})
