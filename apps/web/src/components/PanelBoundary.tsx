import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { AlertCircle, RotateCcw } from 'lucide-react'

export class PanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The failed module remains removable; private configuration is never logged.
  }

  render() {
    if (this.state.failed) return <section className="panel-error" role="alert">
      <AlertCircle size={24} /><h3>这个配置面板暂时无法打开</h3>
      <p>其他平台仍可使用。你可以重试，或移除此插件后重新注册。</p>
      <button className="button button-secondary" onClick={() => this.setState({ failed: false })}><RotateCcw size={16} />重新加载面板</button>
    </section>
    return this.props.children
  }
}
