export function getDeliveryAdmissionSource(): string {
  return String.raw`
  let deliveryAdmissionSequence = 0;
  let stopDeliveryAdmission;
  async function mountDeliveryAdmission(agent) {
    if (agent.id !== sessionId) return;
    stopDeliveryAdmission?.();
    let stopped = false;
    let sending = false;
    let queued = false;
    let requested = false;
    let timer;
    const phase = () => ctx.agents.get(sessionId) === agent && agent.status === 'idle' && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0 ? 'idle' : 'busy';
    const report = async () => {
      if (stopped || disposed || failed || initialization.signal.aborted) return;
      if (sending) { requested = true; return; }
      sending = true;
      requested = false;
      try {
        await control('delivery-state', { agentId: sessionId, sequence: ++deliveryAdmissionSequence, phase: phase() }, AbortSignal.any([initialization.signal, AbortSignal.timeout(2000)]));
      } catch {
        requested = true;
      } finally {
        sending = false;
        if (!stopped && !initialization.signal.aborted) {
          clearTimeout(timer);
          timer = setTimeout(() => { void report(); }, requested ? 100 : 500);
        }
      }
    };
    const notify = () => {
      if (queued || stopped) return;
      queued = true;
      queueMicrotask(() => { queued = false; void report(); });
    };
    const listeners = [
      ctx.on('agent/status', ({ agent: caller }) => { if (caller === agent) notify(); }),
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && (event.type === 'turn/end' || event.type.startsWith('agent/inbox/'))) notify();
      }),
      ctx.on('agent/disposed', ({ agent: caller }) => { if (caller === agent) notify(); }),
    ];
    const stop = () => { stopped = true; clearTimeout(timer); for (const release of listeners) release(); };
    stopDeliveryAdmission = stop;
    releases.push(stop);
    await report();
  }
`;
}
