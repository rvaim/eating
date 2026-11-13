import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshDeliveryRegistry } from './delivery-registry'
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) { if (realpathSync(path) !== path || dirname(path) !== realpathSync(tmpdir()) || !basename(path).startsWith('eating-delivery-registry-')) throw new Error('Unsafe fixture path'); rmSync(path, { recursive: true }) } })
function fixture() { const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'eating-delivery-registry-'))); directories.push(directory); return { directory, registry: new DshDeliveryRegistry(directory) } }
const frame = (index = 1) => ({ batchId: index.toString(16).padStart(64, '0'), digest: 'd'.repeat(64), ownerRevision: 2, bindings: [{ contextRef: index.toString(16).padStart(64, '0'), agentId: 'child', agentTypeId: 'qq.private', label: 'Fixture child' }] })
describe('durable per-batch metadata ownership', () => {
  it.each(['host-first', 'main-first'] as const)('retires a frame only after both confirmations, including a %s restart', order => {
    const f = fixture(), first = frame(), second = frame(2)
    f.registry.publish(first, 'nonce', 'root'); f.registry.publish(second, 'nonce', 'root')
    if (order === 'host-first') f.registry.accept(first.batchId); else f.registry.retire([first.batchId])
    expect(f.registry.get(first.batchId)).toBeDefined()
    const restored = new DshDeliveryRegistry(f.directory)
    restored.restore('new-nonce', 'root')
    expect(JSON.parse(readFileSync(join(f.directory, `expected-${first.batchId}.json`), 'utf8')).nonce).toBe('new-nonce')
    if (order === 'host-first') restored.retire([first.batchId]); else restored.accept(first.batchId)
    expect(restored.get(first.batchId)).toBeUndefined(); expect(restored.get(second.batchId)).toBeDefined()
    expect(JSON.parse(readFileSync(join(f.directory, 'deliveries.json'), 'utf8')).deliveries).toHaveLength(1)
  })
  it('bounds concurrent frames, refuses external writes, and withdraws only definitely unsubmitted input', () => {
    const f = fixture()
    for (let i = 1; i <= 32; i++) f.registry.publish(frame(i), 'nonce', 'root')
    expect(f.registry.canAccept()).toBe(false)
    expect(() => f.registry.publish(frame(33), 'nonce', 'root')).toThrow(expect.objectContaining({ code: 'DELIVERY_CAPACITY' }))
    f.registry.withdraw(frame().batchId); expect(f.registry.canAccept()).toBe(true)
    f.registry.accept(frame(2).batchId)
    expect(() => f.registry.withdraw(frame(2).batchId)).toThrow()
    const path = join(f.directory, 'deliveries.json'), original = readFileSync(path, 'utf8')
    writeFileSync(path, original.replace('"revision":', '"revision":0,"extra":'))
    expect(() => f.registry.accept(frame(3).batchId)).toThrow(expect.objectContaining({ code: 'DELIVERY_REGISTRY_CHANGED' }))
  })
})
