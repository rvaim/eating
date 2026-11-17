import { useEffect, useState, useSyncExternalStore } from 'react'
import { Check, Monitor, Moon, Palette, RotateCcw, Sun } from 'lucide-react'
import { registerTranslations, useI18n } from '@eating/ui-sdk'
import {
  DEFAULT_THEME,
  THEME_PRESETS,
  findPreset,
  getThemePreference,
  normalizeHex,
  resetThemePreference,
  setThemePreference,
  subscribeTheme,
} from '../state/theme'
import type { ThemeMode, ThemePalette, ThemePresetId } from '../state/theme'
import './ThemeSettings.css'

registerTranslations('theme-settings', {
  'zh-CN': {
    title: '主题配色',
    description: '切换系统、浅色或深色外观，选择内置主题预设或自由调整配色方案；偏好仅保存在当前浏览器中。',
    reset: '恢复默认',
    modeTitle: '外观模式',
    modeHint: '预设主题会随浅色 / 深色模式自动适配；使用自定义配色时以你填写的明暗颜色为准。',
    'mode.system': '跟随系统',
    'mode.light': '浅色模式',
    'mode.dark': '深色模式',
    presetsTitle: '配色预设',
    presetsHint: '点击即可实时预览并生效，也可在此基础上继续微调自定义颜色。',
    'preset.coral.name': '珊瑚手账',
    'preset.coral.note': '暖奶白纸面配珊瑚莓红',
    'preset.terracotta.name': '陶土暖纸',
    'preset.terracotta.note': '羊皮纸底色配焦糖陶红',
    'preset.matcha.name': '森林青苔',
    'preset.matcha.note': '浅草雾底配松叶深绿',
    'preset.cobalt.name': '晴空钴蓝',
    'preset.cobalt.note': '矿石浅灰配清透电蓝',
    'preset.plum.name': '暮色梅果',
    'preset.plum.note': '浅紫象牙底配梅果紫红',
    customBadge: '当前为自定义配色',
    customTitle: '自定义配色',
    customHint: '通过色盘或输入十六进制颜色码实时定制全站主色、画布与卡片底色。',
    'custom.primary': '主强调色',
    'custom.primaryHint': '用于主要按钮、激活导航和重点高亮，会自动适配文字与对比度。',
    'custom.canvas': '画布底色',
    'custom.canvasHint': '页面外围背景底色；浅色或深色都会自动推导文字与分隔线。',
    'custom.surface': '卡片底色',
    'custom.surfaceHint': '内容卡片、表单与顶部悬浮导航栏的背景颜色。',
    hexPlaceholder: '#RRGGBB',
    pickerLabel: '{{name}}色盘',
    invalidHex: '请输入 3 位或 6 位十六进制颜色，例如 #d94858。',
    previewTitle: '实时效果预览',
    previewPrimary: '主要按钮',
    previewSecondary: '次要按钮',
    previewSelected: '激活项',
    previewSampleTitle: '卡片排版与对比度示例',
    previewSampleBody: '保存前所有改动都会立即应用到界面，刷新页面后依然保留。',
  },
  'en-US': {
    title: 'Theme & colors',
    description: 'Switch between system, light, or dark appearance, pick a built-in preset, or customize colors live. Saved locally in this browser.',
    reset: 'Reset to default',
    modeTitle: 'Appearance mode',
    modeHint: 'Built-in presets adapt automatically to light and dark modes; custom palettes follow the colors you choose.',
    'mode.system': 'System',
    'mode.light': 'Light',
    'mode.dark': 'Dark',
    presetsTitle: 'Color presets',
    presetsHint: 'Select a preset to apply it right away, or use it as a starting point for custom colors.',
    'preset.coral.name': 'Sunlit Coral',
    'preset.coral.note': 'Warm linen with raspberry coral',
    'preset.terracotta.name': 'Studio Terracotta',
    'preset.terracotta.note': 'Parchment paper with burnt clay',
    'preset.matcha.name': 'Botanical Matcha',
    'preset.matcha.note': 'Soft sage mist with pine green',
    'preset.cobalt.name': 'Nordic Cobalt',
    'preset.cobalt.note': 'Mineral slate with crisp cobalt',
    'preset.plum.name': 'Evening Plum',
    'preset.plum.note': 'Warm ivory with berry plum',
    customBadge: 'Custom palette active',
    customTitle: 'Custom palette',
    customHint: 'Use the color pickers or enter hex codes to customize the accent, canvas, and card surfaces live.',
    'custom.primary': 'Accent color',
    'custom.primaryHint': 'Used for primary actions, active pills, and highlights with automatic text contrast.',
    'custom.canvas': 'Background canvas',
    'custom.canvasHint': 'Outer backdrop behind floating cards; ink and borders adapt automatically.',
    'custom.surface': 'Card surface',
    'custom.surfaceHint': 'Background for panels, forms, and the top navigation bar.',
    hexPlaceholder: '#RRGGBB',
    pickerLabel: '{{name}} picker',
    invalidHex: 'Enter a 3- or 6-digit hex color such as #d94858.',
    previewTitle: 'Live preview',
    previewPrimary: 'Primary action',
    previewSecondary: 'Secondary',
    previewSelected: 'Selected',
    previewSampleTitle: 'Surface & typography contrast',
    previewSampleBody: 'Changes apply immediately across all views and persist across page reloads.',
  },
})

type ColorKey = keyof ThemePalette

const modes: readonly { readonly id: ThemeMode; readonly Icon: typeof Monitor }[] = [
  { id: 'system', Icon: Monitor },
  { id: 'light', Icon: Sun },
  { id: 'dark', Icon: Moon },
]

const colorFields: readonly ColorKey[] = ['primary', 'canvas', 'surface']

function resolvePreviewDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

export function ThemeSettings() {
  const { t } = useI18n('theme-settings')
  const preference = useSyncExternalStore(subscribeTheme, getThemePreference, getThemePreference)
  const [hexDraft, setHexDraft] = useState<ThemePalette>(preference.custom)
  const [invalidKeys, setInvalidKeys] = useState<Partial<Record<ColorKey, boolean>>>({})

  useEffect(() => {
    setHexDraft(preference.custom)
    setInvalidKeys({})
  }, [preference.custom.primary, preference.custom.canvas, preference.custom.surface])

  const previewDark = resolvePreviewDark(preference.mode)
  const isDefault = preference.mode === DEFAULT_THEME.mode
    && preference.preset === DEFAULT_THEME.preset

  function selectMode(mode: ThemeMode) {
    const nextDark = resolvePreviewDark(mode)
    if (preference.preset === 'custom') {
      setThemePreference({ ...preference, mode })
      return
    }
    const preset = findPreset(preference.preset)
    const swatch = nextDark ? preset.dark : preset.light
    const custom = { primary: swatch.primary, canvas: swatch.canvas, surface: swatch.surface }
    setHexDraft(custom)
    setInvalidKeys({})
    setThemePreference({ mode, preset: preference.preset, custom })
  }

  function selectPreset(id: ThemePresetId) {
    const preset = findPreset(id)
    const swatch = previewDark ? preset.dark : preset.light
    const custom = { primary: swatch.primary, canvas: swatch.canvas, surface: swatch.surface }
    setHexDraft(custom)
    setInvalidKeys({})
    setThemePreference({ mode: preference.mode, preset: id, custom })
  }

  function updateCustomColor(key: ColorKey, raw: string, fromPicker: boolean) {
    setHexDraft(current => ({ ...current, [key]: raw }))
    const isFullSix = /^#?[0-9a-fA-F]{6}$/.test(raw.trim())
    const normalized = (fromPicker || isFullSix) ? normalizeHex(raw) : null
    if (!normalized) {
      if (!fromPicker) setInvalidKeys(current => ({ ...current, [key]: !/^#?[0-9a-fA-F]{0,6}$/.test(raw.trim()) }))
      return
    }
    setInvalidKeys(current => ({ ...current, [key]: false }))
    setThemePreference({
      mode: preference.mode,
      preset: 'custom',
      custom: { ...preference.custom, [key]: normalized },
    })
  }

  return (
    <section className="theme-settings" aria-labelledby="theme-settings-title">
      <div className="theme-header">
        <div>
          <h2 id="theme-settings-title">{t('title')}</h2>
          <p className="panel-description">{t('description')}</p>
        </div>
        <button
          type="button"
          className="button button-secondary"
          disabled={isDefault}
          onClick={() => {
            setHexDraft(DEFAULT_THEME.custom)
            setInvalidKeys({})
            resetThemePreference()
          }}>
          <RotateCcw size={15} aria-hidden="true" />
          {t('reset')}
        </button>
      </div>

      <section className="theme-card" aria-labelledby="theme-mode-title">
        <div className="theme-card-heading">
          <div>
            <h3 id="theme-mode-title">{t('modeTitle')}</h3>
            <p>{t('modeHint')}</p>
          </div>
        </div>
        <div className="theme-mode-group" role="group" aria-label={t('modeTitle')}>
          {modes.map(({ id, Icon }) => {
            const active = preference.mode === id
            return (
              <button
                key={id}
                type="button"
                className={`theme-mode-button${active ? ' is-selected' : ''}`}
                aria-pressed={active}
                onClick={() => selectMode(id)}>
                <Icon size={16} aria-hidden="true" />
                <span>{t(`mode.${id}`)}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="theme-card" aria-labelledby="theme-presets-title">
        <div className="theme-card-heading">
          <div>
            <h3 id="theme-presets-title">{t('presetsTitle')}</h3>
            <p>{t('presetsHint')}</p>
          </div>
          {preference.preset === 'custom' && (
            <span className="theme-custom-pill">
              <Palette size={14} aria-hidden="true" />
              {t('customBadge')}
            </span>
          )}
        </div>
        <div className="theme-preset-grid">
          {THEME_PRESETS.map(preset => {
            const active = preference.preset === preset.id
            const swatch = previewDark ? preset.dark : preset.light
            return (
              <button
                key={preset.id}
                type="button"
                className={`theme-preset-card${active ? ' is-selected' : ''}`}
                aria-pressed={active}
                onClick={() => selectPreset(preset.id)}>
                <div className="theme-preset-top">
                  <div className="theme-swatches" aria-hidden="true">
                    <span className="theme-swatch-dot" style={{ backgroundColor: swatch.canvas }} />
                    <span className="theme-swatch-dot" style={{ backgroundColor: swatch.surface }} />
                    <span className="theme-swatch-dot is-accent" style={{ backgroundColor: swatch.primary }} />
                  </div>
                  {active && <span className="theme-preset-check" aria-hidden="true"><Check size={14} /></span>}
                </div>
                <strong>{t(`preset.${preset.id}.name`)}</strong>
                <small>{t(`preset.${preset.id}.note`)}</small>
              </button>
            )
          })}
        </div>
      </section>

      <section className="theme-card" aria-labelledby="theme-custom-title">
        <div className="theme-card-heading">
          <div>
            <h3 id="theme-custom-title">{t('customTitle')}</h3>
            <p>{t('customHint')}</p>
          </div>
        </div>
        <div className="theme-custom-grid">
          {colorFields.map(key => {
            const value = preference.custom[key]
            const draft = hexDraft[key]
            const invalid = Boolean(invalidKeys[key])
            return (
              <div key={key} className={`theme-color-field${invalid ? ' is-invalid' : ''}`}>
                <label htmlFor={`theme-hex-${key}`}>{t(`custom.${key}`)}</label>
                <div className="theme-color-inputs">
                  <input
                    id={`theme-picker-${key}`}
                    type="color"
                    className="theme-color-picker"
                    value={value}
                    aria-label={t('pickerLabel', { name: t(`custom.${key}`) })}
                    onChange={event => updateCustomColor(key, event.target.value, true)}
                  />
                  <input
                    id={`theme-hex-${key}`}
                    type="text"
                    className="theme-hex-input"
                    value={draft}
                    maxLength={7}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={t('hexPlaceholder')}
                    aria-invalid={invalid}
                    aria-describedby={`theme-hint-${key}`}
                    onChange={event => updateCustomColor(key, event.target.value, false)}
                    onBlur={() => {
                      const normalized = normalizeHex(draft)
                      if (normalized) {
                        setHexDraft(current => ({ ...current, [key]: normalized }))
                        setInvalidKeys(current => ({ ...current, [key]: false }))
                        if (normalized !== value || preference.preset !== 'custom') {
                          setThemePreference({
                            mode: preference.mode,
                            preset: 'custom',
                            custom: { ...preference.custom, [key]: normalized },
                          })
                        }
                      } else {
                        setInvalidKeys(current => ({ ...current, [key]: true }))
                      }
                    }}
                  />
                </div>
                <p id={`theme-hint-${key}`} className="theme-color-hint">
                  {invalid ? t('invalidHex') : t(`custom.${key}Hint`)}
                </p>
              </div>
            )
          })}
        </div>

        <div className="theme-preview-box" aria-label={t('previewTitle')}>
          <span className="theme-preview-label">{t('previewTitle')}</span>
          <div className="theme-preview-surface">
            <div className="theme-preview-copy">
              <strong>{t('previewSampleTitle')}</strong>
              <p>{t('previewSampleBody')}</p>
            </div>
            <div className="theme-preview-controls">
              <span className="theme-preview-pill">{t('previewSelected')}</span>
              <span className="button button-secondary">{t('previewSecondary')}</span>
              <span className="button button-primary">{t('previewPrimary')}</span>
            </div>
          </div>
        </div>
      </section>
    </section>
  )
}
