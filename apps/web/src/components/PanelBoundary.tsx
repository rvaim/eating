import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { AlertCircle, RotateCcw } from 'lucide-react'
import { useI18n } from '@eating/ui-sdk'
import '../i18n/app'

function PanelError({ onRetry }: { readonly onRetry: () => void }) {
  const { t } = useI18n('app')
  return <section className="panel-error" role="alert">
    <AlertCircle size={24} /><h3>{t('panel.errorTitle')}</h3>
    <p>{t('panel.errorDescription')}</p>
    <button className="button button-secondary" onClick={onRetry}><RotateCcw size={16} />{t('panel.retry')}</button>
  </section>
}

export class PanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Private configuration is never logged when a panel fails.
  }

  render() {
    if (this.state.failed) return <PanelError onRetry={() => this.setState({ failed: false })} />
    return this.props.children
  }
}
