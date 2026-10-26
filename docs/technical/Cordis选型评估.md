# Eating Cordis 选型评估

结论：**在 Host 采用 Node.js/TypeScript 的前提下，优先验证 Cordis 作为后台插件运行底座；Eating 自己定义扩展接口与前端注册机制。** 当前未最终采用 Cordis、未选择包/版本、未安装或运行测试。

状态：Proposed。负责人已同意将推荐与限制写入文档，不等于确认它已满足全部要求。对应 [ADR-0008](../decisions/ADR-0008-Cordis候选底座.md)。

## 现状与问题

Eating 需要多个独立通讯/运行时模块，管理依赖、生命周期、注册和撤销。简单注册表足以演示发现模块，但如果继续自行增加依赖追踪、停用重启和副作用清理，会逐步重建通用插件框架。

另一方面，选 Cordis 也不会自动提供 Eating 的业务契约、React 插件页面、可信安装批准或进程隔离，不能将这些目标打包宣称完成。

## 已有官方证据

以下保存 2026-10-26 本轮讨论前已实际读取的固定源码，不重新声称当前 master 未变化；属于源码分析，未运行官方测试。

| 项目 | 固定版本事实 | 来源 |
| --- | --- | --- |
| 上游核心 | SHA bf5af66abbed85e7496a4fbd364bd1bf66ed6a58，包名 cordis，版本 4.0.0-rc.12 | [包声明](https://github.com/cordiverse/cordis/blob/bf5af66abbed85e7496a4fbd364bd1bf66ed6a58/packages/core/package.json#L1-L16) |
| 稳定性 | 官方 README 明示 API 尚未稳定，可能未经通知改变 | [README](https://github.com/cordiverse/cordis/blob/bf5af66abbed85e7496a4fbd364bd1bf66ed6a58/packages/core/README.md#L7-L10) |
| 插件依赖/装配 | Context 扩展有 inject/plugin，registry 构造 Fiber 并解析依赖 | [registry](https://github.com/cordiverse/cordis/blob/bf5af66abbed85e7496a4fbd364bd1bf66ed6a58/packages/core/src/registry.ts#L118-L122)、[装配](https://github.com/cordiverse/cordis/blob/bf5af66abbed85e7496a4fbd364bd1bf66ed6a58/packages/core/src/registry.ts#L189-L210) |
| 资源清理 | effect 收集清理函数；实际资源仍需模块正确登记和释放 | [Fiber](https://github.com/cordiverse/cordis/blob/bf5af66abbed85e7496a4fbd364bd1bf66ed6a58/packages/core/src/fiber.ts#L285-L317) |
| 作用域隔离 | isolate 扩展服务命名作用域，不是新 OS 进程或沙箱 | [Context](https://github.com/cordiverse/cordis/blob/bf5af66abbed85e7496a4fbd364bd1bf66ed6a58/packages/core/src/context.ts#L65-L69) |
| 现成 WebUI | SHA 2a884b56e589d81c41e510922e6b9f12badef26a，client 依赖 Vue、Vue 插件等 | [WebUI 包声明](https://github.com/cordiverse/webui/blob/2a884b56e589d81c41e510922e6b9f12badef26a/packages/client/package.json#L57-L72) |
| DSH 自有版本 | 在 DSH SHA 22ddee3792402c3e70ec5f86a63c3e3e895a2f60 中，vendor 包为 @deepseek-ai/cordis 4.0.5 | [DSH 内包声明](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/vendor/cordis/package.json) |

上游 cordis 与 DSH 的 @deepseek-ai/cordis 不能凭相似名称或版本数字认定兼容。最终选择上游包、DSH 维护版本或其他方式仍待比较支持策略、API 和发布制品。

## 推荐分工

| 层 | 责任 |
| --- | --- |
| Eating 扩展约定 | 通讯/Harness/页面的稳定身份、能力、契约版本和注册/撤销规则 |
| Cordis 适配层（候选） | 后台依赖、加载、作用域和生命周期管理，将业务注册绑定到清理流程 |
| Eating 前端机制 | 在实际前端环境加载并注册页面、路由、菜单、状态与权限 |
| 安装与进程执行边界 | 主人批准、来源校验、凭据/文件权限、独立进程和故障恢复 |

模块作者主要面向 Eating 明确的业务契约，避免把 Cordis Context 大量泄漏到队列、平台数据、UI RPC 与主身份格式。内部插件装配可以使用 Cordis，但普通配置/元数据必须可序列化并与具体包版本分开。

如果继续选 React，不直接默认使用 Vue WebUI；两种 UI 机制如何桥接没有验证，也没有决定引入两套前端框架。DSH 适配器与 Host 更不需要共享 Cordis 实例。

## 备选方案

- 自建简单注册表：适合最小实验和业务目录；若还要自建通用依赖/生命周期系统，长期维护负担增大。
- Cordis 加 Eating 业务接口：当前优先候选，复用后台机制，并把业务与前端契约握在 Eating 中。
- 所有模块独立进程：隔离更强，但通信、状态同步与分发成本更高；可按风险与 Cordis 管理器组合，不要求每个轻量模块都单独进程。
- 若 Host 最终使用 Rust 或其他语言：重新评估插件底座，不能为维持 Cordis 而强行增加复杂的 Node 双 Host。

## 待验证与退出条件

进入实现后先做两个模拟通讯模块和一个模拟 Harness：独立加载/页面注册、移除飞书不修改或拖停 QQ、重复启停清理、晚到请求、依赖缺失/恢复、重复 ID、部分失败和全部模块移除。测试必须使用真实插件依赖约束，不只在无限制 root Context 中验证。

另行验证阻塞/崩溃对进程的影响、授权旁路、真实 React 前端注册、发布包与版本锁定。API 变动、双 UI 成本或隔离要求不能接受时，可按新证据替换底座；保留本 ADR 历史。

当前成功证据只有官方源码事实和负责人确认的方向，没有运行兼容或长期稳定性结论。见[插槽设计](../architecture/插槽式扩展.md)、[PoC 计划](../plans/路线图与PoC计划.md)和[待确认问题](../待确认问题.md)。
