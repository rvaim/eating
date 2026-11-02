# ADR-0034：主 Agent 自主决策与功能能力默认开放

状态：Accepted。日期：2026-11-02，Asia/Shanghai。确认来源：主人最新明确“主代理拥有所有权限，他想干嘛就干嘛，所有功能mcp以及新增功能型mcp都默认开放给所有agent”。此授权优先于旧文档中的默认空授权、逐项批准功能工具和自主周期原生 Schedule 禁令。本轮基线为 main `c9793a3`，工作分支 `fix/agent-autonomy-default-access`；源码目标版本为应用／Host／Web0.16.0、plugin-sdk4.6.0、ui-sdk4.2.0、plugin-core4.0.0、DSH0.14.0、QQ0.13.3，插件 API4。验收、Git 与部署事实以[本轮报告](../reports/2026-11-02-主Agent自主与默认能力验证部署报告.md)实际填写为准。

## 背景与根因

主人21:14截图仍显示要求对方先私聊。父代理只读核对21:11的原生 turn333：唯一 `tool/call` 是 `eating_delegate_task`，类型为 `qq.group`，使用当前群聊 `context_ref`；群发送回执成功，没有调用联系对象列表或联系委派。实际请求／工具头已含联系工具，不能把本次未执行私聊归因于工具没有提供，也不能把群回复成功记为私聊成功。

系统 DSH rc.5 的 `systemPrompt.section` 在存在 `complete=true` 片段时仅采用 complete 片段。Eating 的 owner-system 已是 complete，后来独立注册的普通 contact／autonomy section 因而未进入真实 system；实际 system 仍保留“再用当前 context_ref 交出去”的单一路径指引。只检查工具注册、分段回调或组合预览无法发现这一缺口，必须核对发往本地模型的实际请求。

## 决策

1. 主 Agent 自主选择行动、执行者与后续安排。已启用且 connected 的功能型 capability 插件和 direct MCP，其全部当前工具默认对 main、所有现有子类型及后续新增类型可用；服务后续发现的新工具自动纳入当前目录。不再保存按代理类型／精确工具名的功能授权名单，不再提供对应授权勾选和 `save-grants` 操作。连接成功、业务已配置和实际动作成功仍分别报告。
2. `McpServiceSummary.grant` 保留为当前目录的只读动态摘要，列出已知类型和工具，不是准入白名单。功能调用依据可信 Agent 身份、服务启用／connected 状态、当前工具目录和有效 lease；新增类型不能因未列入旧摘要而被拒绝。通讯／其他自管权限来源继续标记 `permissionsManagedByPlugin`，不经通用能力网关获得全权工具。
3. 真实账号、平台对象、类型与资源范围保持。功能工具默认开放不赋予群子代理私聊通讯权，不授予任意消息／图片引用，不把主 Agent 的自主权转换为全权 QQ 令牌。通讯动作仍由精确 scope 的执行者完成，逐次核对实际登录账号、对象、工具和撤权状态；跨会话记忆、群成员过滤等数据边界保持。
4. 主 Agent 先判断实际行动目标，再选入口。当前会话的查询／回复使用真实 `context_ref` 与 `eating_delegate_task`；跨私聊／群聊或其他目标先调用 `eating_list_contact_targets` 读取当前目录，再用返回的 `target_id` 调用 `eating_contact_target`。联系工具自动启动或恢复对应受限原生子代理，无需目标先产生新入站消息。查询当前群信息可以作为准备，但不是每次跨目标联系的强制前置步骤。
5. 子代理范围不足时报告具体未完成动作和当前 scope，由主 Agent 选择其他可用执行者。某一子代理没有私聊工具不表示主 Agent 无联系能力。完成结论按实际目标和 Host／平台回执核对；受理、子终态或文字摘要不能代替动作成功，群回复成功不能证明私聊成功。
6. owner-system 的唯一 `complete=true` provider 组合主人规则、共同人格及主 Agent 必需的委派／联系／自主运行规则，不再把必需规则留在会被抑制的普通 section。主规则只进入主 Agent，子代理保留其类型规则、同一人格和 scope；外部正文、任务与资源始终是数据。6种作者作用域、9个可信变量、schema2及自定义提示词／人格保持，升级不自动 reset 主人正文。
7. 新建 Eating 专属 DSH 配置默认向 main 开启当前平台支持的全部原生 feature，包含文件 `write/edit=true` 和网页 `search=true`；time-context继续主子各一次，其他原生 feature 的子类型默认保持。main自动开放全部原生全局工具；所有Agent的功能型native Profile MCP及后续新工具自动可见，排除Eating／QQ受控通讯。其他子非MCP原生工具仍按精确名称／结构指纹选择，目录automaticAccess仅只读摘要，不保留无效main／全功能MCP授权勾选。tools/change后同步更新native.restrict与当前scope限制。既存原生配置不通过读取自动补写，已授权实例在部署时通过正式设置同步本次主人授权。
8. Eating 自身官方 permission 默认 `danger-full-access`、approval 为 `never`，仅作用于 Eating 专属实例；已有根 Agent 的本次授权通过正式设置同步。主人的主 DSH、当前 GUI、官方 Web 组件与已有自定义提示词不改。网页等功能缺提供商或 Key 时报告真实“未配置”，不能冒充 Eating 权限拒绝；功能开放不证明远端网络或付费业务可用。
9. Eating 的 `enabled/ownerPaused` 只控制 Eating 无输入定时机会及其真正自主周期，不冻结 main 的其他能力。移除自主周期内对原生 `schedule_create/schedule_update` 的人工阻断，原生 Schedule 保持官方语义；Eating agenda 仍是受其暂停、额度、周期及 runtime 约束的一次性任务机制，两者的触发、取消和状态分别记录。Eating 暂停不能表述为暂停整个 DSH 实例的原生提醒或目标。
10. 新增、连接、断开、工具目录变化及能力插件生命周期变更使用一次性重挂事务：先撤lease并停受影响Harness，await来源／目录变更完成后，仅对变更前connected、仍为同一实例且启用的Harness恢复一次。原stopped／error不自动启动，主人stop／disable优先；失败不重试、不重放unknown，返回harnessRemounts的reconnected／failed／cancelled结果。保留稳定 request_id、callId 防重、unknown 不重放、AbortSignal、异步资源取得后及真正 send／落库前复查。关闭 HTTP 响应不等于在途动作已取消，已接受的外部动作不因撤权自动撤回。

## 存储与接口

直接 MCP 保存入参仅含连接配置，不再接受 `grant`；`POST /api/mcp` 仅支持 save／connect／disconnect／delete，旧 `save-grants` 明确拒绝。`host/mcp/connections.json` 使用严格 schema2／revision／connections，各连接移除 grant。schema1原文件明确拒绝且保留，不自动转换、覆盖或标为schema2；默认不兼容政策继续有效。

旧 SQLite `host:capability-grants` 行不再读取、写入或删除，不从其中的空名单恢复限制，也不把忽略旧行当作数据迁移。其他 Host／QQ／作者／DSH 数据版本独立保持。父代理本轮只读现场核对称真实实例没有 direct 服务或连接文件，不需要迁移；实际安装前后检查仍由部署执行者记录。

## 原因与备选

保留手工功能授权名单会让现有或新类型、新工具继续被旧空集合限制，违背主人明确授权；自动补齐旧名单又会保留无必要的授权状态和迁移分支。采用当前连接目录推导可用功能，删除多余授权写入口，并继续使用真实通讯和资源 scope，可直接实现本次要求。

让群子代理拿到私聊工具、把所有行动强行送回当前 context，或要求用户先创建私聊，会混淆入站来源与实际行动目标。由主 Agent 判断目标、使用已有两类受控入口，保留自主选择和可核对的执行边界。

## 替代关系与影响

本决策替代[ADR-0019](ADR-0019-统一插件与MCP能力管理.md)中功能型 MCP 默认无授权、按类型／工具保存 grants 的部分，替代[ADR-0021](ADR-0021-DSH原生能力与插件管理.md)中main与功能型native MCP的手工工具授权、补充新main原生feature及Eating官方权限默认，替代[ADR-0032](ADR-0032-AI定时任务.md)中自主周期禁止原生 Schedule 的部分。继续承接[ADR-0033](ADR-0033-主Agent当前轮次联系权限.md)的真实主 turn 联系许可、统一名单、额度、撤权与 unknown 规则，补足实际行动目标选择、complete 系统组合和证据边界。历史 ADR、实施阶段记录和旧报告保留当时事实，不反写成新行为已在旧阶段完成。

功能默认开放扩大所有 Agent 可调用的功能工具集合。是否实际执行由 Agent、当前配置和外部业务结果决定；scope、Preset、提示词及独立数据根仍不是 OS 沙箱。安装、启用、连接、卸载与删除数据保留各自真实状态，既有安装确认不自动删除，不凭外部聊天自称扩大主人身份。

## 证据与后续

验收必须捕获隔离系统 DSH 发往本地模型的实际 `request.system`，确认 contact／autonomy／两入口选择规则完整进入，且 owner／persona 与子类型规则未串层；工具头包含联系工具只证明可见性。强制脚本模型按预设顺序调用列表、联系和发送，可证明当前协议、scope、真实回执、撤权与恢复链路，不能证明真实 LLM 必定自主选择这条路径。

本轮严格类型、构建、相关／全量测试、浏览器实图、原生 request 断言、备份、正式安装、配置／UUID／历史／账本保持、最终提交／push均由父代理在[报告](../reports/2026-11-02-主Agent自主与默认能力验证部署报告.md)填写实际结果。真实记忆安装维持0.1.1，不升级到源码0.2.0、不部署远端扩展；未执行项明确保留未验证。
