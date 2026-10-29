import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const NATIVE_WEB_MODULES = [
  'dsh-storage', 'dsh-storage-json', 'dsh-storage-domain', 'dsh-workspace', 'dsh-commands',
  'dsh-session-reference', 'dsh-file-reference-local', 'dsh-agent-default-model', 'dsh-credentials-local',
  'dsh-typert-registry', 'dsh-typert-loader', 'dsh-api-remote-access', 'dsh-api-gateway',
  'dsh-client-connection', 'dsh-client-file-upload', 'dsh-api-session-controller',
  'dsh-api-workspace-controller', 'dsh-api-settings-controller', 'dsh-host-webserver', 'dsh-web-app',
  'dsh-client-modules', 'dsh-client-locale', 'dsh-client-shortcuts', 'dsh-client-ui-theme',
  'dsh-client-ui-layout', 'dsh-client-ui-renderer', 'dsh-client-ui-session', 'dsh-client-ui-settings',
  'dsh-client-ui-workspace', 'dsh-client-ui-sidebar', 'dsh-client-ui-sidebar-right', 'dsh-client-ui-input-trigger',
  'dsh-client-resources', 'dsh-client-ui-conversation', 'dsh-client-ui-chat', 'dsh-client-ui-tool',
  'dsh-host-directory-picker-browse', 'dsh-api-remotes', 'dsh-time-context',
] as const

/** Only these application commands cross the browser HTTP transport. */
export const NATIVE_WEB_HTTP_READS = [
  'session/list', 'session/page', 'session/projections', 'session/attachment',
] as const

export function nativeWebRows(modules: Readonly<Record<string, string>>, directory: string, nativeClient: string, configuration: { endpoint: string; model: string }): Readonly<Record<string, unknown>>[] {
  const row = (id: string, name: string, config?: unknown) => ({ id: `eating-web-${id}`, name: modules[name], ...(config === undefined ? {} : { config }) })
  const roster = NATIVE_WEB_MODULES.filter(name => name.startsWith('dsh-client-'))
  return [
    row('storage', 'dsh-storage'), row('storage-json', 'dsh-storage-json', { root: join(dirname(directory), 'dsh-home', 'storages') }),
    row('storage-domain', 'dsh-storage-domain', { backend: 'json' }), row('workspace', 'dsh-workspace'),
    row('commands', 'dsh-commands'), row('session-reference', 'dsh-session-reference'), row('file-reference', 'dsh-file-reference-local'),
    row('default-model', 'dsh-agent-default-model', { provider: 'eating-openai', model: configuration.model }),
    row('credentials', 'dsh-credentials-local'), row('typert', 'dsh-typert-registry'), row('typert-loader', 'dsh-typert-loader'),
    row('access', 'dsh-api-remote-access'), row('connection', 'dsh-client-connection'), row('file-upload', 'dsh-client-file-upload'),
    // This no-op host entry carries the exact installed official browser half; the read-only subclass owns the Host service.
    { id: 'eating-web-session-roster', name: join(directory, 'session-client', 'host.mjs') },
    { id: 'eating-web-session-controller', name: join(directory, 'native-web-session-controller.mjs') },
    row('workspace-controller', 'dsh-api-workspace-controller'), row('directory-picker', 'dsh-host-directory-picker-browse'), row('settings-controller', 'dsh-api-settings-controller'),
    row('webserver', 'dsh-host-webserver', { host: '127.0.0.1', port: 0 }),
    row('app', 'dsh-web-app', { printUrl: false, openBrowser: false, surfaceContext: false }),
    ...roster.filter(name => !['dsh-client-connection', 'dsh-client-file-upload'].includes(name)).map(name => row(name, name)),
    { id: 'eating-web-api-remotes', name: modules['dsh-api-remotes'] },
    { id: 'eating-web-policy', name: join(directory, 'native-web.mjs') },
    { id: 'eating-web-gateway-scope', name: 'cordis:group', group: true, isolate: { connection: 'eating-readonly-web' }, config: [
      { id: 'eating-web-reader-connection', name: join(directory, 'native-web-carrier.mjs') }, row('gateway', 'dsh-api-gateway'),
    ] },
    { id: 'eating-native-client', name: nativeClient },
  ]
}

/** Read only a built, declared plugin asset; never use the caller's working directory. */
export function assertNativeClient(path: string): void {
  const manifest: unknown = JSON.parse(readFileSync(join(dirname(path), 'package.json'), 'utf8'))
  if (!manifest || typeof manifest !== 'object' || !('name' in manifest) || manifest.name !== '@eating/dsh-native-web') throw new Error('Native Web client package is unavailable')
  readFileSync(path)
  readFileSync(join(dirname(path), 'client.js'))
}

/** Generated public-API composition; each installed runtime resolves its own same-version modules. */
export function nativeWebControllerSource(modules: Readonly<Record<string, string>>): string {
  return `import { SessionController } from ${JSON.stringify(pathToFileURL(modules['dsh-api-session-controller']!).href)};\n` + String.raw`
// Override the public follow verb: the upstream root follower promotes cold Sessions after its snapshot.
// Observation + the public page verb keep native records and projections without activating any Agent.
export default class EatingReadonlySessionController extends SessionController {
  async *follow(request, signal) {
    const address = request.address;
    const target = address.kind === 'session' ? address.sessionId : address.childSessionId;
    const queue = [];
    let wake;
    const notify = () => { const current = wake; wake = undefined; current?.(); };
    const release = this.ctx.on('session/event', (session, event) => { if (session.id === target) { queue.push(event); notify(); } }, { global: true });
    const abort = () => notify();
    signal.addEventListener('abort', abort, { once: true });
    let observation;
    try {
      signal.throwIfAborted();
      observation = await this.ctx.sessionQuery.observeSession(target, { signal, projectionMode: 'all' });
      const cursor = observation.cursor;
      // Official page validates the durable root/child address and preserves message-aligned cuts.
      const page = await super.page({ address, throughSeq: cursor, maxMessages: request.maxMessages, turnWindow: request.turnWindow }, signal);
      yield { type: 'snapshot', header: observation.header, cursor, records: page.records, hasMore: page.hasMore,
        projections: observation.projections ?? { asOfSeq: cursor, values: {} },
        ...(request.assistantStream === true ? { assistantStream: { revision: 0 } } : {}) };
      observation[Symbol.dispose](); observation = undefined;
      let nextSeq = cursor + 1;
      while (!signal.aborted) {
        const event = queue.shift();
        if (event === undefined) { await new Promise(resolve => { wake = resolve; if (signal.aborted || queue.length) notify(); }); continue; }
        if (event.seq < nextSeq) continue;
        if (event.seq !== nextSeq) throw new Error('Native read-only event continuity failed');
        nextSeq++;
        yield { type: 'event', event };
      }
    } finally { observation?.[Symbol.dispose](); release(); signal.removeEventListener('abort', abort); }
  }
}
`
}

export function nativeWebCarrierSource(): string {
  return `export const inject=['eatingReaderConnection'];\nexport function apply(ctx){ctx.provide('connection',ctx.eatingReaderConnection);}\n`
}
