import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME,
  THEME_PRESETS,
  deriveThemeVariables,
  normalizeHex,
  sanitizeThemePreference,
} from './theme'

describe('theme preferences and color derivation', () => {
  it('normalizes 3-digit and 6-digit hex inputs and rejects malformed values', () => {
    expect(normalizeHex('abc')).toBe('#aabbcc')
    expect(normalizeHex(' #D94858 ')).toBe('#d94858')
    expect(normalizeHex('#12345')).toBeNull()
    expect(normalizeHex('not-a-color')).toBeNull()
    expect(normalizeHex('')).toBeNull()
  })

  it('sanitizes invalid preference shapes back to safe defaults', () => {
    expect(sanitizeThemePreference(null)).toEqual(DEFAULT_THEME)
    expect(sanitizeThemePreference({ mode: 'weird', preset: 'unknown', custom: { primary: 'invalid', canvas: '#FFF', surface: '#123' } })).toEqual({
      mode: 'system',
      preset: 'coral',
      custom: {
        primary: DEFAULT_THEME.custom.primary,
        canvas: '#ffffff',
        surface: '#112233',
      },
    })
  })

  it('keeps built-in coral default free of inline overrides while deriving dark/light presets and custom contrast', () => {
    expect(deriveThemeVariables(DEFAULT_THEME, false)).toEqual({})
    expect(deriveThemeVariables(DEFAULT_THEME, true)).toEqual({})

    const cobaltLight = deriveThemeVariables({ ...DEFAULT_THEME, mode: 'light', preset: 'cobalt' }, false)
    const cobaltDark = deriveThemeVariables({ ...DEFAULT_THEME, mode: 'dark', preset: 'cobalt' }, false)
    expect(cobaltLight['--color-primary']).toBe('#2563eb')
    expect(cobaltDark['--color-primary']).toBe('#60a5fa')
    expect(cobaltLight['--color-canvas']).not.toBe(cobaltDark['--color-canvas'])

    for (const preset of THEME_PRESETS) {
      if (preset.id === 'coral') continue
      const derived = deriveThemeVariables({ ...DEFAULT_THEME, mode: 'light', preset: preset.id }, false)
      expect(derived['--color-primary']).toBe(preset.light.primary)
    }

    const brightAccent = deriveThemeVariables({
      mode: 'light',
      preset: 'custom',
      custom: { primary: '#fde047', canvas: '#fafaf9', surface: '#ffffff' },
    }, false)
    expect(brightAccent['--color-on-primary']).toBe('#1b1412')

    const darkCustom = deriveThemeVariables({
      mode: 'light',
      preset: 'custom',
      custom: { primary: '#2563eb', canvas: '#0b101b', surface: '#141b29' },
    }, false)
    expect(darkCustom['--color-on-primary']).toBe('#ffffff')
    expect(darkCustom['--color-ink']).not.toBe('#111111')
  })
})
