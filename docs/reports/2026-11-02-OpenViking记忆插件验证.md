# 2026-11-02：OpenViking记忆插件验证

范围：独立开发快照中的OpenViking0.1.0、应用/Host/Web0.14.0、plugin-sdk4.5.0、DSH0.12.0。ui-sdk4.1.0、QQ0.13.1、表情包0.1.1和生图0.2.0保持当前契约，插件API4不变。方案见[ADR-0027](../decisions/ADR-0028-OpenViking记忆能力与自动采集.md)，操作见[使用说明](../operations/OpenViking记忆插件.md)。

## 已确认需求

主人自行创建OpenViking服务用户；插件提供连接面板，不自动创建账号。记忆采用可读platform-account-private/group-target Peer，不使用HMAC；全局记忆开启、自主self、群聊默认关闭并逐群覆盖，支持实际成员白名单/黑名单；主人私聊可显式跨会话查看。

自动主回合采集/召回是主要路径，不依赖AI主动调用MCP；普通消息也进入缓冲，工具回合或显式保存立即提交，默认8条/6000字符/静默300秒。可选每轮或估算token阈值，不设每日/小时提取数量限制。原始会话只是提取载体，成功后清理，只保留长期记忆。用户要求impeccable、ui-ux-pro-max提升交互，保持既有白绿视觉。

## 独立开发与并行保护

原工作区为 /Users/rainvice/Projects/Eating，开始时存在其他会话的SDK、主动联系、UI和生图未提交修改。未stash、重置、移动或提交这些内容；读取后复制406份当前源码文件到独立目录，并保存每份原SHA-256和原字节作为合并基线：

```text
/Users/rainvice/Projects/Eating-worktrees/openviking-memory-l6ucr9qn
```

全部依赖安装、构建、服务、测试和截图在这个目录或临时EATING_HOME进行，原目录未自动写入。最后406份基线与原工作区逐份比较仍一致；用户原Host、QQ/DSH、Profile、凭据和当前DSH GUI没有更改。测试完成后，主人明确要求提交推送；基于另一会话已提交的b3c966e基线，创建独立Git worktree分支feature/openviking-memory，仅纳入本轮69个文件差异提交并推送，不合并或改写原main工作区。交付提供只含本轮差异的源码包/patch及默认只检查的集成脚本，发现并行变化会拒绝写入。

## 代码与数据实现

- [OpenViking插件](../../plugins/capabilities/openviking-memory/src/server.ts)：真实官方@openviking/sdk0.1.0用于add/batchAdd/commit/getTask/find/read/stat/remove/deleteSession。SDK缺少的当前字段，仅以两处公开HTTP补充：system/status检查保存用户身份，sessions创建显式auto_commit_policy:null。无SDK私有方法、旧端点回退或Python中转。
- [公开记忆契约](../../packages/plugin-sdk/src/memory.ts)和[Host当前回合协调](../../apps/host/src/memory-access.ts)：begin/append/finish/end只保留RAM。Host复核真实批次/通讯owners，调用时动态补充MCP范围，不从模型参数取peer_id或主人身份。召回查询有长度界限且原文采集保留。主会话缺记忆服务时不停止聊天。
- [DSH原生记忆接入](../../plugins/harness/dsh/src/backend/memory-runtime.ts)：在所有准入判断之后注入历史参考，保留拒绝和请求序列。主回合采集真实输入、可见助手文本、工具名/返回边界及桥接工具内真实Host回执摘要；returned不冒充外部成功。不采集工具参数、原始结果、内部推理、图片、时间通知和记忆注入自身。子代理不重复采集。
- 同轮原生Web追加输入也采集，且更新当轮MCP主人来源；混在QQ回合时，主人补充与助手最终回复归self，原QQ Peer只采集其本来的用户数据。旧finish不能清掉新回合，新批次不能被迟到清理遗忘。
- 全局开启时允许OpenViking写全局及Peer，两者都能召回；全局可能包含源自私聊的信息，界面不承诺“事实绝不跨域”。自动召回始终当前＋全局，主人all只在显式工具请求时生效。成员名单只过滤新采集，旧记忆不自动重写/删除。
- 配置/状态严格schema1及CAS，秘密留空保持、明确清除，服务用户支持官方安全单段点/连字符/@，Peer组件保持可读无歧义。正文只在RAM；本地任务元数据、来源、摘要计数、幂等哈希有界。每日成功次数跨100条任务摘要淘汰后仍准确，不是费用额度。
- 提取状态区分queued/submitting/processing/cleaning/completed/failed/unknown，accepted不等于提取成功。读取真实task和memory_diff变化计数，再删除本插件创建的临时Session。持久staged/commitAttempted/terminalStatus保证：已知未提交暂存可重试清理；真正未知commit不删不重放；已知终态清理不依赖服务器可能过期的task；DELETE失败保持待清理元数据而不是可淘汰失败项。

## 自动验证

环境：普通Node24.22.0、pnpm11.28.5，系统DSH0.2.1-rc.5显式通过 /usr/local/bin/dsh 选择。所有模型/OneBot/OpenViking是回环协议夹具；只有DSH运行时和官方SDK使用真实安装。提取夹具返回合成task/diff，证明运输和状态机，不能证明实际LLM提取质量。

```bash
pnpm build
EATING_DSH_TEST_SYSTEM_BIN=/usr/local/bin/dsh pnpm exec vitest run --maxWorkers=2
pnpm exec playwright test --workers=2
```

| 检查 | 实际结果 |
| --- | --- |
| 完整构建/严格类型 | 通过；五个插件、Host、公开SDK、Web完成。Vite既有主bundle超过500KiB告警保留，未为本功能扩展无关分包重构。 |
| 全量单元/系统集成 | 72文件通过、1369项通过、8项明确跳过，92.58秒；含最新服务ID、清理恢复、同轮原生steering修正。 |
| OpenViking后台专项 | 32项通过，使用实际SDK和HTTP服务夹具，含配置CAS、auth用户、global/local/owner、中文文件、群名单、批量/每轮/token/idle、重启/未知/撤权、提交前清理/终态task过期恢复。 |
| Host/DSH端到端 | 官方SDK＋真实系统DSH＋回环QQ消息，模型收到全局与当前Peer、不包含其他私聊；未开放或调用memory_save，仍自动提取助手可见回复，真实diff计数及清理，重启无重放。 |
| 原生追加与动作 | 实际DSH测试在工具回合中通过原生Web steer追加消息，主轮次内append被调用并召回；工具返回和原生自主活动捕获正常，不记机械唤醒。 |
| UI专项 | 9项单元通过，配置/范围/活动草稿、CAS、迟到响应、语言、隐藏清秘密、读文/精确删除、模式切换非法字段可达等浏览器用例通过。 |
| 全量浏览器 | 最终源冻结后117/117通过，1.3分钟；包含12项OpenViking面板回归，以及原管理页滚动、DSH、QQ、插件/MCP、图像等检查。 |

8项跳过：未提供EATING_DSH_TEST_RUNTIME的4项时钟直接导入和1项多代理PoC，以及未启专用开关的3项表情库浏览器测试；不将其计为通过。系统DSH的自主时间、原生主子代理、官方Web、图片/表情/生图及记忆链路已显式实跑。

## 独立复核与UI证据

使用用户指定的impeccable和ui-ux-pro-max，保留既有Operate白绿/暗色系统。初次design-system结果为营销Hero/CTA不适配本面板，未采用；后续定向表单/焦点/草稿检索和现有代码作为依据。交付方向见独立surface brief，不改原生DSH Web。

- 实现外的正确性审查发现并修复：同轮steering漏记、提取前失败后清理丢失、已知终态task过期后清理受阻、服务用户连字符拒绝。使用实际原生契约与可重复HTTP故障脚本定位，未恢复旧接口兼容。
- A设计审查独立于detector：首轮28/40，修正全局共享误导文案、隐藏模式参数错误不可达、把采集时间误标提取、干净手机活动页的禁用保存栏之后，真实临时预览浏览器核验31/40。无剩余实质性设计问题。
- B技术/浏览器审查：detector实际exit0，0项非advisory、2项design-system-font-size提示（16px标题/手机输入）；不能说总计零发现。手机输入16px避免缩放、标题16px与操作层级相符，作为记录保留。
- B在24张ARIA/截图矩阵中发现两个额外窄屏问题：新增群规则聚焦字段被保存栏遮挡13.72px、记忆搜索范围选择被压到29px只剩箭头。按真实保存栏高度及最近滚动容器修正，补完整字段上下边界/根文档不滚动/普通Tab进成员textarea与选择框文本宽度检查，最终独立B复核5种上下文全部通过：新增/撤销规则和普通Tab进入成员textarea的完整字段/4边缘绘制均可见，window/document/body滚动为0；隐藏栏测量为0；手机选择框为290×44px、短桌面180×44px，选项文字完整。复核截图已逐张读取，无剩余实质性插件问题。
- 原测试通过不能替代绘制证据；父Agent已实际读取最终明暗、390px、错误、规则编辑、短窗截图。所有截图为合成消息和临时服务，未展示用户秘密。

审查浏览器测得已检查文本正常浅色最低5.684:1、暗色7.634:1，主按钮5.462/8.743，错误6.778/8.034；插件自有动作均至少44×44，检查范围内标签/ARIA/键盘页签/减少动态无失败。既有Host页脚的较小停用/卸载控件不作为本插件已经修复的内容。

## 本轮发现的旧测试调用方

第一次全量系统回归的自主联系测试仍硬编码旧单联系人ID和旧targets配置，而当前业务已按另一会话的ADR-0025采用统一名单策略。修改测试调用方为保存当前策略、读取实际返回目标ID、从QQ代理权限选工具。生产不加旧接口回退。Host服务目录断言同步新memory对象并保持作者配置不可写；更新后两项自主链路和全部Host回归通过。

## 限制与交付边界

真实OpenViking用户/Key/提取模型由主人配置；此次没有连接用户真实服务或付费模型，没有语义提取准确率、人格/兴趣或长期记忆质量认证。没有导入已有聊天。清理只针对OpenViking中本插件创建的临时提取Session，不删除DSH原生会话日志。用户给出的原生目录只作为结构参考，未读写其记忆数据。

未提交正文保存在RAM，进程崩溃/配置撤销前未提交部分会丢失并报告；未知commit的归档不会为了“只保留记忆”承诺而盲删。服务尚在运行的任务或权限撤回后无法清理的远端内容，待同一服务恢复后核对处理。正常退出有界排空，不保证关机/杀进程前全部入库。

其他Harness可使用公开MCP和通用契约，当前只有DSH自动钩子完成并验证，不声称全引擎无损迁移。源码集成与真实部署不同：安装新能力包不能替代Host0.14/DSH0.12自动记忆接入。交付默认只检查的按哈希集成脚本，原工作区有并行变化时拒绝覆盖，不自动启动或重启现有服务。
