import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { isJsonObject, PlatformError } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import { readRestrictedJson, writeRestrictedJson } from './config'

export interface AgendaTask {
  readonly id: string
  readonly message: string
  readonly dueAt: number
  readonly createdAt: number
}
interface Document { schemaVersion: 1; revision: number; tasks: AgendaTask[] }
const MAX_TASKS = 50
const MAX_DUE_TASKS = 10
const MAX_BYTES = 128 * 1024
const MAX_HORIZON_MS = 365 * 86400000
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const exact = (value: JsonObject, names: readonly string[]): boolean => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
const messageText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000 && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)
function fail(code = 'AUTONOMY_AGENDA_INVALID', status = 400, message = 'AI 定时任务无效，请重新读取并核对。'): never { throw new PlatformError(code, message, status, 'not-sent') }

/** AI-authored one-shot task messages. Kept apart from owner configuration and autonomy history. */
export class DshAutonomyAgenda {
  readonly filePath: string
  private document: Document
  constructor(directory: string, private readonly clock: () => number = Date.now) {
    this.filePath = join(directory, 'autonomy-agenda.json')
    try { if (statSync(this.filePath).size > MAX_BYTES) fail('AUTONOMY_AGENDA_CORRUPTED', 500) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const data = readRestrictedJson(this.filePath)
    if (data === null) this.document = { schemaVersion: 1, revision: 0, tasks: [] }
    else {
      try {
        if (!exact(data, ['schemaVersion', 'revision', 'tasks']) || data.schemaVersion !== 1 || !integer(data.revision) || !Array.isArray(data.tasks) || data.tasks.length > MAX_TASKS || Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES) fail('AUTONOMY_AGENDA_CORRUPTED', 500)
        const ids = new Set<string>()
        for (const task of data.tasks) {
          if (!isJsonObject(task) || !exact(task, ['id', 'message', 'dueAt', 'createdAt']) || typeof task.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(task.id) || ids.has(task.id) || !messageText(task.message) || !integer(task.dueAt) || !integer(task.createdAt) || task.dueAt <= task.createdAt) fail('AUTONOMY_AGENDA_CORRUPTED', 500)
          ids.add(task.id)
        }
        this.document = structuredClone(data) as unknown as Document
      } catch { fail('AUTONOMY_AGENDA_CORRUPTED', 500) }
    }
  }
  private save(): void {
    if (Buffer.byteLength(JSON.stringify(this.document, null, 2) + '\n') > MAX_BYTES) fail('AUTONOMY_AGENDA_CAPACITY', 409)
    try { writeRestrictedJson(this.filePath, this.document as unknown as JsonObject) }
    catch (error) { if (error instanceof PlatformError) throw error; fail('AUTONOMY_AGENDA_PERSISTENCE_FAILED', 500) }
  }
  private advance(): void { if (this.document.revision >= Number.MAX_SAFE_INTEGER) fail('AUTONOMY_AGENDA_REVISION_EXHAUSTED', 409); this.document.revision++ }
  snapshot(): JsonObject {
    return { revision: this.document.revision, tasks: [...this.document.tasks].sort((left, right) => left.dueAt - right.dueAt || left.createdAt - right.createdAt).map(task => ({ ...task })) as unknown as JsonObject[] }
  }
  nextDueAt(): number | null { return this.document.tasks.length ? Math.min(...this.document.tasks.map(task => task.dueAt)) : null }
  private requireRevision(value: unknown): void { if (!integer(value) || value !== this.document.revision) fail('AUTONOMY_AGENDA_CONFLICT', 409) }
  schedule(input: unknown): JsonObject {
    if (!isJsonObject(input) || !exact(input, ['expectedRevision', 'dueAt', 'message']) || !integer(input.dueAt) || !messageText(input.message)) fail()
    this.requireRevision(input.expectedRevision)
    const now = this.clock()
    if (input.dueAt < now + 1000 || input.dueAt > now + MAX_HORIZON_MS) fail('AUTONOMY_TASK_TIME_INVALID')
    if (this.document.tasks.length >= MAX_TASKS) fail('AUTONOMY_TASK_CAPACITY', 409)
    const task: AgendaTask = { id: randomUUID(), message: input.message.trim(), dueAt: input.dueAt, createdAt: now }
    this.document.tasks.push(task)
    this.document.tasks.sort((left, right) => left.dueAt - right.dueAt || left.createdAt - right.createdAt)
    this.advance(); this.save()
    return this.snapshot()
  }
  cancel(input: unknown): JsonObject {
    if (!isJsonObject(input) || !exact(input, ['expectedRevision', 'taskId']) || typeof input.taskId !== 'string') fail()
    this.requireRevision(input.expectedRevision)
    if (!this.document.tasks.some(task => task.id === input.taskId)) fail('AUTONOMY_TASK_NOT_FOUND', 404, '找不到这条 AI 定时任务，请刷新后重试。')
    this.document.tasks = this.document.tasks.filter(task => task.id !== input.taskId)
    this.advance(); this.save()
    return this.snapshot()
  }
  due(now: number): readonly AgendaTask[] {
    return [...this.document.tasks].filter(task => task.dueAt <= now).sort((left, right) => left.dueAt - right.dueAt || left.createdAt - right.createdAt).slice(0, MAX_DUE_TASKS).map(task => ({ ...task }))
  }
  consume(ids: readonly string[]): void {
    const selected = new Set(ids)
    if (!this.document.tasks.some(task => selected.has(task.id))) return
    this.document.tasks = this.document.tasks.filter(task => !selected.has(task.id))
    this.advance(); this.save()
  }
}
