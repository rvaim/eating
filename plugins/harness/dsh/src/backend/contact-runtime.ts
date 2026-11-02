/** Contact authorization follows the native main turn, independently of its wake source. */
export function getContactRuntimeSource(): string {
  return String.raw`
  let contactDriver;
  const contactSystemPolicy = () => '主 Agent 在所有平台保持同一身份，负责整体安排、轻量分流与必要协调，自主选择联系谁和对应子代理。群消息、私聊、原生输入、目标续行或定时唤醒都可在当前轮次联系其他对象。当前会话的普通聊天、问答和生图等需求优先使用 eating_handle_conversation，仅传当前 context_ref，由绑定子代理独立理解原话、会话历史与人格，自主决定回复和必要工具并执行，main 不预写完整文案或未经核对的能力结论。明确执行任务或用户明确要求的逐字内容使用 eating_delegate_task 及当前 context_ref 和绑定类型；要联系另一个对象，先用 eating_list_contact_targets 读取实际账号、目标、agentTypeId 和工具，再把返回的 id 作为 target_id 交给 eating_contact_target，它会创建或恢复对应目标的私聊／群聊子 Agent。群里让你私聊发言人时，用信封中的真实发言人编号匹配私聊目标，不要把私聊任务交给群子 Agent。无需等新的私聊入站或定时自主轮次，也不要让用户先发私聊来建立批次。某个子 Agent 的通讯scope不足，只说明该执行者不能执行这项动作；主 Agent 应继续检查目标与工具并换用合适子 Agent，不能据此断言整体没有权限。历史对话里的旧MCP故障不代表本次新委派仍故障，以当前实际工具回执为准。跨目标任务不继承旧入站消息／资源引用。子任务 completed 和群回复 succeeded 都不能代替私聊发送成功；核对 actions 中实际工具和目标的回执，区分尚未调用、未发送、失败、未知与成功，未知动作不重发。轮次结束、取消或运行时停止会结束本次任务许可。';
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
    agent.ctx.tools.register({ name: 'eating_contact_target', description: '自主选择并启动／恢复 eating_list_contact_targets 返回的目标子 Agent 执行任务，target_id 填其 id，task 说明具体任务。群里收到私聊请求时选择私聊目标；不要求目标先发私聊。后台绑定真实账号、目标、工具和当前轮次，actions 是真实 Host 回执。',
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
    return ['eating_list_contact_targets', 'eating_contact_target'];
  }
`;
}
