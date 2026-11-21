import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@eating/plugin-sdk'
import {
  compileSplitRuleRegex,
  defaultQQMessageSplitSettings,
  normalizeSplitFlags,
  qqMessageSplitPresets,
  qqMessageSplitRecommendedPresetIds,
  splitOutgoingQQMessage,
  splitTextByRules,
  validateSplitRulePattern,
} from './message-split'
import type { QQMessageSplitRule } from './message-split'

function presetRule(id: string): QQMessageSplitRule {
  const preset = qqMessageSplitPresets.find(entry => entry.id === id)
  if (!preset) throw new Error(`Missing preset ${id}`)
  return { id: preset.id, name: preset.id, enabled: true, pattern: preset.pattern, flags: preset.flags, delimiterMode: preset.delimiterMode }
}

describe('QQ message regex splitting engine', () => {
  it('validates and normalizes regex flags and patterns', () => {
    expect(normalizeSplitFlags('uims')).toBe('imsu')
    expect(normalizeSplitFlags('ii')).toBeNull()
    expect(normalizeSplitFlags('g')).toBeNull()
    expect(compileSplitRuleRegex('。+', '')).toBeInstanceOf(RegExp)
    expect(compileSplitRuleRegex('[unclosed', '')).toBeNull()
    expect(validateSplitRulePattern('', '')).toBe('empty')
    expect(validateSplitRulePattern('(?<=a)', '')).toBeNull()
    expect(validateSplitRulePattern('a'.repeat(513), '')).toBe('tooLong')
  })

  it('splits by Chinese period dropping the delimiter and by blank lines dropping empty lines', () => {
    const settings = {
      ...defaultQQMessageSplitSettings(),
      enabled: true,
      rules: [presetRule('blank-lines'), presetRule('zh-period')],
    }
    const result = splitTextByRules('第一句。第二句。\n\n第三段。\n   \n第四段。', settings)
    expect(result.parts).toEqual(['第一句', '第二句', '第三段', '第四段'])
    expect(result.truncated).toBe(false)
    expect(result.fallbackToOriginal).toBe(false)
  })

  it('keeps exclamation and question marks at the end while skipping decimals, ellipsis, and URLs with recommended presets', () => {
    const settings = {
      ...defaultQQMessageSplitSettings(),
      enabled: true,
      rules: qqMessageSplitRecommendedPresetIds.map(presetRule),
    }
    const input = '你好呀！今天天气真不错。\n\n圆周率是 3.14，访问 https://example.com?a=1&b=2 看看... Hello. World! Really?!'
    const result = splitTextByRules(input, settings)
    expect(result.parts).toEqual([
      '你好呀！',
      '今天天气真不错',
      '圆周率是 3.14，访问 https://example.com?a=1&b=2 看看... Hello',
      'World!',
      'Really?!',
    ])
  })

  it('supports keep-start delimiter mode without infinite loops even when matching at index 0', () => {
    const settings = {
      ...defaultQQMessageSplitSettings(),
      enabled: true,
      rules: [{ id: 'keep-start', name: 'heading', enabled: true, pattern: '【', flags: '', delimiterMode: 'keep-start' as const }],
    }
    const result = splitTextByRules('【一】内容一【二】内容二【三】内容三', settings)
    expect(result.parts).toEqual(['【一】内容一', '【二】内容二', '【三】内容三'])
  })

  it('handles zero-width lookbehind assertions safely without infinite loops', () => {
    const settings = {
      ...defaultQQMessageSplitSettings(),
      enabled: true,
      rules: [{ id: 'lookbehind', name: 'lookbehind', enabled: true, pattern: '(?<=[？！])', flags: 'u', delimiterMode: 'drop' as const }],
    }
    const result = splitTextByRules('真的吗？太棒了！好的', settings)
    expect(result.parts).toEqual(['真的吗？', '太棒了！', '好的'])
  })

  it('merges overflow back verbatim into the final segment when exceeding maxSegments', () => {
    const settings = {
      ...defaultQQMessageSplitSettings(),
      enabled: true,
      maxSegments: 3,
      rules: [presetRule('zh-period')],
    }
    const result = splitTextByRules('第一句。第二句。第三句。第四句。第五句。', settings)
    expect(result.parts).toEqual(['第一句', '第二句', '第三句。第四句。第五句。'])
    expect(result.truncated).toBe(true)
  })

  it('falls back to original text when all content is matched away as delimiters', () => {
    const settings = {
      ...defaultQQMessageSplitSettings(),
      enabled: true,
      rules: [presetRule('zh-period')],
    }
    const result = splitTextByRules('。。。', settings)
    expect(result.parts).toEqual(['。。。'])
    expect(result.fallbackToOriginal).toBe(true)
  })

  it('respects trimSegments=false and skips disabled rules', () => {
    const settings = {
      ...defaultQQMessageSplitSettings(),
      enabled: true,
      trimSegments: false,
      rules: [
        { ...presetRule('zh-period'), enabled: false },
        presetRule('newlines'),
      ],
    }
    const result = splitTextByRules('  第一行。  \n  第二行  ', settings)
    expect(result.parts).toEqual(['  第一行。  ', '  第二行  '])
  })

  it('splits string, single text segment, and leading reply/at + text arrays while preserving media and CQ messages intact', () => {
    const settings = {
      ...defaultQQMessageSplitSettings(),
      enabled: true,
      rules: [presetRule('zh-period'), presetRule('zh-en-exclaim-question')],
    }

    expect(splitOutgoingQQMessage('第一句。第二句！', true, settings)).toEqual(['第一句', '第二句！'])
    expect(splitOutgoingQQMessage('你好。', true, settings)).toEqual(['你好'])
    expect(splitOutgoingQQMessage('。。。', true, settings)).toEqual(['。。。'])
    expect(splitOutgoingQQMessage('第一句。第二句。', false, settings)).toEqual(['第一句。第二句。'])

    expect(splitOutgoingQQMessage({ type: 'text', data: { text: '你好！再见。' } }, true, settings)).toEqual([
      { type: 'text', data: { text: '你好！' } },
      { type: 'text', data: { text: '再见' } },
    ])

    expect(splitOutgoingQQMessage([
      { type: 'reply', data: { id: '42' } },
      { type: 'at', data: { qq: '234567' } },
      { type: 'text', data: { text: '收到啦！马上处理。' } },
    ], true, settings)).toEqual([
      [
        { type: 'reply', data: { id: '42' } },
        { type: 'at', data: { qq: '234567' } },
        { type: 'text', data: { text: '收到啦！' } },
      ],
      [{ type: 'text', data: { text: '马上处理' } }],
    ])

    const mixedWithImage: JsonValue = [
      { type: 'text', data: { text: '看这张图。真好看。' } },
      { type: 'image', data: { file: 'eating-asset://image-generation/abc' } },
    ]
    expect(splitOutgoingQQMessage(mixedWithImage, true, settings)).toEqual([mixedWithImage])

    const inlineAt: JsonValue = [
      { type: 'text', data: { text: '先说一句。' } },
      { type: 'at', data: { qq: '234567' } },
      { type: 'text', data: { text: '再说一句。' } },
    ]
    expect(splitOutgoingQQMessage(inlineAt, true, settings)).toEqual([inlineAt])

    const recordSegment = { type: 'record', data: { file: 'eating-audio://text-to-speech/abc' } }
    expect(splitOutgoingQQMessage(recordSegment, true, settings)).toEqual([recordSegment])
  })
})
