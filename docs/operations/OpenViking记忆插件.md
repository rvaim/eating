# OpenViking 记忆插件

适用：Eating记忆0.2.0、Host/Web0.14.0、plugin-sdk4.5.0、DSH0.12.1、API4。服务端需要与openviking==0.5.2.1配套的[增量扩展](../../integrations/openviking-incremental/README.md)。本轮只交付代码，不替换用户现有安装、不部署服务器。

## 接入和当前格式

连接／范围／活动三个页签保持。主人在OpenViking创建服务用户，填地址、用户ID和Key；Account在高级项。Key省略保持，明确清除才删除，不回显。保存只做本地校验；连接／测试核对保存的身份及协议1的incremental_extraction、history_segmentation能力，不调用提取模型。缺扩展显示MEMORY_INCREMENTAL_UNSUPPORTED，不回退旧commit路径。

配置和状态位于EATING_HOME/capabilities/openviking-memory，均严格schema2/CAS。删除submissionMode、batchMessages、batchChars、idleSeconds、tokenThreshold，新增archiveMaxMiB：默认8，范围1–64，单位MiB。它只控制历史分段，不控制提取延迟。召回、全局、成员名单等字段保持。

旧schema1及旧字段明确拒绝，原文件字节保留，不自动改版本、迁移或清空。用户审查决定启用后，先备份并显式选择当前格式配置/状态；可按当前字段重新填写已有地址、身份、Key和规则。源码更新不等于真实实例已切换，不能直接把旧文件当作新格式。

## 三条独立路径

| 路径 | 何时执行 | 结果 |
| --- | --- | --- |
| 对话同步 | 每个获准主回合结束 | 本轮新增消息及时追加到固定Session，不创建archive |
| 增量提取 | 服务接受同步后即排队 | 官方提取器处理本次增量，合并长期记忆，可能零变化 |
| 历史分段 | 成功提取的live原文达到archiveMaxMiB | 写同根archive_NNN并保留原文，不重复提取 |

工具名和真实结果摘要并入对应助手消息，不产生额外归档触发器。returned只表示工具函数返回；不采集推理、工具参数/原始结果、图片、机械时间输入和记忆注入自身。自动采集不依赖模型主动保存，子代理不重复上传。原生Web追加输入仍保留可信来源，混入QQ回合时分入self。

前端关页不停止远端已接受的提取；记录接收和真正形成记忆分别展示。正常completed任务的archiveUri通常为null，页面明确“未创建历史分段”。变化数来自官方实际文件操作，不等同于语义新事实数，相同正文的版本/来源变化也可能计为更新。

## 范围和目录

Peer为platform-account-private/group-target，自主为self。新模式固定Session为eating-live-<peer>；全局关闭用固定-local后缀，因为当前服务不能通过公开API更改会话提取策略。切回原策略继续原根，不按回合随机建根。旧0.1.x Session和归档保留，不自动接管未知原文、回放或删除。

长期记忆位置保持：

```text
viking://user/<user>/memories/
viking://user/<user>/peers/<platform>-<account>-private-<target>/memories/
viking://user/<user>/peers/<platform>-<account>-group-<target>/memories/
viking://user/<user>/peers/self/memories/
```

平台用小写字母/数字/下划线且首位字母；账号/目标/成员用字母、数字、下划线。服务用户/Account另允许点、连字符和至多一个@，最多96字符，不能为单点或双点，Account不能以下划线开头。

全局开启允许从会话提取共享知识，其他获准会话可召回；不是私聊事实绝不跨域的保证。自动召回当前Peer＋全局。主人私聊和原生主人Web可显式all检索，群中主人或自主活动不能冒充私聊主人。统一人格仍由Eating作者配置管理，不复制进记忆。

私聊默认采集，群默认不采集；逐会话规则可选全部成员／白名单／黑名单，以实际发送者ID匹配。混合被排除成员的回合只提交允许成员原文，不提交可能引用其内容的助手/工具总结。规则影响新采集，不自动清除旧记忆。保存范围、断开、停用撤销本地授权，不删除远端已接受记录。

## 持久回执和恢复

每次同步带稳定request_id与expected_sequence，服务在官方Session锁下保存本批及[from_sequence,to_sequence)。同ID/相同负载返回原回执，冲突拒绝。一个Session只用一个提取工作者；上一轮提取时仍可持久追加新消息，其他Session独立运行。

POST回执丢失后只GET原request_id，不换ID重发。回执不依赖官方TaskTracker短期TTL；该task_id是扩展的持久任务标识，查询走扩展requests接口。无法证明接收或应用结果时显示unknown并阻止同Session盲目后续操作。

证明尚未进入记忆应用的准备失败，可由主人点击“重试提取”：复用原回执和原文，只重试提取，不重复追加消息。unknown、已开始应用和已完成不能按此重放。崩溃落在无法证明部分记忆是否已写入的窗口时，保留资料并等待核对，不宣称永久exactly-once。

分段先保存并校验完整归档，再缩短live区；持久意图恢复允许暂时原文重叠，不允许失去唯一副本。正常完成、零变化、失败、取消、重启和断开均不自动删除Session、消息或归档。

## 工具与容量

保留memory_search/read/save/scopes；已启用且connected时，全部功能MCP工具默认供main、现有及后续Agent类型使用，无逐类型／工具授权勾选。真实Peer、群成员过滤和主人显式跨会话范围保持，自动采集开关独立；当前功能规则见[ADR-0034](../decisions/ADR-0034-主Agent自主决策与功能能力默认开放.md)。memory_save走同一增量入口，接收不等于提取完成。模型无Session删除工具；主人管理页只可确认删除精确记忆文件URI。

Eating只保存有界任务/幂等/范围元数据；未接受正文只在RAM，崩溃可能丢失并明确报告。没有每日/每小时提取上限，2MiB暂存、512KiB单批、2个传输槽只是机械容量。服务端也有待处理和回执容量，满时拒绝，不静默丢弃原文。

Host正常启动按保存的autoConnect工作，EATING_AUTO_CONNECT=false会压制开关；本轮不改用户真实启动设置。配置/草稿/CAS、隐藏清Key与正文、双语/暗色/窄屏焦点保持现有面板规范。

决策见[ADR-0030](../decisions/ADR-0030-增量记忆提取与历史分段解耦.md)，实际验证见[本轮报告](../reports/2026-11-02-增量记忆与历史分段验证.md)。
