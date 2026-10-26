# ADR-0004：推荐 Tauri 2 作为桌面壳

- 状态：Proposed
- 日期：2026-10-26
- 来源：v0.3 §5、§12

## 背景与决策提议

Eating 需要三平台独立 UI、托盘和后台进程管理。优先研究 Tauri 2，前端候选 React/TypeScript/Vite，Host 优先 Node.js/TypeScript Sidecar；这些均未最终选定。

## 原因与备选

Tauri 复用系统 WebView，适合研究较小的壳体积。实际产品还包含 DSH、Node、原生依赖和插件工具，不能预先保证体积或内存低。

Electron 是备选，可提供较一致的浏览器环境，但捆绑体积和运行资源需比较。尚未做基准，不据此否定任何方案。

## 影响

Rust/Tauri 工具链、系统 WebView、Sidecar 签名、三平台原生依赖和动态扩展可能增加工程成本。关窗口、隐藏托盘、退出 UI 进程与停止后台需分别验证。

## 证据与后续

[Tauri 2 官方入口](https://v2.tauri.app/)仅作选型参考；本轮没有验证具体 API、构建或系统行为。Phase 5 测安装包、冷启动、空闲资源、DSH 启动、动态插件安装及干净系统运行，之后由负责人决定。

详见[打包计划](../technical/运行时与打包.md)。替代关系：无。
