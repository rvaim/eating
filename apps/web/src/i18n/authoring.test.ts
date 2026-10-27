import { afterEach, describe, expect, it } from 'vitest'
import { TEMPLATE_VARIABLES } from '@eating/plugin-sdk'
import { setLocale, translate } from '@eating/ui-sdk'
import { authoringResources, variableDescriptionKeys } from './authoring'
import { settingsResources } from './settings'

afterEach(() => setLocale('zh-CN'))

const placeholders = (text: string) => [...text.matchAll(/\{\{([^{}]+)\}\}/g)].map(match => match[1]).sort()

describe('设置和创作双语资源', () => {
  it('两种语言提供相同的非空key和插值参数', () => {
    for (const resources of [settingsResources, authoringResources]) {
      expect(Object.keys(resources['en-US']).sort()).toEqual(Object.keys(resources['zh-CN']).sort())
      for (const [key, text] of Object.entries(resources['zh-CN'])) {
        const english = resources['en-US'][key as keyof typeof resources['en-US']]
        expect(text.trim(), key).not.toBe('')
        expect(english.trim(), key).not.toBe('')
        expect(placeholders(english), key).toEqual(placeholders(text))
        expect(english, key).not.toMatch(/\p{Script=Han}/u)
      }
    }
  })

  it('每个协议变量都具有双语说明，所有诊断code都有双语资源', () => {
    expect(Object.keys(variableDescriptionKeys).sort()).toEqual(TEMPLATE_VARIABLES.map(variable => variable.name).sort())
    for (const locale of ['zh-CN', 'en-US'] as const) {
      setLocale(locale)
      for (const variable of TEMPLATE_VARIABLES) {
        const key = variableDescriptionKeys[variable.name]!
        expect(translate('authoring', key)).not.toBe(key)
      }
      for (const code of ['UNKNOWN_VARIABLE', 'UNAVAILABLE_VARIABLE', 'UNCLOSED_VARIABLE', 'MALFORMED_VARIABLE']) {
        const key = `editor.diagnostic.${code}`
        expect(translate('authoring', key, { name: 'custom' })).not.toBe(key)
      }
    }
  })

  it('英语数量采用单复数，协议起始标记保持原样', () => {
    setLocale('en-US')
    expect(translate('settings', 'count.messages', { count: 1, formattedCount: '1' })).toBe('1 message')
    expect(translate('settings', 'count.messages', { count: 2, formattedCount: '2' })).toBe('2 messages')
    expect(translate('authoring', 'editor.scopeCount', { scope: 'Persona', count: 1, formattedCount: '1' })).toBe('Persona · 1 available variable')
    expect(translate('authoring', 'editor.hint', { opening: '{{' })).toContain('Type {{ to choose')
  })
})
