import { NATIVE_WEB_HTTP_READS } from './native-web'

/** Runs only in the SDK-owned process. Browser identity never receives owner authority. */
export function getNativeWebRuntimeSource(): string {
  return String.raw`export const name = 'eating-readonly-native-web';
export const inject = ['connection', 'remoteAccess', 'sessionQuery', 'sessions', 'webApp', 'webServer', 'clientModules', 'sessionController'];
const HTTP_READS = new Set(` + JSON.stringify(NATIVE_WEB_HTTP_READS) + String.raw`);
export function apply(ctx) {
  const rootId = process.env.EATING_DSH_SESSION_ID;
  const nonce = process.env.EATING_DSH_BRIDGE_NONCE;
  if (!rootId || !nonce) throw new Error('Native Web runtime identity is missing');
  const owner = ctx.connection;
  const reader = owner.createPeer({ principal: { kind: 'eating-reader' }, interactions: 'answer' });
  const headers = new Map();
  let disposed = false;
  const globalActions = ['session/list', 'session/control', 'session/projections', 'session/attachment', 'workspace/follow'];
  const sessionActions = ['session/list', 'session/control', 'session/page', 'session/follow', 'session/projections', 'session/attachment',
    'event:api-session/added', 'event:api-session/removed', 'event:api-session/activity', 'event:api-session/status', 'event:api-session/error', 'workspace/follow'];
  function member(id) {
    if (id === rootId) return true;
    const visited = new Set();
    while (typeof id === 'string' && !visited.has(id)) {
      visited.add(id);
      const header = headers.get(id);
      if (!header || header.origin !== 'subagent' || typeof header.parentSession !== 'string') return false;
      if (header.parentSession === rootId) return true;
      id = header.parentSession;
    }
    return false;
  }
  function condition({ action, args }) {
    if (args === undefined) return { kind: 'allow' };
    if (['session/list', 'session/control', 'workspace/follow'].includes(action)) return { kind: 'allow' };
    const request = args.request;
    if (!request || typeof request !== 'object' || Array.isArray(request)) return { kind: 'deny', reason: 'invalid-read-address' };
    const address = request.address;
    const target = address ? address.kind === 'session' ? address.sessionId : address.childSessionId : request.sessionId;
    if (!member(target)) return { kind: 'deny', reason: 'outside-eating-tree' };
    if (address?.kind === 'session' && target !== rootId) return { kind: 'deny', reason: 'child-requires-parent-address' };
    if (address?.kind === 'subagent' && (!member(address.parentSessionId) || headers.get(target)?.parentSession !== address.parentSessionId)) return { kind: 'deny', reason: 'invalid-child-parent' };
    return { kind: 'allow' };
  }
  const changed = header => {
    headers.set(header.id, header);
    ctx.remoteAccess.invalidate(reader.principal);
  };
  ctx.on('session/created', session => changed(session.header));
  const seeded = ctx.sessionQuery.listSessions().then(rows => { for (const row of rows) changed(row.header); });
  ctx.remoteAccess.registerPolicy('eating-reader', { bindings() {
    return [
      { role: { name: 'Eating read-only Web', resource: 'global', actions: globalActions }, resource: { kind: 'global' }, condition },
      ...[rootId, ...headers.keys()].filter((id, index, all) => all.indexOf(id) === index && member(id)).map(id => ({
        role: { name: 'Eating native session reader', resource: 'session', actions: sessionActions }, resource: { kind: 'session', id }, condition,
      })),
    ];
  } });
  // Gateway alone reads this carrier through Cordis isolation. The SDK and native login exchange retain their own channels.
  ctx.provide('eatingReaderConnection', {
    get browserPeer() { return reader; },
    get rpc() { return { handle: (channel, handler) => owner.rpc.handle(channel, handler),
      intercept: (channel, matches, handler) => owner.rpc.intercept(channel, matches, (endpoint, payload, signal) => handler(endpoint, payload, signal, reader)) }; },
    admitConnection(request) {
      const admitted = owner.admitConnection(request);
      return 'rejection' in admitted ? admitted : { peer: reader, release: admitted.release };
    },
  });
  // Exact Fetch routes bypass Gateway, so refuse every raw upload, media path, file read and non-read HTTP route here.
  ctx.on('connection/request', (request, response, next) => {
    let endpoint;
    try { const url = new URL(request.url, 'http://127.0.0.1'); endpoint = url.pathname.startsWith('/api/') ? url.pathname.slice(5) : undefined; }
    catch { endpoint = undefined; }
    if (request.method !== 'POST' || !HTTP_READS.has(endpoint)) { response.writeHead(403, { 'cache-control': 'no-store' }); response.end('Eating native Web is read-only'); return; }
    return next();
  }, { prepend: true });
  ctx.on('webserver/index-inject', table => {
    // Official LocaleBridge bootstrap is page-local and never writes a Host setting.
    table.unshift({ kind: 'script', placement: 'head', text: "globalThis.__DSH_LOCALE__={read:async()=>({languages:['zh-CN'],preference:'zh'}),onChange(){}};" });
    // The official BrowserAuth login still owns the cookie; this replaces only the displayed access snapshot.
    for (let index = table.length - 1; index >= 0; index--) if (table[index].kind === 'global' && table[index].name === '__DSH_REMOTE_ACCESS__') table.splice(index, 1);
    table.push({ kind: 'global', name: '__DSH_REMOTE_ACCESS__', value: ctx.remoteAccess.snapshotFor(reader.principal) });
    table.push({ kind: 'global', name: '__EATING_NATIVE_WEB__', value: { rootSessionId: rootId, readOnly: true, agentLabels: Object.fromEntries(Object.entries(ctx.get('eatingNativeAgentLabels').read()).filter(([id]) => member(id))) } });
  });
  ctx.provide('eatingNativeWeb', {
    async entry() {
      await seeded;
      if (disposed) throw new Error('Native Web is stopped');
      const graph = ctx.clientModules.graph();
      if (!['@eating/dsh-native-web', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-api-session-controller'].every(id => graph.entries.some(entry => entry.id === id))) throw new Error('Native Web client roster is incomplete');
      const origin = ctx.webApp.getAdvertisedUrl();
      const url = new URL(origin);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('Native Web loopback listener is unavailable');
      return { url: owner.authenticatedUrl(origin), rootSessionId: rootId, readOnly: true };
    },
  });
  ctx.on('dispose', () => { disposed = true; });
}
`
}
