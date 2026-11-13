import { isJsonObject } from '@eating/plugin-sdk'
import type { JsonObject } from '@eating/plugin-sdk'
import type { ModelFixtureRequest } from './openai'
const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(isJsonObject).filter(block => block.type === 'text').map(block => String(block.text)).join('') : ''
/** Query real native result notifications; never rewrite a tool handle or the model request. */
export function fixtureTaskNotices(request: ModelFixtureRequest): Map<string, JsonObject> {
  const results = new Map<string, JsonObject>()
  for (const message of request.messages ?? []) if (message.role === 'user') {
    try { const body: unknown = JSON.parse(text(message.content)); if (isJsonObject(body) && isJsonObject(body.eating_task_result) && typeof body.eating_task_result.taskId === 'string') results.set(body.eating_task_result.taskId, body.eating_task_result) } catch { /* Other native input. */ }
  }
  return results
}
export function fixturePendingTask(request: ModelFixtureRequest): boolean {
  const notices = fixtureTaskNotices(request)
  return (request.messages ?? []).some(message => {
    if (message.role !== 'tool') return false
    try { const result: unknown = JSON.parse(text(message.content)); return isJsonObject(result) && result.status === 'running' && typeof result.taskId === 'string' && !notices.has(result.taskId) } catch { return false }
  })
}
export function fixtureTaskResult(request: ModelFixtureRequest, content: unknown): JsonObject {
  const result: unknown = JSON.parse(text(content).split('\n')[0]!)
  if (!isJsonObject(result)) throw new Error('Expected a structured real tool result')
  if (result.status === 'running' && typeof result.taskId === 'string') {
    const completed = fixtureTaskNotices(request).get(result.taskId)
    if (!completed) throw new Error('The async task still has no native result notice')
    return completed
  }
  return result
}
export function fixtureResolveTaskTurns<T extends { text: string }>(request: ModelFixtureRequest, turns: T[]): Array<T & { taskResult?: JsonObject }> {
  const notices = fixtureTaskNotices(request)
  return turns.map(turn => {
    try { const value = JSON.parse(turn.text); const result = value.status === 'running' && typeof value.taskId === 'string' ? notices.get(value.taskId) : undefined; return { ...turn, ...(result ? { taskResult: result } : {}) } } catch { return turn }
  })
}
