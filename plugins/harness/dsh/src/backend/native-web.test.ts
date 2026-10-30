import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareNativeWebProfile } from './native-web'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (realpathSync(root) !== root || dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith('eating-web-profile-')) throw new Error('Unexpected fixture directory')
    rmSync(root, { recursive: true })
  }
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-web-profile-')))
  roots.push(root)
  const bridge = join(root, 'bridge')
  mkdirSync(bridge)
  return { root, bridge, patch: join(root, 'dsh-home/profiles/sdk-minimal/cordis.patch.yml') }
}
const write = (path: string, source: string) => writeFileSync(path, source, { mode: 0o600 })

describe('Eating private native Web profile', () => {
  it('creates a working profile with official Web modules and preserves it on restart', () => {
    const f = fixture()
    prepareNativeWebProfile(f.bridge, { model: 'fixture-model' }, write)
    const first = readFileSync(f.patch, 'utf8')
    expect(first).toContain('@deepseek-ai/dsh-web-app')
    expect(first).toContain('printUrl: false')
    expect(first).toContain('openBrowser: false')
    expect(first).toContain('port: 0')
    expect(first).not.toContain('readOnly')
    prepareNativeWebProfile(f.bridge, { model: 'fixture-model' }, write)
    expect(readFileSync(f.patch, 'utf8')).toBe(first)
    expect(JSON.parse(readFileSync(join(dirname(f.patch), 'package.json'), 'utf8')).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-sdk-minimal'])
  })
  it('keeps the existing writable user layer, JS expressions and comments', () => {
    const f = fixture()
    mkdirSync(dirname(f.patch), { recursive: true })
    write(f.patch, '# owner settings\n- id: ui-theme\n  config:\n    preference: dark\n- id: custom\n  disabled: !!js process.platform === \'win32\'\n')
    prepareNativeWebProfile(f.bridge, { model: 'fixture-model' }, write)
    const after = readFileSync(f.patch, 'utf8')
    expect(after).toContain('# owner settings')
    expect(after).toContain('preference: dark')
    expect(after).toContain("!!js process.platform === 'win32'")
    expect(after.indexOf('id: web-runtime')).toBeLessThan(after.indexOf('id: ui-theme'))
  })
  it('rejects malformed profile configuration without overwriting it', () => {
    const f = fixture()
    mkdirSync(dirname(f.patch), { recursive: true })
    const original = '{ invalid yaml'
    write(f.patch, original)
    expect(() => prepareNativeWebProfile(f.bridge, { model: 'fixture-model' }, write)).toThrow('valid sequence')
    expect(readFileSync(f.patch, 'utf8')).toBe(original)
  })
})
