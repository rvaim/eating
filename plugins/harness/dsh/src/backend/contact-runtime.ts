/** Contact authorization follows the native main turn, independently of its wake source. */
export function getContactRuntimeSource(): string {
  return String.raw`
  let contactDriver;
  async function mountContacts(agent) {
    if (agent.id !== sessionId) return [];
    contactDriver?.stop();
    const driver = { agent, current: null, stopped: false, settlement: Promise.resolve(), stop: undefined };
    contactDriver = driver;
    const request = (operation, body = {}, signal) => control(operation, { agentId: sessionId, ...body }, AbortSignal.any([initialization.signal, AbortSignal.timeout(5000), ...(signal ? [signal] : [])]));
    const report = () => ctx.logger?.warn?.('Contact turn authority could not be settled; expired tasks remain blocked.');
    // Cleanup remains usable after bridge initialization is aborted.
    const end = (turn, cycleId) => control('contact-turn-end', { agentId: sessionId, turn, cycleId }, AbortSignal.timeout(5000));
    const close = current => {
      if (!current || current.closed) return;
      current.closed = true;
      if (driver.current === current) driver.current = null;
      current.signal.removeEventListener('abort', current.abort);
      // Serialize end after the matching start, including cancellation during start.
      // A delayed end always carries its own reference and cannot revoke a newer turn.
      driver.settlement = current.opened.then(
        value => end(current.turn, value.id),
        () => end(current.turn, null)
      ).then(() => {}, report);
    };
    driver.stop = () => { driver.stopped = true; close(driver.current); };
    initialization.signal.addEventListener('abort', driver.stop, { once: true });
    const currentTurn = exec => {
      const current = driver.current;
      if (driver.stopped || initialization.signal.aborted || disposed || failed || exec.agent !== agent || ctx.agents.get(sessionId) !== agent || !current || current.closed || current.signal.aborted || exec.signal?.aborted || !current.id) throw new Error('Contact communication requires the current main Agent turn and an approved target');
      return current;
    };
    releases.push(ctx.on('agent/pre-step', async ({ agent: caller, turn, signal }, next) => {
      const decision = await next();
      if (caller !== agent || decision.kind !== 'enter' || signal.aborted || driver.stopped || disposed || failed || ctx.agents.get(sessionId) !== agent) return decision;
      if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('Native main turn identity is unavailable');
      if (driver.current?.turn === turn && !driver.current.closed) return decision;
      if (!decision.messages.length) return decision;
      close(driver.current);
      await driver.settlement;
      signal.throwIfAborted();
      const autonomyCycleId = autonomyDriver?.agent === agent && autonomyDriver.flight?.entered ? autonomyDriver.flight.cycle.id : null;
      const current = { turn, id: null, signal, closed: false, opened: null, abort: null };
      current.abort = () => close(current);
      // Local cancellation closes authority immediately; retain the bounded start
      // transport so an accepted response can still be paired with exact end.
      current.opened = request('contact-turn-start', { turn, autonomyCycleId });
      driver.current = current;
      signal.addEventListener('abort', current.abort, { once: true });
      try {
        const value = await current.opened;
        current.id = value.id;
        if (current.closed || signal.aborted || driver.stopped || driver.current !== current || ctx.agents.get(sessionId) !== agent) { close(current); throw new Error('Main Agent contact turn ended during admission'); }
      } catch (error) { close(current); throw error; }
      return decision;
    }, { prepend: true }));
    releases.push(ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/end' && event.data.turn === driver.current?.turn) close(driver.current);
    }));
    releases.push(ctx.on('agent/disposed', ({ agent: caller }) => { if (caller === agent) driver.stop(); }));
    releases.push(() => { initialization.signal.removeEventListener('abort', driver.stop); driver.stop(); });
    const output = { schema: { type: 'object', additionalProperties: true }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] };
    agent.ctx.tools.register({ name: 'eating_list_contact_targets', description: '读取主人当前联系策略允许的对象及其精确工具集合。主 Agent 可在收到消息、原生输入、目标续行或定时唤醒后的任意当前轮次选择联系，无需等待定时活动。', parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
      async execute(args, exec) {
        const current = currentTurn(exec);
        if (!record(args) || Object.keys(args).length) throw new Error('Target listing arguments are invalid');
        return request('contact-targets', { cycleId: current.id }, exec.signal);
      } });
    agent.ctx.tools.register({ name: 'eating_contact_target', description: '将联系任务委派给 eating_list_contact_targets 当前返回的对象，target_id 填其 id，task 说明具体任务。适用于主 Agent 任意当前轮次，包括群消息后联系已授权私聊；后台绑定真实账号、目标、工具和当前轮次，返回 actions 为真实 Host 回执。',
      parameters: { type: 'object', properties: { target_id: { type: 'string' }, task: { type: 'string', maxLength: 16000 } }, required: ['target_id', 'task'], additionalProperties: false }, output,
      async execute(args, exec) {
        const current = currentTurn(exec);
        if (!record(args) || Object.keys(args).length !== 2 || !opaque(args.target_id) || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 16000 || typeof exec.callId !== 'string' || !exec.callId) throw new Error('Contact task arguments are invalid');
        const taskId = createHash('sha256').update(sessionId + '\0' + exec.callId).digest('hex');
        const configuration = await request('prepare-proactive', { targetId: args.target_id, cycleId: current.id, taskId }, exec.signal);
        try {
          if (currentTurn(exec) !== current) throw new Error('Main Agent contact turn changed during task preparation');
        } catch (error) {
          await control('finish-task', { agentId: configuration.agentId, contextRef: configuration.contextRef, taskId, status: 'unknown' }, AbortSignal.timeout(5000)).catch(report);
          throw error;
        }
        return runDelegation({ contextRef: configuration.contextRef, binding: { agentId: configuration.agentId, agentTypeId: configuration.agentTypeId, label: configuration.label }, payload: { context: { source: 'eating-contact', turnId: current.id, target: configuration.scope }, events: [] } }, configuration.agentTypeId, args.task, taskId, exec, configuration);
      } });
    agent.ctx.systemPrompt.section({ name: 'eating:contact-policy', order: 21, interpolate: false, text: () => '主 Agent 在所有平台保持同一身份，并自主决定行动和委派；消息、原生输入或定时唤醒只是取得活动机会的不同来源，不决定通讯权限。需要联系当前会话以外的对象时，使用 eating_list_contact_targets 和 eating_contact_target，后台按主人保存的账号、目标和工具策略签发当前轮次任务许可。无需等新的私聊入站或定时自主轮次。当前入站 context_ref 继续只用于当前会话资料和回复，不能冒充另一会话的消息/资源授权；跨目标联系不继承旧收到资源。轮次结束、取消、授权变化或运行时停止即撤销任务许可，未知动作不自动重发。' });
    return ['eating_list_contact_targets', 'eating_contact_target'];
  }
`;
}
