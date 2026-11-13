import { createHash } from 'node:crypto'
import { lstatSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import { readRestrictedJson, writeRestrictedJson } from './config'

export interface DeliveryFrame {
  readonly batchId: string
  readonly digest: string
  readonly ownerRevision: number
  readonly bindings: readonly JsonObject[]
  readonly accepted: boolean
  readonly finished: boolean
}
const digestPattern = /^[a-f0-9]{64}$/
const canonical = (value: unknown) => JSON.stringify(value)
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const invalid = (): never => { throw new PlatformError('DELIVERY_REGISTRY_INVALID', '消息交接索引无效，原数据已保留。', 500, 'not-sent') }

export class DshDeliveryRegistry {
  private readonly file: string
  private revision = 0
  private frames: DeliveryFrame[] = []
  private stamp: string | null = null
  constructor(private readonly directory: string) {
    this.file = join(directory, 'deliveries.json')
    const value = readRestrictedJson(this.file)
    if (!value) return
    if (Object.keys(value).length !== 3 || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
      || !Array.isArray(value.deliveries) || value.deliveries.length > 32 || Buffer.byteLength(canonical(value)) > 1024 * 1024) return invalid()
    for (const entry of value.deliveries) {
      if (!isJsonObject(entry) || Object.keys(entry).length !== 6 || typeof entry.accepted !== 'boolean' || typeof entry.finished !== 'boolean' || !digestPattern.test(String(entry.batchId)) || !digestPattern.test(String(entry.digest))
        || !Number.isSafeInteger(entry.ownerRevision) || Number(entry.ownerRevision) < 0 || !Array.isArray(entry.bindings) || entry.bindings.length < 1 || entry.bindings.length > 10000
        || entry.bindings.some(binding => !isJsonObject(binding) || !digestPattern.test(String(binding.contextRef)))) invalid()
    }
    if (new Set(value.deliveries.map(entry => (entry as JsonObject).batchId)).size !== value.deliveries.length) invalid()
    this.revision = Number(value.revision); this.frames = structuredClone(value.deliveries) as unknown as DeliveryFrame[]; this.stamp = fingerprint(value)
  }
  all(): readonly DeliveryFrame[] { return structuredClone(this.frames) }
  get(batchId: string): DeliveryFrame | undefined { return this.frames.find(frame => frame.batchId === batchId) }
  canAccept(): boolean { return this.frames.length < 32 }
  private save(frames: readonly DeliveryFrame[]): void {
    const current = readRestrictedJson(this.file)
    if ((current ? fingerprint(current) : null) !== this.stamp) throw new PlatformError('DELIVERY_REGISTRY_CHANGED', '消息交接索引已变化，未覆盖原数据。', 409, 'not-sent')
    const next = { schemaVersion: 1, revision: this.revision + 1, deliveries: frames }
    if (frames.length > 32 || Buffer.byteLength(canonical(next)) > 1024 * 1024) throw new PlatformError('DELIVERY_CAPACITY', '待处理批次达到容量，消息继续在Host队列等待。', 429, 'not-sent')
    writeRestrictedJson(this.file, next as unknown as JsonObject)
    this.frames = [...frames]; this.revision++; this.stamp = fingerprint(next)
  }
  publish(frame: Omit<DeliveryFrame, 'accepted' | 'finished'>, nonce: string, sessionId: string): void {
    if (!digestPattern.test(frame.batchId) || !digestPattern.test(frame.digest)) invalid()
    const previous = this.get(frame.batchId)
    if (previous && (previous.digest !== frame.digest || previous.ownerRevision !== frame.ownerRevision || canonical(previous.bindings) !== canonical(frame.bindings))) invalid()
    if (!previous) this.save([...this.frames, { ...frame, accepted: false, finished: false }])
    writeRestrictedJson(join(this.directory, `expected-${frame.batchId}.json`), { schemaVersion: 1, nonce, sessionId, ...frame } as unknown as JsonObject)
  }
  restore(nonce: string, sessionId: string): void { for (const frame of this.frames) { const { accepted: _accepted, finished: _finished, ...expected } = frame; this.publish(expected, nonce, sessionId) } }
  accept(batchId: string): void {
    if (!this.get(batchId)) return
    this.save(this.frames.map(frame => frame.batchId === batchId ? { ...frame, accepted: true } : frame))
    this.retire([])
  }
  withdraw(batchId: string): void {
    const frame = this.get(batchId)
    if (!frame) return
    if (frame.accepted || frame.finished) invalid()
    this.save(this.frames.filter(entry => entry.batchId !== batchId))
    const path = join(this.directory, `expected-${batchId}.json`), stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat) { if (!stat.isFile() || stat.isSymbolicLink()) invalid(); unlinkSync(path) }
  }
  retire(batchIds: readonly string[]): void {
    const finished = this.frames.map(frame => batchIds.includes(frame.batchId) ? { ...frame, finished: true } : frame)
    const removed = finished.filter(frame => frame.finished && frame.accepted)
    if (!removed.length && !batchIds.length) return
    this.save(finished.filter(frame => !frame.finished || !frame.accepted))
    for (const frame of removed) for (const name of [`expected-${frame.batchId}.json`, `ack-${frame.batchId}.json`]) {
      const path = join(this.directory, name), stat = lstatSync(path, { throwIfNoEntry: false })
      if (!stat) continue
      if (!stat.isFile() || stat.isSymbolicLink()) invalid()
      unlinkSync(path)
    }
  }
}
