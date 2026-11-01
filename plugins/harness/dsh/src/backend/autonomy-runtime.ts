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
    agent.ctx.tools.register({ name: 'eating_activity_state', description: 'Read the owner-controlled autonomous mode, current activity revision, limits and next wake. This does not change permissions.', parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
      async execute(args, exec) { if (exec.agent !== agent || !record(args) || Object.keys(args).length) throw new Error('Activity state arguments are invalid'); return auto('snapshot', {}, exec.signal); } });
    agent.ctx.tools.register({ name: 'eating_plan_activity', description: 'Decide your next activity: active continues after the owner interval, sleeping waits until an RFC3339 time, waiting waits for a real external event. Read eating_activity_state first and supply its state.revision. This cannot enable owner-paused activity or change limits.',
      parameters: { type: 'object', properties: { expected_revision: { type: 'integer', minimum: 0 }, mode: { type: 'string', enum: ['active', 'sleeping', 'waiting'] }, wake_at: { type: ['string', 'null'] }, note: { type: 'string', maxLength: 500 } }, required: ['expected_revision', 'mode', 'wake_at', 'note'], additionalProperties: false }, output,
      async execute(args, exec) {
        if (exec.agent !== agent || !record(args) || Object.keys(args).length !== 4 || !Number.isSafeInteger(args.expected_revision) || typeof args.note !== 'string' || !['active', 'sleeping', 'waiting'].includes(args.mode)) throw new Error('Activity plan arguments are invalid');
        const wakeAt = args.mode === 'sleeping' && typeof args.wake_at === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(args.wake_at) ? Date.parse(args.wake_at) : null;
        if (args.mode === 'sleeping' ? !Number.isFinite(wakeAt) : args.wake_at !== null) throw new Error('Sleeping requires an explicit RFC3339 wake time; other modes require null');
        return auto('decide', { decision: { expectedActivityRevision: args.expected_revision, mode: args.mode, wakeAt, note: args.note } }, exec.signal);
      } });
    agent.ctx.tools.register({ name: 'eating_list_contact_targets', description: 'List owner-approved proactive communication targets and exact tools. A target grant does not permit arbitrary accounts or other destinations.', parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
      async execute(args, exec) { if (exec.agent !== agent || !record(args) || Object.keys(args).length) throw new Error('Target listing arguments are invalid'); return auto('targets', {}, exec.signal); } });
    agent.ctx.tools.register({ name: 'eating_contact_target', description: 'During an admitted autonomous round, delegate proactive communication to one owner-approved target. The backend supplies its account, scope, tool permissions and child identity. The returned actions are real Host receipts.',
      parameters: { type: 'object', properties: { target_id: { type: 'string' }, task: { type: 'string', maxLength: 16000 } }, required: ['target_id', 'task'], additionalProperties: false }, output,
      async execute(args, exec) {
        const flight = state.flight;
        if (exec.agent !== agent || !flight?.entered || !record(args) || Object.keys(args).length !== 2 || !opaque(args.target_id) || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 16000 || typeof exec.callId !== 'string' || !exec.callId) throw new Error('Proactive communication requires the current autonomous round and target');
        const taskId = createHash('sha256').update(sessionId + '\0' + exec.callId).digest('hex');
        const configuration = await control('prepare-proactive', { agentId: sessionId, targetId: args.target_id, cycleId: flight.cycle.id, taskId }, exec.signal);
        return runDelegation({ contextRef: configuration.contextRef, binding: { agentId: configuration.agentId, agentTypeId: configuration.agentTypeId, label: configuration.label }, payload: { context: { source: 'eating-autonomy', cycleId: flight.cycle.id, target: configuration.scope }, events: [] } }, configuration.agentTypeId, args.task, taskId, exec, configuration);
      } });
    agent.ctx.systemPrompt.section({ name: 'eating:autonomy-policy', order: 20, interpolate: false, text: () => 'When owner-authorized autonomous activity is enabled, you may choose meaningful work, continue, wait for external events, or sleep. Use eating_activity_state and eating_plan_activity for structured arrangements; prose alone does not schedule a wake. No human task is required for an autonomous opportunity. Only eating_contact_target may initiate owner-approved proactive communication; no prior incoming-message authority is implied. Native owner goals retain their own continuation priority.' });
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
        const message = Llm.createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ eating_autonomous_opportunity: { cycleId: claim.cycle.id, activity: claim.activity, limits: claim.limits }, instruction: 'This is an owner-authorized autonomous opportunity, not an incoming chat or a new human instruction. Choose what to do from current interests, unfinished work and authorized context. You may continue, wait, or sleep. Register a structured next activity arrangement before ending when appropriate; you need not send any message.' }) }], source: { kind: 'eating-autonomy', cycleId: claim.cycle.id, nonce } });
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
