# ADR-0058：固定聚合窗口与主 Agent 异步协调

状态：Accepted。日期：2026-11-14，Asia/Shanghai。主人明确要求实现、提交、push并部署：默认10秒汇总入站消息，Harness忙碌时继续追加，由主Agent自主选择等待、给子Agent补充消息或中断。

## 根因与分工

此前Host仅在DSH主Agent空闲、没有Inbox和活动周期时交接；主Agent委派工具又同步等待子Agent结束。一次慢工具调用便挡住后续批次。旧实现只有一份当前expected/owner binding/context，直接放开接收会覆盖旧任务的可信上下文与图片权限。修改必须同时解决入站准入、异步委派、多个批次、租约及可靠回执，不能只调整提示词或轮询间隔。

Eating仍仅负责消息机械聚合、可靠交接和权限。主Agent决定任务关系、优先次序及是否中断；Host不按正文猜测意图，不把消息自动转发给子Agent，不建设第二个Agent Loop。依赖使用系统DSH公开Agent.send、subagents及sessions.flush接口，不修改主人主DSH或官方Web。

## 当前投递契约

应用/Host/Web0.23.0，plugin-sdk4.12.0，DSH0.20.0，API4保持。QQ0.16.2、表情包0.3.1、生图0.6.1、记忆0.3.3、语音0.1.3仅随共享SDK打包字节变化补丁升级，功能与原数据格式保持；不覆盖同版本封存产物。DeliverySettings严格接受九项：storageMode、maxQueuedMessages、maxQueuedBytes、overflowPolicy、aggregationWindowMs、appendWhileBusy、deliveryTimeoutMs、retryIntervalMs、maxDeliveryAttempts。

aggregationWindowMs默认10000，范围0–300000毫秒；界面以秒显示。第一条待交接消息起固定计时，新消息不重置，不再按消息数或大小提前触发。窗口到期后所有可用会话按全局接收顺序组成整批，保持不同账号、实例、会话、目标、类型的独立contextRef。拒收冷却、容量、存储方式及unknown不重发保持。当前reason唯一为aggregation-window。

appendWhileBusy默认true；关闭后等主Agent、子任务和自主机会空闲。开启时，通过同一原生主Agent的next-step Inbox追加，先flush再给Host可靠ACK。模型会在下一步边界读取，正在执行的模型HTTP请求或外部工具不会因此自动中断；accepted不表示已读或动作成功。接收仍串行执行短交接，最多保留32个在途批次，达到容量继续留在Host队列。

每批expected-<batchId>.json及deliveries.json保存有界身份、摘要、绑定与双确认状态，不保存正文。只有Host已持久提交接收回执，且主Agent不再需要批次及异步协调上下文后才能退休。为支持“私聊核实→联系群子→回到原私聊回复”，存在未结束子任务或未消费结果通知时保留当前上下文。Host的accepted回调只能在SQLite ACK事务提交后触发；崩溃后可用receipt hash核对恢复，不重发未知批次。

## 异步子任务

原eating_handle_conversation、eating_delegate_task、eating_contact_target保留各自输入用途，立即返回taskId、childId、contextRef、running、summary及空actions。running只是启动成功。完成后读取真实Host动作差量、登记精确当前taskId终态，再以独立eating_task_result原生通知主Agent。

新增主Agent专用eating_task_control：list查询当前及最近已知任务（有界256），status查询具体任务；message向运行中子Agent补充说明，可附同一真实会话的新context_ref；interrupt停止后续执行，不能撤销已经发生的外部动作。模型不能自行指定scope、令牌、系统提示或工具权限。不同目标、账号、实例、类型、会话禁止混入。相同callId或context_ref的未知追加不自动重放。

追加只扩展原通讯与功能MCP租约的消息/资源引用，不换令牌、不撤销正在进行的旧调用，verify保持只读。完整当前任务引用只存RAM；历史绑定仍只保有界引用。主Agent的普通工具signal或正常轮次结束不取消已接受子任务；明确中断、运行时停止、期限或主人撤权仍生效。自主联系只归属真实发起的自主机会，其执行预算包括被接受的子任务；普通入站任务独立于该机会。旧自主机会结算等待期间，暂停它不取消随后开始的普通主轮次。

最多32个并发任务/待交接通知名额。结果先写有界async-outbox.json，发往原生Inbox并flush后才移出outbox；确定的通知ID使重启可先核对原生日志，避免重复通知。它是未交接结果队列，不是聊天历史。重启把旧pending任务标unknown，不重新运行，不自动唤醒模型补发历史unknown任务；查询仍保留真实状态。原生DSH可能提供后台子任务结束摘要，主Agent仍必须以Eating结构化终态与真实actions为准。

## 数据更新与验证

当前生产读取只接受新契约，不读旧四种聚合参数，不自动迁移或覆盖用户文件。部署前必须确认旧服务空闲、队列0且无pending子任务，停止Eating、核对完整私有备份，再运行独立scripts/server-delivery-transition.mjs：严格核对原配置、原session哈希及Host已接受receipt，仅转换投递设置（revision+1、默认10秒/true，保容量/存储/重试），清理已可靠交接的旧瞬时指针，保schema1、主UUID、created及全部原生日志。其他人格、插件配置、数据库记录、账本、图片及自主暂停状态不迁移。

追加进入同一原生轮次时，自动记忆使用经过验证的实际批次来源，按真实peer追加和召回；不能把外部正文当作主人的self输入。混合来源的摘要/动作继续隔离。

专项验证覆盖固定窗口不重置、忙碌主模型SSE期间先ACK、子忙时主Agent追加/中断、正确图片引用扩展、跨目标拒绝、只读保持、Host提交后清理、跨会话核实继续、未知任务隔离、outbox与原生重启恢复。测试模型明确读取running句柄及后续真实原生通知，不伪装成同步completed工具结果。详见[验证与部署报告](../reports/2026-11-14-消息聚合与异步协调部署报告.md)。
