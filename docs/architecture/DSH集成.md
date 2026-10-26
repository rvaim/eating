# Eating DSH 集成设计

状态：DSH 适配器专属源码已核对，集成实现未开始。本轮已确认 Eating 可替换 Harness；本文的 SDK/Profile/Preset/inbox 结论只适用于 DSH，不能写成通用 Host 契约。通用边界见[Harness 适配](Harness适配.md)和[插槽设计](插槽式扩展.md)，固定版本证据见[源码核对](../research/DSH源码核对.md)。

DSH 适配模块通过 Eating 注册表暴露运行时能力和自己的配置/诊断面板；通用 UI、通讯模块和队列不直接导入 DSH 类型。停用时核对在途动作并撤销本模块贡献，不误删其他运行时数据。DSH 内部插件/Context 与 Eating 后台底座不默认共用或兼容。

## 最小入口

优先用官方 TypeScript 客户端 `DeepSeekHarness` 或低层 `HarnessClient`，由 SDK Profile 挂载服务端插件。官方服务端不是假设中的默认导出 `startServer/createSession` 风格 API；真实导出和方法以固定版本为准。

客户端可启动 DSH 子进程并以 JSON-RPC 通信；初始化完成后再订阅和投递。Host 显式管理进程、独立根目录、工作区、关闭和恢复，不连接本次正在使用的主 DSH。

## Profile 与 Preset 必须区分

SDK 启动会选择 Profile（默认 sdk）和 patch。**SDK Server 的 Agent 创建/恢复路径明确不做 Agent Preset composition，也不自动 join roster。** 因此“配置好 Preset 后 SDK Agent 自动继承”不是成立的设计。

最小实验先验证独立 Profile/patch 对外层提示词与工具的贡献，再按需要研究公开配置/注册接口能否满足主 Agent。若必须按 Agent 挂载 Preset，需要确认正确扩展点并另行验证；不能把 persona 塞进未经支持的 AgentOptions 字段。

persona 的 prefix/suffix 只是提示词组合的一部分；complete 会抑制其他系统片段，includeRuntimeContext 控制运行上下文贡献，不自动提供安全边界。固定人格的只写权限必须由 Host/OS 保护。

## 消息与来源缺口

公开 SDK 普通 prompt 进入 followup，只有内容块与 Session ID，服务端固定 `source.kind=user`。进程内有 followup/steer/inject，但后两者不在当前公开协议。

Eating 在自身记录中保留真实平台来源、身份和 eventId；向模型的来源描述不能提升为系统权限。需要结构化可信来源、忙碌时 next-step 消息或非唤醒注入时，再评估最小内部桥。桥只转发并校验，不产生意图。

## 事件、确认与恢复

先订阅再投递，按 Session ID 和事件序号关联。SDK 生命周期通知不全部属于持久日志；恢复不自动重放旧事件，当前协议没有历史游标读取接口。可靠补投需要另外解决断线后确认缺口，不能只靠重新 subscribe。

prompt 的 messageId 是受理标识，不是磁盘确认、模型消费或动作成功。run 的首次根 Agent idle 与 session/wait 的受管理后代等待语义不同；读取 turn/end 和实际工具/平台结果判断状态。

持久后端必须实际装配。正常关闭与崩溃恢复分别验证；保存映射后显式 resume，不能重新发送同 ID 假装恢复。会话恢复不恢复外部浏览器、Shell 进程或任意 token 生成。

## 需要实验回答

隔离是否完整、发行包与源码是否一致、首次 Session 何时耐久、Preset 最小正确配置方式、回执丢失怎样核对、内部桥是否必要、取消/暂停如何落实。见[主会话模型](主会话模型.md)、[Phase 1](../plans/路线图与PoC计划.md)和[待确认问题](../待确认问题.md)。
