import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocaleResources } from './i18n'
import { commonResources } from './locales/common'

const symbol = Symbol.for('eating.ui.i18n.v1')
const runtime = globalThis as typeof globalThis & { [symbol]?: unknown }
let values: Map<string, string>
let storageListener: ((event: { key: string; newValue: string | null }) => void) | undefined

beforeEach(() => {
  delete runtime[symbol]
  vi.resetModules(); vi.useFakeTimers()
  values = new Map()
  vi.stubGlobal('localStorage', { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value) }) })
  vi.stubGlobal('document', { documentElement: { lang: '', dir: '' } })
  vi.stubGlobal('window', { addEventListener: vi.fn((event: string, listener: typeof storageListener) => { if (event === 'storage') storageListener = listener }) })
})
afterEach(() => { delete runtime[symbol]; storageListener = undefined; vi.unstubAllGlobals(); vi.useRealTimers() })
const resources: LocaleResources = {
  'zh-CN': { title: '消息设置', greeting: '你好，{{name}}', files_one: '{{count}} 个文件', files_other: '{{count}} 个文件' },
  'en-US': { title: 'Message settings', greeting: 'Hello, {{name}}', files_one: '{{count}} file', files_other: '{{count}} files' },
}

describe('shared user-facing localization', () => {
  it('keeps complete nonempty common resources in both shipped languages', () => {
    expect(Object.keys(commonResources['en-US']).sort()).toEqual(Object.keys(commonResources['zh-CN']).sort())
    for (const messages of Object.values(commonResources)) expect(Object.values(messages).every(message => typeof message === 'string' && message.length > 0)).toBe(true)
  })
  it('uses Chinese by default and persists only the display-language preference', async () => {
    const sdk = await import('./i18n')
    sdk.registerTranslations('fixture', resources)
    expect(sdk.getLocale()).toBe('zh-CN')
    expect(sdk.translate('fixture', 'title')).toBe('消息设置')
    sdk.setLocale('en-US')
    expect(sdk.translate('fixture', 'title')).toBe('Message settings')
    expect(localStorage.setItem).toHaveBeenCalledExactlyOnceWith('eating.locale', 'en-US')
    expect(document.documentElement.lang).toBe('en-US')
    expect(document.documentElement.dir).toBe('ltr')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('loads a saved language before rendering and ignores unsupported stored values', async () => {
    values.set('eating.locale', 'en-US')
    const sdk = await import('./i18n')
    expect(sdk.getLocale()).toBe('en-US')
    expect(document.documentElement.lang).toBe('en-US')
    delete runtime[symbol]; values.set('eating.locale', 'unsupported-locale')
    expect(sdk.getLocale()).toBe('zh-CN')
  })
  it('shares the selected language and resource bundles across independently loaded SDK modules', async () => {
    const first = await import('./i18n')
    first.registerTranslations('fixture', resources)
    first.setLocale('en-US')
    vi.resetModules()
    const second = await import('./i18n')
    expect(second.getLocale()).toBe('en-US')
    expect(second.translate('fixture', 'title')).toBe('Message settings')
    second.registerTranslations('plugin-fixture', { 'zh-CN': { connect: '连接' }, 'en-US': { connect: 'Connect' } })
    expect(first.translate('plugin-fixture', 'connect')).toBe('Connect')
    second.setLocale('zh-CN')
    expect(first.translate('fixture', 'title')).toBe('消息设置')
  })
  it('updates subscribers across tabs without rewriting storage and releases subscriptions', async () => {
    const sdk = await import('./i18n')
    const changed = vi.fn(), stop = sdk.subscribeLocale(changed)
    storageListener?.({ key: 'unrelated', newValue: 'en-US' })
    expect(changed).not.toHaveBeenCalled()
    storageListener?.({ key: 'eating.locale', newValue: 'en-US' })
    expect(changed).toHaveBeenCalledOnce()
    expect(sdk.getLocale()).toBe('en-US')
    expect(localStorage.setItem).not.toHaveBeenCalled()
    stop(); sdk.setLocale('zh-CN')
    expect(changed).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps switching usable when browser preference storage is unavailable', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    const sdk = await import('./i18n')
    expect(sdk.getLocale()).toBe('zh-CN')
    expect(() => sdk.setLocale('en-US')).not.toThrow()
    expect(sdk.getLocale()).toBe('en-US')
  })
  it('uses whole-message interpolation and real plural forms without reinterpreting supplied values', async () => {
    const sdk = await import('./i18n')
    sdk.registerTranslations('fixture', resources); sdk.setLocale('en-US')
    expect(sdk.translate('fixture', 'greeting', { name: '{{title}}' })).toBe('Hello, {{title}}')
    expect(sdk.translate('fixture', 'files', { count: 1 })).toBe('1 file')
    expect(sdk.translate('fixture', 'files', { count: 2 })).toBe('2 files')
    expect(sdk.translate('fixture', 'optional', { defaultValue: 'Provider-defined label' })).toBe('Provider-defined label')
  })
  it('formats dates and compact quantities using the current display locale', async () => {
    const sdk = await import('./i18n')
    expect(sdk.formatDateTime('2026-10-28T00:00:00Z', { month: 'long', timeZone: 'UTC' })).toBe('十月')
    expect(sdk.formatNumber(1200000, { notation: 'compact' })).toContain('万')
    sdk.setLocale('en-US')
    expect(sdk.formatDateTime('2026-10-28T00:00:00Z', { month: 'long', timeZone: 'UTC' })).toBe('October')
    expect(sdk.formatNumber(1200000, { notation: 'compact' })).toContain('M')
    expect(sdk.formatDateTime('invalid-date')).toBe('Not available')
  })
  it('maps structured error codes to helpful current-language copy without exposing raw backend text', async () => {
    const sdk = await import('./i18n')
    sdk.setLocale('en-US')
    expect(sdk.getErrorMessage({ code: 'REQUEST_INTERRUPTED', message: '内部实现信息' })).toContain('Refresh the status')
    expect(sdk.getErrorMessage({ code: 'UNRECOGNIZED', message: '内部实现信息' })).not.toContain('内部')
    expect(sdk.getErrorMessage(new Error('internal-detail'), 'Could not save your draft.')).toBe('Could not save your draft.')
    expect(() => sdk.setLocale('invalid' as 'en-US')).toThrow(RangeError)
    expect(sdk.getLocale()).toBe('en-US')
  })
})
