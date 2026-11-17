import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, BrainCircuit, Circle, Link2, Link2Off, LoaderCircle, MoreHorizontal, Package, Power, PowerOff, Trash2 } from 'lucide-react'
import type { ConnectionStatus } from '@eating/plugin-sdk'
import { ActionButton } from './action-button.js'
import { InlineConfirm } from './confirm-inline.js'
import type { ManagedPlugin, WorkspaceActionResult } from './contract.js'
import { useI18n } from './i18n.js'
import { Switch } from './switch.js'
import './lifecycle-bar.css'

export interface PluginLifecycleBarProps {
  readonly plugin: Pick<ManagedPlugin, 'id' | 'name' | 'version' | 'kind' | 'icon' | 'brandColor'> & { readonly description?: string }
  readonly enabled: boolean
  readonly status?: ConnectionStatus
  readonly stale?: boolean
  readonly dirty?: boolean
  readonly busy?: boolean
  readonly connectionBusy?: boolean
  readonly subtitle?: string
  readonly updateHref?: string
  readonly onToggleEnabled?: (next: boolean) => Promise<WorkspaceActionResult>
  readonly onConnect?: () => Promise<WorkspaceActionResult>
  readonly onDisconnect?: () => Promise<WorkspaceActionResult>
  readonly onUninstall?: () => Promise<WorkspaceActionResult>
  readonly onFeedback?: (message: string) => void
  readonly onAfterDisable?: () => void
  readonly onAfterUninstall?: () => void
}

export function PluginLifecycleBar({
  plugin,
  enabled,
  status,
  stale = false,
  dirty = false,
  busy = false,
  connectionBusy = false,
  subtitle,
  updateHref = '#plugins',
  onToggleEnabled,
  onConnect,
  onDisconnect,
  onUninstall,
  onFeedback,
  onAfterDisable,
  onAfterUninstall,
}: PluginLifecycleBarProps) {
  const { t } = useI18n('common')
  const [confirmMode, setConfirmMode] = useState<'disable' | 'uninstall' | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuWrap = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    setConfirmMode(null)
    setActionError(null)
    setMenuOpen(false)
  }, [plugin.id])

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (menuWrap.current && !menuWrap.current.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const Icon = plugin.icon
  const state = status?.state ?? 'unconfigured'
  const isConnected = state === 'connected' || state === 'connecting' || state === 'reconnecting'
  const overallBusy = busy || connectionBusy || actionBusy

  const StatusIcon = stale || state === 'error'
    ? AlertTriangle
    : state === 'connecting' || state === 'reconnecting'
      ? LoaderCircle
      : state === 'connected'
        ? (plugin.kind === 'harness' ? BrainCircuit : Link2)
        : state === 'unconfigured'
          ? Circle
          : Link2Off

  async function runToggle(next: boolean): Promise<void> {
    if (!onToggleEnabled || overallBusy) return
    setActionBusy(true)
    setActionError(null)
    try {
      const result = await onToggleEnabled(next)
      if (!mounted.current) return
      if (result.ok) {
        setConfirmMode(null)
        onFeedback?.(t(next ? 'lifecycle.enabledFeedback' : 'lifecycle.disabledFeedback', { name: plugin.name }))
        if (!next) onAfterDisable?.()
      } else {
        setActionError(result.error)
      }
    } finally {
      if (mounted.current) setActionBusy(false)
    }
  }

  async function runConnection(connect: boolean): Promise<void> {
    const fn = connect ? onConnect : onDisconnect
    if (!fn || overallBusy) return
    setActionBusy(true)
    setActionError(null)
    try {
      const result = await fn()
      if (!mounted.current) return
      if (result.ok) {
        onFeedback?.(t(connect ? 'lifecycle.connectedFeedback' : 'lifecycle.disconnectedFeedback', { name: plugin.name }))
      } else {
        setActionError(result.error)
      }
    } finally {
      if (mounted.current) setActionBusy(false)
    }
  }

  async function runUninstall(): Promise<void> {
    if (!onUninstall || overallBusy) return
    setActionBusy(true)
    setActionError(null)
    try {
      const result = await onUninstall()
      if (!mounted.current) return
      if (result.ok) {
        setConfirmMode(null)
        onFeedback?.(t('lifecycle.uninstalledFeedback', { name: plugin.name }))
        onAfterUninstall?.()
      } else {
        setActionError(result.error)
      }
    } finally {
      if (mounted.current) setActionBusy(false)
    }
  }

  return (
    <section className="eating-lifecycle" aria-label={plugin.name}>
      <div className="eating-lifecycle-row">
        <div className="eating-lifecycle-identity">
          <div className="eating-lifecycle-icon" style={{ color: plugin.brandColor }}>
            <Icon size={22} aria-hidden="true" />
          </div>
          <div className="eating-lifecycle-copy">
            <div className="eating-lifecycle-title">
              <h2>{plugin.name}</h2>
              <span className="eating-lifecycle-version">v{plugin.version}</span>
              <span className="eating-lifecycle-kind">{t(`lifecycle.kind.${plugin.kind}`)}</span>
              <span className={`status-badge status-${stale ? 'warning' : state}`}>
                <StatusIcon size={12} aria-hidden="true" />
                {stale ? t('actionReason.read') : t(`lifecycle.status.${plugin.kind}.${state}`)}
              </span>
              {dirty && <span className="eating-lifecycle-dirty">{t('lifecycle.dirtyBadge')}</span>}
            </div>
            {(subtitle ?? plugin.description) && (
              <p className="eating-lifecycle-subtitle">{subtitle ?? plugin.description}</p>
            )}
          </div>
        </div>

        <div className="eating-lifecycle-controls">
          {onToggleEnabled && (
            <Switch
              checked={enabled}
              compact
              disabled={overallBusy}
              reasonCode="busy"
              aria-label={t(enabled ? 'lifecycle.disableSwitch' : 'lifecycle.enableSwitch')}
              label={t(enabled ? 'lifecycle.enabled' : 'lifecycle.disabled')}
              onChange={next => {
                if (next) void runToggle(true)
                else setConfirmMode(current => (current === 'disable' ? null : 'disable'))
              }}
            />
          )}

          {onConnect && onDisconnect && (
            isConnected ? (
              <ActionButton
                type="button"
                className="button button-secondary"
                disabled={!enabled || overallBusy}
                reasonCode={!enabled ? 'enable' : 'busy'}
                onClick={() => void runConnection(false)}>
                <PowerOff size={14} aria-hidden="true" />
                {actionBusy ? t('lifecycle.disconnecting') : t(`lifecycle.disconnect.${plugin.kind}`)}
              </ActionButton>
            ) : (
              <ActionButton
                type="button"
                className="button button-primary"
                disabled={!enabled || state === 'unconfigured' || overallBusy}
                reasonCode={!enabled ? 'enable' : state === 'unconfigured' ? 'configure' : 'busy'}
                onClick={() => void runConnection(true)}>
                <Power size={14} aria-hidden="true" />
                {actionBusy ? t('lifecycle.connecting') : t(`lifecycle.connect.${plugin.kind}`)}
              </ActionButton>
            )
          )}

          {(updateHref || onUninstall) && (
            <div ref={menuWrap} className="eating-lifecycle-more">
              <button
                type="button"
                className="button button-secondary"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label={t('lifecycle.moreActions')}
                onClick={() => setMenuOpen(current => !current)}>
                <MoreHorizontal size={16} aria-hidden="true" />
              </button>
              {menuOpen && (
                <div className="eating-lifecycle-menu" role="menu">
                  <a
                    href={updateHref}
                    className="eating-lifecycle-menu-item"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}>
                    <Package size={14} aria-hidden="true" />
                    {t('lifecycle.update')}
                  </a>
                  {onUninstall && (
                    <button
                      type="button"
                      className="eating-lifecycle-menu-item is-danger"
                      role="menuitem"
                      disabled={overallBusy}
                      onClick={() => {
                        setMenuOpen(false)
                        setActionError(null)
                        setConfirmMode('uninstall')
                      }}>
                      <Trash2 size={14} aria-hidden="true" />
                      {t('lifecycle.uninstall')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {confirmMode === 'disable' && (
        <InlineConfirm
          variant="danger"
          title={t('lifecycle.disableConfirmTitle', { name: plugin.name })}
          description={t(`lifecycle.disableConfirmBody.${plugin.kind}`)}
          confirmLabel={t('lifecycle.confirmDisable')}
          busyLabel={t('lifecycle.disabling')}
          cancelLabel={t('lifecycle.cancel')}
          busy={overallBusy}
          error={actionError}
          onConfirm={() => void runToggle(false)}
          onCancel={() => { setConfirmMode(null); setActionError(null) }}
        />
      )}

      {confirmMode === 'uninstall' && (
        <InlineConfirm
          variant="danger"
          title={t('lifecycle.uninstallConfirmTitle', { name: plugin.name })}
          description={t('lifecycle.uninstallConfirmBody')}
          confirmLabel={t('lifecycle.confirmUninstall')}
          busyLabel={t('lifecycle.uninstalling')}
          cancelLabel={t('lifecycle.cancel')}
          busy={overallBusy}
          error={actionError}
          onConfirm={() => void runUninstall()}
          onCancel={() => { setConfirmMode(null); setActionError(null) }}
        />
      )}

      {!confirmMode && actionError && (
        <p className="eating-lifecycle-error" role="alert">{actionError}</p>
      )}
    </section>
  )
}
