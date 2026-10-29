/** Runs inside the installed runtime. All Agent APIs below are public npm contracts. */
export function getRuntimeAgentSource(): string {
  return String.raw`
  const taskConfigurations = new Map();
  const registeredAgentTypes = new Set();
  let activeContext;
  releases.push(ctx.on('session/event', (session, event) => {
    if (session.id === sessionId && event.type === 'turn/end') activeContext = undefined;
  }));
  const taskDeadlineMs = Math.max(1000, Math.min(120000, Number(process.env.EATING_DSH_TASK_TIMEOUT) || 60000));
  const controlUrl = process.env.EATING_DSH_CONTROL_URL;
  const controlToken = process.env.EATING_DSH_CONTROL_TOKEN;
  const mcpEntry = process.env.EATING_DSH_MCP_ENTRY;
  const clockEntry = process.env.EATING_DSH_TIME_CONTEXT_ENTRY;
  // Official packages may be named by bare specifier so the child resolves them from
  // its own installation (app.asar when packaged); only our own files are absolute.
  const moduleSpec = value => typeof value === 'string' && (isAbsolute(value) || /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(value));
  // A bare specifier is resolved from the running DSH entry, so it also works when
  // the installation lives inside app.asar (plain static imports would not).
  const loadModule = spec => {
    if (!spec.startsWith('@')) return import(pathToFileURL(spec).href);
    const requireFromRuntime = createRequire(process.argv[1] || process.execPath);
    return import(pathToFileURL(requireFromRuntime.resolve(spec)).href);
  };
  if (!moduleSpec(clockEntry)) throw bridgeError('BRIDGE_CONFIGURATION_INVALID');
  const clocks = new WeakSet();
  async function mountClock(agent) {
    if (clocks.has(agent)) return;
    const Clock = await loadModule(clockEntry);
    await agent.ctx.plugin(Clock, { timeZone: 'Asia/Shanghai', refreshIntervalMs: 600000 });
    clocks.add(agent);
  }
  if (!controlUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(controlUrl) || !opaque(controlToken) || !moduleSpec(mcpEntry)) throw bridgeError('BRIDGE_CONFIGURATION_INVALID');

  async function control(operation, value, signal) {
    const response = await fetch(controlUrl + '/' + operation, { method: 'POST', redirect: 'error', signal,
      headers: { Authorization: 'Bearer ' + controlToken, 'X-Eating-Runtime': nonce, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('Runtime control response is too large');
    const result = JSON.parse(text);
    if (!response.ok || !record(result)) throw new Error(record(result) && typeof result.message === 'string' ? result.message : 'Runtime control request failed');
    return result;
  }
  function acceptContext(message, expected) {
    if (!identifyMessage(message, expected, false)) return;
    const payload = JSON.parse(message.content.map(block => block.text).join(''));
    const policy = readValidatedOwnerPolicy();
    const binding = policy.binding;
    if (!record(binding) || !opaque(binding.agentId) || !opaque(binding.agentTypeId) || !opaque(binding.label) || policy.contextRef !== expected.batchId) return;
    activeContext = { contextRef: expected.batchId, binding, payload };
  }
  function lastText(blocks) { return Array.isArray(blocks) ? blocks.filter(block => record(block) && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('').slice(0, 32768) : ''; }
  function waitForTask(promise, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('The delegated task was interrupted; its outcome requires verification.'));
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  async function mountChild(agent) {
    const configuration = taskConfigurations.get(agent.id);
    if (!configuration || !record(configuration.mcp) || !record(configuration.mcp.headers) || typeof configuration.systemPrompt !== 'string') throw new Error('Trusted child task configuration is unavailable');
    agent.ctx.systemPrompt.section({ name: 'eating:owner-system', order: 0, complete: true, interpolate: false, text: () => configuration.systemPrompt });
    // Child Agent scopes are separate from their runtime parent; a preset layer may
    // contribute capabilities, so filter every inherited tool before own MCP mounts.
    agent.ctx.tools.restrict({ allow: [] });
    const Mcp = await loadModule(mcpEntry);
    await agent.ctx.plugin(Mcp, { transport: 'streamable-http', serverName: 'qq', url: configuration.mcp.url, headers: configuration.mcp.headers,
      toolCallTimeoutMs: taskDeadlineMs, failOnStartupError: true, reconnect: { enabled: false } });
    const expectedNames = configuration.tools.map(name => 'mcp__qq__' + name).sort();
    const actualNames = agent.ctx.tools.schemas(agent).map(schema => schema.name).sort();
    if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) throw new Error('Scoped MCP tools differ from the approved Agent type');
    agent.ctx.tools.guard(exec => exec.agent !== agent || !expectedNames.includes(exec.name) ? 'This child cannot call that tool.' : undefined);
  }
  function resultOutputSchema() {
    return { type: 'object', properties: { childId: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' }, actions: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['childId', 'status', 'summary', 'actions'], additionalProperties: false };
  }
  async function delegate(args, exec) {
    if (exec.agent?.id !== sessionId || !record(args) || Object.keys(args).some(key => !['type_id', 'context_ref', 'task'].includes(key)) || !opaque(args.type_id) || !HEX.test(args.context_ref) || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 16000) throw new Error('Delegate arguments are invalid');
    if (typeof exec.callId !== 'string' || !exec.callId || exec.callId.length > 4096) throw new Error('Native tool call identity is unavailable');
    const taskId = createHash('sha256').update(sessionId + '\0' + exec.callId).digest('hex');
    const context = activeContext;
    if (!context || context.contextRef !== args.context_ref || context.binding.agentTypeId !== args.type_id) throw new Error('Only the current verified external batch may be delegated to its bound Agent type');
    const childId = context.binding.agentId;
    const deadline = new AbortController();
    const signal = AbortSignal.any([exec.signal, initialization.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), taskDeadlineMs);
    let activation;
    let releaseEnd;
    let cancel;
    let submitted = false;
    let prepared = false;
    try {
      await registerAgentTypes();
      if (ctx.agents.get(childId)) await ctx.subagents.drainChildren(exec.agent, [childId]);
      const configuration = await control('prepare-task', { agentId: childId, agentTypeId: args.type_id, contextRef: args.context_ref, taskId }, signal);
      prepared = true;
      taskConfigurations.set(childId, configuration);
      const prompt = [{ type: 'text', text: JSON.stringify({ eating: { protocolVersion: 1, contextRef: args.context_ref, agentTypeId: args.type_id }, task: args.task,
        context: context.payload.context, events: context.payload.events }) }];
      let terminal;
      const stored = await ctx.sessionPersistence.stat(childId, { signal });
      if (stored) {
        if (stored.header.parentSession !== sessionId) throw new Error('Persisted child does not belong to this parent');
        const ended = Promise.withResolvers();
        releaseEnd = ctx.on('subagent/end', info => { if (info.id === childId && info.local) ended.resolve({ stopReason: info.stopReason, output: info.lastAssistantMessage || [] }); });
        cancel = () => { ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: exec.agent }); void ctx.subagents.drainChildren(exec.agent, [childId]).catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        await ctx.subagents.sendMessage(exec.agent, childId, prompt, { signal });
        submitted = true;
        const child = ctx.agents.get(childId);
        if (!child || await ctx.sessions.flush(child.session) !== true) throw new Error('Child durability is unavailable');
        if (await ctx.sessions.flush(exec.agent.session) !== true) throw new Error('Parent durability is unavailable');
        terminal = await waitForTask(ended.promise, signal);
      } else {
        activation = await ctx.subagents.startActivation({ provider: 'spawn', childId, label: context.binding.label,
          request: { parent: exec.agent, prompt, agentPreset: args.type_id, maxDepth: 1 }, signal, delivery: 'caller' });
        submitted = true;
        cancel = () => { void activation.dispose().catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        const child = ctx.agents.get(childId);
        if (!child || await ctx.sessions.flush(child.session) !== true) throw new Error('Child durability is unavailable');
        if (await ctx.sessions.flush(exec.agent.session) !== true) throw new Error('Parent durability is unavailable');
        terminal = await waitForTask(activation.result, signal);
      }
      const actionsResult = await control('actions', { agentId: childId, contextRef: args.context_ref, taskId }, AbortSignal.timeout(5000));
      if (!Array.isArray(actionsResult.actions)) throw new Error('Host action receipts are invalid');
      const status = signal.aborted ? 'unknown' : terminal.stopReason === 'completed' ? 'completed' : 'failed';
      await control('finish-task', { agentId: childId, contextRef: args.context_ref, taskId, status }, AbortSignal.timeout(5000));
      return { childId, status, summary: lastText(terminal.output), actions: actionsResult.actions };
    } catch (error) {
      if (submitted) {
        if (activation) await activation.dispose().catch(() => {});
        else await ctx.subagents.drainChildren(exec.agent, [childId]).catch(() => {});
      }
      if (prepared) await control('finish-task', { agentId: childId, contextRef: args.context_ref, taskId, status: 'unknown' }, AbortSignal.timeout(5000)).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      if (cancel) signal.removeEventListener('abort', cancel);
      if (releaseEnd) releaseEnd();
      taskConfigurations.delete(childId);
    }
  }
  async function onAgentCreated({ agent }) {
    await mountClock(agent);
    if (agent.id !== sessionId) { if (taskConfigurations.has(agent.id)) await mountChild(agent); return; }
    agent.ctx.systemPrompt.section({ name: 'eating:owner-system', order: 0, complete: true, interpolate: false, text: () => readValidatedOwnerPolicy().systemPrompt });
    agent.ctx.tools.restrict({ allow: [] });
    const output = { render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] };
    agent.ctx.tools.register({ name: 'eating_list_agent_types', description: 'List the enabled execution Agent types. The main Agent delegates tasks using verified context references.', parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { ...output, schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['id', 'title', 'description'], additionalProperties: false } } },
      async execute(args, exec) { if (exec.agent !== agent || !record(args) || Object.keys(args).length) throw new Error('Agent type listing is not authorized'); return readValidatedOwnerPolicy().agentTypes.filter(type => type.enabled).map(type => ({ id: type.id, title: type.title, description: type.description })); } });
    agent.ctx.tools.register({ name: 'eating_delegate_task', description: 'Delegate a task to the execution Agent bound to a verified batch context_ref. Only type_id, context_ref and task are accepted. The returned actions are Host receipts.',
      parameters: { type: 'object', properties: { type_id: { type: 'string' }, context_ref: { type: 'string' }, task: { type: 'string' } }, required: ['type_id', 'context_ref', 'task'], additionalProperties: false },
      output: { ...output, schema: resultOutputSchema() }, execute: delegate });
    agent.ctx.tools.guard(exec => exec.agent !== agent || !['eating_list_agent_types', 'eating_delegate_task'].includes(exec.name) ? 'The main Agent may only list and delegate.' : undefined);
  }
  async function registerAgentTypes() {
    const policy = readValidatedOwnerPolicy();
    if (!registeredAgentTypes.has('eating-main')) {
      releases.push(await ctx.agentPresets.register({ id: 'eating-main', name: 'Eating', description: 'Eating session', plugins: [] }));
      registeredAgentTypes.add('eating-main');
    }
    for (const type of policy.agentTypes) {
      if (!record(type) || !opaque(type.id) || typeof type.title !== 'string') throw bridgeError('OWNER_POLICY_INVALID');
      if (registeredAgentTypes.has(type.id)) continue;
      const release = await ctx.agentPresets.register({ id: type.id, name: type.title, description: type.description, plugins: [] });
      registeredAgentTypes.add(type.id);
      releases.push(release);
    }
  }
`;
}
