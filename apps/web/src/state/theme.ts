export type ThemeMode = 'system' | 'light' | 'dark'
export type ThemePresetId = 'coral' | 'terracotta' | 'matcha' | 'cobalt' | 'plum'

export interface ThemePalette {
  readonly primary: string
  readonly canvas: string
  readonly surface: string
}

export interface ThemePresetSwatch extends ThemePalette {
  readonly glow: string
}

export interface ThemePreset {
  readonly id: ThemePresetId
  readonly light: ThemePresetSwatch
  readonly dark: ThemePresetSwatch
}

export interface ThemePreference {
  readonly mode: ThemeMode
  readonly preset: ThemePresetId | 'custom'
  readonly custom: ThemePalette
}

export const THEME_STORAGE_KEY = 'eating.theme'

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: 'coral',
    light: { primary: '#d94858', canvas: '#faf6f0', surface: '#ffffff', glow: '#ffdcd5' },
    dark: { primary: '#fb7185', canvas: '#141012', surface: '#1e181b', glow: '#45212a' },
  },
  {
    id: 'terracotta',
    light: { primary: '#c24d24', canvas: '#f6f2ea', surface: '#fdfbf7', glow: '#f8d7c6' },
    dark: { primary: '#e47349', canvas: '#151311', surface: '#1e1b18', glow: '#3f2419' },
  },
  {
    id: 'matcha',
    light: { primary: '#2f6f52', canvas: '#f3f7f2', surface: '#ffffff', glow: '#cce6d0' },
    dark: { primary: '#4ade80', canvas: '#0f1612', surface: '#16201a', glow: '#1b3826' },
  },
  {
    id: 'cobalt',
    light: { primary: '#2563eb', canvas: '#eef2f7', surface: '#ffffff', glow: '#cfe0ff' },
    dark: { primary: '#60a5fa', canvas: '#090d16', surface: '#111827', glow: '#17284a' },
  },
  {
    id: 'plum',
    light: { primary: '#9d3c72', canvas: '#f8f4f8', surface: '#ffffff', glow: '#f0d4eb' },
    dark: { primary: '#e879b9', canvas: '#140f15', surface: '#1e1620', glow: '#3c1b3a' },
  },
] as const

export const DEFAULT_THEME: ThemePreference = {
  mode: 'system',
  preset: 'coral',
  custom: {
    primary: THEME_PRESETS[0]!.light.primary,
    canvas: THEME_PRESETS[0]!.light.canvas,
    surface: THEME_PRESETS[0]!.light.surface,
  },
}

type RGB = readonly [number, number, number]

export function normalizeHex(raw: string): string | null {
  const cleaned = raw.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) return `#${cleaned.toLowerCase()}`
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    const [r, g, b] = cleaned.toLowerCase().split('')
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return null
}

function toRgb(hex: string): RGB {
  const clean = hex.slice(1)
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ]
}

function fromRgb([r, g, b]: RGB): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`
}

function mixHex(a: string, b: string, weight: number): string {
  const [r1, g1, b1] = toRgb(a)
  const [r2, g2, b2] = toRgb(b)
  return fromRgb([
    r1 + (r2 - r1) * weight,
    g1 + (g2 - g1) * weight,
    b1 + (b2 - b1) * weight,
  ])
}

function rgbaHex(hex: string, alpha: number): string {
  const [r, g, b] = toRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function relativeLuminance(hex: string): number {
  const channels = toRgb(hex).map(channel => {
    const ratio = channel / 255
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

const DERIVED_KEYS = [
  '--color-ink', '--color-ink-strong', '--color-ink-soft', '--color-ink-notice',
  '--color-muted', '--color-subtle', '--color-disabled-ink', '--color-placeholder',
  '--color-trigger-ink', '--color-primary', '--color-primary-bright',
  '--color-primary-hover', '--color-primary-strong', '--color-focus-ring',
  '--color-hero', '--color-hero-surface', '--color-hero-glow', '--color-hero-ink',
  '--color-hero-body', '--color-on-primary', '--color-illustration', '--color-activity-dot',
  '--color-nav-bg', '--color-nav-border', '--color-nav-ink', '--color-nav-muted',
  '--color-nav-pill', '--color-nav-active-bg', '--color-nav-active-ink', '--color-nav-active-border',
  '--color-line', '--color-line-strong', '--color-line-strong-hover',
  '--color-line-input', '--color-line-input-hover', '--color-line-soft',
  '--color-line-hero', '--color-line-socket', '--color-line-info', '--color-line-warm',
  '--color-scrollbar-thumb', '--color-scrollbar-track',
  '--color-canvas', '--color-sidebar', '--color-surface', '--color-surface-raised',
  '--color-surface-muted', '--color-surface-sunken', '--color-surface-quiet',
  '--color-hover', '--color-hover-strong', '--color-selected', '--color-selection',
  '--color-highlight', '--color-tint', '--color-info-ink', '--color-info-surface',
  '--color-switch-track', '--color-switch-active', '--color-chip-bg', '--color-chip-border',
] as const

export function findPreset(id: string): ThemePreset {
  return THEME_PRESETS.find(item => item.id === id) ?? THEME_PRESETS[0]!
}

/** Resolve all semantic CSS custom property overrides needed for a non-default preset or custom palette. */
export function deriveThemeVariables(preference: ThemePreference, prefersDark: boolean): Record<string, string> {
  if (preference.preset === 'coral') return {}

  const isDark = preference.mode === 'dark' || (preference.mode === 'system' && prefersDark)
  const preset = preference.preset === 'custom' ? null : findPreset(preference.preset)
  const swatch = preset ? (isDark ? preset.dark : preset.light) : null

  const primary = normalizeHex(swatch?.primary ?? preference.custom.primary) ?? DEFAULT_THEME.custom.primary
  const canvas = normalizeHex(swatch?.canvas ?? preference.custom.canvas) ?? DEFAULT_THEME.custom.canvas
  const surface = normalizeHex(swatch?.surface ?? preference.custom.surface) ?? DEFAULT_THEME.custom.surface

  const surfaceDark = relativeLuminance(surface) < 0.25
  const canvasDark = relativeLuminance(canvas) < 0.25
  const darkBase = surfaceDark || canvasDark

  const ink = darkBase ? mixHex(surface, '#ffffff', 0.92) : mixHex(canvas, '#111111', 0.88)
  const mutedBase = mixHex(ink, surface, darkBase ? 0.42 : 0.48)
  const lineBase = darkBase ? mixHex(surface, '#ffffff', 0.14) : mixHex(canvas, '#000000', 0.11)
  const lineStrong = darkBase ? mixHex(surface, '#ffffff', 0.24) : mixHex(canvas, '#000000', 0.2)

  const primaryLum = relativeLuminance(primary)
  const onPrimary = primaryLum > 0.36 ? '#1b1412' : '#ffffff'
  const primaryHover = darkBase ? mixHex(primary, '#ffffff', 0.2) : mixHex(primary, '#000000', 0.16)
  const primaryBright = mixHex(primary, '#ffffff', 0.24)
  const primaryStrong = darkBase ? mixHex(primary, '#ffffff', 0.45) : mixHex(primary, '#000000', 0.34)

  const tint = mixHex(surface, primary, darkBase ? 0.24 : 0.11)
  const selected = mixHex(surface, primary, darkBase ? 0.2 : 0.08)
  const selection = mixHex(surface, primary, darkBase ? 0.3 : 0.16)
  const lineAccent = mixHex(surface, primary, darkBase ? 0.46 : 0.32)

  const hero = mixHex(surface, primary, darkBase ? 0.14 : 0.06)
  const heroGlow = swatch?.glow ?? mixHex(surface, primary, darkBase ? 0.34 : 0.22)
  const heroSurface = darkBase ? mixHex(hero, '#000000', 0.22) : mixHex(surface, '#ffffff', 0.7)

  const raised = darkBase ? mixHex(canvas, surface, 0.45) : mixHex(canvas, '#000000', 0.03)
  const sunken = darkBase ? mixHex(canvas, '#000000', 0.18) : mixHex(canvas, '#000000', 0.05)
  const hover = darkBase ? mixHex(surface, '#ffffff', 0.08) : mixHex(canvas, '#000000', 0.06)
  const hoverStrong = darkBase ? mixHex(surface, '#ffffff', 0.14) : mixHex(canvas, '#000000', 0.1)

  return {
    '--color-ink': ink,
    '--color-ink-strong': mixHex(ink, surface, 0.14),
    '--color-ink-soft': mixHex(ink, surface, 0.28),
    '--color-ink-notice': mixHex(ink, surface, 0.32),
    '--color-muted': mutedBase,
    '--color-subtle': mixHex(ink, surface, darkBase ? 0.56 : 0.58),
    '--color-disabled-ink': mixHex(ink, surface, 0.54),
    '--color-placeholder': mixHex(ink, surface, 0.6),
    '--color-trigger-ink': mutedBase,
    '--color-primary': primary,
    '--color-primary-bright': primaryBright,
    '--color-primary-hover': primaryHover,
    '--color-primary-strong': primaryStrong,
    '--color-focus-ring': rgbaHex(primary, darkBase ? 0.26 : 0.18),
    '--color-hero': hero,
    '--color-hero-surface': heroSurface,
    '--color-hero-glow': heroGlow,
    '--color-hero-ink': ink,
    '--color-hero-body': mixHex(ink, hero, 0.34),
    '--color-on-primary': onPrimary,
    '--color-illustration': primary,
    '--color-activity-dot': primary,
    '--color-nav-bg': surface,
    '--color-nav-border': lineBase,
    '--color-nav-ink': ink,
    '--color-nav-muted': mutedBase,
    '--color-nav-pill': sunken,
    '--color-nav-active-bg': primary,
    '--color-nav-active-ink': onPrimary,
    '--color-nav-active-border': primary,
    '--color-line': lineBase,
    '--color-line-strong': lineStrong,
    '--color-line-strong-hover': mixHex(lineStrong, ink, 0.22),
    '--color-line-input': lineStrong,
    '--color-line-input-hover': mixHex(lineStrong, ink, 0.32),
    '--color-line-soft': mixHex(lineBase, surface, 0.45),
    '--color-line-hero': lineAccent,
    '--color-line-socket': mixHex(lineAccent, surface, 0.35),
    '--color-line-info': lineAccent,
    '--color-line-warm': lineAccent,
    '--color-scrollbar-thumb': lineStrong,
    '--color-scrollbar-track': raised,
    '--color-canvas': canvas,
    '--color-sidebar': surface,
    '--color-surface': surface,
    '--color-surface-raised': raised,
    '--color-surface-muted': raised,
    '--color-surface-sunken': sunken,
    '--color-surface-quiet': darkBase ? mixHex(surface, '#ffffff', 0.04) : mixHex(surface, canvas, 0.28),
    '--color-hover': hover,
    '--color-hover-strong': hoverStrong,
    '--color-selected': selected,
    '--color-selection': selection,
    '--color-highlight': selected,
    '--color-tint': tint,
    '--color-info-ink': primaryStrong,
    '--color-info-surface': selected,
    '--color-switch-track': lineStrong,
    '--color-switch-active': primary,
    '--color-chip-bg': sunken,
    '--color-chip-border': lineStrong,
  }
}

export function sanitizeThemePreference(value: unknown): ThemePreference {
  if (!value || typeof value !== 'object') return DEFAULT_THEME
  const record = value as Record<string, unknown>
  const mode: ThemeMode = record.mode === 'light' || record.mode === 'dark' || record.mode === 'system' ? record.mode : 'system'
  const rawPreset = record.preset
  const preset: ThemePresetId | 'custom' = rawPreset === 'custom' || THEME_PRESETS.some(item => item.id === rawPreset)
    ? (rawPreset as ThemePresetId | 'custom')
    : 'coral'
  const rawCustom = (record.custom && typeof record.custom === 'object' ? record.custom : {}) as Record<string, unknown>
  return {
    mode,
    preset,
    custom: {
      primary: typeof rawCustom.primary === 'string' ? normalizeHex(rawCustom.primary) ?? DEFAULT_THEME.custom.primary : DEFAULT_THEME.custom.primary,
      canvas: typeof rawCustom.canvas === 'string' ? normalizeHex(rawCustom.canvas) ?? DEFAULT_THEME.custom.canvas : DEFAULT_THEME.custom.canvas,
      surface: typeof rawCustom.surface === 'string' ? normalizeHex(rawCustom.surface) ?? DEFAULT_THEME.custom.surface : DEFAULT_THEME.custom.surface,
    },
  }
}

export function loadThemePreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (!raw) return DEFAULT_THEME
    return sanitizeThemePreference(JSON.parse(raw))
  } catch {
    return DEFAULT_THEME
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

export function applyThemePreference(preference: ThemePreference): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const prefersDark = systemPrefersDark()
  const isDark = preference.preset === 'custom'
    ? relativeLuminance(preference.custom.surface) < 0.25 || relativeLuminance(preference.custom.canvas) < 0.25
    : preference.mode === 'dark' || (preference.mode === 'system' && prefersDark)

  if (preference.preset === 'custom') {
    root.setAttribute('data-theme', isDark ? 'dark' : 'light')
  } else if (preference.mode === 'light' || preference.mode === 'dark') {
    root.setAttribute('data-theme', preference.mode)
  } else {
    root.removeAttribute('data-theme')
  }

  for (const key of DERIVED_KEYS) root.style.removeProperty(key)
  const overrides = deriveThemeVariables(preference, prefersDark)
  for (const [key, value] of Object.entries(overrides)) {
    root.style.setProperty(key, value)
  }
}

let currentTheme: ThemePreference = typeof window !== 'undefined' ? loadThemePreference() : DEFAULT_THEME
const listeners = new Set<() => void>()
let initialized = false

function notify() {
  for (const listener of listeners) listener()
}

export function getThemePreference(): ThemePreference {
  return currentTheme
}

export function setThemePreference(next: ThemePreference): void {
  currentTheme = sanitizeThemePreference(next)
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(currentTheme))
  } catch { /* ignore storage restrictions */ }
  applyThemePreference(currentTheme)
  notify()
}

export function resetThemePreference(): void {
  currentTheme = DEFAULT_THEME
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY)
  } catch { /* ignore storage restrictions */ }
  applyThemePreference(currentTheme)
  notify()
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function initTheme(): void {
  currentTheme = typeof window !== 'undefined' ? loadThemePreference() : DEFAULT_THEME
  applyThemePreference(currentTheme)
  if (initialized || typeof window === 'undefined') return
  initialized = true
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  media?.addEventListener?.('change', () => {
    if (currentTheme.mode === 'system') applyThemePreference(currentTheme)
  })
  window.addEventListener('storage', event => {
    if (event.key !== THEME_STORAGE_KEY) return
    currentTheme = loadThemePreference()
    applyThemePreference(currentTheme)
    notify()
  })
}
