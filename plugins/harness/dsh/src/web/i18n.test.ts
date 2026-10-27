import { afterEach, describe, expect, it } from 'vitest'
import { getLocale, hasTranslation, setLocale, translate } from '@eating/ui-sdk'
import dsh from './entry'
import { dshTranslations } from './i18n'

const startingLocale = getLocale()
afterEach(() => { setLocale(startingLocale) })

describe('DSH 面板本地化', () => {
  it('双语资源的键与插值参数一致，注册后均可直接读取', () => {
    const zhCN = dshTranslations['zh-CN']
    const enUS = dshTranslations['en-US']
    const keys = Object.keys(zhCN) as (keyof typeof zhCN)[]
    const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort()
    expect(Object.keys(enUS).sort()).toEqual([...keys].sort())
    for (const locale of ['zh-CN', 'en-US'] as const) {
      setLocale(locale)
      for (const key of keys) {
        expect(hasTranslation('dsh', key), `${locale}: ${key}`).toBe(true)
        expect(dshTranslations[locale][key].trim(), `${locale}: ${key}`).not.toBe('')
        expect(placeholders(enUS[key]), key).toEqual(placeholders(zhCN[key]))
      }
      expect(translate('dsh', 'plugin.summary', { name: '<owner name>', model: 'provider/model-v1' })).toBe('<owner name> · provider/model-v1')
    }
  })

  it('同一插件在切换语言后即时生成描述和校验，不改变空草稿或摘要数据', () => {
    const invalid = { ...dsh.initialValues, endpoint: 'invalid URL', timeoutMs: '999' }
    setLocale('zh-CN')
    const chinese = dsh.validate(invalid)
    const chineseDescription = dsh.description
    expect(chinese.errors.endpoint).toBe('请填写有效的 http:// 或 https:// API 基础地址。')
    expect(chinese.errors.timeoutMs).toContain('120,000')
    expect(dsh.validate(dsh.initialValues)).toEqual({ valid: true, errors: {} })
    setLocale('en-US')
    const english = dsh.validate(invalid)
    expect(english.errors.endpoint).toBe('Enter a valid http:// or https:// API base URL.')
    expect(english.errors.timeoutMs).toContain('120,000')
    expect(english.errors).not.toEqual(chinese.errors)
    expect(dsh.description).toBe('Connect a model so your AI can process messages.')
    expect(dsh.description).not.toBe(chineseDescription)
    expect(dsh.summary({ ...dsh.initialValues, displayName: '用户名称', model: 'provider/model-v1', apiKey: 'fixture-hidden-key' })).toBe('用户名称 · provider/model-v1')
    expect(dsh.validate(dsh.initialValues)).toEqual({ valid: true, errors: {} })
  })
})
