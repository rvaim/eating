# ADR-0066：插件体系 UI 与交互体验重构

日期：2026-11-17。状态：Accepted，本地实现及Git发布完成，2026-11-17追加授权后已云端部署；不改变现有配置／存储 schema、权限边界、原生 DSH Web 界面及真机／付费外部行为契约。

## 用户确认与范围

前序走查确认插件与宿主管理界面存在五类交互痛点：生命周期控制割裂（列表、页尾、面板内开关多头并存且提示折返）、核心开关与配置过度折叠、条件显隐与全局通知导致突发布局跳变（Reflow）、多套独立保存与裸 JSON/换行输入人体工学薄弱、以及列表与工作流（实时日志、记忆浏览、生图续编辑、任务播放器）缺少闭环。

主人批准实施计划，并明确采用以下方案边界：
- 仅在前端架构、共享 `@eating/ui-sdk`、宿主界面及 8 个内置插件面板内重塑交互，**补齐 TTS／STT 零计费 `test-connection` 只读鉴权探测操作**，不引入旧版兼容分支（遵守 [ADR-0015](ADR-0015-默认不兼容旧版.md)）。
- 严格遵守白绿／暗色语义令牌制度与单滚动视口框架，保持原生 DSH Web 完全原样（[ADR-0017](ADR-0017-原样接入DSH原生Web.md)、[ADR-0018](ADR-0018-系统DSH原生Web与看板移除.md)），不修改 `.impeccable/design.json` 或新增任何外部 npm 依赖。
- 本轮已授权本地开发、验证并 `commit`／`push` 至 GitHub，**不部署到云服务器或操作真实服务／设备**。

## 核心决策

### 1. 共享组件契约与跨端无障碍（`@eating/ui-sdk` `4.4.0`）
- 扩展 [`PluginPanelProps`](../../packages/ui-sdk/src/contract.ts)，新增标准化运行时控制回调与脏稿信号：`status`、`connectionBusy`、`onToggleEnabled`、`onConnect`、`onDisconnect`、`onDirtyChange`。
- 新增并导出共享通用控件：
  - [`PluginLifecycleBar`](../../packages/ui-sdk/src/lifecycle-bar.tsx)：插件详情顶部唯一权威生命周期控制条，统一呈现图标、名称／版本、启用开关（`<Switch>`）、运行连接态胶囊、连接／停止／重读主动作以及“更多”溢出菜单（更新路径指引与原位确认卸载）。彻底移除页面底部 `plugins-panel-footer` 与 `plugin-information` 停用区。
  - [`Switch`](../../packages/ui-sdk/src/switch.tsx)、[`PasswordInput`](../../packages/ui-sdk/src/password-input.tsx)（仅支持本地未保存新值显隐及行内待确认清除开关，绝不回显已保存密钥）、[`DurationInput`](../../packages/ui-sdk/src/duration-input.tsx)（UI 层可读秒输入与快捷预设，接口层读写精确毫秒 `ms` 且不改变存储 schema）。
  - 结构化编辑器 [`TagChipsInput`](../../packages/ui-sdk/src/structured-inputs.tsx)、[`KeyValuePairsEditor`](../../packages/ui-sdk/src/structured-inputs.tsx) 与 [`StringListEditor`](../../packages/ui-sdk/src/structured-inputs.tsx)：支持回车／批量粘贴拆分、单条目校验和一键切换“JSON／原始文本模式”。
  - [`SegmentedTabs`](../../packages/ui-sdk/src/segmented-tabs.tsx)（吸顶兼容、键盘方向键导航、脏稿圆点提示、窄屏平滑横滑）、[`InlineConfirm`](../../packages/ui-sdk/src/confirm-inline.tsx)、[`FormSaveBar`](../../packages/ui-sdk/src/confirm-inline.tsx) 与 [`UnknownOutcomeCard`](../../packages/ui-sdk/src/confirm-inline.tsx)（统一展示幂等 `request_id` 复制与“已核实”收起操作）。
- [`ActionButton`](../../packages/ui-sdk/src/action-button.tsx) 补充触屏 `pointerType === 'touch'` 点击交互，通过顶层 `popover="manual"` 原位解释禁用原因，再次轻点、外部点击或按 `Escape` 收起；页签统一迁移至 `SegmentedTabs`。

### 2. 宿主壳层与多入口收敛（应用／Host／Web `0.27.0`）
- 修复 [`workspace.ts`](../../apps/web/src/state/workspace.ts) 的 `hasConfiguration` 就绪判断逻辑，停止仅凭 `endpoint` 字符串推断配置状态；新增统一 `toggleEnabled`、`connect`、`disconnect` 与单插件并发锁 `busyPluginId`。
- [`App.tsx`](../../apps/web/src/App.tsx) 增加切换左侧全局／二级导航及关闭面板前的未保存草稿拦截提示条（`host-dirty-guard`），防止切页悄无声息丢失编辑；切换路由与清除脏稿时自动收起。
- [`Overview.tsx`](../../apps/web/src/pages/Overview.tsx) 补充已启用关键能力插件（生图、记忆、语音、玩手机等）状态摘要与快捷跳转；[`Plugins.tsx`](../../apps/web/src/pages/Plugins.tsx) 增加关键词搜索、状态筛选（`全部 / 已连接 / 待配置 / 已停用`）并收敛为单一“打开设置”入口，与 `#robots`/`#harness` 共用顶部 `PluginLifecycleBar`；[`PluginCatalog.tsx`](../../apps/web/src/components/PluginCatalog.tsx) 正名为“快速启用已安装插件”并提供跳转插件中心入口。
- [`styles.css`](../../apps/web/src/styles.css) 同步扩展浅色与 `@media (prefers-color-scheme: dark)` 语义色彩令牌至各 69 个（新增 `--color-info-*`、`--color-success-*`、`--color-switch-*`、`--color-chip-*`、`--color-backdrop`），组件及插件 CSS 保持零硬编码颜色字面量。

### 3. 页面隐藏（`visibilitychange`）与离开（`pagehide`）状态保护策略
- 区分“敏感凭据／服务端临时预览”与“用户非秘钥编辑草稿”：
  - `document.hidden`（切标签页或失焦隐藏）保持立即中止活动轮询／读取请求、清空正在输入但尚未保存的 `apiKey`／`token`／手动 MCP 凭据（并给出显式局部清理提示），并销毁临时下载的图片预览／缩略图 `Blob URL` 与授权历史图片编辑引用；
  - 用户正在填写的普通表单字段、尚未上传提交的本地图片／音频／Android 上传文件引用、DSH 已拉取模型列表与 Android 终端输出在切屏隐藏时**不再误清空**；仅在页面关闭或路由卸载（`pagehide`／unmount）时彻底清除本地上传句柄与全部 `Blob URL`。

### 4. 八插件交互重塑、零跳变与端到端闭环
- **QQ `0.19.0`**：页签切换为 `SegmentedTabs`；主机／群配置使用 `TagChipsInput` 与 40+ 工具搜索及分类筛选；媒体／音频传输配置采用独立卡片与保存锁（`mediaSaving`／`audioSaving` 不相互阻塞写入），切换至 `auto` 时保留本地目录草稿但收起输入并提交清理；手动 MCP 连接凭据改为弹层卡片（不顶飞下方 41 项能力列表，隐藏即销）；工具测试支持可视化 `message` 段构建器、一键切换 JSON 及历史回填；**`LiveLogs` 严守隐藏／离页即清与零落盘契约**，重构为高信噪比双行流，支持关键词／级别／方向／入队状态过滤、暂停跟随与粘性新日志提示、保留上限选择以及页内可折叠“快捷测试抽屉”。
- **DSH `0.23.0`**：固定模型组合选择区消除拉取后突增 `<select>` 的高度跳变；测连／拉取模型仅在凭据未保存时提示先保存（改显示名或超时不锁定）；原生能力与模块主行外置 `<Switch>` 与状态徽章并强化模块配置 JSON 状态反馈；模型能力手写补充去折叠；历史会话快照剩余有效时间每秒倒计时显示。
- **OpenViking Memory `0.4.0`**：将 `enabled` 总开关提升至顶部总览横条并在连接／活动页提供一键开启；展开高级连接设置与规则列表内每行独立提取／召回 `<Switch>`；群成员列表改为 `TagChipsInput`；独立第 4 页签“记忆浏览器”常驻检索工作台，输入新词条期间置灰保留上次结果不闪跳；粘性 `FormSaveBar` 仅在脏稿／冲突／未知态出现并带页签未保存圆点。
- **Image Generation `0.7.0`**：拆分为“创作与图库”与“服务与参数配置”两页签，整合 `RequestParameters`（`KeyValuePairsEditor` + JSON 模式）与主表单统一保存体系；新增生成计费原位 `InlineConfirm`；直接打通后端既有 `source: { kind: 'asset', assetId }` 能力，增加“以此图继续编辑”与“复用提示词”工作流闭环，列表实现受控并发（最多 3 路 + `AbortController`）真图片缩略图懒加载与隐藏清内存。
- **Text-to-Speech `0.3.0` & Speech-to-Text `0.2.0`**：均拆分为“工作台／队列”与“协议与配置”两页签，保留跨协议非秘钥草稿；在各自 `manage('test-connection')` 后端增加仅发起受控 `GET /models`（带 1MB 读取上限、15s 超时及 `AbortSignal`，WebSocket 地址经确定性路径规则映射为 HTTP(S) `/models` 探针，零付费合成／转写）的鉴权测试动作；TTS 在对应任务行内就近展开唯一活跃 `<audio>` 播放器；STT 增加全文收起／复制与拖拽音频校验卡。
- **Android Control `0.2.0`**：拆分为“控制台与进程”、“屏幕与文件传输”、“执行端连接配置”三页签；`argv` 升级为 `StringListEditor` 与常用 ADB 命令快捷芯片；解析文件目录为可视化可点击列表；补齐所有禁用按钮为带原因 `<ActionButton>`；当已连接状态修改配置时提供显式“保存并重连执行端”确认流程，前端有序调用 `disconnect` → `updateConfiguration` → `connect`，遵守后端 `ANDROID_STOP_FIRST` 安全约束不越权。
- **Stickers `0.4.0`**：`<select multiple>` 升级为带数量徽章的多选标签云筛选条，`TagChipsInput` 替代标签换行框；移除顶层抖动确认条与移动端 `scrollIntoView` 硬跳，1100px 以下切换为列表 ⇄ 详情双视图切换。

## 原因与备选方案

1. **QQ 实时日志保留策略（方案 A vs 切子页签缓冲）**：选择严格方案 A（切出实时日志页签或隐藏即清空内存、停止订阅），结合同页可折叠快捷测试抽屉解决调试往返痛点，从而在不违背现有实时日志最小内存与隐私边界的前提下改善可用性。
2. **TTS / STT 连通性测试（纯格式校验 vs `test-connection` 后端探针）**：纯前端校验无法排查无效域名或错误 Key，直接试听／识别又会真实计费；因此新增受控只读 `/models` 探针（不计费、可取消、禁用重定向），保持原有存储与任务幂等契约不变。
3. **缩略图加载策略（新增后端 thumbnail 端点 vs 前端受控并发 LRU 队列）**：选择先通过前端并发上限为 3 的受控 `get` 队列与随翻页／隐藏回收 `Blob URL` 的策略实现，避免修改既有资源二进制协议与插件安装快照复杂度，未来需要更高分页上限时仍可平滑扩展。

## 影响与边界

- **版本同步**：应用／Host／Web `0.27.0`、`@eating/ui-sdk` `4.4.0`；8 个内置插件均升级：`qq` `0.19.0`、`dsh` `0.23.0`、`stickers` `0.4.0`、`image-generation` `0.7.0`、`openviking-memory` `0.4.0`、`text-to-speech` `0.3.0`、`speech-to-text` `0.2.0`、`android-control` `0.2.0`；`@eating/plugin-sdk` `4.15.0`、`@eating/plugin-core` `4.0.0`、`API4` 与 `pnpm-lock.yaml` 均保持不变。
- **持久化与外部契约**：全部 SQLite／JSON 配置、状态、任务账本、unknown 隔离、OneBot 协议、DSH 原生 Web、`.impeccable/design.json` 均无 schema 或不兼容破坏；更新 Playwright 端到端测试以匹配新布局结构与统一 `PluginLifecycleBar`，同时完整保留所有布局不变量、安全校验与幂等断言。

## 证据与后续

- 本地验证结果见 [2026-11-17 插件 UI 重构本地验证报告](../reports/2026-11-17-插件UI重构本地验证报告.md)，设计规范同步见 [界面设计规范](../design/界面设计规范.md)。
- 后续仅按当前指令完成本地 `commit` 与 `push` 至 `origin/main`；云端部署及真实设备／付费接口联调需另行确认授权。

2026-11-17后续授权与执行：主人要求同步最新代码直接部署，已部署`8afebb7`，数据保留与启动状态正常；停止额外测试。见[部署报告](../reports/2026-11-17-最新代码同步与云端部署报告.md)。
