# OpenViking 记忆插件

适用：openviking-memory0.3.0、Eating／Host／Web0.18.0、plugin-sdk4.8.0、DSH0.16.0、API4。当前使用官方 OpenViking Session／Task API，无需安装 Eating 服务端扩展。源码已实现，整体验证进行中，服务器尚未更新；本轮修复及云端 Eating 更新已获批准，实际结果由父代理创建的[本轮报告](../reports/2026-11-04-官方记忆与插件能力更新验证报告.md)收口。本机已安装记忆0.1.1保持，不配置或重启真实OpenViking服务端。

## 连接和当前格式

连接／范围／活动三个页签保持。在运行中的官方OpenViking服务创建所需服务用户，填写服务地址、用户ID及服务要求的Key；Account在高级项。Key省略保持，明确清除才删除，不回显。保存只做本地检查，连接／测试核对官方服务就绪与保存的用户身份，不调用提取模型，也不探测Eating私有扩展。

配置和状态位于 `EATING_HOME/capabilities/openviking-memory`，均严格schema3，配置保存使用revision／CAS。旧schema及旧字段明确拒绝并保留原文件，生产启动不自动迁移、补齐或清空。

| 提交设置 | 当前行为 |
| --- | --- |
| autoCommit | 默认true；控制阈值、会话压缩和正常结束时的自动提交 |
| commitTokenThreshold | 整数1～1000000，默认20000；使用官方Session报告的待处理Token数 |
| archiveMaxMiB | 当前格式已移除；归档随官方commit执行，不再由客户端体积分段 |
| 手动提交 | 主人显式提交待处理记录，可在autoCommit关闭时执行 |

本轮云端旧state的只读预检为schema2、jobs0／scopes0。实际更新由部署负责人先停止Eating、复核原文件SHA并备份，再使用独立[一次性转换工具](../../scripts/server-memory-transition.mjs)执行本轮已授权的精确变更。`EATING_MEMORY_TRANSITION_CONFIG` 指向项目外私有配置，含数据／备份目录、两份旧文件SHA及明确确认值；存在Host锁、哈希不符或jobs／scopes非空就停止核对，不能丢弃旧任务。

转换保留已保存的Key、endpoint、Account、用户、范围规则及其他设置；配置只改schema3／revision+1，settings只移除archive字段并加入两个提交默认值。空state只把schema2改为3，其他metadata保留。该工具不进入应用正常读取路径；用户无需为本次保留配置更新重新填写密钥。预检不等于转换或部署已完成，最终记录见本轮报告。

## 同步、提交和提取

| 阶段 | 何时执行 | 可以确认的事实 |
| --- | --- | --- |
| 对话同步 | 每个获准主回合结束 | 通过官方messages/batch追加新增消息；synced表示已同步、尚未提取 |
| 官方提交 | 达到阈值、压缩、正常结束且autoCommit开启，或主人手动提交 | 官方commit归档原始记录并接纳异步提取，保存实际taskId／archiveUri |
| 任务查询 | 已取得taskId后 | 只GET原官方Task；completed表示已知任务完成，不提供伪造增删改数量 |

普通回合不因发生QQ回复工具就强制commit。`memory_save` 也先同步待处理记录，不能把工具返回、queued或synced当作提取完成；需要时由主人明确提交。自动采集不依赖模型主动保存，子代理不重复上传。

工具名和真实结果摘要并入对应助手消息；returned只表示工具函数返回，不代表外部动作成功。不采集推理、工具参数／原始结果、图片、机械时间输入或记忆注入自身。原生Web追加输入保留可信来源，混入QQ回合时分入self。

前端关页不撤销官方服务已接受的任务。官方commit同时归档和提取；当前不再承诺“每轮即时提取且不创建archive”，也不显示私有持久回执或未经官方证实的记忆变化计数。

## 范围和目录

Peer为 `platform-account-private/group-target`，自主为 `self`。固定Session为 `eating-standard-<peer>`；全局关闭用同Peer固定 `-local` 后缀，切回原策略继续对应根，不按回合随机建根。创建时显式关闭服务自动提交并核验记忆策略。旧 `eating-live-<peer>` 扩展Session与0.1.x原始记录保留，不自动接管、回放、合并或删除。

长期记忆位置保持：

```text
viking://user/<user>/memories/
viking://user/<user>/peers/<platform>-<account>-private-<target>/memories/
viking://user/<user>/peers/<platform>-<account>-group-<target>/memories/
viking://user/<user>/peers/self/memories/
```

平台用小写字母／数字／下划线且首位字母；账号／目标／成员用字母、数字、下划线。服务用户／Account另允许点、连字符和至多一个@，最多96字符，不能为单点或双点，Account不能以下划线开头。

全局开启允许从会话提取共享知识，其他获准会话可召回；不是私聊事实绝不跨域的保证。自动召回当前Peer＋全局。主人私聊和原生主人Web可显式all检索，群中主人或自主活动不能冒充私聊主人。统一人格仍由Eating作者配置管理。

私聊默认采集，群默认不采集；逐会话规则可选全部成员／白名单／黑名单，以实际发送者ID匹配。混合被排除成员的回合只同步允许成员原文，不同步可能引用其内容的助手／动作总结。规则影响新采集，不自动清除旧记忆。保存范围、断开或停用撤销本地授权，不删除远端已接受记录。

## 活动与故障恢复

活动区区分 `queued / syncing / synced / committing / processing / completed / failed / unknown`；追加任务和提交任务分别记录。`synced`不是“已提取”，`processing`不是“完成”。

同Session串行写入。结果未知的追加或commit保留原标识与元数据，并阻塞该Session后续写入；不换ID重发、不切换到私有协议。已保存taskId时只GET原官方任务恢复；任务不存在、过期或仍无法证明结果时继续unknown，不重新commit。其他独立Peer可继续处理。

当前没有扩展的“重试提取”入口，不承诺官方Task长期持久可查，也不从缺失文件推算记忆增删改。遇unknown先核对原官方任务和服务记录，不删除本地防重记录来解除阻塞。正常完成、零变化、失败、断开及重启均不自动删除远端Session或归档。

## 工具、容量与部署

保留 `memory_search / memory_read / memory_save / memory_scopes`。启用且connected的新功能来源默认all，当前／未来工具和类型自动可用；主人可保存custom精确例外并恢复all，见[ADR-0035](../decisions/ADR-0035-会话代理自主处理与默认开放可配置.md)。真实Peer、群成员过滤、主人显式跨会话与自动采集开关独立生效。模型无删除工具；主人管理页只能明确确认删除精确记忆文件URI。

Eating只保存有界任务、幂等与范围元数据，未同步正文只在RAM，崩溃可能丢失并明确报告；没有每日／每小时提取额度，缓冲／单批／并发限制只保护机械容量。Host正常启动按保存的autoConnect工作，`EATING_AUTO_CONNECT=false`只压制该次启动，不改变已保存偏好。

本轮只更新Eating，代码仍先本地验证commit／push，再由云端GitHub拉取确认提交构建。真实连接值、Key、部署目录与别名只存项目外；不安装额外依赖、不配置或重启真实OpenViking服务，不增加TLS、网关或防火墙。配置草稿／CAS、隐藏清Key与正文、双语／暗色／窄屏焦点保持。

当前决策见[ADR-0045](../decisions/ADR-0045-官方记忆接口与插件部署提示.md)。[ADR-0030](../decisions/ADR-0030-增量记忆提取与历史分段解耦.md)、[增量扩展目录](../../integrations/openviking-incremental/README.md)与[旧报告](../reports/2026-11-02-增量记忆与历史分段验证.md)仅保留历史方案和数字，当前安装不以其为前提。真实OpenViking提取质量与付费模型尚须独立证据，隔离协议验证不能代替。
