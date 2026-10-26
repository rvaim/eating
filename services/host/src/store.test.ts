import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlatformError } from '../../../packages/platform-contract/src/index'
import type { HarnessEvent, JsonValue } from '../../../packages/platform-contract/src/index'
import { HostStore } from './store'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  const temporaryParent = realpathSync(tmpdir())
  const directory = realpathSync(mkdtempSync(join(temporaryParent, 'eating-store-test-')))
  const databasePath = resolve(directory, 'database', 'host.sqlite')
  if (relative(directory, databasePath).startsWith('..')) throw new Error('Test database escaped its temporary directory.')
  const opened = new Set<HostStore>()
  const open = () => { const store = new HostStore(databasePath); opened.add(store); return store }
  const close = (store: HostStore) => { store.close(); opened.delete(store) }
  cleanups.push(() => {
    for (const store of opened) store.close()
    const target = realpathSync(directory)
    if (target !== directory || dirname(target) !== temporaryParent || !basename(target).startsWith('eating-store-test-')) {
      throw new Error('Refusing to remove a path outside the test mkdtemp directory.')
    }
    rmSync(target, { recursive: true })
  })
  return { databasePath, open, close }
}

function event(conversationId = 'test:private:one', text = 'hello', pluginId = 'test-platform'): HarnessEvent {
  return { protocolVersion: 1, eventId: 'replaced-by-store', pluginId, instanceId: 'test-instance-one', platform: 'test',
    accountId: 'account-one', conversationId, senderId: 'sender-one', receivedAt: '2026-10-26T12:00:00.000Z',
    source: { trust: 'external', kind: 'private' }, content: { type: 'text', text }, text }
}

function deferred<T>() {
  let resolveValue!: (value: T) => void
  const promise = new Promise<T>(complete => { resolveValue = complete })
  return { promise, resolve: resolveValue }
}

describe('HostStore durable messages', () => {
  it('persists settings and deduplicates messages across a close/reopen without replacing the original', () => {
    const { open, close } = fixture()
    const first = open()
    first.setSetting('test:display-name', 'First name')
    first.setSetting('test:display-name', 'Saved name')
    const original = first.recordEvent('test-platform', 'incoming-001', { raw_message: 'original' }, event())
    expect(original.inserted).toBe(true)
    expect(first.recordEvent('test-platform', 'incoming-001', { raw_message: 'changed' }, event('other', 'changed'))).toEqual({ inserted: false, eventId: original.eventId })
    expect(first.recordEvent('other-platform', 'incoming-001', { raw_message: 'other' }, event('other', 'other', 'other-platform')).inserted).toBe(true)
    close(first)
    const reopened = open()
    expect(reopened.getSetting('test:display-name')).toBe('Saved name')
    expect(reopened.getSetting('missing')).toBeNull()
    expect(reopened.recordEvent('test-platform', 'incoming-001', { raw_message: 'late' }, event())).toEqual({ inserted: false, eventId: original.eventId })
    expect(reopened.listMessages('test-platform')).toEqual([expect.objectContaining({ eventId: original.eventId, text: 'hello', raw: { raw_message: 'original' }, harnessStatus: 'pending' })])
    expect(reopened.listMessages('other-platform')).toHaveLength(1)
  })

  it('filters by plugin and conversation with descending stable cursor pagination', () => {
    const store = fixture().open()
    store.recordEvent('test-platform', 'one', { n: 1 }, event('conversation-one', 'oldest'))
    store.recordEvent('test-platform', 'two', { n: 2 }, event('conversation-two', 'other conversation'))
    store.recordEvent('other-platform', 'three', { n: 3 }, event('conversation-one', 'other platform', 'other-platform'))
    store.recordEvent('test-platform', 'four', { n: 4 }, event('conversation-one', 'newest'))
    const page = store.listMessages('test-platform', { conversationId: 'conversation-one', limit: 1 })
    expect(page.map(message => message.text)).toEqual(['newest'])
    expect(store.listMessages('test-platform', { conversationId: 'conversation-one', before: page[0]!.sequence }).map(message => message.text)).toEqual(['oldest'])
    expect(store.listMessages('test-platform', { conversationId: 'missing' })).toEqual([])
    expect(store.listMessages('test-platform').map(message => message.text)).toEqual(['newest', 'other conversation', 'oldest'])
    expect(store.listMessages('test-platform', { limit: 0 })).toHaveLength(1)
  })

  it('filters a shared conversation by stable instance identity, including local-only metadata', () => {
    const store = fixture().open()
    store.recordEvent('test-platform', 'instance-one', {}, event('same-conversation', 'first instance'))
    store.recordEvent('test-platform', 'instance-two', {}, { ...event('same-conversation', 'second instance'), instanceId: 'test-instance-two' })
    store.recordEvent('test-platform', 'local-only', {}, null, { conversationId: 'same-conversation', text: 'second instance local', instanceId: 'test-instance-two' })
    expect(store.listMessages('test-platform', { conversationId: 'same-conversation', instanceId: 'test-instance-one' }).map(message => message.text)).toEqual(['first instance'])
    expect(store.listMessages('test-platform', { conversationId: 'same-conversation', instanceId: 'test-instance-two' }).map(message => message.text)).toEqual(['second instance local', 'second instance'])
    expect(store.listMessages('test-platform', { instanceId: 'missing-instance' })).toEqual([])
  })

  it('keeps eligible events pending with no Harness and excludes events explicitly not forwarded', () => {
    const { open, close } = fixture()
    const store = open()
    const pending = store.recordEvent('test-platform', 'pending', { raw_message: 'forward me' }, event())
    store.recordEvent('test-platform', 'local', { raw_message: 'local only' }, null, { conversationId: 'local-conversation', text: 'local only' })
    expect(store.pendingHarnessEvents()).toEqual([{ event: { ...event(), eventId: pending.eventId }, attempts: 0 }])
    expect(store.harnessSummary()).toMatchObject({ pending: 1, accepted: 0, uncertain: 0, 'not-forwarded': 1 })
    close(store)
    const reopened = open()
    expect(reopened.pendingHarnessEvents()).toHaveLength(1)
    expect(reopened.listMessages('test-platform', { conversationId: 'local-conversation' })[0]).toMatchObject({ text: 'local only', harnessStatus: 'not-forwarded' })
    expect(reopened.listMessages('test-platform', { conversationId: event().conversationId })[0]).toMatchObject({ harnessStatus: 'pending' })
  })

  it('recovers an interrupted Harness delivery as uncertain and never silently requeues it', () => {
    const { open, close } = fixture()
    const store = open()
    const recorded = store.recordEvent('test-platform', 'interrupted-delivery', {}, event())
    store.markHarnessDelivery(recorded.eventId, 'delivering')
    close(store)
    const reopened = open()
    expect(reopened.listMessages('test-platform')[0]?.harnessStatus).toBe('uncertain')
    expect(reopened.pendingHarnessEvents()).toEqual([])
    expect(reopened.harnessSummary()).toMatchObject({ pending: 0, accepted: 0, uncertain: 1 })
  })
})

describe('HostStore durable action idempotency', () => {
  it('replays a successful nested JSON result after reopen without executing twice', async () => {
    const { open, close } = fixture()
    const first = open()
    const execute = vi.fn(async () => ({ message: { id: 'message-123' }, values: [1, true, null] }))
    const params = { target: { id: 'recipient', flags: { quiet: true, urgent: false } }, segments: [{ type: 'text', text: 'hello' }] }
    const result = await first.executeIdempotent('test-platform', 'send', params, 'success-key-001', execute)
    expect(await first.executeIdempotent('test-platform', 'send', params, 'success-key-001', execute)).toEqual(result)
    close(first)
    const reopened = open()
    const reordered = { segments: [{ text: 'hello', type: 'text' }], target: { flags: { urgent: false, quiet: true }, id: 'recipient' } }
    expect(await reopened.executeIdempotent('test-platform', 'send', reordered, 'success-key-001', execute)).toEqual(result)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rejects changed nested values, array order or action names for a previously used key', async () => {
    const store = fixture().open()
    const execute = vi.fn(async () => ({ done: true }))
    await store.executeIdempotent('test-platform', 'send', { nested: { value: 'first' }, items: ['one', 'two'] }, 'conflict-key-001', execute)
    await expect(store.executeIdempotent('test-platform', 'send', { nested: { value: 'second' }, items: ['one', 'two'] }, 'conflict-key-001', execute)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 })
    await expect(store.executeIdempotent('test-platform', 'send', { nested: { value: 'first' }, items: ['two', 'one'] }, 'conflict-key-001', execute)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(store.executeIdempotent('test-platform', 'remove', { nested: { value: 'first' }, items: ['one', 'two'] }, 'conflict-key-001', execute)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('namespaces the same request key by plugin', async () => {
    const store = fixture().open()
    const execute = vi.fn(async () => ({ done: true }))
    await store.executeIdempotent('test-platform', 'send', {}, 'namespaced-key', execute)
    await store.executeIdempotent('other-platform', 'send', {}, 'namespaced-key', execute)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('keeps a shared request key independent across the default, instance and actual-account scopes after reopen', async () => {
    const { open, close } = fixture()
    const store = open()
    const scopes = [undefined, { instanceId: 'instance-one', accountId: 'account-one' },
      { instanceId: 'instance-two', accountId: 'account-one' }, { instanceId: 'instance-one', accountId: 'account-two' }]
    let execution = 0
    const execute = vi.fn(async () => ({ execution: ++execution }))
    for (const [index, scope] of scopes.entries()) {
      expect(await store.executeIdempotent('test-platform', 'send', {}, 'shared-scope-key', execute, scope)).toEqual({ execution: index + 1 })
    }
    close(store)
    const reopened = open()
    for (const [index, scope] of scopes.entries()) {
      expect(await reopened.executeIdempotent('test-platform', 'send', {}, 'shared-scope-key', execute, scope)).toEqual({ execution: index + 1 })
    }
    expect(execute).toHaveBeenCalledTimes(scopes.length)
  })

  it('does not let an unknown action in one account poison the same key in a different account', async () => {
    const store = fixture().open()
    const firstScope = { instanceId: 'instance-one', accountId: 'account-one' }
    const secondScope = { instanceId: 'instance-one', accountId: 'account-two' }
    const failed = vi.fn(async () => { throw new PlatformError('TIMEOUT', 'Test timeout.', 504, 'unknown') })
    const successful = vi.fn(async () => ({ account: 'two' }))
    await expect(store.executeIdempotent('test-platform', 'send', {}, 'separate-scope-key', failed, firstScope)).rejects.toMatchObject({ outcome: 'unknown' })
    expect(await store.executeIdempotent('test-platform', 'send', {}, 'separate-scope-key', successful, secondScope)).toEqual({ account: 'two' })
    await expect(store.executeIdempotent('test-platform', 'send', {}, 'separate-scope-key', failed, firstScope)).rejects.toMatchObject({ code: 'ACTION_OUTCOME_UNKNOWN' })
    expect(failed).toHaveBeenCalledOnce()
    expect(successful).toHaveBeenCalledOnce()
  })

  it('refuses concurrent resends while the first invocation is still running', async () => {
    const store = fixture().open()
    const result = deferred<JsonValue>()
    const execute = vi.fn(() => result.promise)
    const first = store.executeIdempotent('test-platform', 'send', {}, 'inflight-key-001', execute)
    await expect(store.executeIdempotent('test-platform', 'send', {}, 'inflight-key-001', execute)).rejects.toMatchObject({ outcome: 'unknown' })
    expect(execute).toHaveBeenCalledOnce()
    result.resolve({ id: 'confirmed' })
    await expect(first).resolves.toEqual({ id: 'confirmed' })
    await expect(store.executeIdempotent('test-platform', 'send', {}, 'inflight-key-001', execute)).resolves.toEqual({ id: 'confirmed' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('persists an unknown timeout and refuses to redo it after restart', async () => {
    const { open, close } = fixture()
    const store = open()
    const execute = vi.fn(async () => { throw new PlatformError('PLATFORM_TIMEOUT', 'Test platform response timed out.', 504, 'unknown') })
    await expect(store.executeIdempotent('test-platform', 'send', {}, 'timeout-key-001', execute)).rejects.toMatchObject({ code: 'PLATFORM_TIMEOUT', outcome: 'unknown' })
    close(store)
    const reopened = open()
    await expect(reopened.executeIdempotent('test-platform', 'send', {}, 'timeout-key-001', execute)).rejects.toMatchObject({ code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('stores a known failure and refuses to resend the same key', async () => {
    const store = fixture().open()
    const execute = vi.fn(async () => { throw new PlatformError('PLATFORM_REJECTED', 'Test platform rejected the action.', 502, 'failed') })
    await expect(store.executeIdempotent('test-platform', 'send', {}, 'rejected-key-001', execute)).rejects.toMatchObject({ code: 'PLATFORM_REJECTED', outcome: 'failed' })
    await expect(store.executeIdempotent('test-platform', 'send', {}, 'rejected-key-001', execute)).rejects.toMatchObject({ code: 'PLATFORM_REJECTED', outcome: 'failed' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('treats unexpected errors as unknown without copying sensitive exception text', async () => {
    const store = fixture().open()
    const execute = vi.fn(async () => { throw new Error('test-only-sensitive-exception') })
    await expect(store.executeIdempotent('test-platform', 'send', {}, 'unexpected-key', execute)).rejects.toMatchObject({ code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' })
    await expect(store.executeIdempotent('test-platform', 'send', {}, 'unexpected-key', execute)).rejects.not.toThrow('test-only-sensitive-exception')
    expect(execute).toHaveBeenCalledOnce()
  })

  it.each(['short', 'invalid key with spaces', 'a'.repeat(129)])('rejects invalid request IDs before executing: %s', async requestId => {
    const store = fixture().open()
    const execute = vi.fn(async () => null)
    await expect(store.executeIdempotent('test-platform', 'send', {}, requestId, execute)).rejects.toMatchObject({ code: 'INVALID_REQUEST_ID' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('recovers a real killed process from running to unknown without executing its action again', async () => {
    const { open, databasePath } = fixture()
    const program = `
      const { HostStore } = await import(process.argv[2]);
      const store = new HostStore(process.argv[1]);
      setInterval(() => {}, 1000);
      void store.executeIdempotent('test-platform', 'send', { nested: { text: 'hello' } }, 'killed-process-key', async () => {
        process.send({ kind: 'action-running' });
        return new Promise(() => {});
      });
    `
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, databasePath, new URL('./store.ts', import.meta.url).href], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    cleanups.push(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    })
    const ready = once(child, 'message')
    const exited = once(child, 'exit')
    const [message] = await Promise.race([ready, exited.then(([code]) => { throw new Error(`Test child exited before its action started (${String(code)}): ${stderr}`) })])
    expect(message).toEqual({ kind: 'action-running' })
    child.kill('SIGKILL')
    await exited
    const reopened = open()
    const inspection = new DatabaseSync(databasePath, { readOnly: true })
    try {
      expect(inspection.prepare('SELECT state,error_code FROM actions WHERE plugin_id=? AND request_id=?').get('test-platform', 'killed-process-key')).toMatchObject({ state: 'unknown', error_code: 'PROCESS_INTERRUPTED' })
    } finally { inspection.close() }
    const execute = vi.fn(async () => ({ resent: true }))
    await expect(reopened.executeIdempotent('test-platform', 'send', { nested: { text: 'hello' } }, 'killed-process-key', execute)).rejects.toMatchObject({ code: 'ACTION_OUTCOME_UNKNOWN', outcome: 'unknown' })
    expect(execute).not.toHaveBeenCalled()
  }, 10000)
})
