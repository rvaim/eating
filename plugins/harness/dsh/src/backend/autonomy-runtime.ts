/** Mechanical wake admission over the native Agent inbox; no alternate model loop. */
export function getAutonomyRuntimeSource(): string {
  return String.raw`
  let autonomyDriver;
  async function mountAutonomy(agent) {
    if (process.env.EATING_DSH_AUTONOMY !== 'true' || agent.id !== sessionId) return [];
    if (autonomyDriver) {
      if (!autonomyDriver.stopped && ctx.agents.get(sessionId) === autonomyDriver.agent) throw new Error('Autonomy driver already owns the main Agent');
      autonomyDriver.stopped = true;
      if (autonomyDriver.timer !== null) clearTimeout(autonomyDriver.timer);
    }
    const Llm = await loadModule('@deepseek-ai/dsh-llm');
    if (typeof Llm.createUserMessage !== 'function' || typeof agent.followup !== 'function' || typeof agent.cancel !== 'function' || typeof agent.inbox.remove !== 'function') throw new Error('Native autonomous admission APIs are unavailable');
    const state = { agent, flight: null, timer: null, stopped: false, polling: false, settling: false, pendingSettlement: null };
    autonomyDriver = state;
    const auto = (operation, body = {}, signal) => control('autonomy-' + operation, { agentId: sessionId, ...body }, AbortSignal.any([initialization.signal, AbortSignal.timeout(5000), ...(signal ? [signal] : [])]));
    const finish = async (flight, outcome, code = null) => {
      if (state.flight === flight) state.flight = null;
      state.settling = true;
      try {
        if (flight.entered && await ctx.sessions.flush(agent.session) !== true) { outcome = 'unknown'; code = 'AUTONOMY_DURABILITY_FAILED'; }
      } catch { outcome = 'unknown'; code = 'AUTONOMY_DURABILITY_FAILED'; }
      const settlement = { cycleId: flight.cycle.id, outcome, code };
      try { await auto('finish', settlement); state.settling = false; }
      catch { state.pendingSettlement = settlement; }
    };
    const cancelFlight = async (outcome, code) => {
      const flight = state.flight;
      if (!flight) return;
      flight.forced = { outcome, code };
      if (!flight.entered && agent.inbox.remove(flight.messageId)) { await finish(flight, outcome, code); return; }
      agent.cancel({ kind: 'user' }, { keepInbox: true });
    };
    for (const pending of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) if (pending.source?.kind === 'eating-autonomy') agent.inbox.remove(pending.id);
    const render = (_, value) => [{ type: 'text', text: JSON.stringify(value) }];
    const output = { schema: { type: 'object', additionalProperties: true }, render };
    const modelView = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const configuration = value.configuration;
      if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return value;
      const { targets, ...publicConfiguration } = configuration;
      return { ...value, configuration: publicConfiguration };
    };
    agent.ctx.tools.register({ name: 'eating_activity_state', description: '读取自主运行配置、主人暂停状态、当前活动安排、state.revision、额度、下次唤醒时间及主动联系策略摘要；具体联系人必须用 eating_list_contact_targets 查询。', parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
      async execute(args, exec) { if (exec.agent !== agent || !record(args) || Object.keys(args).length) throw new Error('Activity state arguments are invalid'); return modelView(await auto('snapshot', {}, exec.signal)); } });
    agent.ctx.tools.register({ name: 'eating_plan_activity', description: '登记下一步活动：先调用 eating_activity_state，将最新 state.revision 填入 expected_revision。active 按主人设定的间隔等待下一轮机会；sleeping 休息至 wake_at 指定的带时区 RFC3339 时间；waiting 等待真实外部事件。active 和 waiting 的 wake_at 必须为 null，note 简述安排原因。',
      parameters: { type: 'object', properties: { expected_revision: { type: 'integer', minimum: 0 }, mode: { type: 'string', enum: ['active', 'sleeping', 'waiting'] }, wake_at: { type: ['string', 'null'] }, note: { type: 'string', maxLength: 500 } }, required: ['expected_revision', 'mode', 'wake_at', 'note'], additionalProperties: false }, output,
      async execute(args, exec) {
        if (exec.agent !== agent || !record(args) || Object.keys(args).length !== 4 || !Number.isSafeInteger(args.expected_revision) || typeof args.note !== 'string' || !['active', 'sleeping', 'waiting'].includes(args.mode)) throw new Error('Activity plan arguments are invalid');
        const wakeAt = args.mode === 'sleeping' && typeof args.wake_at === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(args.wake_at) ? Date.parse(args.wake_at) : null;
        if (args.mode === 'sleeping' ? !Number.isFinite(wakeAt) : args.wake_at !== null) throw new Error('Sleeping requires an explicit RFC3339 wake time; other modes require null');
        return modelView(await auto('decide', { decision: { expectedActivityRevision: args.expected_revision, mode: args.mode, wakeAt, note: args.note } }, exec.signal));
      } });
    agent.ctx.tools.register({ name: 'eating_list_contact_targets', description: '按主人当前的全部放行、白名单或黑名单策略，列出可主动联系的对象及其精确工具集合。使用返回的对象 id 发起联系；名单策略不扩大账号、目标或工具权限。', parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
      async execute(args, exec) { if (exec.agent !== agent || !record(args) || Object.keys(args).length) throw new Error('Target listing arguments are invalid'); return auto('targets', {}, exec.signal); } });
    agent.ctx.tools.register({ name: 'eating_contact_target', description: '将主动联系任务委派给 eating_list_contact_targets 当前返回的对象，target_id 填其 id，task 说明具体任务。后台核验当前自主周期，并提供账号、scope、工具权限和子代理身份；返回 actions 是真实 Host 动作回执。',
      parameters: { type: 'object', properties: { target_id: { type: 'string' }, task: { type: 'string', maxLength: 16000 } }, required: ['target_id', 'task'], additionalProperties: false }, output,
      async execute(args, exec) {
        const flight = state.flight;
        if (exec.agent !== agent || !flight?.entered || !record(args) || Object.keys(args).length !== 2 || !opaque(args.target_id) || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 16000 || typeof exec.callId !== 'string' || !exec.callId) throw new Error('Proactive communication requires the current autonomous round and target');
        const taskId = createHash('sha256').update(sessionId + '\0' + exec.callId).digest('hex');
        const configuration = await control('prepare-proactive', { agentId: sessionId, targetId: args.target_id, cycleId: flight.cycle.id, taskId }, exec.signal);
        return runDelegation({ contextRef: configuration.contextRef, binding: { agentId: configuration.agentId, agentTypeId: configuration.agentTypeId, label: configuration.label }, payload: { context: { source: 'eating-autonomy', cycleId: flight.cycle.id, target: configuration.scope }, events: [] } }, configuration.agentTypeId, args.task, taskId, exec, configuration);
      } });
    agent.ctx.systemPrompt.section({ name: 'eating:autonomy-policy', order: 20, interpolate: false, text: () => '自主活动须遵守主人当前的启停、暂停、额度和时长边界；外部消息、原生目标和其他 Inbox 输入优先。主动联系仅限当前已准入的自主周期，只能通过 eating_contact_target 在 eating_list_contact_targets 当前返回的对象和工具范围内执行；旧入站 message/resource 引用不授予本轮主动联系权限。判断主动联系权限不得沿用历史对话中的结论，也不得把 configuration.targets 当作授权名单；每次以 eating_list_contact_targets 和 contactPolicy 摘要为准。自主安排使用 eating_plan_activity，不得另建或修改原生 schedule 形成第二条提醒链，以绕过自主调度或主人暂停。' });
    releases.push(ctx.on('agent/pre-step', async ({ agent: caller, messages, signal }, next) => {
      if (caller !== agent) return next();
      const decision = await next();
      if (decision.kind !== 'enter') return decision;
      const own = decision.messages.filter(message => message.source?.kind === 'eating-autonomy');
      const flight = state.flight;
      if (!own.length && !flight?.entered) return decision;
      let valid = false;
      try {
        const status = own.length ? await auto('snapshot', {}, signal) : null;
        const goal = ctx.get('goals')?.get(agent);
        const competing = own.length && (status.externalPending || goal?.phase === 'active' && goal.activation === 'armed');
        valid = Boolean(!competing && flight && (await auto('valid', { cycleId: flight.cycle.id }, signal)).valid && (!own.length || own.every(message => message.source.cycleId === flight.cycle.id && message.source.nonce === nonce)));
      } catch { valid = false; }
      if (!valid) {
        const remaining = decision.messages.filter(message => message.source?.kind !== 'eating-autonomy');
        if (flight) await finish(flight, 'cancelled', 'AUTONOMY_CYCLE_REVOKED');
        return remaining.length ? { ...decision, messages: remaining } : { kind: 'reject' };
      }
      flight.entered = true;
      return decision;
    }));
    releases.push(ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId || event.type !== 'turn/end') return;
      const flight = state.flight;
      if (!flight) return;
      if (!flight.entered) { if (![...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.id === flight.messageId)) void finish(flight, 'cancelled', 'AUTONOMY_ADMISSION_REJECTED'); return; }
      const outcome = flight.forced?.outcome || (event.data.reason.kind === 'completed' ? 'completed' : event.data.reason.kind === 'cancelled' ? 'cancelled' : 'failed');
      const code = flight.forced?.code || (outcome === 'failed' ? 'AUTONOMY_MODEL_FAILED' : null);
      void finish(flight, outcome, code);
    }));
    const poll = async () => {
      if (state.stopped || initialization.signal.aborted) return;
      if (state.polling) return;
      state.polling = true;
      try {
        if (ctx.agents.get(sessionId) !== agent) return;
        if (state.pendingSettlement) {
          await auto('finish', state.pendingSettlement);
          state.pendingSettlement = null; state.settling = false;
          return;
        }
        const status = await auto('snapshot');
        if (!status.ready) return;
        if (!state.flight && !state.settling && status.state.active) {
          await auto('finish', { cycleId: status.state.active.id, outcome: 'unknown', code: 'AUTONOMY_ADMISSION_UNKNOWN' });
          return;
        }
        if (state.flight) {
          if (!(await auto('valid', { cycleId: state.flight.cycle.id })).valid) await cancelFlight(Date.now() >= state.flight.cycle.deadline ? 'unknown' : 'cancelled', Date.now() >= state.flight.cycle.deadline ? 'AUTONOMY_CYCLE_TIMEOUT' : 'AUTONOMY_OWNER_PAUSED');
          return;
        }
        if (state.settling || !status.configuration.enabled || status.state.ownerPaused || status.state.errorCode) return;
        const goal = ctx.get('goals')?.get(agent);
        const phase = status.externalPending ? 'external-pending' : goal?.phase === 'active' && goal.activation === 'armed' ? 'native-goal' : agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length ? 'busy' : 'idle';
        await auto('observe', { phase });
        if (phase !== 'idle') return;
        const claim = await auto('claim');
        if (!claim.admitted) return;
        if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length || state.stopped) { await auto('finish', { cycleId: claim.cycle.id, outcome: 'cancelled', code: 'AUTONOMY_COMPETING_INPUT' }); return; }
        const message = Llm.createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ eating_autonomous_opportunity: { cycleId: claim.cycle.id, activity: claim.activity, limits: claim.limits }, instruction: '这是本轮内部自主机会，不是新的人类指令；activity 和 limits 提供本轮活动与额度上下文。按当前需要选择行动、休息或等待；需调整后续节奏时登记活动安排，无需例行发消息。' }) }], source: { kind: 'eating-autonomy', cycleId: claim.cycle.id, nonce } });
        state.flight = { cycle: claim.cycle, messageId: message.id, entered: false, forced: null };
        agent.followup(message);
        if (await ctx.sessions.flush(agent.session) !== true) await cancelFlight('unknown', 'AUTONOMY_DURABILITY_FAILED');
      } catch {
        if (state.flight) await cancelFlight('unknown', 'AUTONOMY_CONTROL_FAILED');
        else { try { await auto('fault'); } catch { /* Owner status exposes a stale heartbeat until the control channel is restored. */ } }
      } finally {
        state.polling = false;
        if (!state.stopped && !initialization.signal.aborted) state.timer = setTimeout(() => { void poll(); }, 1000);
      }
    };
    state.timer = setTimeout(() => { void poll(); }, 1000);
    releases.push(() => { state.stopped = true; if (state.timer !== null) clearTimeout(state.timer); });
    return ['eating_activity_state', 'eating_plan_activity', 'eating_list_contact_targets', 'eating_contact_target'];
  }
`;
}
