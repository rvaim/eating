/** The Web remains the official application; this bridge publishes only its private launch entry. */
export function getNativeWebRuntimeSource(): string {
  return String.raw`export const name = 'eating-native-web-entry';
export const inject = ['connection', 'webApp', 'webServer', 'clientModules', 'sessionController'];
export function apply(ctx) {
  const rootSessionId = process.env.EATING_DSH_SESSION_ID;
  const nonce = process.env.EATING_DSH_BRIDGE_NONCE;
  if (!rootSessionId || !nonce) throw new Error('Native Web runtime identity is missing');
  let disposed = false;
  ctx.provide('eatingNativeWeb', {
    async entry() {
      if (disposed) throw new Error('Native Web is stopped');
      const graph = ctx.clientModules.graph();
      if (!['@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-sidebar'].every(id => graph.entries.some(entry => entry.id === id))) throw new Error('Official native Web client roster is incomplete');
      const origin = ctx.webApp.getAdvertisedUrl();
      const url = new URL(origin);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('Native Web loopback listener is unavailable');
      return { url: ctx.connection.authenticatedUrl(origin), rootSessionId };
    },
  });
  ctx.on('dispose', () => { disposed = true; });
}
`
}
