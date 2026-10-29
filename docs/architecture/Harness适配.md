# Eating Harness 适配设计

更新：2026-10-29。用户选择的 Harness 承担认知与行动，Eating 提供连接、运行、授权和可靠交接。DSH0.5.0是当前具体适配；其他Harness不自动继承其能力。当前共享SDK3.0.0、插件唯一API3，默认不兼容旧版，见[ADR-0015](../decisions/ADR-0015-默认不兼容旧版.md)；本轮原生Web、时间和图片决策见[ADR-0016](../decisions/ADR-0016-原生只读Web与多模态会话.md)。

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

不转交的正文不保存，原始OneBot包和额外正文列不落库。短期去重为24小时小标识，常态最多10000个；磁盘清理也失败时含内存后备最多20000个。不存在历史库转换，旧schema／旧表写前拒绝，不自动读取成新队列。已交给模型的图片由Harness原生附件机制负责持久化；Eating不另建聊天或媒体库，不能据此承诺图片全链路不落盘。

## 分层规则与原生委派

| 对象 | 受信system顺序 | 工具 |
| --- | --- | --- |
| 主Agent | common→main→启用插件说明→统一当前人格 | eating_list_agent_types、eating_delegate_task |
| 子Agent | common→subagent→agent类型独有→同一人格 | 当前类型可范围化且已勾选的MCP工具 |

插件通过公开契约贡献类型、默认规则、主使用说明、可选／默认工具和展示标题。QQ提供qq.private／qq.group，通用Host与UI不硬编码QQ目录。未启用人格明确空共享层，最多启用一份；不复制人格到每个角色。

作者只收当前schema2，6种scope、9个可信变量，scope/source必填并核对来源。不存在旧群私输入模板、legacy集合或外部正文变量。一次渲染不递归解释替换值，不执行eval。未编辑插件默认可随当前插件更新，主人覆盖优先；停用可编辑不可执行，卸载保覆盖只读。这是当前配置生命周期，不是旧格式迁移。

主按真实context_ref与类型委派，不能传任意system／tools／persona／scope。DSH从实际批次取得targetId并预绑定插件、账号、会话和引用；不猜sender或解析会话字符串补目标。user信封只有当前context/events，子任务另含实际任务，不再有renderedPrompt。

适配器使用公开Agent创建钩子、Preset和in-process原生startActivation／sendMessage。实例按plugin＋instance＋account＋conversation＋type绑定稳定UUID；每个新任务装配最新系统与精确MCP。显示名统一为“平台-绑定登录账号-私聊／群聊-目标”，平台取注册元数据真实pluginName，无元数据用canonical pluginId；账号取scope.accountId，不使用instanceId。切号区分新实例，历史归属与UUID不改。原生历史标签通过Host提供的受信agentLabels映射展示，不解析旧label猜账号。

同批可先查询、主看到结果后再派同一子发送。内部taskId来自公开exec.callId；同context最多32个调用，不淘汰旧ID后放行重放。重复、pending、unknown拒绝；actions／finish必须匹配当前taskId，迟到回调不能撤新权限。当前批正文RAM在主turn/end清理。

每任务独立临时MCP令牌，后台逐调用核对当前类型、账号／目标和引用，结束／断开／停用撤销。主不挂全权QQ，子不能再委派或调用原生文件／Shell／安装／人格写工具。Host回传实际动作回执，集合按任务隔离；子摘要不冒充动作，主普通final文本不自动发QQ。

## 原生持久与服务边界

主／子入箱与父目录显式flush成功后才能确认接管，原子ACK含匹配nonce／批次／摘要。中断恢复通过当前公开原生记录核对并重建ACK，不重复prompt，不宣称exactly-once。created=false就绪哨兵和同版固定UUID恢复继续保留；缺必要公开API明确失败，不用旧接口兜底。

适配器私有loopback通道仅prepare-task、actions、finish-task，随机令牌／nonce，只处理已绑定当前任务，不搬正文。Host必要scope连接、真实回执和撤权服务必填。

## 模型能力与图片输入

模型列表／测试仅用已保存endpoint/key，选择只写草稿。测试为最小Ping/max_tokens1，15秒、禁止重定向、解压后响应最多1MiB，错误不回显提供商正文或Key。不支持列表可手填；API连通、runtimeReady和业务成功分别表示。

图片输入能力由主人单独声明，保存在专属[数据目录](../technical/数据目录与账号实例.md)的model-capabilities.json，初始imageInput=false。读取／保存走主人管理操作与revision CAS，仅runtime停止时可保存；endpoint或model变化重置false，Key／超时变化不重置。不根据模型名猜视觉能力，也不通过改声明把文本模型变成视觉模型。

API3工具必须声明resultFormat为json或content。QQ原39项OneBot工具保持json语义；新增qq_view_received_image返回标准MCP image内容，由原生MCP客户端转为附件并进入支持视觉的子Agent请求。图片只按当前账号／会话已授权的message与resource配对读取，网络取得后再次核验权限；主Agent先取得子摘要，未默认自动接收原图。纯文本能力拒绝真实图片并给明确诊断。网络与图片校验边界见[QQ架构](QQ与平台能力.md)。

## 时间上下文

主、子Agent各在自身ctx挂载一次官方time-context，注入依赖agents与sessionProjections，默认Asia/Shanghai，使用原生600000ms刷新间隔。只在已有合格step准备请求时判断追加读数；运行时user context位于历史末尾，source.kind为time-context，冷恢复从原生日志恢复注入状态。没有新时间工具、scheduler或后台唤醒模型。

Host通用与QQ角色默认提示词移除动态时间行，其他规则保持。9个受信变量仍注册，主人自定义正文若再次引用当前时间，system仍会动态变化，缓存影响应如实说明。验收system前缀稳定和来源明确注入，不以日志条数或夹具结果推断提供商缓存命中率。

## 原生会话看板与只读Web

Eating看板仅显式list／read当前根的真实parentSession子树。reader通过公开persistence读一次快照，以Session.fromRestore、currentSessionMessageProjections和surface取得有效上下文，不把inbox splice／撤回当成已进入模型的消息，不平铺失效system。保messageId、turn、step、callId、native source及surface替换关系；platformEvents保核验后的sender／account／target，没有证据不造昵称。当前binding revision不能倒灌成历史配置版本，assistant输出不表示QQ已发；原生日志事实仍保留。

默认每页50、列表100，最多每次扫描2000个原生日志位置；响应1MiB／单文本32K，敏感字段和内部推理过滤。停机可读、不启Agent／模型／新会话、不建Eating档案。隐藏／切离清正文，不增加会话轮询；运行中缓冲可能未写，缺证据状态unknown、更新时间空。底层可能整文件解码，不承诺大日志磁盘分页性能。

独立原生Web在同一Eating专属sdk-minimal进程加入官方必要服务、前端与Eating renderer，共用原主子会话／权限，不启动第二写进程。Eating按钮在新页签打开主人管理操作`open-native-web`返回的当前入口；返回`{url, rootSessionId, readOnly: true}`，URL仅允许127.0.0.1合法端口及鉴权交换，状态只公开nativeWeb.ready／readOnly，不放token。关闭网页不影响QQ处理，Harness停止则Web停止。

后端readerPeer与Gateway allowed-read同时限制当前root及后代树，处理owner默认旁路；只读不是隐藏按钮。禁止create、prompt、settings、install、file和upload，冷热follow不提升权限、不启动模型。renderer区分平台sender／account／group、主任务／子回报、框架通知、模型输出与真实工具outcome，system／time折叠，reasoning不展示。直接聊天、任意新会话及第二套配置入口不在首版。

## 证据与未实现范围

本轮构建、严格类型、原生只读Web、图片wire、时间与浏览器的实际命令和结果统一见[原生Web时间与图片验证报告](../reports/2026-10-29-原生Web时间与图片验证报告.md)。自动模型／OneBot仅回环；图片wire验证真实图像块进入请求及文本模型拒绝行为，不验证真人付费模型的识图准确率。实际部署与资料保持状态见[项目状态](../项目状态.md)，本页不把隔离验证写成已更新真实实例。

其他Harness、热切换、完整自主调度、长期记忆、OS沙箱、三平台与真实提供商端到端尚未证明。未来转换或跨Harness数据处理仍须用户明确指令，不默认迁移。
