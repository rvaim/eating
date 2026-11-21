import { describe, expect, it } from 'vitest'
import { parseMessageSplitSettings } from './message-split'

describe('parseMessageSplitSettings', () => {
  it('accepts valid schema1 message split settings', () => {
    const parsed = parseMessageSplitSettings({
      schemaVersion: 1,
      revision: 3,
      enabled: true,
      maxSegments: 8,
      delayMs: 400,
      trimSegments: true,
      rules: [
        { id: 'preset-zh-period', name: '中文句号', enabled: true, pattern: '。+', flags: '', delimiterMode: 'drop' },
        { id: 'preset-exclaim', name: '问号感叹号', enabled: true, pattern: '[？！?!]+', flags: 'u', delimiterMode: 'keep-end' },
      ],
    })
    expect(parsed.revision).toBe(3)
    expect(parsed.rules).toHaveLength(2)
  })

  it('rejects malformed payloads, invalid flags, and unknown modes', () => {
    expect(() => parseMessageSplitSettings(null)).toThrow()
    expect(() => parseMessageSplitSettings({
      schemaVersion: 2,
      revision: 0,
      enabled: false,
      maxSegments: 8,
      delayMs: 400,
      trimSegments: true,
      rules: [],
    })).toThrow()
    expect(() => parseMessageSplitSettings({
      schemaVersion: 1,
      revision: 0,
      enabled: true,
      maxSegments: 8,
      delayMs: 400,
      trimSegments: true,
      rules: [{ id: 'r1', name: 'bad', enabled: true, pattern: '。', flags: 'g', delimiterMode: 'drop' }],
    })).toThrow()
    expect(() => parseMessageSplitSettings({
      schemaVersion: 1,
      revision: 0,
      enabled: true,
      maxSegments: 8,
      delayMs: 400,
      trimSegments: true,
      rules: [{ id: 'r1', name: 'bad', enabled: true, pattern: '。', flags: '', delimiterMode: 'unknown' }],
    })).toThrow()
  })
})
