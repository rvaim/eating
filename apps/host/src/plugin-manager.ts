import { randomUUID } from 'node:crypto'
import { PlatformError } from '@eating/plugin-sdk'
import type { PluginPackageManifest } from '@eating/plugin-sdk'
import { assertPluginId, installPreparedPluginPackage, preparePluginPackage, uninstallPluginPackage } from './plugin-installation'
import type { InstalledPluginPackage, PreparedPluginPackage } from './plugin-installation'

export interface PluginPackageManagerCallbacks {
  activate(pkg: InstalledPluginPackage): Promise<void>
  /** 没有此运行实例时应为空操作；同样用于清理激活失败的部分实例。 */
  deactivate(id: string): Promise<void>
}

export interface PluginPackagePreview {
  readonly planId: string
  readonly manifest: PluginPackageManifest
  readonly packageBytes: number
  readonly digest: string
}

export class PluginPackageActivationError extends PlatformError {
  constructor(readonly installed: InstalledPluginPackage, readonly phase: 'deactivate' | 'activate', cause: unknown, readonly cleanupFailed = false) {
    const action = phase === 'deactivate' ? '停止旧实例失败，未启动新版' : '运行激活失败'
    super('PLUGIN_ACTIVATION_FAILED', `插件 ${installed.manifest.id} ${installed.manifest.version} 的代码已安装，但${action}。已发布版本与用户数据已保留。${cleanupFailed ? '部分运行实例清理未确认成功，请先停止该插件。' : ''}`, 500, 'failed')
    this.cause = cause
  }
}

type Plan = { readonly prepared: PreparedPluginPackage; readonly expiresAt: number }
const MAX_PLANS = 2
const PLAN_LIFETIME_MS = 5 * 60 * 1000

/**
 * 主人确认的本地代码管理入口，不自行 import 插件。
 * Host 必须已持有工作区锁；所有操作串行，索引仍由原安装器独立加锁。
 * 预览最多缓存两份快照，五分钟后不可确认；新预览逐出最旧计划，关闭释放所有计划。
 */
export class PluginPackageManager {
  private readonly plans = new Map<string, Plan>()
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly home: string, private readonly callbacks: PluginPackageManagerCallbacks) {}

  preview(sourceDirectory: string): Promise<PluginPackagePreview> {
    return this.run(async () => {
      const prepared = await preparePluginPackage(sourceDirectory)
      this.assertOpen()
      const now = Date.now()
      for (const [id, plan] of this.plans) if (plan.expiresAt <= now) this.plans.delete(id)
      while (this.plans.size >= MAX_PLANS) this.plans.delete(this.plans.keys().next().value!)
      const planId = randomUUID()
      this.plans.set(planId, { prepared, expiresAt: now + PLAN_LIFETIME_MS })
      return { planId, manifest: prepared.manifest, packageBytes: prepared.packageBytes, digest: prepared.digest }
    })
  }

  install(planId: string): Promise<InstalledPluginPackage> {
    return this.run(async () => {
      const plan = this.plans.get(planId)
      if (!plan) throw new PlatformError('PLUGIN_PLAN_NOT_FOUND', '插件安装计划不存在或已失效，请重新预览。', 409, 'not-sent')
      this.plans.delete(planId)
      if (plan.expiresAt <= Date.now()) throw new PlatformError('PLUGIN_PLAN_EXPIRED', '插件安装预览已超过五分钟，请重新预览后确认。', 409, 'not-sent')
      // 确认只使用预览封存的字节；磁盘失败时不调用任何运行实例回调。
      const installed = await installPreparedPluginPackage(this.home, plan.prepared, { hostOwnsWorkspace: true })
      let phase: 'deactivate' | 'activate' = 'deactivate'
      let attemptedActivation = false
      try {
        this.assertOpen()
        await this.callbacks.deactivate(installed.manifest.id)
        this.assertOpen()
        phase = 'activate'
        attemptedActivation = true
        await this.callbacks.activate(installed)
        this.assertOpen()
        return installed
      } catch (error) {
        let cause = error, cleanupFailed = false
        if (attemptedActivation) {
          try { await this.callbacks.deactivate(installed.manifest.id) }
          catch (cleanupError) { cause = new AggregateError([error, cleanupError], '插件激活失败且部分运行实例清理失败。'); cleanupFailed = true }
        }
        // 索引已提交，不能把运行失败当作回滚依据删除版本或用户资料。
        throw new PluginPackageActivationError(installed, phase, cause, cleanupFailed)
      }
    })
  }

  uninstall(id: string): Promise<void> {
    return this.run(async () => {
      assertPluginId(id)
      try { await this.callbacks.deactivate(id) }
      catch (cause) {
        const error = new PlatformError('PLUGIN_DEACTIVATION_FAILED', `插件 ${id} 停止失败，未撤销安装索引；请先核对运行状态。`, 500, 'failed')
        error.cause = cause
        throw error
      }
      this.assertOpen()
      await uninstallPluginPackage(this.home, id, { hostOwnsWorkspace: true })
    })
  }

  close(): void {
    this.closed = true
    this.plans.clear()
  }

  private assertOpen(): void {
    if (this.closed) throw new PlatformError('PLUGIN_MANAGER_CLOSED', '插件管理器已关闭，未启动新的运行实例。', 409, 'not-sent')
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new PlatformError('PLUGIN_MANAGER_CLOSED', '插件管理器已关闭，未启动新的运行实例。', 409, 'not-sent'))
    const result = this.tail.then(() => { this.assertOpen(); return operation() })
    this.tail = result.then(() => {}, () => {})
    return result
  }
}
