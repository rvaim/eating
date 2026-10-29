# Eating Harness 适配设计

更新：2026-10-29。用户选择的 Harness 承担认知与行动，Eating 提供连接、运行、授权和可靠交接。DSH0.4.0是当前具体适配；其他Harness不自动继承其能力。当前共享SDK2.0.0、插件API2，默认不兼容旧版，见[ADR-0015](../decisions/ADR-0015-默认不兼容旧版.md)。

## 依赖与唯一控制者

UI、通讯、队列与授权依赖公开Eating契约，具体适配器映射到实际运行时。通用Host不导入DSH Session、Preset或内部Context，插件不引用Host／Web私有源码。同一AI数据集只有一个活跃主认知控制者；子Agent是共享人格的执行者，不创建多个自主身份。

DSH使用专属运行时、DSH_HOME、DSH_AGENTS_HOME、runtime-home和工作区，不借主DSH的Profile、会话或Key。Cordis是DSH内部实际依赖，不因此成为所有Harness的通用协议，也不代表Host最终插件底座已选定。

## 当前输入与交接

[公开SDK](../../packages/plugin-sdk/src/index.ts)定义HarnessEvent、HarnessDeliveryBatch和回执。规范化事件包含稳定eventId、插件／账号实例／登录账号／会话／发送者、时间和结构化content/text；接收时核验的角色、目标和资源引用经队列白名单保存，source始终external。外部正文不能产生主人授权。

[Gateway](../../apps/host/src/harness.ts)仅接受必填`deliverBatch(batch, signal)`，不存在单条deliver或逐条兼容循环。同工作区只允许一个主要接收者。可选isReady未就绪时不选批、不耗尝试，处理结束用wake恢复。

按conversationId聚合，不混会话。默认静默500ms、最长2000ms、最多10条、目标32KiB；静默从末条计，最长从首条固定，达到数量／字节可提前。目标是软阈值，超目标单条独立投递，仍受总队列硬容量限制，不等于模型token或请求次数。

默认交接超时15秒，明确拒收后间隔10秒，最多5次包含首次；在途任务保开始时设置。同会话冷却的队首不能被新消息越过。批次接收与模型原生执行由Harness自己管理，Host不做第二认知Loop。

## 可靠性与无历史责任

只有accepted=true、durable=true、非空receiptId，且Host本地确认成功，才删除队列正文并记可靠接管。它不代表模型已读、轮次完成、任务成功或平台动作完成。

明确拒收才有限重试。超时、异常、中断、缺耐久证据与尝试耗尽保留uncertain，不能推断未发送并补投。本地确认写失败时最多保存一个无正文结果，只重试本地提交，不再次调用sink；注销／关闭的有限处理和重新登记恢复不构成旧版兼容。

[HostStore](../../apps/host/src/store.ts)只保存有界未交接信封，默认persistent、1000条、10MiB、reject-new。memory正文只在RAM，Host退出丢失；当前模式切换原子转移队列，失败保设置与正文。drop-oldest仅移最旧pending，保护delivering／uncertain；缩容／清空需要明确操作并保留账号和动作账本。

不转交的正文不保存，原始OneBot包和额外正文列不落库。短期去重为24小时小标识，常态最多10000个；磁盘清理也失败时含内存后备最多20000个。不存在历史库转换，旧schema／旧表写前拒绝，不自动读取成新队列。

## 分层规则与原生委派

| 对象 | 受信system顺序 | 工具 |
| --- | --- | --- |
| 主Agent | common→main→启用插件说明→统一当前人格 | eating_list_agent_types、eating_delegate_task |
| 子Agent | common→subagent→agent类型独有→同一人格 | 当前类型可范围化且已勾选的MCP工具 |

插件通过公开契约贡献类型、默认规则、主使用说明、可选／默认工具和展示标题。QQ提供qq.private／qq.group，通用Host与UI不硬编码QQ目录。未启用人格明确空共享层，最多启用一份；不复制人格到每个角色。

作者只收当前schema2，6种scope、9个可信变量，scope/source必填并核对来源。不存在旧群私输入模板、legacy集合或外部正文变量。一次渲染不递归解释替换值，不执行eval。未编辑插件默认可随当前插件更新，主人覆盖优先；停用可编辑不可执行，卸载保覆盖只读。这是当前配置生命周期，不是旧格式迁移。

主按真实context_ref与类型委派，不能传任意system／tools／persona／scope。DSH从实际批次取得targetId并预绑定插件、账号、会话和引用；不猜sender或解析会话字符串补目标。user信封只有当前context/events，子任务另含实际任务，不再有renderedPrompt。

适配器使用公开Agent创建钩子、Preset和in-process原生startActivation／sendMessage。实例按plugin＋instance＋account＋conversation＋type绑定稳定UUID；每个新任务重挂最新系统与精确MCP，原生旧上下文仍归当前会话。主不挂全权QQ，子不能再委派或调用原生文件／Shell／安装／人格写工具。

同批可先查询、主看到结果后再派同一子发送。内部taskId来自公开exec.callId；同context最多32个调用，不淘汰旧ID后放行重放。重复、pending、unknown拒绝；actions／finish必须匹配当前taskId，迟到回调不能撤新权限。当前批正文RAM在主turn/end清理。

每任务独立临时MCP令牌，后台逐调用核对当前类型、账号／目标和引用，结束／断开／停用撤销。Host回传实际动作回执，集合按任务隔离；子摘要不冒充动作，主普通final文本不自动发QQ。

## 原生持久与服务边界

主／子入箱与父目录显式flush成功后才能确认接管，原子ACK含匹配nonce／批次／摘要。中断恢复通过当前公开原生记录核对并重建ACK，不重复prompt，不宣称exactly-once。created=false就绪哨兵和同版固定UUID恢复继续保留；缺必要公开API明确失败，不用旧接口兜底。

适配器私有loopback通道仅prepare-task、actions、finish-task，随机令牌／nonce，只处理已绑定当前任务，不搬正文。Host必要scope连接、真实回执和撤权服务必填。

## 模型与原生会话看板

模型列表／测试仅用已保存endpoint/key，选择只写草稿。测试为最小Ping/max_tokens1，15秒、禁止重定向、解压后响应最多1MiB，错误不回显提供商正文或Key。不支持列表可手填；API连通、runtimeReady和业务成功分别表示。

看板仅显式list／read当前根的parentSession子树，通过公开Cordis＋persistence只读，停机可读、不启模型／新会话、不建立Eating档案。默认每页50、列表100，响应1MiB／单文本32K，敏感字段和内部推理过滤。隐藏／切离清正文，不增加会话轮询；应用状态刷新另算。运行中缓冲可能未写，缺证据状态unknown、更新时间空；底层可能整文件解码，不承诺大日志磁盘分页性能。

## 证据与未实现范围

当前完整构建、983项测试（含5项实际SDK）及53项浏览器均通过，精确命令和限制见[当前报告](../reports/2026-10-29-删除旧版兼容验证报告.md)。自动对端均回环；独立产物删除临时来源后运行、同版整Host恢复、同子新配置、同批分阶段查询发送和原生只读摘要保持有实际证据。旧版本迁移用例已删除，历史结果保留在[上轮报告](../reports/2026-10-28-多代理与会话看板验证报告.md)。

其他Harness、热切换、完整自主调度、长期记忆、OS沙箱、三平台与真实提供商端到端尚未证明。需要未来转换或跨Harness数据处理时必须另有用户明确指令，不默认迁移。
