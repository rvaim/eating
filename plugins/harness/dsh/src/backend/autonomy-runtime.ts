/** Mechanical wake admission over the native Agent inbox; no alternate model loop. */
export function getAutonomyRuntimeSource(): string {
  return String.raw`
  let autonomyDriver;
  const autonomySystemPolicy = () => '主 Agent 可自行继续、休息、等待或安排未来任务。没有待办也可以延续真实兴趣、探索实际内容、问候当前获准的人或接起未完的话题；想交流本身就是活动，不必先编工作理由。是否联系由当前上下文、真实素材、对象回应与授权决定，不要求每轮发消息。eating_plan_activity 只登记 Eating 无输入活动节奏，不限制普通有输入轮次的行动与联系。暂时没想法但希望稍后再考虑时，用有明确 wake_at 的 sleeping 或按主人间隔继续的 active；waiting 会停止普通定时思考，只有确实等待真实外部事件、在此之前不再定时考虑时才选，不把这一轮没有发言等同于 waiting。需要未来一次性任务消息时，先读 eating_activity_state 的 agenda.revision，再用 eating_schedule_task 或 eating_cancel_scheduled_task；到点消息来自过去的自己，不是主人新指令。Eating 的定时机会仍遵守主人当前的开启／暂停、额度和时长，外部消息、原生目标与其他 Inbox 输入优先；暂停定时机会不撤销普通轮次已有的能力。';
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
    agent.ctx.tools.register({ name: 'eating_activity_state', description: '读取自主运行配置、主人暂停状态、当前活动安排、state.revision、AI 定时任务（agenda.revision）、下次唤醒时间及主动联系策略摘要。state.contactLimit 提供当前小时主动联系任务的 limit、used、remaining、exhausted、windowStartedAt 与 resetAt（Unix 毫秒）；额度用尽需等窗口重置，读取状态或安排 active 不会恢复额度。具体联系人必须用 eating_list_contact_targets 查询。', parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
      async execute(args, exec) { if (exec.agent !== agent || !record(args) || Object.keys(args).length) throw new Error('Activity state arguments are invalid'); return modelView(await auto('snapshot', {}, exec.signal)); } });
    agent.ctx.tools.register({ name: 'eating_plan_activity', description: '登记下一步活动：先调用 eating_activity_state，将最新 state.revision 填入 expected_revision。active 按主人设定的间隔等待下一轮机会；sleeping 休息至 wake_at 指定的带时区 RFC3339 时间，适合暂时没想法但希望稍后再考虑。waiting 停止普通定时思考，直到真实外部事件或已登记任务到期；只有明确希望停止普通机会时才选，这一轮不联系任何人也可保持 active 或安排 sleeping。active 和 waiting 的 wake_at 必须为 null，note 简述安排原因。',
      parameters: { type: 'object', properties: { expected_revision: { type: 'integer', minimum: 0 }, mode: { type: 'string', enum: ['active', 'sleeping', 'waiting'] }, wake_at: { type: ['string', 'null'] }, note: { type: 'string', maxLength: 500 } }, required: ['expected_revision', 'mode', 'wake_at', 'note'], additionalProperties: false }, output,
      async execute(args, exec) {
        if (exec.agent !== agent || !record(args) || Object.keys(args).length !== 4 || !Number.isSafeInteger(args.expected_revision) || typeof args.note !== 'string' || !['active', 'sleeping', 'waiting'].includes(args.mode)) throw new Error('Activity plan arguments are invalid');
        const wakeAt = args.mode === 'sleeping' && typeof args.wake_at === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(args.wake_at) ? Date.parse(args.wake_at) : null;
        if (args.mode === 'sleeping' ? !Number.isFinite(wakeAt) : args.wake_at !== null) throw new Error('Sleeping requires an explicit RFC3339 wake time; other modes require null');
        return modelView(await auto('decide', { decision: { expectedActivityRevision: args.expected_revision, mode: args.mode, wakeAt, note: args.note } }, exec.signal));
      } });
    agent.ctx.tools.register({ name: 'eating_schedule_task', description: '给自己安排一条未来的一次性任务消息。先调用 eating_activity_state 读取 agenda.revision 和当前时间；due_at 必须带时区且在未来一年内，message 是到点时交回给自己的任务内容。到点后该任务作为自主机会进入当前主 Agent，仍受主人暂停、额度、运行时和周期限制；不能替代 eating_plan_activity 的休息/等待安排。',
      parameters: { type: 'object', properties: { expected_agenda_revision: { type: 'integer', minimum: 0 }, due_at: { type: 'string' }, message: { type: 'string', maxLength: 2000 } }, required: ['expected_agenda_revision', 'due_at', 'message'], additionalProperties: false }, output,
      async execute(args, exec) {
        if (exec.agent !== agent || !record(args) || Object.keys(args).length !== 3 || !Number.isSafeInteger(args.expected_agenda_revision) || typeof args.due_at !== 'string' || typeof args.message !== 'string') throw new Error('Scheduled task arguments are invalid');
        const dueAt = /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(args.due_at) ? Date.parse(args.due_at) : NaN;
        if (!Number.isFinite(dueAt)) throw new Error('Scheduled task due_at must be an RFC3339 time with timezone');
        return modelView(await auto('schedule-task', { task: { expectedRevision: args.expected_agenda_revision, dueAt, message: args.message } }, exec.signal));
      } });
    agent.ctx.tools.register({ name: 'eating_cancel_scheduled_task', description: '取消一条尚未到点的 AI 定时任务。先调用 eating_activity_state 读取 agenda.revision 和任务 id；取消后立即停止该任务，不影响已经进入会话的自主机会。',
      parameters: { type: 'object', properties: { expected_agenda_revision: { type: 'integer', minimum: 0 }, task_id: { type: 'string' } }, required: ['expected_agenda_revision', 'task_id'], additionalProperties: false }, output,
      async execute(args, exec) {
        if (exec.agent !== agent || !record(args) || Object.keys(args).length !== 2 || !Number.isSafeInteger(args.expected_agenda_revision) || !opaque(args.task_id)) throw new Error('Scheduled task cancellation arguments are invalid');
        return modelView(await auto('cancel-scheduled-task', { task: { expectedRevision: args.expected_agenda_revision, taskId: args.task_id } }, exec.signal));
      } });
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
        const scheduledTasks = Array.isArray(claim.scheduledTasks) ? claim.scheduledTasks : [];
        const instruction = scheduledTasks.length
          ? '这是本轮内部自主机会，不是新的人类指令；activity 和 limits 提供本轮活动与额度上下文。scheduledTasks 是你在之前给自己安排的定时任务消息，不是主人指令；按这些任务和当前上下文行动。可以延续真实话题、探索实际内容、分享新发现或联系当前获准的人，不要求先有工作任务，也不要求每轮发消息。需调整后续节奏时登记活动安排或新的定时任务；暂时休息后想再考虑，用有唤醒时间的 sleeping，waiting 会停止普通定时思考。'
          : '这是本轮内部自主机会，不是新的人类指令；activity 和 limits 提供本轮活动与额度上下文。看看真实上下文和可用记忆里，有没有自己想继续的兴趣、未完话题、想分享的新发现或想联系的获准对象；想交流本身就有意义，不需要编工作理由。有具体想做的就在当前授权内行动，也可以选择休息。是否联系还要看对象回应和节奏，不例行问候或追着未回复的人。需调整后续节奏时登记活动安排；暂时没想法但想稍后再考虑，用有唤醒时间的 sleeping 或 active，只有明确想等待外部事件并停止普通定时思考才选 waiting。';
        const message = Llm.createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ eating_autonomous_opportunity: { cycleId: claim.cycle.id, activity: claim.activity, scheduledTasks, limits: claim.limits }, instruction }) }], source: { kind: 'eating-autonomy', cycleId: claim.cycle.id, nonce } });
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
    return ['eating_activity_state', 'eating_plan_activity', 'eating_schedule_task', 'eating_cancel_scheduled_task'];
  }
`;
}
