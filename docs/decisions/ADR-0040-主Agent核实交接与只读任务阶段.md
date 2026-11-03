# ADR-0040：主Agent核实交接与只读任务阶段

状态：Accepted；源码已实现，隔离验证及实际 Eating 部署完成；未提交或 push。运行证据见[本轮报告](../reports/2026-11-03-主Agent核实交接与实际部署验证报告.md)。

日期：2026-11-03，Asia/Shanghai。确认来源：主人本轮“修复问题”已授权代码修复并部署实际 Eating；主 Agent 先理解请求、判断事实是否充分，再选择核实或回复阶段。文档子任务只更新仓库文档，实际部署、最终验证与现场保留证据由父代理在[本轮报告](../reports/2026-11-03-主Agent核实交接与实际部署验证报告.md)记录。

## 背景与根因

[ADR-0035](ADR-0035-会话代理自主处理与默认开放可配置.md)的仅 `{context_ref}` 交接没有承载主 Agent 已核实事实的入口；主虽然看过记录或记忆，原会话子仍可能只见自己的局部历史。[ADR-0039](ADR-0039-统一身份核实与自然短消息.md)已要求跨会话先核实，但“只核实、不发言”仅靠任务文字，不能阻止被查询子代理调用普通发送或写入工具。主必须负责事实充分性判断与必要协调，子仍负责自然表达和实际工具执行。

根因应通过明确阶段、可用事实交接及实际调用限制解决。不能要求主预写每句回复，不能把共享身份解释为自动共享全部历史，也不能把提示词约定当作后台只读约束。

## 交接契约

| 入口 | 严格入参 | 语义 |
| --- | --- | --- |
| `eating_handle_conversation` | 必填 `context_ref`、`mode:'reply'\|'verify'`；可选 `context_notes`，最长8000字符 | 当前批次真实引用交绑定子；主先理解请求与判断事实，再显式选择阶段 |
| `eating_contact_target` | 必填 `target_id`、`task`、`mode:'reply'\|'verify'` | 先读取当前联系对象，再对真实目标核实或执行；不以查询任务向被查询会话公告 |
| `eating_delegate_task` | 保持 `type_id/context_ref/task`，不新增 `mode` | 明确执行任务或用户明确逐字内容，内部固定 `reply` |

以上入口拒绝未知字段；缺 `mode` 的旧 handle／contact 调用明确拒绝，不回落为 reply。`context_notes` 用于交接可向当前对象披露的事实、来源、时间范围和未知部分，不预写普通聊天全文，不承载新的权限。省略时子信封中的 notes 为空字符串。

子任务信封在原有 `eating/task/context/events` 之外新增 `coordination:{mode,context_notes}`；原始事件及来源不被 notes 替换。主不自动把全部历史复制给子，也不改变当前 `context_ref`、账号、对象、消息或资源授权。需要另一会话事实时，主用该目标的 verify 阶段取得真实回报，再将可披露事实通过原会话的 reply＋notes 交回原子自主表达。读取与披露分别核对。

## 只读任务阶段

`verify` 是当前任务的真实临时只读范围。控制层按显式 mode 构造 `AgentInvocationScope.readOnly`，并贯穿通讯 `ScopedAccessPolicy` 与功能 `CapabilityInvocationScope`。Host 的工具目录和最终调用守卫只允许 `tool.readOnly === true`；功能型 capability 与 direct MCP 同样受限，direct 工具元数据未知不放行。主人 all／custom 和通讯账号、对象、资源限制仍取交集。

没有合格读取工具时，允许空 MCP 工具集合，子可以依据已有会话历史回报或明确未知。`AgentMcpConnection.toolNames` 为必填，内容必须是 Host 实际过滤后的集合，不能拿类型原工具表代替。零工具不是启动失败，也不能为了凑工具恢复发送权限。

verify 子任务不挂载任何 Harness 原生 feature，原生全局工具也不可用，本阶段不额外挂载 time。目录不可见之外，调用守卫仍须拒绝强制指定的原生、发送和写入调用。此规则只约束 verify 子任务，不修改官方原生 Web 的正常操作或主人保存的 feature 选择。

核实结束后，后续 reply 在同一 canonical UUID 上从原普通授权重新取 scope／工具，恢复当前有效的普通权限；旧 lease 撤销，不能沿用前一阶段令牌。每任务结束、取消及既有撤权路径继续生效。临时 `readOnly`、scope 与闭包 policy 只在 RAM，不写入原绑定、联系策略或能力策略文件；各持久 schema 保持当前编号，不新增旧格式读取或迁移。

## 职责与保证范围

主 Agent 必须先理解用户要解决的问题和现有事实，显式选择 verify 或 reply。跨会话、记忆缺口及是否需要继续核实属于 LLM 语义判断；Eating 不增加关键词 router、第二认知循环或“事实绝对正确”的机械承诺。主可以自行使用当前获准来源核实，也可让对应会话子只读核实，随后给原子事实与未知范围。子按人格和历史自主决定措辞、必要工具及真实发送，不要求主写每句话。

系统保证显式 verify 子阶段通过受控路径不能发送消息或执行写操作；它不保证模型每次选择了正确阶段、理解无误或事实完整。reply 的实际动作仍以 Host `actions` 和平台回执为准，子 completed／摘要不能代替发送成功。既有 unknown 不重放，旧 unknown 不自动 review，已有重复历史不 merge／delete。

## 替代关系与保留边界

本决策仅替代 ADR-0035 与 ADR-0039 中“handle 仅 `{context_ref}`”、核实后以 delegate 承载普通回复事实，以及只靠任务文字限制核实阶段的旧契约；同时补充联系工具必填 mode。其余子自主会话、统一身份、自然多句／多条、真实气泡回执、唯一 complete、默认开放且可配置、原生 Web 与数据保留规则继续生效。旧 ADR、变更和历史报告正文及数字不改写，当前索引标明部分替代。

[ADR-0038](ADR-0038-空闲整批交接与统一会话身份.md)的空闲整批、canonical UUID、冷恢复与实际 scope 记忆隔离，以及 ADR-0039 的身份／自然表达本轮一并部署完成，已有重复历史保持。应用／Host／Web0.17.3、QQ0.13.6、DSH0.15.3，API4、plugin-sdk4.7.0／ui-sdk4.2.0／plugin-core4.0.0保持。记忆源码0.2.0只构建，真实安装0.1.1保持；现场主人实际联系额度12／小时、native revision5 的 time＋web保持，不套用旧报告6／小时或新实例默认。新Harness默认仍仅 time，前轮主动活动方案不实施。

## 证据与后续

父代理已完成严格类型／完整构建，最终全量85文件通过／2跳过、1691项通过／8条件跳过（120.32秒）；新增系统 DSH `verification-handoff` 2/2、Host readonly 59/59、controller 91/91通过。实际5180／5181已更新，五插件connected、DSH ready／nativeWeb就绪，运行桥SHA与当前源码完全相同。15受保护文件、16历史／附件前缀、225旧actions、133 dedup与6 settings保留，root UUID、12／小时、native revision5 time＋web及旧unknown保持。详见[本轮报告](../reports/2026-11-03-主Agent核实交接与实际部署验证报告.md)；本轮未提交或push，未真人／付费试发。

隔离验收须检查严格 schema／旧调用拒绝、主子实际 `request.system` 与 `coordination` 送达、verify 的通讯／功能／direct 目录和调用守卫、未知元数据拒绝、零只读工具、原生工具禁用、同 UUID verify→reply 重新取权和旧 lease 失效。系统回环覆盖核实后在原私聊回答、查询群只核实不广播；脚本模型证明预设链路与限制可执行，不能证明真实 LLM 必然自主选择相同阶段或正确事实。实际部署与新运行桥加载已完成并由报告记录，后续自然业务仍按真实回执观察。
