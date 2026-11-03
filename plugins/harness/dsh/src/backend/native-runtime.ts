import { NATIVE_FEATURES, nativeGlobalToolAccess, protectedNativeModule } from '../native-capabilities'

/** Executed by the installed DSH, using its own public plugin and management services. */
export function getNativeCapabilitiesRuntimeSource(): string {
  return String.raw`import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export const name = 'eating-native-capabilities';
export const inject = ['tools', 'agents', 'agentPresets', 'pluginManager', 'configEditor'];
const definitions = ${JSON.stringify(NATIVE_FEATURES)};
const protectedModule = ${protectedNativeModule.toString()};
const globalToolAccess = ${nativeGlobalToolAccess.toString()};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const safe = value => typeof value === 'string' ? value.slice(0, 4096) : '';
const runtimeRequire = createRequire(process.argv[1] || process.execPath);
const load = async name => import(pathToFileURL(runtimeRequire.resolve(name)).href);
const plugin = value => value.default || value;
const requiredBundle = name => ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-minimal', '@deepseek-ai/dsh-web-app'].includes(name);
function invalid(code = 'NATIVE_INPUT_INVALID') { const error = new Error(code); error.code = code; throw error; }
function fields(value, keys) { if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) invalid(); }
export function apply(ctx) {
  const directory = process.env.EATING_DSH_BRIDGE_DIRECTORY;
  const nonce = process.env.EATING_DSH_BRIDGE_NONCE;
  const secret = process.env.EATING_DSH_NATIVE_TOKEN;
  const configurationPath = process.env.EATING_DSH_NATIVE_CONFIGURATION;
  const managementOnly = process.env.EATING_DSH_NATIVE_MANAGEMENT === 'true';
  if (!isAbsolute(directory || '') || !nonce || !secret || !isAbsolute(configurationPath || '')) invalid('NATIVE_IDENTITY_INVALID');
  const configuration = JSON.parse(readFileSync(configurationPath, 'utf8'));
  if (configuration.schemaVersion !== 1 || !Array.isArray(configuration.features) || !Array.isArray(configuration.toolGrants) || Object.hasOwn(configuration, 'toolAccessOverrides') && !Array.isArray(configuration.toolAccessOverrides)) invalid('NATIVE_CONFIGURATION_INVALID');
  const mounted = new Map();
  const agentTools = new Map();
  const services = new Map();
  let disposed = false;
  let readyError = null;
  let server;
  let mutation = false;
  const results = new Map();
  const restrictions = new Map();
  const scopedNativeTools = new WeakMap();
  const approvedLocalTools = new WeakMap();
  const nativeToolNames = type => ctx.tools.schemas().filter(schema => {
    const access = globalToolAccess(schema.name);
    if (access === 'reserved') return false;
    const override = configuration.toolAccessOverrides?.find(grant => grant.name === schema.name);
    // A named owner policy remains authoritative even when the source schema changes.
    if (override) return override.agentTypeIds.includes(type) && digest(schema) === override.fingerprint;
    return type === 'main' || access === 'all' || configuration.toolGrants.some(grant => grant.name === schema.name && grant.agentTypeIds.includes(type) && digest(schema) === grant.fingerprint);
  }).map(schema => schema.name);
  function releaseRestriction(agent, entry) {
    if (restrictions.get(agent) !== entry) return;
    restrictions.delete(agent);
    entry.release?.();
  }
  function refreshRestriction(agent, entry) {
    const current = ctx.agents.get(agent.id);
    if (current && current !== agent) { releaseRestriction(agent, entry); return; }
    const names = entry.readOnly ? [] : nativeToolNames(entry.type).sort(), signature = JSON.stringify(names);
    if (entry.signature === signature) return;
    // Publish before restrict emits tools/change, so our own registration cannot recurse.
    entry.signature = signature;
    const previous = entry.release;
    entry.release = agent.ctx.tools.restrict({ allow: names });
    previous?.();
  }
  ctx.on('tools/change', () => { for (const [agent, entry] of restrictions) refreshRestriction(agent, entry); });
  ctx.on('agent/disposed', ({ agent }) => { const entry = restrictions.get(agent); if (entry) releaseRestriction(agent, entry); approvedLocalTools.delete(agent); scopedNativeTools.delete(agent); });
  function restrict(agent, type, readOnly = false) {
    const previous = restrictions.get(agent);
    if (previous && (previous.type !== type || previous.readOnly !== readOnly)) invalid('NATIVE_AGENT_TYPE_CHANGED');
    if (previous) { refreshRestriction(agent, previous); return; }
    const entry = { type, readOnly, signature: null, release: null };
    restrictions.set(agent, entry);
    try {
      refreshRestriction(agent, entry);
      agent.ctx.effect(() => () => releaseRestriction(agent, entry), 'eating-native.global-restriction');
    } catch (error) { releaseRestriction(agent, entry); throw error; }
  }
  async function moduleAvailability(module) {
    try { runtimeRequire.resolve(module.name); return { id: module.id, name: module.name, available: true }; }
    catch { return { id: module.id, name: module.name, available: false }; }
  }
  async function ensureServices(next) {
    for (const selection of next.features.filter(feature => feature.enabled)) {
      const definition = definitions.find(feature => feature.id === selection.id);
      if (!definition) invalid('NATIVE_CONFIGURATION_INVALID');
      if (definition.platform === 'win32' && process.platform !== 'win32' || definition.platform === 'posix' && process.platform === 'win32') invalid('NATIVE_PLATFORM_UNAVAILABLE');
      for (const module of definition.services || []) {
        if (services.has(module.name)) continue;
        const fiber = ctx.plugin(plugin(await load(module.name)), selection.config[module.id]);
        await fiber.await();
        if (fiber.state !== 2) invalid('NATIVE_DEPENDENCY_UNAVAILABLE');
        services.set(module.name, fiber);
      }
    }
  }
  async function validate(next) {
    if (!record(next) || next.schemaVersion !== 1 || !Array.isArray(next.features) || !Array.isArray(next.toolGrants) || Object.hasOwn(next, 'toolAccessOverrides') && !Array.isArray(next.toolAccessOverrides)) invalid();
    await ensureServices(next);
    const types = [...new Set(next.features.filter(feature => feature.enabled).flatMap(feature => feature.agentTypeIds))];
    for (const type of types) {
      const rows = next.features.filter(feature => feature.enabled && feature.agentTypeIds.includes(type)).flatMap(selection => {
        const definition = definitions.find(feature => feature.id === selection.id);
        return definition.modules.map(module => ({ id: module.id, name: module.name, config: selection.config[module.id] }));
      });
      const id = 'eating-native-validation-' + createHash('sha256').update(type).digest('hex').slice(0, 16);
      const release = await ctx.agentPresets.register({ id, plugins: rows });
      try { const result = await ctx.agentPresets.resolve(id); if (result.broken) invalid('NATIVE_CONFIGURATION_REJECTED'); }
      finally { await release(); }
    }
    const schemas = ctx.tools.schemas();
    for (const grant of next.toolGrants) {
      if (!next.toolAccessOverrides?.some(override => override.name === grant.name) && grant.agentTypeIds.some(type => type !== 'main') && !schemas.some(schema => globalToolAccess(schema.name) === 'main' && schema.name === grant.name && digest(schema) === grant.fingerprint)) invalid('NATIVE_TOOL_CHANGED');
    }
    return { valid: true };
  }
  async function mount(agent, type) {
    const selections = configuration.features.filter(feature => feature.enabled && feature.agentTypeIds.includes(type));
    const names = new Set(nativeToolNames(type));
    const scoped = new Map();
    scopedNativeTools.set(agent, scoped);
    for (const selection of selections) {
      const definition = definitions.find(feature => feature.id === selection.id);
      const before = new Map(agent.ctx.tools.schemas(agent).map(schema => [schema.name, ctx.tools.get(schema.name, agent)]));
      for (const module of definition.modules) {
        const fiber = agent.ctx.plugin(plugin(await load(module.name)), selection.config[module.id]);
        await fiber.await();
        if (fiber.state !== 2) invalid('NATIVE_DEPENDENCY_UNAVAILABLE');
      }
      for (const schema of agent.ctx.tools.schemas(agent)) {
        const tool = ctx.tools.get(schema.name, agent);
        if (before.get(schema.name) !== tool) { names.add(schema.name); scoped.set(schema.name, tool); }
      }
      mounted.set(agent.id + '/' + selection.id, { agentId: agent.id, agentTypeId: type, featureId: selection.id, state: 'mounted' });
      if (mounted.size > 4096) mounted.delete(mounted.keys().next().value);
    }
    return [...names];
  }
  const toolReport = (type, names) => ({ agentTypeId: type, nativeTools: names.filter(name => !name.startsWith('mcp__') && !name.startsWith('eating_')), mcpTools: names.filter(name => name.startsWith('mcp__')) });
  ctx.provide('eatingNativeCapabilities', { mount, restrict, allowedGlobal: nativeToolNames,
    reportTools(agent, type, names) {
      const local = new Map();
      for (const name of names) {
        const actual = ctx.tools.get(name, agent), global = ctx.tools.get(name);
        // A matching name never authorizes an inherited shadow of a global tool.
        if (actual && actual !== global && (!global || scopedNativeTools.get(agent)?.get(name) === actual)) local.set(name, actual);
      }
      approvedLocalTools.set(agent, local);
      agentTools.set(agent.id, toolReport(type, names));
      if (agentTools.size > 512) agentTools.delete(agentTools.keys().next().value);
    },
    authorize(exec, agent, type, allowed) {
      if (exec.agent !== agent) return 'This Agent may only use its approved tools.';
      const actual = ctx.tools.get(exec.name, agent), global = ctx.tools.get(exec.name);
      if (!actual) return 'The tool is no longer available.';
      if (actual === global) return restrictions.get(agent)?.readOnly !== true && nativeToolNames(type).includes(exec.name) ? undefined : 'The native plugin tool changed or is not authorized for this Agent.';
      if (!allowed.includes(exec.name) || approvedLocalTools.get(agent)?.get(exec.name) !== actual) return 'The scoped tool changed or is not authorized for this Agent.';
    },
    async ready() { await initialized; if (readyError) invalid(readyError); await validate({ ...configuration, toolGrants: [] }); }, revision: configuration.revision });
  const initialized = Promise.resolve().then(async () => {
    try { if (!managementOnly) await ensureServices(configuration); }
    catch { readyError = 'NATIVE_DEPENDENCY_UNAVAILABLE'; }
  });
  function configuredRows() {
    return ctx.configEditor.configuration().map(row => ({ id: row.entry.options.id, config: row.entry.options.config || {} }));
  }
  async function list() {
    await initialized;
    const [plugins, bundles] = await Promise.all([ctx.pluginManager.listPlugins(), ctx.pluginManager.listBundles()]);
    const configs = configuredRows();
    for (const [id, row] of mounted) if (!ctx.agents.get(row.agentId)) mounted.delete(id);
    for (const [id, row] of agentTools) {
      const agent = ctx.agents.get(id);
      if (!agent) agentTools.delete(id);
      else agentTools.set(id, toolReport(row.agentTypeId, ctx.tools.schemas(agent).map(schema => schema.name)));
    }
    const features = await Promise.all(definitions.map(async definition => {
      const modules = await Promise.all([...(definition.services || []), ...definition.modules].map(moduleAvailability));
      const platformAvailable = !(definition.platform === 'win32' && process.platform !== 'win32' || definition.platform === 'posix' && process.platform === 'win32');
      return { id: definition.id, modules, available: platformAvailable && modules.every(module => module.available), platformAvailable };
    }));
    return {
      schemaVersion: 1, runtime: { running: !managementOnly, appliedRevision: managementOnly ? null : configuration.revision, errorCode: readyError, mounted: managementOnly ? [] : [...mounted.values()].map(({ agentId, ...row }) => row), agents: managementOnly ? [] : [...agentTools.values()] },
      features,
      tools: ctx.tools.schemas().filter(schema => globalToolAccess(schema.name) !== 'reserved').map(schema => ({ name: schema.name, description: safe(schema.description), fingerprint: digest(schema), automaticAccess: globalToolAccess(schema.name) })),
      plugins: plugins.map(row => ({ entryId: row.entryId, moduleName: row.moduleName, enabled: row.enabled, phase: managementOnly ? null : row.fiberPhase, observedPhase: row.fiberPhase,
        protected: protectedModule(row.moduleName), manageable: Boolean(row.patchId) && !protectedModule(row.moduleName),
        configured: configs.some(config => config.id === row.patchId && Object.keys(config.config).length > 0),
        fingerprint: digest({ entryId: row.entryId, enabled: row.enabled, config: configs.find(config => config.id === row.patchId)?.config || null }),
        ...(row.meta?.title ? { title: row.meta.title } : {}) })),
      bundles: bundles.map(row => ({ name: row.name, version: row.version || null, enabled: row.enabled, installed: row.installed, availability: row.availability,
        official: row.official, optional: row.optional, removable: row.removable && !requiredBundle(row.name), protected: requiredBundle(row.name),
        fingerprint: digest({ name: row.name, version: row.version || null, enabled: row.enabled, installed: row.installed }),
        rows: row.rows.map(entry => ({ id: entry.rowId, name: entry.moduleName })), overrides: row.overrides,
        ...(row.installTarget ? { installTarget: row.installTarget.spec } : {}), ...(row.meta?.title ? { title: row.meta.title } : {}), ...(row.meta?.description ? { description: row.meta.description } : {}),
        errorCode: row.error?.code || null })),
    };
  }
  const cleanChange = result => ({ changed: result.changed, application: result.application, stage: result.stage, target: result.target, ...(result.enabled !== undefined ? { enabled: result.enabled } : {}),
    ...(result.bundle ? { bundle: result.bundle } : {}), ...(result.version ? { version: result.version } : {}), ...(result.error ? { errorCode: result.error.code } : {}),
    ...(result.restartReason ? { restartReason: result.restartReason } : {}), ...(result.pendingBuilds?.length ? { pendingBuilds: result.pendingBuilds } : {}),
    ...(result.packageResult ? { package: { exitCode: result.packageResult.exitCode, kind: result.packageResult.kind || null, timedOut: result.packageResult.timedOut === true } } : {}) });
  async function dispatch(operation, input, signal) {
    if (operation === 'list') { fields(input, []); return list(); }
    if (operation === 'validate') { fields(input, ['configuration']); if (!managementOnly) invalid('NATIVE_STOP_FIRST'); return validate(input.configuration); }
    if (operation === 'inspect') {
      fields(input, ['spec']); if (typeof input.spec !== 'string' || !input.spec.trim() || input.spec.length > 2048 || /[\u0000-\u001f]/.test(input.spec)) invalid();
      const result = await ctx.pluginManager.inspect(input.spec, undefined, signal);
      return result.status === 'accepted' ? { status: result.status, kind: result.kind, name: result.name || null, version: result.version || null, bundle: result.bundle } : { status: result.status, problem: result.problem };
    }
    if (!managementOnly) invalid('NATIVE_STOP_FIRST');
    if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) invalid();
    const requestDigest = digest({ operation, input });
    const previous = results.get(input.requestId);
    if (previous) { if (previous.digest !== requestDigest) invalid('NATIVE_REQUEST_CONFLICT'); return previous.result; }
    if (mutation) invalid('NATIVE_BUSY');
    if (results.size >= 128) invalid('NATIVE_CAPACITY');
    mutation = true;
    try {
      let result;
      if (operation === 'bundle') {
        fields(input, ['requestId', 'name', 'enabled', 'expectedFingerprint']);
        const rows = (await list()).bundles, row = rows.find(row => row.name === input.name);
        if (!row || row.protected || row.fingerprint !== input.expectedFingerprint || typeof input.enabled !== 'boolean') invalid('NATIVE_PLUGIN_CONFLICT');
        result = cleanChange(await ctx.pluginManager.setBundleEnabled(input.name, input.enabled));
      } else if (operation === 'plugin' || operation === 'configure') {
        fields(input, operation === 'plugin' ? ['requestId', 'entryId', 'enabled', 'expectedFingerprint'] : ['requestId', 'entryId', 'config', 'expectedFingerprint']);
        const rows = await ctx.pluginManager.listPlugins(), row = rows.find(row => row.entryId === input.entryId);
        if (!row || !row.patchId || protectedModule(row.moduleName)) invalid('NATIVE_PLUGIN_PROTECTED');
        const current = (await list()).plugins.find(row => row.entryId === input.entryId);
        if (current.fingerprint !== input.expectedFingerprint) invalid('NATIVE_PLUGIN_CONFLICT');
        if (operation === 'plugin') {
          if (typeof input.enabled !== 'boolean') invalid();
          result = cleanChange(await ctx.pluginManager.setPluginEnabled(row.entryId, input.enabled));
        } else {
          if (!record(input.config)) invalid();
          const entry = ctx.configEditor.entries().find(entry => entry.options.id === row.patchId);
          if (!entry) invalid('NATIVE_PLUGIN_CONFLICT');
          await ctx.configEditor.edit(entry, () => structuredClone(input.config));
          result = { changed: true, application: 'restart-required', stage: 'configure', target: row.entryId };
        }
      } else if (operation === 'install') {
        fields(input, ['requestId', 'spec', 'confirmed', 'approvedBuilds']);
        if (input.confirmed !== true || typeof input.spec !== 'string' || input.spec.length > 2048 || /[\u0000-\u001f]/.test(input.spec) || input.approvedBuilds !== undefined && (!Array.isArray(input.approvedBuilds) || input.approvedBuilds.length > 32 || input.approvedBuilds.some(value => typeof value !== 'string' || value.length > 256))) invalid();
        const inspection = await ctx.pluginManager.inspect(input.spec, undefined, signal);
        if (inspection.status !== 'accepted') invalid('NATIVE_INSTALL_REFUSED');
        result = cleanChange(await ctx.pluginManager.installBundle(input.spec, { enabled: false, saveExact: true, requestId: input.requestId, approvedBuilds: input.approvedBuilds }));
      } else if (operation === 'remove') {
        fields(input, ['requestId', 'name', 'confirmed', 'expectedFingerprint']);
        const row = (await list()).bundles.find(row => row.name === input.name);
        if (input.confirmed !== true || !row || !row.removable || row.protected || row.enabled || row.fingerprint !== input.expectedFingerprint) invalid('NATIVE_PLUGIN_CONFLICT');
        result = cleanChange(await ctx.pluginManager.removeBundle(input.name));
      } else invalid();
      results.set(input.requestId, { digest: requestDigest, result });
      return result;
    } finally { mutation = false; }
  }
  server = createServer((request, response) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 180000); timer.unref();
    void (async () => {
      const authorization = request.headers.authorization, expected = 'Bearer ' + secret;
      if (disposed || request.method !== 'POST' || request.url !== '/' || request.headers['x-eating-runtime'] !== nonce || typeof authorization !== 'string' || Buffer.byteLength(authorization) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) { response.writeHead(403); response.end(); return; }
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 512 * 1024) invalid(); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); fields(body, ['protocolVersion', 'operation', 'input']);
      if (body.protocolVersion !== 1 || typeof body.operation !== 'string' || !record(body.input)) invalid();
      const result = await dispatch(body.operation, body.input, abort.signal);
      const output = JSON.stringify({ protocolVersion: 1, result });
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) invalid('NATIVE_RESULT_TOO_LARGE');
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(output);
    })().catch(error => { if (!response.headersSent) response.writeHead(409, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ protocolVersion: 1, error: { code: typeof error?.code === 'string' && /^NATIVE_[A-Z_]+$/.test(error.code) ? error.code : 'NATIVE_OPERATION_FAILED' } })); }).finally(() => clearTimeout(timer));
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address(); if (!address || typeof address === 'string' || disposed) return;
    const path = join(directory, 'native-control.json'), temporary = path + '.' + nonce + '.tmp';
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, nonce, url: 'http://127.0.0.1:' + address.port }), { mode: 0o600 }); renameSync(temporary, path);
  });
  ctx.on('dispose', async () => {
    disposed = true;
    const activeRestrictions = [...restrictions.values()];
    restrictions.clear();
    for (const entry of activeRestrictions) entry.release?.();
    try { const value = JSON.parse(readFileSync(join(directory, 'native-control.json'), 'utf8')); if (value.nonce === nonce) unlinkSync(join(directory, 'native-control.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
}
`;
}
