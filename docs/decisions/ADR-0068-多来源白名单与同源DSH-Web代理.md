# ADR-0068：多来源白名单与同源 DSH Web 代理

状态：Accepted。日期：2026-11-18，Asia/Shanghai。依据：主人要求在保留 `Host` / `Origin` 安全校验的前提下，同时支持公网与虚拟局域网（如 Tailscale IP、MagicDNS 域名、IPv6）等多地址直接访问 Eating，并使从局域网入口打开的官方 DSH Web 也走对应的局域网同源地址。

## 问题根因

1. **多访问地址被拒（`403 INVALID_HOST`）**：`EatingHost` 的 `validateLocalRequest`（[security.ts](../../apps/host/src/security.ts)）原本就以 `Set` 存储多个允许的 `allowedHosts` 与 `allowedOrigins`，但 [server-access.ts](../../apps/host/src/server-access.ts) 与 [server-service.mjs](../../scripts/server-service.mjs) 仅支持单个 `EATING_PUBLIC_ORIGIN`，导致除公网主来源与回环端口外的虚拟局域网 Host/Origin 全部被拒。直接移除 `validateLocalRequest` 会暴露 DNS 重绑定与跨站请求风险，不可接受。
2. **官方 DSH Web 固定返回 `127.0.0.1`**：在依赖 `@deepseek-ai/dsh-host-webserver` 源码中，`WebServer.Config` 明确拒绝 `0.0.0.0` 通配绑定；且 Eating 在 [native-web.ts](../../plugins/harness/dsh/src/backend/native-web.ts) 仅将其绑定在 `127.0.0.1:0`。远程浏览器通过公网或 Tailscale 访问 Eating 时，点击“打开 DSH Web”拿到 `http://127.0.0.1:<port>/?token=...` 无法连通服务器。同时查看 `@deepseek-ai/dsh-host-frontend-static`、`@deepseek-ai/dsh-client-connection` 与 `@deepseek-ai/dsh-api-gateway` 可知，DSH 前端本身已使用 `<base href="./">`、`api/...`、`plugins/...` 与 `./` 相对路由以支持子路径代理；若仅将上游转发而未在 Host 层改写 `Host`/`Origin`、作用域 Cookie 与拦截 `/api/` 绝对基路径，也会被 DSH 的 `isTrustedApiRequest` 拒绝或泄露 Eating 凭据。

## 决策

1. **保留全部安全校验并扩展显式多 Origin 白名单**：
   - `ServerAccessOptions`、`parseServerAccess` 与 `validateServerAccess` 新增可选 `extraOrigins` / 环境变量 `EATING_EXTRA_ORIGINS`（逗号分隔）；[server-service.mjs](../../scripts/server-service.mjs) 新增可选数组 `extraOrigins`。
   - 每个额外 Origin 复用 `parseCanonicalOrigin` 做与 `EATING_PUBLIC_ORIGIN` 完全相同的规范 HTTP(S) Origin 校验，禁止同一 `host` 同时混用 HTTP 与 HTTPS。
   - 按 `httpsHosts` 记录每台主机是否属于 HTTPS Origin，`EatingOwnerAccess`、`EatingOwnerSession` 与代理响应 Cookie 按请求命中的主机决定是否附加 `Secure`。
2. **新增经主人鉴权的同源 DSH Web HTTP/WebSocket 反向代理（`/dsh-web/`）**：
   - `dsh-host-webserver` 仍严格只监听 `127.0.0.1` 随机端口，不直接对外暴露新端口。
   - 当浏览器通过任意已放行的来源请求 `POST /api/plugins/dsh/manage` 的 `open-native-web` 时，[app.ts](../../apps/host/src/app.ts) 与 [dsh-web-proxy.ts](../../apps/host/src/dsh-web-proxy.ts) 校验内部回环地址后，按当前已通过 `validateLocalRequest` 的请求 `Host` 与协议改写返回 `${scheme}//${host}/dsh-web/?token=...`。
   - `/dsh-web/` 的 HTTP 与 WebSocket `upgrade` 均先通过 `validateLocalRequest` 与 `EatingOwnerAccess` 入口 Cookie 校验，再将上游 `Host` 与（若存在）`Origin` 改写为 DSH 真实回环来源、剥离 `EatingOwnerAccess`/`EatingOwnerSession` 防止主机凭据外泄、并将 DSH 返回的 `Set-Cookie` 收窄至 `Path=/dsh-web/`（HTTPS 下补充 `Secure`）。
   - `dsh` 断开、停用、卸载或 Host 关闭时立即清空 `dshWebOrigin` 并销毁活动代理连接。
   - DSH 插件前端（`0.23.2`）[panel-data.ts](../../plugins/harness/dsh/src/web/panel-data.ts) 的 `readNativeWebLaunch` 同时接收回环官方地址与当前同源 `/dsh-web/` 代理地址，仍严格拒绝跨源、非代理路径或异常协议。
   - [vite.config.ts](../../apps/web/vite.config.ts) 同步补充 `/dsh-web`（含 `ws: true`）开发代理。

## 边界与影响

- 应用／Host／Web 升至 `0.27.2`，DSH 插件按封存包升级规则升至 `0.23.2`，其余 7 个插件、`plugin-sdk`、`plugin-core`、`ui-sdk` 与 `pnpm-lock.yaml` 保持不变。
- 本决策补充并更新 ADR-0018 与 ADR-0043 中“公网下 DSH Web 不增加主机同源代理”的原先范围，同时保留 DSH 本身仅回环监听与不改动系统 DSH 安装文件的安全原则；历史 ADR 与报告不改写。
