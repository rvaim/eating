import { describe, expect, it } from 'vitest'
import { msToSecondsString, secondsStringToMs } from './duration-input'
import {
  mergeUniqueTags,
  parseKeyValueObject,
  parseStringArrayJson,
  serializeKeyValueRows,
  splitTagTokens,
} from './structured-inputs'

describe('UI SDK duration and structured input helpers', () => {
  it('converts milliseconds to readable seconds and back accurately', () => {
    expect(msToSecondsString('30000')).toBe('30')
    expect(msToSecondsString('1500')).toBe('1.5')
    expect(msToSecondsString('750')).toBe('0.75')
    expect(msToSecondsString('abc')).toBe('')

    expect(secondsStringToMs('30')).toBe('30000')
    expect(secondsStringToMs('0.8')).toBe('800')
    expect(secondsStringToMs('1.25')).toBe('1250')
    expect(secondsStringToMs('')).toBe('')
    expect(secondsStringToMs('-5')).toBeNull()
    expect(secondsStringToMs('abc')).toBeNull()
  })

  it('splits pasted or typed tag batches and enforces uniqueness and caps', () => {
    expect(splitTagTokens(' alpha, beta；gamma\ndelta ')).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    expect(splitTagTokens('123 456, 789\n000', 'line-comma-space')).toEqual(['123', '456', '789', '000'])
    expect(mergeUniqueTags(['a'], ['a', 'b', 'c'], false, 2)).toEqual(['a', 'b'])
    expect(mergeUniqueTags(['a'], ['a', 'b'], true, 3)).toEqual(['a', 'a', 'b'])
  })

  it('round-trips structured request parameter JSON objects without losing types', () => {
    const parsed = parseKeyValueObject('{"moderation":"low","n":2,"transparent":true,"nested":{"k":1}}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.entries.map(item => [item.key, item.type])).toEqual([
      ['moderation', 'string'],
      ['n', 'number'],
      ['transparent', 'boolean'],
      ['nested', 'json'],
    ])
    expect(JSON.parse(serializeKeyValueRows(parsed.entries))).toEqual({
      moderation: 'low',
      n: 2,
      transparent: true,
      nested: { k: 1 },
    })
    expect(serializeKeyValueRows([])).toBe('')
    expect(serializeKeyValueRows([], '{}')).toBe('{}')
    expect(parseKeyValueObject('[]')).toEqual({ ok: false, errorKey: 'structured.jsonInvalidObject' })
    expect(parseKeyValueObject('{broken')).toEqual({ ok: false, errorKey: 'structured.jsonInvalidObject' })
  })

  it('parses string arrays cleanly for CLI argv editors', () => {
    expect(parseStringArrayJson('')).toEqual({ ok: true, items: [] })
    expect(parseStringArrayJson('["devices", "-l"]')).toEqual({ ok: true, items: ['devices', '-l'] })
    expect(parseStringArrayJson('[1, 2]')).toEqual({ ok: false })
    expect(parseStringArrayJson('{"a":1}')).toEqual({ ok: false })
  })
})
