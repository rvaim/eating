# ADR-0067：玩手机插件本机 ADB 管理与网络设备连接

日期：2026-11-18。状态：Accepted，本地实现、构建与验证完成，准备提交并推送 GitHub（本轮未部署云服务器，未连接真实安卓设备或执行在线 Google Platform-Tools 真实下载）。

## 背景与用户决策

此前 `android-control` `0.1.0`／`0.2.0` 将连接分为 `local` 与远程 HTTP MCP 执行端（`executor.mjs` ＋ `RemoteExecutor`），存在四类实践障碍：
1. 面板将“ADB 可执行”与“手机在线”混为一谈，且缺少内置 ADB 下载安装与独立工具清理入口；
2. 远程执行端需单独托管服务进程、Token 与 MCP 端口，实际使用更常直接通过本机或网络 ADB（`adb connect`／`adb pair`）操作手机；
3. 多台设备连接时缺少明确的默认设备绑定与跨设备幂等校验；
4. 旧版配置缺乏面向 `USB`／`网络 ADB` 的结构化契约。

主人批准全面转向 **“插件管理本机 ADB，直接连接 USB 或网络设备”**，版本升级至 `android-control` `0.3.0`。

## 核心决策

### 1. 移除远程 MCP 执行端，所有 ADB 在 Eating 所在机器本机执行
- 删除 [executor.ts](../../plugins/capabilities/android-control/src/backend/executor.ts) 对应远程服务／客户端、`executor.mjs` 启动入口与 `tests/fixtures/android-executor.ts`，清理 [plugin.json](../../plugins/capabilities/android-control/plugin.json) 中 `"assets": ["executor.mjs"]`。
- 全部 ADB 命令、TTY 进程、工作目录文件与屏幕截图均直接由 Eating 所在机器的 [AndroidEngine](../../plugins/capabilities/android-control/src/backend/engine.ts) 执行；网络模式下通过规范的 `主机:端口` 连接设备。
- 在面板与工具提示中显式声明路径作用域与 `127.0.0.1` 语义：文件读写与 `127.0.0.1` 均指运行 Eating 的机器；若 Eating 部署在云端，须填写云端可达的设备地址或内网／SSH 转发地址。

### 2. 三级检测、纯净内置安装与独立清理（不修改系统 PATH）
- **严格检测顺序**（[adb.ts](../../plugins/capabilities/android-control/src/backend/adb.ts)）：
  1. 手动 `adbPath`（只要填写即严格校验文件存在、可执行与 `adb version` 输出；无效直接报 `ANDROID_MANUAL_ADB_INVALID`，**禁止静默回退**到系统或插件内置 ADB）；
  2. 系统 `PATH` 与标准 Android SDK 目录（`ANDROID_HOME`、`ANDROID_SDK_ROOT` 及各平台常见 SDK／包管理路径，排除插件自身工具目录）；
  3. 插件私有目录 `EATING_HOME/capabilities/android-control/tools/platform-tools/`。
- **插件内按需安装与校验**：
  - 按 `process.platform`／`process.arch` 匹配 Google 官方 `repository2-3.xml` 与 Platform-Tools（支持 `darwin arm64/x64`、`linux x64`、`win32 x64`）；其他架构（如 `linux arm64`）在下载前即明确返回 `ANDROID_PLATFORM_UNSUPPORTED` 并引导填入自定义路径。
  - 若系统已存在可用 ADB，拒绝重复下载（`ANDROID_SYSTEM_ADB_EXISTS`）；并发重复点击合并为单份安装任务；安装需先明确确认 `Android SDK License Agreement`。
  - 使用 Node 内置 `fetch`、`node:crypto` 与纯 Node `node:zlib` ZIP 解压器（校验 ZIP 路径防穿越、拒绝符号链接、CRC-32、单文件与总解压上限），避免新增外部 npm 依赖或修改 `pnpm-lock.yaml`。校验大小、SHA-256 与临时解压可执行文件的 `adb version` 通过后，原子替换 `tools/platform-tools/` 并记录 `tools/install.json`；任何阶段失败均清理 `.tmp-install-*`。
- **单独移除插件工具**：提供 `manage('remove-installed-adb')`，先停止运行中 ADB 运行时，随后仅删除 `EATING_HOME/capabilities/android-control/tools/`，完整保留 `config.json`、工作目录、`receipts.sqlite`、系统 ADB 与其他软件服务，并维持宿主“卸载插件保留数据”策略说明。

### 3. 严格 v2 连接配置与显式重建
- 配置文件（[config.ts](../../plugins/capabilities/android-control/src/backend/config.ts)）升级为严格 `schemaVersion: 2`：字段仅包含 `schemaVersion`、`revision`、`connectionMode`（`'usb' | 'network'`）、`networkAddress`（支持 `IPv4:port`、`域名:port` 与 `[IPv6]:port`）、`defaultDevice`、`adbPath`、`workspace`。
- **禁止自动迁移旧版 v1**：发现 `schemaVersion: 1` 或 `mode`／`endpoint`／`token` 字段时保留磁盘原文件不动，不将旧 MCP 地址解释为网络 ADB 地址，返回 `legacy-unsupported` 状态与 `ANDROID_LEGACY_CONFIGURATION_UNSUPPORTED`，仅在主人确认后经 `manage('rebuild-configuration', { confirmed: true })` 重建全新 `config.json`（保留工作目录、`tools/` 与回执账本）。

### 4. 设备状态分离、无线配对与目标设备意图绑定
- 面板头部与配置页严格分离 **ADB 环境**（可用／不可用／来源／版本／路径）与 **手机设备状态**（`device` 在线、`offline` 离线、`unauthorized` 未授权、多设备未选默认、无设备），`adb version` 通过绝不误报“手机已连接”。
- 网络连接流程固定为：`校验并保存地址 → adb connect → adb devices -l 复核真实在线状态 → 在线时设为 defaultDevice`。增加 `adb pair` 无线配对（`pairAddress`、`pairCode`、可选 `connectAddress`），配对码仅传递一次，绝不落盘或写入日志，且页面隐藏（`visibilitychange`）即刻清空未提交草稿。
- `AndroidEngine` 对所有命令与 `android_screenshot` 统一目标解析：显式 `-s`/`-d`/`-e`/`-t`/`serial` 优先；其次使用 `defaultDevice`；无默认设备且存在多台在线设备时返回 `ANDROID_DEVICE_REQUIRED`，禁止猜第一台。解析后的目标设备键（`targetKey`）与实际 `finalArgs` 参与 HMAC `intent` 摘要计算，切换默认设备或重连后阻止同 `request_id` 误作用于另一台手机。
- [Host App](../../apps/host/src/app.ts) 仅针对插件显式声明的 `configurationManageOperations` 允许在插件未启用状态调用配置与 ADB 安装／检测／连接管理，确保“无 ADB 且插件停用时仍可进入配置页完成安装与配对”；其他插件及所有运行时／MCP／工具调用依然严格要求启用与就绪状态。

## 影响与边界

- `android-control` 升至 `0.3.0`；`pnpm-lock.yaml`、`@eating/plugin-sdk`、`@eating/ui-sdk`、其余 7 个插件版本及源码包均保持不变。
- `scripts/server-build.mjs` 回归清单同步纳入 [adb.test.ts](../../plugins/capabilities/android-control/src/backend/adb.test.ts)。
- 相关证据见 [2026-11-18 验证报告](../reports/2026-11-18-玩手机插件本机ADB管理与设备连接验证报告.md) 与 [安卓手机插件操作说明](../operations/安卓手机插件.md)。
