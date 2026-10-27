import { createInstance } from 'i18next'
import type { i18n } from 'i18next'
import { useMemo, useSyncExternalStore } from 'react'
import { commonResources } from './locales/common.js'

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = typeof SUPPORTED_LOCALES[number]
export type LocaleResources = Readonly<Record<Locale, Readonly<Record<string, string>>>>
export type TranslationParams = Readonly<Record<string, string | number | boolean | null | undefined>> & { readonly count?: number; readonly defaultValue?: string }
export type Translate = (key: string, params?: TranslationParams) => string

const DEFAULT_LOCALE: Locale = 'zh-CN'
export const LOCALE_STORAGE_KEY = 'eating.locale'
const serviceSymbol = Symbol.for('eating.ui.i18n.v1')
interface LocaleService {
  readonly engine: i18n
  readonly listeners: Set<() => void>
  locale: Locale
}

function isLocale(value: unknown): value is Locale { return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value) }
function initialLocale(): Locale {
  try { const stored = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY); if (isLocale(stored)) return stored } catch { /* Display preferences still work in memory when browser storage is blocked. */ }
  return DEFAULT_LOCALE
}
function updateDocument(locale: Locale): void { if (typeof document !== 'undefined') { document.documentElement.lang = locale; document.documentElement.dir = 'ltr' } }
function getService(): LocaleService {
  // Every independently bundled plugin reaches this same window-owned service.
  const runtime = globalThis as typeof globalThis & { [serviceSymbol]?: LocaleService }
  if (runtime[serviceSymbol]) return runtime[serviceSymbol]
  const locale = initialLocale()
  const engine = createInstance()
  void engine.init({ lng: locale, fallbackLng: DEFAULT_LOCALE, supportedLngs: [...SUPPORTED_LOCALES], initAsync: false,
    keySeparator: false, nsSeparator: false, defaultNS: 'common', ns: ['common'],
    interpolation: { escapeValue: false, skipOnVariables: true }, returnNull: false, returnEmptyString: false,
    resources: Object.fromEntries(SUPPORTED_LOCALES.map(language => [language, { common: { ...commonResources[language] } }])) })
  const service: LocaleService = { engine, listeners: new Set(), locale }
  runtime[serviceSymbol] = service
  updateDocument(locale)
  if (typeof window !== 'undefined') window.addEventListener('storage', event => {
    if (event.key === LOCALE_STORAGE_KEY && (event.newValue === null || isLocale(event.newValue))) changeLocale(event.newValue ?? DEFAULT_LOCALE, false)
  })
  return service
}
function changeLocale(locale: Locale, persist: boolean): void {
  if (!isLocale(locale)) throw new RangeError('Unsupported display language')
  const service = getService()
  if (persist) { try { globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale) } catch { /* The user can still switch language for this page. */ } }
  if (service.locale === locale) { updateDocument(locale); return }
  service.locale = locale
  void service.engine.changeLanguage(locale)
  updateDocument(locale)
  for (const listener of [...service.listeners]) listener()
}

export function getLocale(): Locale { return getService().locale }
export function setLocale(locale: Locale): void { changeLocale(locale, true) }
export function subscribeLocale(listener: () => void): () => void { const service = getService(); service.listeners.add(listener); return () => { service.listeners.delete(listener) } }
export function registerTranslations(namespace: string, resources: LocaleResources): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(namespace)) throw new Error('Invalid translation namespace')
  const service = getService()
  for (const locale of SUPPORTED_LOCALES) service.engine.addResourceBundle(locale, namespace, { ...resources[locale] }, true, true)
}
export function hasTranslation(namespace: string, key: string): boolean { return getService().engine.exists(key, { ns: namespace }) }
export function translate(namespace: string, key: string, params: TranslationParams = {}): string {
  const result = getService().engine.t(key, { ...params, ns: namespace, returnObjects: false })
  return typeof result === 'string' ? result : key
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string { return new Intl.NumberFormat(getLocale(), options).format(value) }
export function formatDateTime(value: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions): string {
  if (value === null || value === undefined || value === '') return translate('common', 'notAvailable')
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return translate('common', 'notAvailable')
  return new Intl.DateTimeFormat(getLocale(), options ?? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
export function getErrorMessage(error: unknown, fallbackMessage?: string): string {
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null
  return code && hasTranslation('common', `errors.${code}`) ? translate('common', `errors.${code}`) : fallbackMessage ?? translate('common', 'errors.unexpected')
}
export function useI18n(namespace: string) {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  const t: Translate = useMemo(() => (key, params) => translate(namespace, key, params), [namespace])
  return { locale, t, setLocale, formatNumber, formatDateTime }
}
