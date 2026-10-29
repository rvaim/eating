import { Languages } from 'lucide-react'
import { SUPPORTED_LOCALES, useI18n } from '@eating/ui-sdk'
import './LanguageSelector.css'

export function LanguageSelector() {
  const { locale, t, setLocale } = useI18n('common')
  return <footer className="global-sidebar-footer language-selector">
    <label className="language-selector-label" htmlFor="display-language"><Languages size={18} aria-hidden="true" /><span>{t('language.label')}</span></label>
    <select id="display-language" aria-label={t('language.label')} value={locale} title={t(`language.${locale}`)} onChange={event => {
      const selected = SUPPORTED_LOCALES.find(language => language === event.target.value)
      if (selected) setLocale(selected)
    }}>
      {SUPPORTED_LOCALES.map(language => <option key={language} value={language}>{t(`language.${language}`)}</option>)}
    </select>
    <small className="language-selector-version">Eating 0.10</small>
  </footer>
}
