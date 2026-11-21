import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { QQMessageSplitConfiguration } from './message-split-config'

const roots: string[] = []
afterEach(() => {
  const parent = realpathSync(tmpdir())
  for (const root of roots.splice(0)) {
    const target = realpathSync(root)
    if (target !== root || dirname(target) !== parent || !basename(target).startsWith('eating-qq-split-cfg-')) throw new Error('Unexpected temp path')
    rmSync(target, { recursive: true })
  }
})

function makeDirectory(): string {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-qq-split-cfg-')))
  roots.push(dir)
  return dir
}

describe('QQMessageSplitConfiguration', () => {
  it('returns default disabled settings without creating a file on read, then persists with CAS revision', () => {
    const dir = makeDirectory()
    const config = new QQMessageSplitConfiguration(dir)
    const initial = config.snapshot()
    expect(initial).toEqual({
      schemaVersion: 1,
      revision: 0,
      enabled: false,
      maxSegments: 8,
      delayMs: 400,
      trimSegments: true,
      rules: [],
    })
    expect(existsSync(config.filePath)).toBe(false)

    const saved = config.save({
      expectedRevision: 0,
      enabled: true,
      maxSegments: 6,
      delayMs: 250,
      trimSegments: true,
      rules: [
        { id: 'r1', name: '中文句号', enabled: true, pattern: '。+', flags: 'ui', delimiterMode: 'drop' },
        { id: 'r2', name: '问号感叹号', enabled: true, pattern: '[？！?!]+', flags: '', delimiterMode: 'keep-end' },
      ],
    })
    expect(saved.revision).toBe(1)
    expect(saved.rules[0]?.flags).toBe('iu')
    expect(existsSync(config.filePath)).toBe(true)

    const reopened = new QQMessageSplitConfiguration(dir)
    expect(reopened.snapshot()).toEqual(saved)

    expect(() => config.save({
      expectedRevision: 0,
      enabled: false,
      maxSegments: 6,
      delayMs: 0,
      trimSegments: true,
      rules: [],
    })).toThrowError(expect.objectContaining({ code: 'QQ_MESSAGE_SPLIT_CONFLICT', statusCode: 409 }))
  })

  it('rejects invalid regex, out-of-range settings, duplicate rule IDs, and unknown fields', () => {
    const config = new QQMessageSplitConfiguration(makeDirectory())
    const base = { expectedRevision: 0, enabled: true, maxSegments: 8, delayMs: 300, trimSegments: true, rules: [] as unknown[] }

    expect(() => config.save({ ...base, unknown: 1 })).toThrowError(expect.objectContaining({ code: 'QQ_MESSAGE_SPLIT_INVALID' }))
    expect(() => config.save({ ...base, maxSegments: 0 })).toThrowError(expect.objectContaining({ code: 'QQ_MESSAGE_SPLIT_INVALID' }))
    expect(() => config.save({ ...base, maxSegments: 21 })).toThrowError(expect.objectContaining({ code: 'QQ_MESSAGE_SPLIT_INVALID' }))
    expect(() => config.save({ ...base, delayMs: -1 })).toThrowError(expect.objectContaining({ code: 'QQ_MESSAGE_SPLIT_INVALID' }))
    expect(() => config.save({ ...base, delayMs: 10001 })).toThrowError(expect.objectContaining({ code: 'QQ_MESSAGE_SPLIT_INVALID' }))
    expect(() => config.save({
      ...base,
      rules: [{ id: 'bad', name: 'bad', enabled: true, pattern: '[unclosed', flags: '', delimiterMode: 'drop' }],
    })).toThrowError(expect.objectContaining({ code: 'QQ_MESSAGE_SPLIT_INVALID' }))
    expect(() => config.save({
      ...base,
      rules: [
        { id: 'dup', name: 'a', enabled: true, pattern: '。', flags: '', delimiterMode: 'drop' },
        { id: 'dup', name: 'b', enabled: true, pattern: '\\n', flags: '', delimiterMode: 'drop' },
      ],
    })).toThrowError(expect.objectContaining({ code: 'QQ_MESSAGE_SPLIT_INVALID' }))
    expect(existsSync(config.filePath)).toBe(false)
  })

  it('reports corrupted configuration without overwriting and rejects symlinks', () => {
    const dir = makeDirectory()
    const config = new QQMessageSplitConfiguration(dir)
    const bad = '{"schemaVersion":2,"revision":0}'
    writeFileSync(config.filePath, bad)
    expect(() => config.snapshot()).toThrowError(expect.objectContaining({ code: 'QQ_MESSAGE_SPLIT_CORRUPTED', statusCode: 500 }))
    expect(readFileSync(config.filePath, 'utf8')).toBe(bad)

    const symlinkDir = makeDirectory()
    const target = join(symlinkDir, 'target.json')
    writeFileSync(target, '{}')
    symlinkSync(target, join(symlinkDir, 'message-split.json'))
    const linked = new QQMessageSplitConfiguration(symlinkDir)
    expect(() => linked.snapshot()).toThrowError(expect.objectContaining({ code: 'QQ_MESSAGE_SPLIT_CORRUPTED' }))
  })
})
