import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { HarnessHostServices, ProactiveChannel, ProactiveContactEntry, ProactiveContactChannel } from '@eating/plugin-sdk'
import { contactIdentity, DshProactivePolicy, parseContactPolicy } from './proactive-policy'
import { AUTONOMY_DEFAULTS, DshAutonomy } from './autonomy'
const channel = (kind: 'private' | 'group'): ProactiveChannel => ({ pluginId: 'qq', pluginName: 'QQ', instanceId: 'instance', accountId: '12345', agentTypeId: `qq.${kind}`, kind, title: kind, tools: [{ name: 'send', title: '发送' }] })
const entry = (kind: 'private' | 'group', targetId: string): ProactiveContactEntry => ({ pluginId: 'qq', instanceId: 'instance', accountId: '12345', agentTypeId: `qq.${kind}`, targetId, label: targetId })
let directory: string, host: HarnessHostServices, channels: ProactiveChannel[], policy: DshProactivePolicy
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'Eating_contact_policy_')))
  channels = [channel('private'), channel('group')]
  host = { readProactiveChannels: () => channels, readProactiveContacts: vi.fn(async (_pluginId: string, request: ProactiveContactChannel) => request.agentTypeId === 'qq.private' ? [{ id: '100', name: '好友甲' }, { id: '200', name: '好友乙' }] : [{ id: '300', name: '群甲' }, { id: '400', name: '群乙' }]) } as unknown as HarnessHostServices
  policy = new DshProactivePolicy(directory, host)
})
afterEach(async () => { const actual = await realpath(directory); if (dirname(actual) !== await realpath(tmpdir()) || !basename(actual).startsWith('Eating_contact_policy_')) throw new Error('Unsafe policy fixture cleanup'); await rm(actual, { recursive: true }) })
const save = (mode: string, entries: readonly ProactiveContactEntry[] = []) => policy.commit(policy.prepare({ expectedRevision: policy.snapshot().revision, mode, entries }))
describe('统一主动联系黑白名单与全部放行', () => {
  it('默认白名单为空，私聊群聊均不放行，读取不写新文件或改旧自主配置', async () => {
    await writeFile(join(directory, 'autonomy.json'), 'original-owner-data')
    expect(policy.snapshot()).toEqual({ schemaVersion: 1, revision: 0, mode: 'allowlist', entries: [] }); expect(await policy.targets()).toEqual([])
    await expect(readFile(policy.filePath)).rejects.toMatchObject({ code: 'ENOENT' }); expect(host.readProactiveContacts).not.toHaveBeenCalled()
    expect(await readFile(join(directory, 'autonomy.json'), 'utf8')).toBe('original-owner-data')
  })
  it.each([
    ['all', [], ['100', '200', '300', '400']], ['allowlist', [], []], ['denylist', [], ['100', '200', '300', '400']],
    ['allowlist', [entry('private', '100'), entry('group', '300')], ['100', '300']],
    ['denylist', [entry('private', '100'), entry('group', '300')], ['200', '400']],
  ])('%s统一作用于私聊和群聊', async (mode, entries, expected) => { save(String(mode), entries as ProactiveContactEntry[]); expect((await policy.targets()).map(target => target.targetId).sort()).toEqual(expected) })
  it('同一模式切换两类对象，名单不被互相清空且稳定ID可复用', async () => { const entries = [entry('private', '100'), entry('group', '300')]; save('allowlist', entries); const original = await policy.targets(); save('denylist', entries); expect((await policy.targets()).map(target => target.targetId)).toEqual(['200', '400']); save('allowlist', entries); expect((await policy.targets()).map(target => target.id)).toEqual(original.map(target => target.id)) })
  it('全部放行忽略保存名单但不删除，工具来自当前代理权限', async () => { save('all', [entry('private', '100')]); expect(policy.summary()).toEqual({ schemaVersion: 1, revision: 1, mode: 'all', entryCount: 1 }); channels[0] = { ...channels[0]!, tools: [{ name: 'read', title: '读取' }] }; const targets = await policy.targets(); expect(targets.filter(target => target.agentTypeId === 'qq.private').every(target => target.toolNames.join() === 'read')).toBe(true); expect(policy.snapshot().entries).toHaveLength(1) })
  it('手动白名单私聊号码允许精确地址，群号仍必须是已加入群', async () => { save('allowlist', [entry('private', '999'), entry('group', '999')]); expect((await policy.targets()).map(target => [target.agentTypeId, target.targetId])).toEqual([['qq.private', '999']]) })
  it('停用/离线账号不产生对象，账号改变不能套用原账号白名单', async () => { save('allowlist', [entry('private', '100')]); channels = []; expect(await policy.targets()).toEqual([]); channels = [{ ...channel('private'), accountId: 'changed' }]; expect(await policy.targets()).toEqual([]) })
  it('没有已授权工具的类型不因全部放行取得任何工具', async () => { save('all'); channels = channels.map(channel => ({ ...channel, tools: [] })); expect(await policy.targets()).toEqual([]) })
  it.each([{ mode: 'groups-only' }, { entries: [entry('private', '0')] }, { entries: [entry('group', '-1')] }, { entries: [entry('private', '9007199254740992')] }, { entries: [entry('private', '1'), entry('private', '1')] }, { rules: [] }])('非法模式或对象拒绝且不写文件：%j', change => { expect(() => parseContactPolicy({ schemaVersion: 1, revision: 0, mode: 'allowlist', entries: [], ...change })).toThrow() })
  it('同号私聊和群聊是不同对象，不能用群白名单放行同号私聊', async () => { expect(contactIdentity(entry('private', '300'))).not.toBe(contactIdentity(entry('group', '300'))); save('allowlist', [entry('group', '300')]); expect((await policy.targets()).map(target => target.agentTypeId)).toEqual(['qq.group']) })
  it('CAS冲突不覆盖保存名单，损坏文件明确报错', async () => { save('denylist', [entry('group', '300')]); const bytes = await readFile(policy.filePath); expect(() => policy.prepare({ expectedRevision: 0, mode: 'all', entries: [] })).toThrow(); expect(await readFile(policy.filePath)).toEqual(bytes); await writeFile(policy.filePath, '{"schemaVersion":0}'); expect(() => new DshProactivePolicy(directory, host)).toThrow(); expect(await readFile(policy.filePath, 'utf8')).toBe('{"schemaVersion":0}') })
  it('目录异步返回前名单变化会丢弃旧的放行结果', async () => { save('all'); let finish!: (rows: { id: string; name: string }[]) => void; channels = [channel('private')]; host.readProactiveContacts = () => new Promise(resolve => { finish = resolve }); const pending = policy.targets(); save('allowlist'); finish([{ id: '100', name: 'old' }]); await expect(pending).rejects.toMatchObject({ code: 'PROACTIVE_POLICY_CONFLICT' }) })
  it('保存暂停后，旧自主轮次和旧主动任务许可失效', async () => { save('all'); const revoked = vi.fn(), activity = new DshAutonomy(directory, () => true, () => {}, revoked); activity.setTargetDirectory(() => policy.targets()); await activity.configure({ expectedRevision: 0, configuration: { ...AUTONOMY_DEFAULTS, enabled: true } }); activity.startRuntime('nonce'); let state = activity.snapshot(); await activity.control('resume', { expectedRevision: state.revision, expectedActivityRevision: (state.state as { revision: number }).revision }); activity.claim('nonce'); const target = (await activity.listTargets())[0]!; expect(activity.contactTargetStillAllowed(target)).toBe(true); const next = policy.prepare({ expectedRevision: 1, mode: 'allowlist', entries: [] }); state = activity.snapshot(); await activity.control('pause', { expectedRevision: state.revision, expectedActivityRevision: (state.state as { revision: number }).revision }); activity.invalidateTargets(); policy.commit(next); expect(revoked).toHaveBeenCalled(); expect(activity.contactTargetStillAllowed(target)).toBe(false); await expect(activity.prepareContactTarget(target.id)).rejects.toMatchObject({ code: 'AUTONOMY_TARGET_DENIED' }) })
})
