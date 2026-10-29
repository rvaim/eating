import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DshModelCapabilitiesFile } from './model-capabilities'
const directories: string[] = []
const fixture = () => { const directory = realpathSync(mkdtempSync(join(tmpdir(), 'Eating_model_caps_'))); directories.push(directory); return { directory, file: new DshModelCapabilitiesFile(directory) } }
afterEach(() => { for (const directory of directories.splice(0)) { if (dirname(directory) !== realpathSync(tmpdir()) || !basename(directory).startsWith('Eating_model_caps_')) throw new Error('Unsafe fixture path'); rmSync(directory, { recursive: true }) } })
describe('independent current model capabilities', () => {
  it('starts a new feature state without rewriting the saved connection', () => {
    const { directory, file } = fixture(); const connection = '{"private":"fixture-only-key"}\n'
    writeFileSync(join(directory, 'config.json'), connection)
    expect(file.read()).toEqual({ schemaVersion: 1, revision: 0, imageInput: false })
    expect(existsSync(file.filePath)).toBe(false)
    expect(readFileSync(join(directory, 'config.json'), 'utf8')).toBe(connection)
  })
  it('persists the complete state with CAS and leaves no-change saves untouched', () => {
    const { file } = fixture()
    expect(file.update({ expectedRevision: 0, imageInput: true })).toEqual({ schemaVersion: 1, revision: 1, imageInput: true })
    const before = readFileSync(file.filePath, 'utf8')
    expect(file.update({ expectedRevision: 1, imageInput: true }).revision).toBe(1)
    expect(readFileSync(file.filePath, 'utf8')).toBe(before)
    expect(() => file.update({ expectedRevision: 0, imageInput: false })).toThrow('模型能力已被其他页面修改')
    expect(readFileSync(file.filePath, 'utf8')).toBe(before)
  })
  it.each([{}, { imageInput: true }, { expectedRevision: 0 }, { expectedRevision: -1, imageInput: true }, { expectedRevision: 0, imageInput: 'yes' }, { expectedRevision: 0, imageInput: true, extra: true }])('rejects incomplete or extra fields atomically', input => {
    const { file } = fixture(); expect(() => file.update(input)).toThrow(); expect(existsSync(file.filePath)).toBe(false)
  })
  it.each([
    { schemaVersion: 2, revision: 0, imageInput: false }, { schemaVersion: 1, revision: 0 },
    { schemaVersion: 1, revision: 0, imageInput: false, extra: true }, { schemaVersion: 1, revision: '0', imageInput: false },
  ])('rejects unsupported saved shapes without replacing them', value => {
    const { file } = fixture(); const bytes = JSON.stringify(value); writeFileSync(file.filePath, bytes)
    expect(() => file.read()).toThrow('模型能力配置无法读取')
    expect(readFileSync(file.filePath, 'utf8')).toBe(bytes)
  })
})
