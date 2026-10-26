# Eating DSH 官方源码核对

结论：**已完成定向源码分析，未运行 DSH/SDK、模型或官方测试。** SDK Preset、消息来源、持久确认和调度存在需要改变原实现假设的限制。

## 版本与方法

- 核对日期：2026-10-26，Asia/Shanghai。
- 官方仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
- `git ls-remote` 的 HEAD、master 均返回 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`。
- [提交元数据](https://github.com/deepseek-ai/deepseek-harness/commit/22ddee3792402c3e70ec5f86a63c3e3e895a2f60)：2026-10-23 11:48:59 UTC。
- 本轮通过普通 HTTPS 读取固定 SHA 的 raw/API，定向检查文档、类型和实现；没有 clone、保存上游源码、安装依赖或启动运行时。
- web_fetch 因 GitHub 域名被解析为非公网地址拒绝读取，改用正常 Git/HTTPS 请求；未修改 hosts、TLS 或系统配置。

远端检查命令：

```bash
git ls-remote https://github.com/deepseek-ai/deepseek-harness.git HEAD refs/heads/master
```

源码读取使用 `curl --fail --silent --show-error --location --max-time 30` 指向下列固定提交的 raw 对应地址。这里记录可复核方式，不是已执行的 PoC 启动命令。源码 SHA 不等同 npm 发布版本；尚未选择/安装发行包。

## SDK、会话与事件

| 编号 | 源码事实 | 官方固定证据 | 对 Eating 的影响 |
| --- | --- | --- | --- |
| S-01 | Client 导出 DeepSeekHarness、HarnessSession、HarnessClient；服务端是 Cordis 插件和 HarnessSdkJsonRpcServer，无 default export | [Client 导出](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/client/src/index.ts#L12-L32)、[Server 入口](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/server/src/index.ts#L18-L59) | 不编造 startServer/createSession 风格 API；实际发行包需核对导出 |
| S-02 | session(id?) 只建惰性句柄；默认生成 session-UUID；run 不带 id 可产生新会话；resumeSession 才发恢复请求 | [高层 API](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/client/src/api.ts#L100-L130)、[Server 创建路径](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/server/src/server.ts#L461-L514) | 保存真实 ID，复用句柄，重启显式 resume；不能相同 ID prompt 冒充恢复 |
| S-03 | SDK 启动选 Profile（默认 sdk）及 patch；Agent 创建明确 No preset composition，不自动 join roster | [启动选项](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/client/src/launch.ts#L128-L149)、[No preset composition](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/server/src/server.ts#L481-L510) | Profile 与 Agent Preset 是两层；最小实验先验证外层配置，Preset 绑定另验 |
| S-04 | 持久后端按组合挂载；无后端无法 resume；官方 base 挂 JSONL 到 dshHomePath('sessions') | [写句柄](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/index.ts#L678-L695)、[恢复实现](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/index.ts#L747-L809)、[base 配置](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/bundle/base/cordis.patch.yml#L138-L141) | 不能将任意手动 Server 假设为默认耐久 |
| S-05 | Agent 内 followup=next-turn+wake，steer=next-step+wake，inject=next-step+不 wake；公开 wire 没有 steer/inject/cancel/逐 Session close | [实现](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts#L163-L182)、[公开方法表](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/protocol/src/types.ts#L176-L185) | SDK 普通 prompt 走 followup；后两者需其他扩展入口；inject 不代表隐藏消息 |
| S-06 | SDK prompt 固定 source.kind=user；UserMessage.role=user，source 为独立轴；调用方没有任意 role/source 参数 | [SDK prompt](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/server/src/server.ts#L253-L269)、[消息定义](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/llm/llm/src/message.ts#L103-L164) | 平台与主人身份由 Host 验证，正文描述不能成为权限 |
| S-07 | 三类输入先入 inbox，经 pre-step 接纳后进入 user/message；可被拒绝/修改，inject 不保证立即进入下一次已 claim 的模型请求 | [接纳](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts#L276-L305)、[历史写入](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts#L455-L469) | 准入不等于模型感知；不能用 inject 作为隐私隔离机制 |
| S-08 | session.event、status 和本地子 Agent 通知不同；Server event 转发范围不只 SDK roots；tree 订阅依赖收到的 started 建图 | [转发](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/server/src/server.ts#L154-L198)、[订阅](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/client/src/client.ts#L439-L476) | 先订阅、按 Session 过滤；生命周期通知不能当作所有持久事实 |
| S-09 | 恢复不重播旧历史通知；现有 wire 没有历史分页/游标读取 API | [官方恢复测试文本（未运行）](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/server/tests/resume.spec.ts#L149-L184)、[协议方法表](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/protocol/src/types.ts#L176-L185) | subscribe 重连不足以解决确认丢失；历史核对需要额外路径 |
| S-10 | prompt 回 messageId 是排队；run 到根首次 idle，finalResponse 是区间最后助手文本；wait 还等待受管理后代；终止原因另在 turn/end | [run](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/client/src/api.ts#L210-L257)、[wait](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/server/src/server.ts#L297-L320)、[终止原因](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts#L395-L419) | idle、文本、任务成功与平台确认不可合并；并发输入下不保证一问一答因果归属 |
| S-11 | 实时日志有异步缓冲；flush/close 才有对应耐久屏障；SDK prompt 没等待 fsync 链 | [句柄约定](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence/src/handle.ts#L85-L116)、[缓冲/flush](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/session/session-persistence-jsonl/src/storage.ts#L549-L560) | messageId 和通知不是崩溃耐久确认，需正常/异常关闭分别测 |
| S-12 | approval/request 是显式协议，单次 outcome 为 allowed-once/rejected/cancelled；关闭 client 有界 shutdown 后可升级到信号终止 | [审批](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/protocol/src/types.ts#L187-L207)、[close](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/sdk/client/src/client.ts#L478-L505) | SDK 审批不是 Eating 主人身份验证；关 UI 不可误关 runtime；退出码 0 仍需恢复核验 |

## 目录、人格、调度和安装

| 编号 | 源码事实 | 官方固定证据 | 对 Eating 的影响 |
| --- | --- | --- | --- |
| S-13 | home 解析显式配置优先于非空环境变量，默认 DSH home 与 agents home 分别独立 | [路径实现](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/util/home-paths/src/index.ts#L101-L153) | 分别指定 DSH_HOME 和 DSH_AGENTS_HOME；再核工作区、插件自有路径/远端空间 |
| S-14 | Profile 位于 home/profiles/name；patch 顺序为 bundle→profile→home 全局→启动 overlay→telemetry hard-disable | [Profile](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/boot/app-boot/src/profile.ts#L164-L171)、[顺序](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/boot/app-boot/src/profile-context.ts#L74-L84) | 只换 Profile 仍继承 home patch，不适合依赖用户主 home 隔离 |
| S-15 | Preset 注册插件树；persona 是 Agent scope 的 prefix/suffix/complete/includeRuntimeContext | [Preset](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/preset/agent-preset/src/index.ts#L9-L29)、[persona](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/preset/persona/src/index.ts#L30-L75) | 不把 prefix/suffix 当整个系统提示词，不把 Preset 当 OS 沙箱 |
| S-16 | Schedule 服务与工具在 Web/SDK 组合中按装配启用；任务存在 Host domain；漏发和失败语义有条件 | [Schedule 文档](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/schedule/schedule/README.md#L26-L75)、[存储定义](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/schedule/schedule/src/storage.ts#L36-L60) | 不能泛化到任意手动组合；必须验证实际挂载、休眠/重启补发 |
| S-17 | Schedule 先 inbox/flush 再 task put，两次独立持久写，崩溃/关闭可能重复；Session binding 不是 caller authorization | [保证与非保证](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/schedule/schedule/README.md#L153-L158) | 无 exactly-once，提醒回执不是模型完成；外部动作另做幂等保护 |
| S-18 | plugin-manager 支持来源安装/更新；approvedBuilds 不验证对话批准，许可持久化；脚本可按宿主权限执行且失败可能留副作用 | [安装与风险](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/boot/plugin-manager/README.md#L56-L77) | Host 必须验证真实主人并封住 Shell/配置/文件旁路；自动更新触发路径未核完 |
| S-19 | CLI prepareProfile 会写根 cordis.yml；初始化 Profile 涉及替换依赖/patch | [CLI 准备](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/apps/cli/src/profile-boot.ts#L108-L199) | 本轮没有运行 dump/初始化命令；不要当无副作用的只读探测 |
| S-20 | 根要求 Node >=24.9.0、pnpm 11.28.5，根 MIT；MIT 要求保留许可 | [元数据](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/package.json#L4-L10)、[LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/LICENSE#L5-L13) | 下限不是 embedded Node pin；第三方许可、发布包、原生 ABI 与三平台分发仍未核完 |

## 明确未覆盖

没有验证实际 npm 包对应此 SHA、实际模型与记忆插件、完整 OS/网络隔离、所有插件动态加载/自动更新入口、Preset registry 的最终挂载方案、全部缓存/凭据位置、官方完整 Node 捆绑清单、第三方 notices、任何三平台运行/打包。

阅读官方测试文本只作证据，不记为本轮测试通过。未来固定运行版本后复核这些结论，尤其组合差异可能改变 max-token 处理、默认工具和调度挂载。

## 原文假设的处理

保留唯一身份与“不在 Host 重写认知核心”的目标；负责人后续已确认可替换 Harness，DSH 现在只是具体适配器案例，见[当前决定](../decisions/ADR-0006-可替换Harness与认知边界.md)。本文件的固定版本事实不推广到 Codex/Claude Code 或通用 Host。

将“DSH SDK 自动绑定 Preset”“DSH SDK 直接 steer/inject”“messageId=处理成功”“只有 DSH_HOME 即完全隔离”“DSH 调度精确一次”排除为未经证实或与源码不符的实现假设。先验证通用模块边界，再做最小 DSH 适配实验，按证据决定薄桥与权限方案，见[路线图](../plans/路线图与PoC计划.md)。
