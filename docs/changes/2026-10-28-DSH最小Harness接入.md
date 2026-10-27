# 2026-10-28 DSH 最小 Harness 接入

更新：2026-10-28，Asia/Shanghai。最小 DSH 已完成构建/严格检查、Vitest 24 文件 541/541、Playwright 23/23、两项官方 SDK 源码/安装产物集成及实际部署。QQ 0.5.0 connected，DSH 0.1.0 已启用、专属运行时已预装，但模型配置为空、未启动；真实提供商认证未验证。

## 修改原因与范围

负责人要求先提交旧代码、完成提示词/人格并再次提交，然后才实施最小 DSH，让同一主 Agent 自主处理 QQ 消息并决定工具回复。顺序已完成：`fea2f7a` → `93a3d51` → 本阶段实现。Eating 不建立第二套 Agent Loop，不转发 `finalResponse` 冒充模型工具发送，不借用用户主 DSH、Profile、凭据或当前 GUI。

Host/Web/根应用为 `0.5.0`，plugin-sdk/ui-sdk `1.4.0`，QQ `0.5.0`，新增[DSH 独立包](../../plugins/harness/dsh/) `0.1.0`，apiVersion 仍 1。通用插件契约区分 communication/harness，按安装产物注册后台与界面；数据分别进 `bot`/`harness`，跨 kind 升级拒绝隐式迁移。本阶段未另行提交、未推送，前两个提交授权不扩展为自动第三次提交。

## 页面与使用

新增全局“Harness”，二级“DeepSeek Harness”提供配置与运行状态；机器人分类仅列通讯插件。首版没有原生 SDK Web 会话页或聊天历史页。

1. QQ 已连接，允许向 Harness 转发；群消息还需允许接收群聊。
2. 保存 OpenAI-compatible API 基础地址、精确模型名称和独立 API Key；Key 只写入不回显，留空保留，勾选并保存才清除。可配置超时、最大输出 token 与 Host 自动启动。
3. 当前实例运行时已预装，可跳过；新安装时点击“安装运行时”，等待后台状态完成，异步 started 不等于安装成功，首次下载可能需 1–3 分钟。
4. 点击“启动 Harness”，核对工具/持久能力就绪、固定主会话、忙闲和最近结果。保存配置先停止旧运行时；启动不等于模型服务商认证成功。

真实提供商尚未配置，须主人自行填写生产地址、模型和 Key；不自动发测试消息给真人。

## 主人策略与模型行动

[适配器](../../plugins/harness/dsh/src/backend/adapter.ts)使用官方 SDK 的 `sdk-minimal`、最小 patch 和可信只读主人策略桥。当前主提示词与启用人格组合为 system，群/私聊模板及逐条来源批次只作为 external user 数据。下一批次读取最新 owner 配置；修改主策略或切换人格不更换固定 session ID。模板变量和替换继续共用 Eating SDK，不 eval、不递归解释外部值。

模型工具目录实测只有 9 项 `mcp__qq__…`。原生文件、Shell、资源、安装和固定人格写入不开放给模型；安装运行时走 owner session/CSRF 的管理入口。模型可选择不回复；需要回复时自行调用 QQ MCP，Host 不将普通文本或 `finalResponse` 自动转发。

QQ 0.5.0 补充可选规范化 messageId/targetId；自身发送回声不转投 Harness，避免自触发循环。既有 QQ 账号、外发防重复账本、按需日志和无历史队列规则保持。

## 持久交接与恢复

ready 只校验 QQ 工具和公开持久化能力。桥必须等待 `sessions.flush(session) === true`，再 fsync/原子发布绑定 nonce、session、batch、digest 的 ACK，Host 才确认 durable 并删除队列正文。SDK 入箱/排队事件不代替持久屏障；交接完成仍不等于模型已执行工具或任务完成。

首次创建空会话也经 session-ready sentinel 的持久屏障后才写 created。启动使用公开 sessionPersistence 扫描既存输入，恢复 flush 后、ACK 前窗口，只重签新 nonce，不重新 prompt。缺少可靠凭据时保留结果未知，不自动重放；SDK 无调用方幂等保证，不能宣称 exactly-once。

模型忙时 `isReady=false`，Gateway 暂停新投递、不消耗重试，已有本地 pending finalization 优先完成。stop/reconnect 仍恢复同一会话，不额外发 prompt/send。桥文件仅主人策略和交接元数据，不复制批次正文；当前 ACK 为重启恢复保留，下一批清理旧 ACK，保持有界且不建后台日志。DSH 原生 JSONL 是所选 Harness 上下文，Eating 不额外复制聊天历史。

## 运行时安装与边界

SDK 精确固定 npm 官方 rc.4 版本，运行时、provider、MCP 三包同版，精确值以[插件清单](../../plugins/harness/dsh/package.json)和[安装器](../../plugins/harness/dsh/src/backend/runtime.ts)为准。实际新安装依赖的 pi-ai 为 1.4.0，来自上游 ^1.1 范围；不沿用旧源码研究仓库 lock 中 1.3 版本的补丁假设。

插件数据根为 `EATING_HOME/harness/dsh`，配置文件 0600、目录 0700；DSH_HOME、DSH_AGENTS_HOME 分别指向专属 `dsh-home`/`agents-home`，另有 `workspace` 和 `runtime-home`。SDK 环境只传白名单与独立模型 Key、获授 QQ MCP 凭据，不继承主 DSH/Profile/既有 Key。

运行时装到 `runtime/versions/install-<UUID>`，校验依赖、三包精确版本和 lockfile 后原子切换 `current.json`；失败不覆盖旧指针。依赖安装 ignore-scripts，子进程 shell=false，保留 lockfile。安装上限 10 分钟，取消终止子进程，只有 ESRCH 证明旧进程不存在才回收 stale lock。

Host 只向 Harness entry 提供只读主人配置、已批准通讯 MCP 私有连接、唯一 sink 注册及 wake；communication 无此 secret 读取入口。停用先持久化 disabled 并撤销权限，再执行 disconnect；即使失败也不重新注册旧入口。stop/close 同样撤销 sink。以上是能力与数据边界，不是完整 OS 沙箱，也不承诺恶意代码无法绕过进程权限。

## 当前验证

完整构建、严格 TypeScript、Vitest **24 文件 541/541**（31.55 秒）、Playwright **23/23**（10.9 秒）全部通过。浏览器包含新增 Harness 4 项和原 19 项；Host 定向 146（API 23/Gateway 57/安装 66）、DSH 配置/适配 35、桥/运行时 24、前端目录/校验两文件 10 的分项检查也通过，含 ACK 有界清理和停用失败撤权限保护。

实际 5180 的 Harness/DSH 页面桌面 1440×1659、移动 390×2318 两张截图已逐一读取，pageerror=0、无横向溢出。新鲜独立限定只读 UI 复核给出 SHIP、material=0，无需重采；其范围限于界面，不声称该审阅重跑了 541 项或 23 项自动测试。

[官方 SDK 集成](../../apps/host/src/dsh-integration.test.ts)两项均已实跑：源码组合链用实际官方运行时驱动本地模型 SSE 与真实 QQ MCP，在 OneBot 夹具上各发私聊/群聊一次，沉默分支不发；验证持久 ACK 删除正文、system/user 隔离、仅 QQ 工具、下一请求更新人格/策略及固定 session 恢复。安装产物链约 28.5 秒通过，将专属 runtime 物理复制到测试 home、删除临时安装源，以正式构建 entry 运行并整 Host 重启，恢复同一 session，不依赖源码 import 或注入 runtime 替身。

本轮完整命令从仓库根执行，运行时目录须已独立安装：

```bash
pnpm build
pnpm typecheck
EATING_DSH_TEST_RUNTIME=.impeccable/runtime-cache/dsh pnpm test
pnpm test:e2e
```

不设置 `EATING_DSH_TEST_RUNTIME` 时默认跳过两项真实 SDK 集成，不能写成上述 541 项完整实跑。真实模型服务商认证和生产推理费用链路未验证；自动测试只用本地模型协议和 OneBot 夹具，不向真人发送消息、不借用主 DSH。

实际部署已完成，当前开发 job `bash-7b27e976826d465e`，旧阶段二 job 已关闭。安装 QQ 0.5.0 和 DSH 0.1.0 成功；将已通过实际 npm 安装验证的运行时依赖图复制到此前不存在的 `EATING_HOME/harness/dsh/runtime`，不覆盖任何用户数据，resolve 核验各入口均位于专属目录。QQ enabled/connected；DSH enabled/unconfigured，runtime installed=true、installing=false、ready=false、busy=false、session=null、lastError=null，Harness not-attached。

本次只由主人管理入口启用插件目录，不填写提供商/Key、不启动模型，不消费原 3 条 pending 或向真人发消息。QQ 配置、账号索引、队列正文和外发账本四摘要与升级前逐项一致，双方日志查看者为 0。主人保存地址/模型/独立 Key 后点击“启动 Harness”即可，已预装可跳安装。部署、界面和验证证据见[本轮报告](../reports/2026-10-28-DSH最小Harness验证报告.md)。

## 影响与后续

停止/停用保留 owner 配置和 DSH 原生会话，Host 队列仍遵守可靠交接删除规则。升级需完整构建并在 Host 停止后安装新 QQ/DSH 产物，不能以源码扫描或静态捆绑替代；版本与跨 kind 校验失败保留旧激活。数据删除另需授权，代码回退不保证运行时/原生会话格式向后兼容。

阶段二报告仍保留当时 456/19 与 `93a3d51` 的范围，不改写旧报告。最小 DSH 已实现不代表其他 Harness、跨 Harness 无损迁移、长期记忆或 OS 隔离已实现。当前本阶段不自动提交/推送；状态与续接见[项目状态](../项目状态.md)、[开发交接](../开发交接.md)和[开发规则](../../AGENTS.md)。
