import type { ActivityEntry, PluginConfiguration, SavedConfiguration } from '@eating/plugin-core'
import type { ConnectionStatus, JsonObject } from '@eating/plugin-sdk'
import type { ManagedPlugin, WorkspaceActionResult } from '@eating/ui-sdk'
import { getErrorMessage, hostRequest, translate } from '@eating/ui-sdk'
import '../i18n/app'
import type { InstalledFrontendContribution } from '../plugins/catalog'

interface HostWorkspaceResponse {
  readonly registeredIds: readonly string[]
  readonly plugins: readonly (InstalledFrontendContribution & { readonly configuration: JsonObject; readonly status: ConnectionStatus })[]
  readonly harness: JsonObject
}

export interface WorkspaceSnapshot {
  readonly plugins: readonly ManagedPlugin[]
  readonly configurations: Readonly<Record<string, SavedConfiguration>>
  readonly activity: readonly ActivityEntry[]
  readonly storageError: string | null
  readonly unavailableIds: readonly string[]
  readonly statuses: Readonly<Record<string, ConnectionStatus>>
  readonly harness: JsonObject
  readonly ready: boolean
}

type WorkspaceOperation = 'enable' | 'disable' | 'configuration'

function actionFailure(key: string, error?: unknown): WorkspaceActionResult {
  return { ok: false, get error() { return getErrorMessage(error, translate('app', key)) } }
}

export class PlatformWorkspace {
  catalog: readonly ManagedPlugin[]
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private mutation = false
  private storageFailure: { readonly error: unknown } | null = null
  private snapshot: WorkspaceSnapshot = Object.freeze({ plugins: [], configurations: {}, activity: [], storageError: null,
    unavailableIds: [], statuses: {}, harness: { state: 'not-attached', pending: 0 }, ready: false })

  constructor(catalog: readonly ManagedPlugin[], private readonly request: typeof hostRequest = hostRequest,
    private readonly loadCatalog?: (entries: readonly InstalledFrontendContribution[]) => Promise<readonly ManagedPlugin[]>) {
    this.catalog = Object.freeze([...catalog].sort((a, b) => a.order - b.order))
  }

  readonly getSnapshot = (): WorkspaceSnapshot => this.snapshot
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  async refresh(): Promise<void> {
    const generation = ++this.generation
    try {
      const response = await this.request<HostWorkspaceResponse>('/workspace')
      const catalog = this.loadCatalog ? await this.loadCatalog(response.plugins) : this.catalog
      if (generation !== this.generation) return
      this.catalog = Object.freeze([...catalog])
      const available = new Map(response.plugins.map(plugin => [plugin.id, plugin]))
      const registered = new Set(response.registeredIds)
      const configurations: Record<string, SavedConfiguration> = {}
      const statuses: Record<string, ConnectionStatus> = {}
      for (const plugin of response.plugins) {
        statuses[plugin.id] = plugin.status
        if (typeof plugin.configuration.endpoint === 'string' && plugin.configuration.endpoint) {
          const values: Record<string, string | boolean> = {}
          for (const [key, value] of Object.entries(plugin.configuration)) {
            if (typeof value === 'string' || typeof value === 'boolean') values[key] = value
            else if (typeof value === 'number' && Number.isFinite(value)) values[key] = String(value)
          }
          configurations[plugin.id] = { values, savedAt: typeof plugin.configuration.updatedAt === 'string' ? plugin.configuration.updatedAt : '' }
        }
      }
      this.storageFailure = null
      this.publish({ ...this.snapshot, plugins: this.catalog.filter(plugin => registered.has(plugin.id) && available.has(plugin.id)),
        configurations, statuses, harness: response.harness, storageError: null,
        unavailableIds: response.registeredIds.filter(id => !this.catalog.some(plugin => plugin.id === id)), ready: true })
    } catch (error) {
      if (generation !== this.generation) return
      this.storageFailure = { error }
      this.publish({ ...this.snapshot, ready: true })
    }
  }

  register(id: string): Promise<WorkspaceActionResult> { return this.change(id, 'enable') }
  remove(id: string): Promise<WorkspaceActionResult> { return this.change(id, 'disable') }

  async save(id: string, values: PluginConfiguration): Promise<WorkspaceActionResult> {
    return this.change(id, 'configuration', values)
  }

  private async change(id: string, operation: WorkspaceOperation, body: unknown = {}): Promise<WorkspaceActionResult> {
    if (this.mutation) return actionFailure('workspace.busyError')
    if (!this.catalog.some(plugin => plugin.id === id)) return actionFailure('workspace.missingError')
    this.mutation = true
    try {
      await this.request(`/plugins/${encodeURIComponent(id)}/${operation}`, { method: 'POST', body })
      const plugin = this.catalog.find(entry => entry.id === id)!
      const entry: ActivityEntry = { id: crypto.randomUUID(), pluginId: id,
        get label() { return translate('app', `workspace.activity.${operation}`, { name: plugin.name }) }, at: new Date().toISOString() }
      this.publish({ ...this.snapshot, activity: [entry, ...this.snapshot.activity].slice(0, 20) })
      await this.refresh()
      return { ok: true }
    } catch (error) { return actionFailure(operation === 'configuration' ? 'workspace.saveError' : 'workspace.actionError', error) }
    finally { this.mutation = false }
  }

  private publish(snapshot: WorkspaceSnapshot): void {
    const failure = this.storageFailure
    this.snapshot = Object.freeze({ ...snapshot,
      get storageError() { return failure ? getErrorMessage(failure.error, translate('app', 'workspace.loadError')) : null } })
    for (const listener of [...this.listeners]) listener()
  }
}
