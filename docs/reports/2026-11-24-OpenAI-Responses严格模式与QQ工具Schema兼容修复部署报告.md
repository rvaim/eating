# 2026-11-24 OpenAI Responses 严格模式与 QQ 工具 Schema 兼容修复部署报告

## 1. 背景与根因结论

切换 DSH 至 `openai-responses` 协议调用 OpenAI 模型时，`qq.private` 与 `qq.group` 子代理返回 HTTP 400 `invalid_json_schema`（`Unimplemented keys: ["not"]. Compilation limits apply to all strict schemas in the request`），而主 Agent 本身未报错。经排查 Eating 源码与 DSH 底层依赖 `@earendil-works/pi-ai` 源码，确认两层根因：

1. **依赖 `@earendil-works/pi-ai` 对自定义 `openai-responses` 模型省略 `strict: false`**：
   - `@earendil-works/pi-ai/dist/api/openai-responses.js:68` 将未显式声明 `compat.supportsStrictMode` 的模型默认解析为 `false`（而同库 `azure-openai-responses.js`、`openai-codex-responses.js`、`openai-responses-shared.js` 均默认 `true`，内置 `providers/data/openai.json` 也为内置模型显式配置了 `"compat":{"supportsStrictMode":true}`）。
   - `openai-responses-shared.js:291-303` 仅在 `supportsStrictMode === true` 时才写入 `functionTool.strict = false`；默认 `false` 时直接省略 `strict` 字段。
   - OpenAI Responses API（`/v1/responses`）服务端对省略 `strict` 的 function tool 默认按 `strict: true` 严格模式编译，进而触发所有工具 schema 的严格校验。
2. **QQ 发送及快捷操作工具对外 `inputSchema` 含 `not` 等高阶组合子**：
   - `plugins/communication/qq/src/backend/operations.ts` 中 `qq_send_private_message`、`qq_send_group_message`、`qq_send_message` 的 `inputSchema` 含 JSON Schema `"not"` 及顶层 `oneOf`/`allOf`，`qq_handle_quick_operation` 含 `oneOf`/`allOf`/`if`/`then`，在 OpenAI Responses 严格模式或不支持 `not` 的第三方网关／模型上会直接报错。

## 2. 根因修复内容

- **运行源码提交**：`bbb4988`（文档收口提交不改动运行代码）。
- **版本变化**：`dsh 0.29.2 -> 0.29.3`，`qq 0.22.1 -> 0.22.2`；应用／Host／Web `0.30.1`、`@eating/plugin-sdk 4.18.0`、其余 6 个插件（`stickers 0.4.4`、`image-generation 0.8.2`、`openviking-memory 0.4.4`、`text-to-speech 0.3.5`、`speech-to-text 0.2.4`、`android-control 0.3.5`）及 `pnpm-lock.yaml` 保持不变。
- **关键改动**：
  1. `plugins/harness/dsh/src/backend/adapter.ts`：`createRuntimePatch` 在 `protocol === 'openai-responses'` 时向 `llm-pi-ai` provider 配置显式传入 `compat: { supportsStrictMode: true }`（与 `@deepseek-ai/dsh-llm-pi-ai` 的 `RESPONSES_COMPAT_GATE` 及 `pi-ai` 内置 OpenAI Responses 模型对齐），使 `pi-ai` 对非严格工具显式下发 `"strict": false`（不影响 `openai-completions` 与 `google-generative-ai`）。
  2. `plugins/communication/qq/src/tool-constraints.ts`、`plugins/communication/qq/src/backend/operations.ts`、`plugins/communication/qq/src/web/tool-fields.ts`：将 6 个 QQ 工具的跨字段 JSON Schema 约束抽离到共享模块 `tool-constraints.ts`；对外暴露给 MCP / LLM 的 `inputSchema` 不再包含 `not`/`if`/`then`/`else` 及顶层 `oneOf`/`allOf`/`anyOf`，而后端 `validateToolInput` 与前端 `parseToolArguments` 继续通过 `toolValidationSchema()` 100% 强制校验全部跨字段规则。
  3. 补充单元与真实系统 DSH 端到端测试：`adapter.test.ts`、`operations.test.ts` 以及 `apps/host/src/dsh-integration.test.ts` 中新增真实系统 DSH 走 `openai-responses` 协议主子协作回环测试，直接校验线上真实发往 `/v1/responses` 的请求体均携带 `strict: false` 且无非法组合子。

## 3. 验证结果

### 本地验证
- `pnpm run typecheck && pnpm run build`：通过，`pnpm-lock.yaml` SHA-256 保持不变。
- 专项及真实系统 DSH Vitest：
  - `operations.test.ts`（60/60）、`audio-reference.test.ts`（4/4）、`outgoing-message.test.ts`（26/26）、`tool-fields.test.ts`（7/7）、`i18n.test.ts`（5/5）、`adapter.test.ts`（40/40）、`mcp.test.ts`（31/31）、`dsh-integration.test.ts`（3/3，含真实系统 DSH 走 `openai-responses` 协议主子协作端到端验证）全部通过（8 文件 176/176）。
- 离线检查 `tests/server-speech-reset-checks.mjs`：15/15 通过。

### 云端 Linux 构建与保留数据上线验证
- 云端从 GitHub 检出 `bbb4988` 并运行 `scripts/server-build.mjs` 控制层全量回归与 `tsc --noEmit`：通过。
- 封存校验：`sameVersionIntegrityMismatches: []`（仅 `dsh` `0.29.2 -> 0.29.3` 与 `qq` `0.22.1 -> 0.22.2` 变更，其余 6 插件产物哈希完全一致）。
- 云端真实系统 DSH 专项 Vitest（含 `dsh-integration.test.ts`、`operations.test.ts`、`tool-fields.test.ts` 等）：301/301 通过（0 失败）。
- 停服前确认队列 0、无运行中任务；完成 802 份数据文件双向 SHA-256 私有备份核对并切换上线。
- 上线只读复核：
  - `sourceCommit = bbb4988`，`applicationVersion = 0.30.1`，`serviceActive = true`，`serviceEnabled = true`，`NRestarts = 0`。
  - 7 个已启用插件全部 `connected`（`dsh@0.29.3`、`qq@0.22.2`），`android-control@0.3.5` 保持 `disconnected`；`dshReady = true`，`nativeWebReady = true`，`queueMessages = 0`。
  - 线上 `bridge/runtime.patch.yaml` 已生效 `"compat":{"supportsStrictMode":true}` 与 `"timeoutMs":60000`／`"streamIdleTimeoutMs":60000`；线上全部 QQ 工具 `inputSchema` 校验 `qqSchemasClean = true`。
  - 290 份受保护文件、SQLite 表结构与既有数据行、3 份原生会话日志前缀、会话与子代理绑定身份及自主运行配置完整保留（未执行线上真人发送或付费模型试调）。
