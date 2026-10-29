import { afterEach, describe, expect, it } from 'vitest'
import { getLocale, setLocale, translate } from '@eating/ui-sdk'
import { isJsonObject } from '@eating/plugin-sdk'
import type { PluginCapability, PluginToolDefinition } from '@eating/plugin-sdk'
import { qqTools } from '../backend/operations'
import { qqViewReceivedImageTool } from '../backend/media'
import plugin from './entry'
import { capabilityDescription, capabilityTitle, parameterDescription, parameterLabel, parameterOptionLabel, qqTranslations, toolDescription, toolSchemaHelp, toolTitle } from './i18n'

const initialLocale = getLocale()
afterEach(() => { setLocale(initialLocale) })

function variables(message: string): string[] {
  return [...message.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map(match => match[1] ?? '').sort()
}

describe('QQ presentation translations', () => {
  it('provides matching nonempty resources and interpolation variables in both languages', () => {
    expect(Object.keys(qqTranslations['en-US']).sort()).toEqual(Object.keys(qqTranslations['zh-CN']).sort())
    for (const [key, source] of Object.entries(qqTranslations['zh-CN'])) {
      const translated = qqTranslations['en-US'][key as keyof typeof qqTranslations['zh-CN']]
      expect(source.trim(), key).not.toBe('')
      expect(translated.trim(), key).not.toBe('')
      expect(variables(translated), key).toEqual(variables(source))
    }
  })

  it('localizes the existing Host tool catalog and each known parameter without changing metadata', () => {
    setLocale('en-US')
    const original = JSON.stringify(qqTools)
    expect(qqTools).toHaveLength(39)
    expect(Object.keys(qqTranslations['zh-CN']).filter(key => /^tool\.[^.]+\.title$/.test(key))).toHaveLength(40)
    for (const tool of [...qqTools, qqViewReceivedImageTool]) {
      expect(toolTitle(tool)).not.toMatch(/\p{Script=Han}/u)
      expect(toolDescription(tool)).not.toMatch(/\p{Script=Han}/u)
      expect(toolSchemaHelp(tool)).not.toMatch(/\p{Script=Han}|\{\{/u)
      expect(toolSchemaHelp(tool)).not.toBe('')
      const properties = isJsonObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {}
      for (const [key, value] of Object.entries(properties)) {
        if (!isJsonObject(value)) continue
        expect(parameterLabel(tool, key, value), `${tool.name}.${key}`).not.toBe(key)
        expect(parameterLabel(tool, key, value), `${tool.name}.${key}`).not.toMatch(/\p{Script=Han}/u)
        expect(parameterDescription(tool, key, value, { max: '20,000' }), `${tool.name}.${key}`).not.toMatch(/\p{Script=Han}|\{\{/u)
        expect(parameterDescription(tool, key, value), `${tool.name}.${key}`).not.toBe(key)
        if (Array.isArray(value.enum)) for (const option of value.enum) {
          expect(parameterOptionLabel(tool, key, String(option)), `${tool.name}.${key}.${String(option)}`).not.toMatch(/\p{Script=Han}|\{\{/u)
        }
      }
      const capability: PluginCapability = { id: tool.name, name: tool.title, description: tool.description, support: 'supported', toolName: tool.name }
      expect(capabilityTitle(capability)).toBe(toolTitle(tool))
      expect(capabilityDescription(capability)).toBe(toolDescription(tool))
    }
    expect(JSON.stringify(qqTools)).toBe(original)
  })

  it('preserves future provider metadata and unknown parameter labels verbatim', () => {
    setLocale('en-US')
    const future: PluginToolDefinition = { name: 'qq_future_tool', title: '未来提供商标题', description: 'Provider metadata 原文', inputSchema: {}, readOnly: true, destructive: false, resultFormat: 'json' }
    expect(toolTitle(future)).toBe(future.title)
    expect(toolDescription(future)).toBe(future.description)
    expect(parameterLabel(future, 'user_id', { title: 'Provider 字段' })).toBe('Provider 字段')
    expect(parameterDescription(future, 'user_id', { description: 'Provider 说明' })).toBe('Provider 说明')
    expect(parameterLabel(future, 'new_key')).toBe('new_key')
    const capability: PluginCapability = { id: 'qq.future', name: '未来能力', description: 'Future provider description', support: 'unknown' }
    expect(capabilityTitle(capability)).toBe(capability.name)
    expect(capabilityDescription(capability)).toBe(capability.description)
  })

  it('reads entry metadata and validations in the current locale while preserving user names', () => {
    setLocale('zh-CN')
    const chineseDescription = plugin.description
    expect(plugin.validate({ displayName: '', endpoint: '' }).errors.displayName).toBe('显示名称需为 1 至 40 个字符。')
    setLocale('en-US')
    expect(plugin.description).not.toBe(chineseDescription)
    expect(plugin.validate({ displayName: '', endpoint: '' }).errors.displayName).toBe('Use 1 to 40 characters for the display name.')
    expect(plugin.summary({ displayName: '用户昵称 {{name}}' })).toBe('用户昵称 {{name}}')
    expect(plugin.summary({})).toBe('QQ configuration')
  })

  it('handles plural messages and leaves interpolated account names unchanged', () => {
    setLocale('en-US')
    expect(translate('qq', 'logs.limit.option', { count: 1, value: '1' })).toBe('1 entry')
    expect(translate('qq', 'logs.limit.option', { count: 1000, value: '1,000' })).toBe('1,000 entries')
    expect(translate('qq', 'connection.account', { name: '昵称 {{raw}}', id: '1234567890123456' })).toBe('Account: 昵称 {{raw}} (1234567890123456)')
    expect(translate('qq', 'capabilities.unsupported')).toBe('Not supported yet')
  })
})
