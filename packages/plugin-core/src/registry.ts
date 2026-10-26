export interface PluginManifest {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly apiVersion: 1
}

export class PluginRegistrationError extends Error {
  constructor(
    readonly code: 'invalid-manifest' | 'incompatible-version' | 'duplicate-id',
    message: string,
  ) {
    super(message)
    this.name = 'PluginRegistrationError'
  }
}

export function validateManifest(manifest: PluginManifest): void {
  if (manifest.apiVersion !== 1) {
    throw new PluginRegistrationError('incompatible-version', '插件与当前验证版的接口版本不兼容。')
  }
  if (
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(manifest.id) ||
    manifest.id.length > 80 ||
    !manifest.name.trim() ||
    manifest.name.length > 40 ||
    !manifest.description.trim() ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)
  ) {
    throw new PluginRegistrationError('invalid-manifest', '插件声明不完整，无法注册。')
  }
}

/** A business directory, not a backend plugin loader or security boundary. */
export class PluginRegistry<T extends PluginManifest> {
  private readonly entries = new Map<string, T>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly T[] = Object.freeze([])

  readonly getSnapshot = (): readonly T[] => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get(id: string): T | undefined {
    return this.entries.get(id)
  }

  register(plugin: T): () => void {
    validateManifest(plugin)
    if (this.entries.has(plugin.id)) {
      throw new PluginRegistrationError('duplicate-id', `${plugin.name} 已经注册，无需重复添加。`)
    }
    const entry = Object.freeze({ ...plugin })
    this.entries.set(plugin.id, entry)
    this.publish()
    return () => {
      if (this.entries.get(plugin.id) === entry) this.unregister(plugin.id)
    }
  }

  unregister(id: string): boolean {
    const removed = this.entries.delete(id)
    if (removed) this.publish()
    return removed
  }

  private publish(): void {
    this.snapshot = Object.freeze([...this.entries.values()])
    for (const listener of [...this.listeners]) listener()
  }
}
