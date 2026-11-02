# Eating DSH 集成设计

状态：DSH适配已实现，源码0.15.0；会话子代理自主处理、可配置默认及主／子唯一complete组合按[ADR-0035](../decisions/ADR-0035-会话代理自主处理与默认开放可配置.md)。本文SDK／Profile／Preset／Inbox结论只适用于DSH，不能当作通用Host契约；通用边界见[Harness适配](Harness适配.md)，源码背景见[研究](../research/DSH源码核对.md)。

DSH 适配模块通过 Eating 注册表暴露运行时能力和自己的配置/诊断面板；通用 UI、通讯模块和队列不直接导入 DSH 类型。停用时核对在途动作并撤销本模块贡献，不误删其他运行时数据。DSH 内部插件/Context 与 Eating 后台底座不默认共用或兼容。

## 最小入口

优先用官方 TypeScript 客户端 `DeepSeekHarness` 或低层 `HarnessClient`，由 SDK Profile 挂载服务端插件。官方服务端不是假设中的默认导出 `startServer/createSession` 风格 API；真实导出和方法以固定版本为准。

客户端可启动 DSH 子进程并以 JSON-RPC 通信；初始化完成后再订阅和投递。Host 显式管理进程、独立根目录、工作区、关闭和恢复，不连接本次正在使用的主 DSH。

## Profile 与 Preset 必须区分

SDK 启动会选择 Profile（默认 sdk）和 patch。**SDK Server 的 Agent 创建/恢复路径明确不做 Agent Preset composition，也不自动 join roster。** 因此“配置好 Preset 后 SDK Agent 自动继承”不是成立的设计。

当前适配用公开Agent创建钩子与Preset装配主子scope，主人组合与主分流／委派／联系／自主规则合入主唯一complete provider，子会话自主规则合入子唯一complete provider，不使用虚构的AgentOptions人格字段。实际request.system必须含完整规则；编辑器预览和工具目录不能代替请求证据。

系统rc.5已确认complete=true片段成为sole；Eating owner-system complete会抑制普通contact／autonomy section，因此必需规则须合入同一provider。owner／persona与子类型隔离，自定义提示词不自动reset，外部正文保持数据。prefix／suffix和includeRuntimeContext只控制组合，不构成OS安全边界。

## 消息与来源缺口

公开 SDK 普通 prompt 进入 followup，只有内容块与 Session ID，服务端固定 `source.kind=user`。进程内有 followup/steer/inject，但后两者不在当前公开协议。

Eating 在自身记录中保留真实平台来源、身份和 eventId；向模型的来源描述不能提升为系统权限。需要结构化可信来源、忙碌时 next-step 消息或非唤醒注入时，再评估最小内部桥。桥只转发并校验，不产生意图。

## 事件、确认与恢复

先订阅再投递，按 Session ID 和事件序号关联。SDK 生命周期通知不全部属于持久日志；恢复不自动重放旧事件，当前协议没有历史游标读取接口。可靠补投需要另外解决断线后确认缺口，不能只靠重新 subscribe。

prompt 的 messageId 是受理标识，不是磁盘确认、模型消费或动作成功。run 的首次根 Agent idle 与 session/wait 的受管理后代等待语义不同；读取 turn/end 和实际工具/平台结果判断状态。

持久后端必须实际装配。正常关闭与崩溃恢复分别验证；保存映射后显式 resume，不能重新发送同 ID 假装恢复。会话恢复不恢复外部浏览器、Shell 进程或任意 token 生成。

## 当前验证与限制

本轮验证、实际request.system、清理和部署结果见[报告](../reports/2026-11-02-会话代理自主处理与默认开放可配置验证清理报告.md)。脚本模型按预设顺序调用两入口只证明协议、scope和回执，不能证明真实LLM必定自主选该路径。Eating暂停只管其无输入机会，main原生Schedule保官方语义，不冻结全部能力；缺provider／Key报告真实未配置。OS隔离、发行包差异和更多故障窗口仍按证据核验。见[主会话模型](主会话模型.md)、[Phase 1](../plans/路线图与PoC计划.md)和[待确认问题](../待确认问题.md)。
