import { getRuntimeAgentSource } from './runtime-agents'

/** The generated module imports only Node builtins; the approved MCP module is resolved at runtime. */
export function getRuntimeBridgeSource(): string {
  return String.raw`import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const name = 'eating-runtime-bridge';
export const inject = ['sessions', 'sessionPersistence', 'systemPrompt', 'tools', 'agents', 'subagents', 'agentPresets', 'eatingNativeWeb'];

const HEX = /^[a-f0-9]{64}$/;
const ERROR_MESSAGES = {
  BRIDGE_CONFIGURATION_INVALID: 'DSH 桥接配置无效。',
  OWNER_POLICY_INVALID: '主人系统提示词配置无效。',
  EXPECTED_DELIVERY_INVALID: 'DSH 待交接批次元数据无效。',
  DURABILITY_UNAVAILABLE: 'DSH 公开持久化屏障不可用。',
  NATIVE_AGENT_API_UNAVAILABLE: 'DSH 当前公开子代理接口不可用。',
  DURABILITY_FAILED: 'DSH 会话持久化失败，未确认可靠交接。',
  SESSION_RECOVERY_FAILED: 'DSH 持久会话核对失败，未重复投递。',
  UNEXPECTED_TOOLS: 'DSH 全局工具集合包含未授权工具。',
  BRIDGE_FILE_FAILED: 'DSH 桥接状态文件写入失败。',
};

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function bridgeError(code) { const error = new Error(ERROR_MESSAGES[code]); error.code = code; return error; }
function opaque(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value); }

export function apply(ctx) {
  const configuredDirectory = process.env.EATING_DSH_BRIDGE_DIRECTORY;
  const nonce = process.env.EATING_DSH_BRIDGE_NONCE;
  const sessionId = process.env.EATING_DSH_SESSION_ID;
  if (!configuredDirectory || !isAbsolute(configuredDirectory) || !opaque(nonce) || !opaque(sessionId)) throw bridgeError('BRIDGE_CONFIGURATION_INVALID');
  let directory;
  let directoryStat;
  try {
    if (lstatSync(configuredDirectory).isSymbolicLink()) throw bridgeError('BRIDGE_CONFIGURATION_INVALID');
    directory = realpathSync(configuredDirectory);
    directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory()) throw bridgeError('BRIDGE_CONFIGURATION_INVALID');
  } catch { throw bridgeError('BRIDGE_CONFIGURATION_INVALID'); }

  let disposed = false;
  let failed = false;
  let acknowledgedBatch;
  let activeAck;
  let sessionBarrier;
  const releases = [];
  const initialization = new AbortController();

  function assertDirectory() {
    const actual = lstatSync(directory);
    if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== directoryStat.dev || actual.ino !== directoryStat.ino || realpathSync(directory) !== directory) throw bridgeError('BRIDGE_FILE_FAILED');
  }
  function filePath(filename) {
    if (basename(filename) !== filename || !/^(?:owner-policy|expected|ready|session-ready|native-web-ready|error)\.json$|^ack-[a-f0-9]{64}\.json$|^\.[a-z-]+-[a-f0-9-]{36}\.tmp$/.test(filename)) throw bridgeError('BRIDGE_FILE_FAILED');
    const file = resolve(directory, filename);
    if (dirname(file) !== directory) throw bridgeError('BRIDGE_FILE_FAILED');
    return file;
  }
  function readJson(filename, optional, maximumBytes) {
    assertDirectory();
    let fd;
    try {
      fd = openSync(filePath(filename), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > maximumBytes) throw bridgeError('BRIDGE_FILE_FAILED');
      return JSON.parse(readFileSync(fd, 'utf8'));
    } catch (error) {
      if (optional && error && error.code === 'ENOENT') return undefined;
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  function atomicJson(filename, value) {
    if (disposed) return;
    assertDirectory();
    const target = filePath(filename);
    try { if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) throw bridgeError('BRIDGE_FILE_FAILED'); }
    catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    const temporary = filePath('.bridge-' + randomUUID() + '.tmp');
    let renamed = false;
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); }
      finally { closeSync(fd); }
      assertDirectory();
      renameSync(temporary, target);
      renamed = true;
      if (process.platform !== 'win32') {
        const rootFd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
        try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
      }
    } finally {
      if (!renamed) {
        // Delete only the exact freshly created temporary entry under the verified owned directory.
        assertDirectory();
        if (dirname(resolve(temporary)) === directory) {
          try { if (lstatSync(temporary).isFile()) unlinkSync(temporary); }
          catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
        }
      }
    }
  }
  function removeOwnState(filename) {
    const value = readJson(filename, true, 8192);
    if (!record(value) || value.nonce !== nonce || value.sessionId !== sessionId) return;
    assertDirectory();
    const file = filePath(filename);
    if (dirname(resolve(file)) !== directory || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw bridgeError('BRIDGE_FILE_FAILED');
    unlinkSync(file);
  }
  function fail(code) {
    if (disposed || failed) return;
    failed = true;
    initialization.abort();
    try { removeOwnState('ready.json'); } catch { /* A replaced directory is never followed during cleanup. */ }
    try { atomicJson('error.json', { schemaVersion: 1, nonce, sessionId, code, message: ERROR_MESSAGES[code] }); }
    catch { /* The SDK startup gate also requires a fresh ready file. */ }
  }
  function failureCode(error, fallback) { return error && Object.hasOwn(ERROR_MESSAGES, error.code) ? error.code : fallback; }

  function readValidatedOwnerPolicy() {
    let policy;
    try { policy = readJson('owner-policy.json', false, 1024 * 1024); }
    catch { throw bridgeError('OWNER_POLICY_INVALID'); }
    if (!record(policy) || policy.schemaVersion !== 1 || !Number.isSafeInteger(policy.revision) || policy.revision < 0 || typeof policy.systemPrompt !== 'string' || policy.systemPrompt.length > 250000 || !Array.isArray(policy.agentTypes) || policy.agentTypes.length > 100) throw bridgeError('OWNER_POLICY_INVALID');
    return policy;
  }
  ctx.provide('eatingNativeAgentLabels', { read() {
    const labels = readValidatedOwnerPolicy().agentLabels;
    if (!record(labels) || Object.entries(labels).some(([id, label]) => !opaque(id) || !opaque(label))) throw bridgeError('OWNER_POLICY_INVALID');
    return { ...labels };
  } });
  function readExpected() {
    let expected;
    try { expected = readJson('expected.json', true, 8192); }
    catch { throw bridgeError('EXPECTED_DELIVERY_INVALID'); }
    if (expected === undefined) return undefined;
    if (!record(expected) || expected.schemaVersion !== 1 || expected.nonce !== nonce || expected.sessionId !== sessionId || !HEX.test(expected.batchId) || !HEX.test(expected.digest)) throw bridgeError('EXPECTED_DELIVERY_INVALID');
    return expected;
  }
  function sameExpected(left, right) {
    return left && right && left.nonce === right.nonce && left.sessionId === right.sessionId && left.batchId === right.batchId && left.digest === right.digest;
  }
  function identifyMessage(message, expected, restoring) {
    if (!record(message) || message.role !== 'user' || !record(message.source) || message.source.kind !== 'user' || !opaque(message.id) || !Array.isArray(message.content) || message.content.length === 0) return undefined;
    // The transport's entire user content must be JSON, never a JSON-looking fragment in QQ text.
    if (message.content.some((block) => !record(block) || block.type !== 'text' || typeof block.text !== 'string')) return undefined;
    let payload;
    try { payload = JSON.parse(message.content.map((block) => block.text).join('')); } catch { return undefined; }
    if (!record(payload) || !record(payload.eating) || !record(payload.context) || Object.keys(payload).some(key => !['eating', 'context', 'events'].includes(key)) || !Array.isArray(payload.events)) return undefined;
    const metadata = payload.eating;
    if (metadata.protocolVersion !== 1 || metadata.magic !== 'eating-harness-delivery' || !opaque(metadata.nonce) || metadata.sessionId !== sessionId || metadata.batchId !== expected.batchId || metadata.digest !== expected.digest || (!restoring && metadata.nonce !== nonce)) return undefined;
    const digest = createHash('sha256').update(JSON.stringify({ context: payload.context, events: payload.events })).digest('hex');
    return digest === expected.digest ? { messageId: message.id } : undefined;
  }
  function matchEvent(event, expected, restoring) {
    if (!record(event) || event.type !== 'agent/inbox/spliced' || !Number.isSafeInteger(event.seq) || event.seq < 0 || !record(event.data) || !Array.isArray(event.data.inserted)) return undefined;
    for (const message of event.data.inserted) {
      const found = identifyMessage(message, expected, restoring);
      if (found) return { ...found, eventSeq: event.seq };
    }
    return undefined;
  }
  function writeAck(expected, found) {
    if (disposed || failed || !sameExpected(expected, readExpected())) return;
    atomicJson('ack-' + expected.batchId + '.json', { schemaVersion: 1, nonce, batchId: expected.batchId, sessionId, messageId: found.messageId, eventSeq: found.eventSeq, digest: expected.digest });
    acknowledgedBatch = expected.batchId;
  }
  async function confirmSession(session) {
    await Promise.resolve();
    if (disposed || failed) return;
    try {
      if (await ctx.sessions.flush(session) !== true) throw bridgeError('DURABILITY_UNAVAILABLE');
      if (disposed || failed) return;
      atomicJson('session-ready.json', { schemaVersion: 1, nonce, sessionId });
    } catch (error) { fail(failureCode(error, 'DURABILITY_FAILED')); }
  }
  function onCreated(session) {
    if (disposed || failed || !session || session.id !== sessionId || sessionBarrier) return;
    sessionBarrier = confirmSession(session).finally(() => { sessionBarrier = undefined; });
  }
  function onEvent(session, event) {
    if (disposed || failed || !session || session.id !== sessionId || activeAck) return;
    let expected;
    let found;
    try {
      expected = readExpected();
      if (!expected || acknowledgedBatch === expected.batchId) return;
      found = matchEvent(event, expected, false);
    } catch (error) { fail(failureCode(error, 'BRIDGE_FILE_FAILED')); return; }
    if (!found) return;
    try { for (const message of event.data.inserted) acceptContext(message, expected); }
    catch (error) { fail(failureCode(error, 'OWNER_POLICY_INVALID')); return; }
    activeAck = (async () => {
      // Every other synchronous session/event observer gets to enqueue this append first.
      await Promise.resolve();
      if (disposed || failed) return;
      if (await ctx.sessions.flush(session) !== true) throw bridgeError('DURABILITY_UNAVAILABLE');
      if (!disposed && !failed) writeAck(expected, found);
    })().catch((error) => fail(failureCode(error, 'DURABILITY_FAILED'))).finally(() => { activeAck = undefined; });
  }
  function assertNoGlobalTools() {
    const schemas = ctx.tools.schemas();
    if (!Array.isArray(schemas) || schemas.length !== 0) throw bridgeError('UNEXPECTED_TOOLS');
  }
  async function inspectStoredSession() {
    const expected = readExpected();
    let handle;
    try { handle = await ctx.sessionPersistence.open(sessionId, 'read', { signal: initialization.signal }); }
    catch (error) {
      if (error && error.name === 'SessionPersistenceNotFoundError' && error.sessionId === sessionId) return { recovery: 'absent' };
      throw bridgeError('SESSION_RECOVERY_FAILED');
    }
    try {
      if (!handle || !handle.header || handle.header.id !== sessionId || handle.id !== sessionId || handle.access !== 'read' || typeof handle.read !== 'function' || typeof handle.close !== 'function') throw bridgeError('SESSION_RECOVERY_FAILED');
      let recovered;
      let offset = 0;
      for (;;) {
        if (disposed || failed) return { recovery: 'absent' };
        const slice = await handle.read(offset, 256, { signal: initialization.signal });
        if (!record(slice) || !Array.isArray(slice.events)) throw bridgeError('SESSION_RECOVERY_FAILED');
        for (const event of slice.events) {
          if (!Number.isSafeInteger(event.seq) || event.seq !== offset) throw bridgeError('SESSION_RECOVERY_FAILED');
          offset += 1;
          if (expected && !recovered) recovered = matchEvent(event, expected, true);
        }
        if (slice.events.length < 256) break;
      }
      if (!disposed && !failed) {
        atomicJson('session-ready.json', { schemaVersion: 1, nonce, sessionId });
        if (recovered && sameExpected(expected, readExpected())) {
          writeAck(expected, recovered);
          return { recovery: 'persisted', batchId: expected.batchId };
        }
      }
      return { recovery: 'absent' };
    } finally { await handle.close(); }
  }
  async function initialize() {
    if (typeof ctx.sessions.flush !== 'function' || typeof ctx.sessions.get !== 'function' || typeof ctx.sessionPersistence.open !== 'function' || typeof ctx.tools.schemas !== 'function') throw bridgeError('DURABILITY_UNAVAILABLE');
    if (typeof ctx.sessionPersistence.stat !== 'function' || typeof ctx.agents.get !== 'function' || typeof ctx.agentPresets.register !== 'function' || ['drainChildren', 'sendMessage', 'interrupt', 'startActivation'].some(name => typeof ctx.subagents[name] !== 'function')) throw bridgeError('NATIVE_AGENT_API_UNAVAILABLE');
    readValidatedOwnerPolicy();
    await registerAgentTypes();
    const liveSession = ctx.sessions.get(sessionId);
    if (liveSession) { onCreated(liveSession); await sessionBarrier; }
    if (disposed || failed) return;
    assertNoGlobalTools();
    const recovery = await inspectStoredSession();
    await ctx.get('loader')?.await();
    const nativeEntry = await ctx.eatingNativeWeb.entry();
    if (!record(nativeEntry) || nativeEntry.readOnly !== true || nativeEntry.rootSessionId !== sessionId || typeof nativeEntry.url !== 'string') throw bridgeError('BRIDGE_CONFIGURATION_INVALID');
    atomicJson('native-web-ready.json', { schemaVersion: 1, nonce, sessionId, url: nativeEntry.url, readOnly: true });
    if (disposed || failed) return;
    atomicJson('ready.json', { schemaVersion: 1, nonce, sessionId, toolsReady: true, durabilityAvailable: true, ...recovery });
  }
  function dispose() {
    if (disposed) return;
    initialization.abort();
    activeContext = undefined;
    taskConfigurations.clear();
    for (const release of releases.splice(0).reverse()) { try { release(); } catch { /* Cordis also owns these effects. */ } }
    for (const filename of ['ready.json', 'session-ready.json', 'native-web-ready.json']) { try { removeOwnState(filename); } catch { /* Do not follow a replaced directory. */ } }
    disposed = true;
  }

  ${getRuntimeAgentSource()}

  try {
    releases.push(ctx.on('agent/created', onAgentCreated));
    releases.push(ctx.on('session/event', onEvent));
    releases.push(ctx.on('session/created', onCreated));
    ctx.on('dispose', dispose);
    void initialize().catch((error) => fail(failureCode(error, 'SESSION_RECOVERY_FAILED')));
  } catch (error) { fail(failureCode(error, 'BRIDGE_CONFIGURATION_INVALID')); }
}
`;
}
