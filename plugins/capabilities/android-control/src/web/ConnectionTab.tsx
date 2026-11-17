import { useEffect, useId, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  Laptop,
  Link2,
  Link2Off,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  Usb,
  Wifi,
  Wrench,
} from 'lucide-react'
import { ActionButton, FormSaveBar, InlineConfirm, PasswordInput, useI18n } from '@eating/ui-sdk'
import type {
  AdbDetectionSnapshot,
  AdbPlatformPackageDescriptor,
  AndroidConnectionMode,
  AndroidDevicesSnapshot,
  PublicAndroidConfiguration,
} from '../types'
import {
  androidErrorKey,
  formatByteSize,
  getErrorCode,
  hostRequest,
  isAbortError,
  manageAndroid,
  readDetection,
  readDevicesSnapshot,
  readPackageDescriptor,
  readPublicConfig,
} from './data'

export interface ConnectionDraft {
  readonly connectionMode: AndroidConnectionMode
  readonly networkAddress: string
  readonly defaultDevice: string
  readonly adbPath: string
  readonly workspace: string
}

export const draftFromConfig = (config: PublicAndroidConfiguration): ConnectionDraft => ({
  connectionMode: config.connectionMode,
  networkAddress: config.networkAddress,
  defaultDevice: config.defaultDevice,
  adbPath: config.adbPath,
  workspace: config.workspace,
})

export function isConnectionDraftDirty(draft: ConnectionDraft | null, config: PublicAndroidConfiguration | null): boolean {
  if (!draft || !config || config.configState !== 'ok') return false
  return (
    draft.connectionMode !== config.connectionMode ||
    draft.networkAddress !== config.networkAddress ||
    draft.defaultDevice !== config.defaultDevice ||
    draft.adbPath !== config.adbPath ||
    draft.workspace !== config.workspace
  )
}

interface ConnectionTabProps {
  readonly enabled: boolean
  readonly busy: boolean
  readonly config: PublicAndroidConfiguration | null
  readonly detection: AdbDetectionSnapshot | null
  readonly devicesSnapshot: AndroidDevicesSnapshot | null
  readonly draft: ConnectionDraft | null
  readonly setDraft: React.Dispatch<React.SetStateAction<ConnectionDraft | null>>
  readonly hiddenClearedPair: boolean
  readonly pairCode: string
  readonly setPairCode: (value: string) => void
  readonly clearHiddenNotice: () => void
  readonly runTask: (fn: (signal: AbortSignal) => Promise<void>, setError: (message: string | null) => void) => Promise<void>
  readonly onUpdated: (nextConfig: PublicAndroidConfiguration | null, nextDetection: AdbDetectionSnapshot | null, nextDevices: AndroidDevicesSnapshot | null) => void
  readonly onRefresh: () => Promise<void>
  readonly onFeedback?: (message: string) => void
}

export function ConnectionTab({
  enabled,
  busy,
  config,
  detection,
  devicesSnapshot,
  draft,
  setDraft,
  hiddenClearedPair,
  pairCode,
  setPairCode,
  clearHiddenNotice,
  runTask,
  onUpdated,
  onRefresh,
  onFeedback,
}: ConnectionTabProps) {
  const { t, formatDateTime } = useI18n('android-control')
  const prefix = useId()

  const [envError, setEnvError] = useState<string | null>(null)
  const [envNotice, setEnvNotice] = useState<string | null>(null)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [deviceNotice, setDeviceNotice] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [saveConflict, setSaveConflict] = useState(false)

  const [confirmRebuild, setConfirmRebuild] = useState(false)
  const [confirmInstall, setConfirmInstall] = useState(false)
  const [loadingPackageInfo, setLoadingPackageInfo] = useState(false)
  const [installPackageInfo, setInstallPackageInfo] = useState<AdbPlatformPackageDescriptor | null>(null)
  const [acceptLicense, setAcceptLicense] = useState(false)
  const [installingAdb, setInstallingAdb] = useState(false)
  const [confirmRemoveAdb, setConfirmRemoveAdb] = useState(false)
  const [confirmReconnectSave, setConfirmReconnectSave] = useState(false)

  const [pairAddress, setPairAddress] = useState('')
  const [connectAddress, setConnectAddress] = useState('')

  useEffect(() => {
    setConfirmInstall(false)
    setConfirmRemoveAdb(false)
    setConfirmRebuild(false)
    setConfirmReconnectSave(false)
    setAcceptLicense(false)
  }, [config?.revision, config?.configState])

  const env = detection ?? config?.adbEnvironment ?? null
  const devSnapshot = devicesSnapshot ?? (config ? {
    queried: true,
    devices: config.devices,
    activeDevice: config.activeDevice,
    onlineCount: config.devices.filter(item => item.online).length,
    deviceOnline: config.deviceOnline,
    errorCode: config.deviceCheckErrorCode,
    errorMessage: config.deviceCheckErrorMessage,
    checkedAt: '',
  } : null)

  const dirty = isConnectionDraftDirty(draft, config)
  const configOk = config?.configState === 'ok'
  const adbAvailable = Boolean(configOk && (env?.available ?? config?.adbAvailable))
  const packageInfo = installPackageInfo ?? env?.packageInfo ?? null

  const applyResponse = (res: Record<string, unknown>, resetDraftFromServer = true) => {
    const nextConfig = readPublicConfig(res.configuration ?? res)
    const nextDetection = readDetection(res.detection) ?? nextConfig?.adbEnvironment ?? null
    const nextDevices = readDevicesSnapshot(res.devices)
    onUpdated(nextConfig, nextDetection, nextDevices)
    if (nextConfig && resetDraftFromServer) {
      setDraft(draftFromConfig(nextConfig))
    }
    return { nextConfig, nextDetection, nextDevices }
  }

  const formatErr = (error: unknown): string => {
    const code = getErrorCode(error)
    const translated = t(androidErrorKey(code))
    if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
      const rawMsg = (error as { message: string }).message
      if (translated !== t('unknownError')) return translated
      return rawMsg || translated
    }
    return translated
  }

  const handleOpenInstall = async () => {
    setEnvError(null)
    setEnvNotice(null)
    setAcceptLicense(false)
    setConfirmInstall(true)
    setLoadingPackageInfo(true)
    try {
      const res = await manageAndroid('install-info', {})
      const info = readPackageDescriptor(res.packageInfo)
      if (info) setInstallPackageInfo(info)
    } catch {
      // Offline/unreachable still shows static package target descriptor
    } finally {
      setLoadingPackageInfo(false)
    }
  }

  const handleInstallAdb = async () => {
    if (!acceptLicense) {
      setEnvError(t('err.ANDROID_LICENSE_NOT_ACCEPTED'))
      return
    }
    setEnvError(null)
    setEnvNotice(null)
    setInstallingAdb(true)
    try {
      const res = await manageAndroid('install-adb', { acceptLicense: true })
      const { nextDetection } = applyResponse(res, false)
      setConfirmInstall(false)
      setAcceptLicense(false)
      const versionText = nextDetection?.pluginVersion ?? nextDetection?.version ?? ''
      const msg = t('installDone', { version: versionText })
      setEnvNotice(msg)
      onFeedback?.(msg)
      await onRefresh()
    } catch (error) {
      if (!isAbortError(error)) setEnvError(formatErr(error))
    } finally {
      setInstallingAdb(false)
    }
  }

  const handleRemoveAdb = async () => {
    setEnvError(null)
    setEnvNotice(null)
    await runTask(async signal => {
      const res = await manageAndroid('remove-installed-adb', { confirmed: true }, signal)
      applyResponse(res, false)
      setConfirmRemoveAdb(false)
      setEnvNotice(t('removeDone'))
      onFeedback?.(t('removeDone'))
      await onRefresh()
    }, msg => setEnvError(msg))
  }

  const saveConfigToHost = async (reconnectAfter: boolean, signal: AbortSignal) => {
    if (!config || !draft) return
    setSaveError(null)
    setSaveNotice(null)
    setSaveConflict(false)
    const wasConnected = config.ready
    if (reconnectAfter && wasConnected) {
      await hostRequest('/plugins/android-control/disconnect', { method: 'POST', body: {}, signal })
    }
    const savedRaw = await hostRequest<unknown>('/plugins/android-control/configuration', {
      method: 'POST',
      body: {
        expectedRevision: config.revision,
        connectionMode: draft.connectionMode,
        networkAddress: draft.networkAddress.trim(),
        defaultDevice: draft.defaultDevice.trim(),
        adbPath: draft.adbPath.trim(),
        workspace: draft.workspace.trim(),
      },
      signal,
    })
    const savedConfig = readPublicConfig(savedRaw)
    if (reconnectAfter && wasConnected) {
      await hostRequest('/plugins/android-control/connect', { method: 'POST', body: {}, signal })
    }
    const freshRaw = await hostRequest<unknown>('/plugins/android-control/configuration', { signal })
    const freshConfig = readPublicConfig(freshRaw) ?? savedConfig
    onUpdated(freshConfig, freshConfig?.adbEnvironment ?? null, null)
    if (freshConfig) setDraft(draftFromConfig(freshConfig))
    setConfirmReconnectSave(false)
    const doneMsg = reconnectAfter && wasConnected ? t('saveReconnectDone') : t('saveDone')
    setSaveNotice(doneMsg)
    onFeedback?.(doneMsg)
    await onRefresh()
  }

  const sourceLabel = (source: string | undefined): string => {
    if (source === 'manual') return t('adbSourceManual')
    if (source === 'system') return t('adbSourceSystem')
    if (source === 'plugin') return t('adbSourcePlugin')
    return t('adbSourceNone')
  }

  const installDisableReason = !env?.packageInfo.supported
    ? t('err.ANDROID_PLATFORM_UNSUPPORTED')
    : env?.systemAvailable
      ? t('systemAdbExistsReason')
      : env?.pluginInstalled
        ? t('pluginAdbAlreadyInstalledReason')
        : undefined

  return (
    <div className="android-conn-stack">
      {!enabled && (
        <div className="android-feedback is-info" role="status">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{t('disabledNotice')}</span>
        </div>
      )}

      {config && config.configState !== 'ok' && (
        <section className="android-block android-block-danger" role="alert">
          <div className="android-block-heading">
            <div>
              <h3>{t('legacyConfigTitle')}</h3>
              <p>{t('legacyConfigBody')}</p>
            </div>
            <ActionButton
              type="button"
              className="button button-danger"
              disabled={busy}
              onClick={() => setConfirmRebuild(true)}>
              <Wrench size={15} aria-hidden="true" />
              {t('rebuildConfigBtn')}
            </ActionButton>
          </div>
          {confirmRebuild && (
            <InlineConfirm
              open
              variant="danger"
              title={t('rebuildConfirmTitle')}
              description={t('rebuildConfirmBody')}
              confirmLabel={t('confirm')}
              cancelLabel={t('cancel')}
              busy={busy}
              onCancel={() => setConfirmRebuild(false)}
              onConfirm={() => void runTask(async signal => {
                const res = await manageAndroid('rebuild-configuration', { confirmed: true }, signal)
                applyResponse(res, true)
                setConfirmRebuild(false)
                setEnvNotice(t('rebuildDone'))
                onFeedback?.(t('rebuildDone'))
                await onRefresh()
              }, msg => setEnvError(msg))}
            />
          )}
        </section>
      )}

      {/* Region 1: ADB Environment */}
      <section className="android-block" aria-labelledby={`${prefix}-adb-env`}>
        <div className="android-block-heading">
          <div>
            <h3 id={`${prefix}-adb-env`}>{t('adbEnvTitle')}</h3>
            <p>{t('adbEnvHelp')}</p>
          </div>
          <div className="android-inline-links">
            <a className="android-ext-link" href="https://developer.android.com/tools/releases/platform-tools" target="_blank" rel="noreferrer">
              {t('officialNotesLink')} <ExternalLink size={12} aria-hidden="true" />
            </a>
            <a className="android-ext-link" href="https://developer.android.com/studio/terms" target="_blank" rel="noreferrer">
              {t('licenseLink')} <ExternalLink size={12} aria-hidden="true" />
            </a>
          </div>
        </div>

        <dl className="android-kv-grid">
          <div>
            <dt>{t('adbFieldResult')}</dt>
            <dd>
              <span className={`android-badge ${env?.available ? 'android-badge-online' : 'android-badge-error'}`}>
                {env?.available ? t('adbValueAvailable') : t('adbValueUnavailable')}
              </span>
            </dd>
          </div>
          <div>
            <dt>{t('adbFieldSource')}</dt>
            <dd>{sourceLabel(env?.source)}</dd>
          </div>
          <div>
            <dt>{t('adbFieldVersion')}</dt>
            <dd><code>{env?.version ?? t('adbValueNone')}</code></dd>
          </div>
          <div className="android-kv-wide">
            <dt>{t('adbFieldPath')}</dt>
            <dd><code>{env?.path ?? config?.adbPath ?? t('adbValueNone')}</code></dd>
          </div>
          {env?.pluginInstallRecord && (
            <div className="android-kv-wide">
              <dt>{t('adbFieldInstallMeta')}</dt>
              <dd className="android-muted-copy">
                <code>v{env.pluginInstallRecord.revision ?? env.pluginInstallRecord.version}</code>
                {' · '}
                {formatByteSize(env.pluginInstallRecord.sizeBytes)}
                {' · '}
                <code>sha256:{env.pluginInstallRecord.sha256.slice(0, 12)}…</code>
                {' · '}
                {formatDateTime(env.pluginInstallRecord.installedAt)}
              </dd>
            </div>
          )}
        </dl>

        {env && env.manualSpecified && !env.manualValid && (
          <div className="android-feedback is-error" role="alert">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>{env.errorMessage ?? t('err.ANDROID_MANUAL_ADB_INVALID')}</span>
          </div>
        )}

        {env && !env.packageInfo.supported && (
          <div className="android-feedback is-warning" role="status">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>{t('platformUnsupportedNote', { reason: env.packageInfo.targetLabel })}</span>
          </div>
        )}

        <div className="android-actions">
          <ActionButton
            type="button"
            className="button button-secondary"
            disabled={busy || installingAdb}
            onClick={() => {
              setEnvError(null)
              setEnvNotice(null)
              void runTask(async signal => {
                const res = await manageAndroid('detect-adb', { includeDevices: true }, signal)
                applyResponse(res, false)
              }, msg => setEnvError(msg))
            }}>
            <RefreshCw size={14} aria-hidden="true" />
            {t('redetectAdb')}
          </ActionButton>

          <ActionButton
            type="button"
            className="button button-primary"
            disabled={busy || installingAdb || Boolean(installDisableReason)}
            reason={installDisableReason}
            onClick={() => void handleOpenInstall()}>
            {installingAdb ? <LoaderCircle size={14} className="android-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
            {installingAdb ? t('installingAdb') : t('installAdbBtn')}
          </ActionButton>

          <ActionButton
            type="button"
            className="button button-secondary"
            disabled={busy || installingAdb || !env?.pluginInstalled}
            reason={!env?.pluginInstalled ? t('pluginAdbNotInstalledReason') : undefined}
            onClick={() => {
              setEnvError(null)
              setEnvNotice(null)
              setConfirmRemoveAdb(true)
            }}>
            <Trash2 size={14} aria-hidden="true" />
            {t('removeAdbBtn')}
          </ActionButton>
        </div>

        {confirmInstall && packageInfo && (
          <div className="android-subcard" role="dialog" aria-label={t('installConfirmTitle')}>
            <strong>{t('installConfirmTitle')}</strong>
            <p className="android-subcopy">
              {loadingPackageInfo ? t('installPreviewLoading') : t('installConfirmBody', {
                target: packageInfo.targetLabel,
                version: packageInfo.version ?? t('installVersionLatest'),
                size: packageInfo.sizeBytes ? formatByteSize(packageInfo.sizeBytes) : t('installSizeUnknown'),
                license: packageInfo.licenseName,
                toolsDir: config?.platformToolsDirectory ?? '',
              })}
            </p>
            <label className="android-checkbox-row">
              <input
                type="checkbox"
                checked={acceptLicense}
                disabled={installingAdb}
                onChange={e => setAcceptLicense(e.target.checked)}
              />
              <span>{t('installAcceptLicense')}</span>
            </label>
            <div className="android-actions">
              <ActionButton
                type="button"
                className="button button-secondary"
                disabled={installingAdb}
                onClick={() => { setConfirmInstall(false); setAcceptLicense(false) }}>
                {t('cancel')}
              </ActionButton>
              <ActionButton
                type="button"
                className="button button-primary"
                disabled={installingAdb || !acceptLicense}
                reason={!acceptLicense ? t('err.ANDROID_LICENSE_NOT_ACCEPTED') : undefined}
                onClick={() => void handleInstallAdb()}>
                {installingAdb ? <LoaderCircle size={14} className="android-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                {installingAdb ? t('installingAdb') : t('confirmInstallAction')}
              </ActionButton>
            </div>
          </div>
        )}

        {confirmRemoveAdb && (
          <div className="android-inline-confirm">
            <InlineConfirm
              open
              variant="danger"
              title={t('removeConfirmTitle')}
              description={t('removeConfirmBody', { toolsDir: config?.toolsDirectory ?? '' })}
              confirmLabel={t('confirmRemoveAction')}
              cancelLabel={t('cancel')}
              busy={busy}
              onCancel={() => setConfirmRemoveAdb(false)}
              onConfirm={() => void handleRemoveAdb()}
            />
          </div>
        )}

        {envError && (
          <div className="android-feedback is-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            <span>{envError}</span>
          </div>
        )}
        {envNotice && (
          <div className="android-feedback is-success" role="status">
            <CheckCircle2 size={15} aria-hidden="true" />
            <span>{envNotice}</span>
          </div>
        )}

        <p className="android-helper-note">{t('uninstallScopeNote')}</p>
      </section>

      {/* Region 2: Device Connection (USB / Network ADB + Wireless Pairing) */}
      <section className="android-block" aria-labelledby={`${prefix}-device-conn`}>
        <div className="android-block-heading">
          <div>
            <h3 id={`${prefix}-device-conn`}>{t('deviceConnTitle')}</h3>
            <p>{t('deviceConnHelp')}</p>
          </div>
          <ActionButton
            type="button"
            className="button button-secondary"
            disabled={busy || !adbAvailable || !configOk}
            reason={!configOk ? t('legacyConfigTitle') : !adbAvailable ? t('err.ANDROID_ADB_MISSING') : undefined}
            onClick={() => {
              setDeviceError(null)
              setDeviceNotice(null)
              void runTask(async signal => {
                const res = await manageAndroid('devices', {}, signal)
                applyResponse(res, false)
              }, msg => setDeviceError(msg))
            }}>
            <RefreshCw size={14} aria-hidden="true" />
            {t('refreshDevices')}
          </ActionButton>
        </div>

        <div className="android-mode-grid" role="radiogroup" aria-label={t('connectionModeLabel')}>
          <button
            type="button"
            role="radio"
            aria-checked={draft?.connectionMode === 'usb'}
            className={`android-mode-card${draft?.connectionMode === 'usb' ? ' is-selected' : ''}`}
            disabled={!configOk || busy}
            onClick={() => setDraft(prev => prev ? { ...prev, connectionMode: 'usb' } : prev)}>
            <div className="android-mode-head">
              <Usb size={16} aria-hidden="true" />
              <strong>{t('modeUsb')}</strong>
            </div>
            <small>{t('modeUsbHint')}</small>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={draft?.connectionMode === 'network'}
            className={`android-mode-card${draft?.connectionMode === 'network' ? ' is-selected' : ''}`}
            disabled={!configOk || busy}
            onClick={() => setDraft(prev => prev ? { ...prev, connectionMode: 'network' } : prev)}>
            <div className="android-mode-head">
              <Wifi size={16} aria-hidden="true" />
              <strong>{t('modeNetwork')}</strong>
            </div>
            <small>{t('modeNetworkHint')}</small>
          </button>
        </div>

        {/* Detected devices */}
        <div className="android-devices-section">
          <div className="android-devices-head">
            <strong>{t('detectedDevicesTitle')}</strong>
            {devSnapshot && devSnapshot.onlineCount > 1 && !config?.defaultDevice && (
              <span className="android-badge android-badge-warning">{t('phoneStatusMultiUnselected', { count: devSnapshot.onlineCount })}</span>
            )}
          </div>

          {devSnapshot && devSnapshot.onlineCount > 1 && !config?.defaultDevice && (
            <div className="android-feedback is-warning" role="status">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>{t('multiDeviceWarning')}</span>
            </div>
          )}

          {!devSnapshot || devSnapshot.devices.length === 0 ? (
            <p className="android-muted-copy">{t('noDevicesFound')}</p>
          ) : (
            <ul className="android-device-list">
              {devSnapshot.devices.map(device => {
                const isDefault = device.isDefault || config?.defaultDevice === device.serial
                const stateBadgeClass =
                  device.state === 'device'
                    ? 'android-badge-online'
                    : device.state === 'unauthorized'
                      ? 'android-badge-error'
                      : 'android-badge-warning'
                const stateLabel =
                  device.state === 'device'
                    ? t('deviceStateOnline')
                    : device.state === 'unauthorized'
                      ? t('deviceStateUnauthorized')
                      : device.state === 'offline'
                        ? t('deviceStateOffline')
                        : t('deviceStateUnknown')
                return (
                  <li key={device.serial} className={`android-device-row${isDefault ? ' is-default' : ''}`}>
                    <div className="android-device-meta">
                      <div className="android-device-title">
                        <Smartphone size={15} aria-hidden="true" />
                        <code>{device.serial}</code>
                        <span className="android-badge">{device.transport === 'network' ? t('transportNetwork') : t('transportUsb')}</span>
                        <span className={`android-badge ${stateBadgeClass}`}>{stateLabel}</span>
                        {isDefault && <span className="android-badge android-badge-primary">{t('deviceDefaultTag')}</span>}
                      </div>
                      {(device.model || device.product) && (
                        <small className="android-muted-copy">
                          {[device.model && `model:${device.model}`, device.product && `product:${device.product}`].filter(Boolean).join(' · ')}
                        </small>
                      )}
                    </div>
                    <div className="android-device-actions">
                      {!isDefault ? (
                        <ActionButton
                          type="button"
                          className="button button-secondary"
                          disabled={busy || !configOk || !device.online}
                          reason={!device.online ? stateLabel : undefined}
                          onClick={() => {
                            setDeviceError(null)
                            setDeviceNotice(null)
                            void runTask(async signal => {
                              const res = await manageAndroid('select-device', { serial: device.serial }, signal)
                              applyResponse(res, true)
                              await onRefresh()
                            }, msg => setDeviceError(msg))
                          }}>
                          <Check size={13} aria-hidden="true" />
                          {t('setDefaultDevice')}
                        </ActionButton>
                      ) : (
                        <ActionButton
                          type="button"
                          className="text-button"
                          disabled={busy || !configOk}
                          onClick={() => {
                            setDeviceError(null)
                            setDeviceNotice(null)
                            void runTask(async signal => {
                              const res = await manageAndroid('select-device', { serial: '' }, signal)
                              applyResponse(res, true)
                              await onRefresh()
                            }, msg => setDeviceError(msg))
                          }}>
                          {t('clearDefaultDevice')}
                        </ActionButton>
                      )}
                      {device.transport === 'network' && (
                        <ActionButton
                          type="button"
                          className="text-button"
                          disabled={busy || !adbAvailable || !configOk}
                          onClick={() => {
                            setDeviceError(null)
                            setDeviceNotice(null)
                            void runTask(async signal => {
                              const res = await manageAndroid('disconnect-device', { address: device.serial }, signal)
                              applyResponse(res, true)
                              setDeviceNotice(t('disconnectDeviceSuccess'))
                              await onRefresh()
                            }, msg => setDeviceError(msg))
                          }}>
                          <Link2Off size={13} aria-hidden="true" />
                          {t('disconnectThisDevice')}
                        </ActionButton>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Network ADB connect block */}
        <div className="android-subcard">
          <div className="android-field">
            <label htmlFor={`${prefix}-network-addr`}>{t('networkAddrLabel')}</label>
            <input
              id={`${prefix}-network-addr`}
              aria-label={t('networkAddrLabel')}
              value={draft?.networkAddress ?? ''}
              placeholder={t('networkAddrPlaceholder')}
              disabled={busy || !configOk}
              onChange={e => setDraft(prev => prev ? { ...prev, networkAddress: e.target.value } : prev)}
            />
          </div>

          <div className="android-feedback is-info" role="note">
            <Laptop size={15} aria-hidden="true" />
            <span>{t('networkLoopbackWarning')}</span>
          </div>

          <div className="android-actions">
            <ActionButton
              type="button"
              className="button button-primary"
              disabled={busy || !adbAvailable || !configOk || !(draft?.networkAddress ?? '').trim()}
              reason={!configOk ? t('legacyConfigTitle') : !adbAvailable ? t('err.ANDROID_ADB_MISSING') : !(draft?.networkAddress ?? '').trim() ? t('err.ANDROID_NETWORK_ADDRESS_INVALID') : undefined}
              onClick={() => {
                setDeviceError(null)
                setDeviceNotice(null)
                void runTask(async signal => {
                  const res = await manageAndroid('connect-device', { address: draft?.networkAddress.trim() ?? '' }, signal)
                  applyResponse(res, true)
                  if (res.ok === true && res.state === 'device') {
                    const msg = t('connectDeviceSuccess', { device: String(res.address ?? '') })
                    setDeviceNotice(msg)
                    onFeedback?.(msg)
                  } else {
                    setDeviceError(typeof res.message === 'string' && res.message ? res.message : t('unknownError'))
                  }
                  await onRefresh()
                }, msg => setDeviceError(msg))
              }}>
              <Link2 size={14} aria-hidden="true" />
              {t('connectDeviceBtn')}
            </ActionButton>

            <ActionButton
              type="button"
              className="button button-secondary"
              disabled={busy || !adbAvailable || !configOk || !((draft?.networkAddress ?? '').trim() || config?.networkAddress)}
              onClick={() => {
                setDeviceError(null)
                setDeviceNotice(null)
                void runTask(async signal => {
                  const res = await manageAndroid('disconnect-device', {
                    address: (draft?.networkAddress ?? '').trim() || config?.networkAddress || '',
                  }, signal)
                  applyResponse(res, true)
                  setDeviceNotice(t('disconnectDeviceSuccess'))
                  await onRefresh()
                }, msg => setDeviceError(msg))
              }}>
              <Link2Off size={14} aria-hidden="true" />
              {t('disconnectDeviceBtn')}
            </ActionButton>
          </div>
        </div>

        {/* Wireless Pairing sub-card */}
        <div className="android-subcard">
          <div className="android-subcard-head">
            <strong>{t('wirelessPairTitle')}</strong>
            <p className="android-muted-copy">{t('wirelessPairHelp')}</p>
          </div>

          <div className="android-fields">
            <div className="android-field">
              <label htmlFor={`${prefix}-pair-addr`}>{t('pairAddrLabel')}</label>
              <input
                id={`${prefix}-pair-addr`}
                aria-label={t('pairAddrLabel')}
                value={pairAddress}
                placeholder={t('pairAddrPlaceholder')}
                disabled={busy || !adbAvailable || !configOk}
                onChange={e => setPairAddress(e.target.value)}
              />
            </div>

            <div className="android-field">
              <label htmlFor={`${prefix}-pair-code`}>{t('pairCodeLabel')}</label>
              <PasswordInput
                id={`${prefix}-pair-code`}
                aria-label={t('pairCodeLabel')}
                value={pairCode}
                placeholder={t('pairCodePlaceholder')}
                hiddenClearedNotice={hiddenClearedPair}
                disabled={busy || !adbAvailable || !configOk}
                onChange={val => { clearHiddenNotice(); setPairCode(val) }}
              />
            </div>
          </div>

          <div className="android-field">
            <label htmlFor={`${prefix}-pair-connect`}>{t('pairConnectAddrLabel')}</label>
            <input
              id={`${prefix}-pair-connect`}
              aria-label={t('pairConnectAddrLabel')}
              value={connectAddress}
              placeholder={t('pairConnectAddrPlaceholder')}
              disabled={busy || !adbAvailable || !configOk}
              onChange={e => setConnectAddress(e.target.value)}
            />
          </div>

          <div className="android-actions">
            <ActionButton
              type="button"
              className="button button-secondary"
              disabled={busy || !adbAvailable || !configOk || !pairAddress.trim() || !pairCode.trim()}
              reason={!configOk ? t('legacyConfigTitle') : !adbAvailable ? t('err.ANDROID_ADB_MISSING') : !pairAddress.trim() ? t('err.ANDROID_NETWORK_ADDRESS_INVALID') : !pairCode.trim() ? t('err.ANDROID_PAIR_CODE_INVALID') : undefined}
              onClick={() => {
                setDeviceError(null)
                setDeviceNotice(null)
                void runTask(async signal => {
                  const res = await manageAndroid('pair-device', {
                    pairAddress: pairAddress.trim(),
                    pairCode: pairCode.trim(),
                    ...(connectAddress.trim() ? { connectAddress: connectAddress.trim() } : {}),
                  }, signal)
                  setPairCode('')
                  applyResponse(res, true)
                  const msg = t('pairSucceeded', { message: String(res.message ?? '') })
                  setDeviceNotice(msg)
                  onFeedback?.(msg)
                  await onRefresh()
                }, msg => {
                  setPairCode('')
                  setDeviceError(msg)
                })
              }}>
              <ShieldCheck size={14} aria-hidden="true" />
              {t('pairExecuteBtn')}
            </ActionButton>
          </div>
        </div>

        {deviceError && (
          <div className="android-feedback is-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            <span>{deviceError}</span>
          </div>
        )}
        {deviceNotice && (
          <div className="android-feedback is-success" role="status">
            <CheckCircle2 size={15} aria-hidden="true" />
            <span>{deviceNotice}</span>
          </div>
        )}
      </section>

      {/* Region 3: Advanced Configuration */}
      <section className="android-block" aria-labelledby={`${prefix}-advanced`}>
        <div className="android-block-heading">
          <div>
            <h3 id={`${prefix}-advanced`}>{t('advancedConfigTitle')}</h3>
            <p>{t('advancedConfigHelp')}</p>
          </div>
        </div>

        <p className="android-workspace-chip">
          <span>{t('defaultDeviceSummaryLabel')}:</span>{' '}
          <code>{config?.defaultDevice || t('defaultDeviceNone')}</code>
        </p>

        <div className="android-field">
          <label htmlFor={`${prefix}-adb-path`}>{t('adbPathLabel')}</label>
          <input
            id={`${prefix}-adb-path`}
            aria-label={t('adbPathLabel')}
            value={draft?.adbPath ?? ''}
            placeholder={t('adbPathPlaceholder')}
            disabled={busy || !configOk}
            onChange={e => setDraft(prev => prev ? { ...prev, adbPath: e.target.value } : prev)}
          />
        </div>

        <div className="android-field">
          <label htmlFor={`${prefix}-workspace`}>{t('workspaceLabel')}</label>
          <input
            id={`${prefix}-workspace`}
            aria-label={t('workspaceLabel')}
            value={draft?.workspace ?? ''}
            placeholder={config?.defaultWorkspace ?? ''}
            disabled={busy || !configOk}
            onChange={e => setDraft(prev => prev ? { ...prev, workspace: e.target.value } : prev)}
          />
          {config?.defaultWorkspace && (
            <small className="android-muted-copy">{t('defaultWorkspaceHint', { path: config.defaultWorkspace })}</small>
          )}
        </div>

        {confirmReconnectSave && (
          <div className="android-inline-confirm">
            <InlineConfirm
              open
              variant="warning"
              title={t('saveReconnectTitle')}
              description={t('saveReconnectBody')}
              confirmLabel={t('saveReconnectBtn')}
              cancelLabel={t('cancel')}
              busy={busy}
              onCancel={() => setConfirmReconnectSave(false)}
              onConfirm={() => void runTask(signal => saveConfigToHost(true, signal), msg => setSaveError(msg))}
            />
          </div>
        )}

        <FormSaveBar
          dirty={dirty}
          saving={busy}
          disabled={!configOk}
          disabledReason={!configOk ? t('legacyConfigTitle') : undefined}
          conflict={saveConflict}
          saveLabel={config?.ready ? t('saveReconnectBtn') : t('saveBtn')}
          discardLabel={t('discardDraft')}
          error={saveError}
          notice={saveNotice}
          onDiscard={() => {
            if (config) setDraft(draftFromConfig(config))
            setSaveError(null)
            setSaveNotice(null)
            setConfirmReconnectSave(false)
          }}
          onReload={() => {
            setSaveConflict(false)
            void onRefresh()
          }}
          onSave={() => {
            if (config?.ready) {
              setConfirmReconnectSave(true)
            } else {
              void runTask(signal => saveConfigToHost(false, signal), msg => {
                if (msg && msg.includes(t('err.ANDROID_CONFIGURATION_CONFLICT'))) setSaveConflict(true)
                setSaveError(msg)
              })
            }
          }}
        />
      </section>
    </div>
  )
}
