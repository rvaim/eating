# Eating Harness 适配设计

更新：2026-11-02。用户选择的 Harness 承担认知与行动，Eating 提供连接、运行、授权和可靠交接。DSH0.15.0是当前具体适配；其他Harness不自动继承其能力。当前应用／Host／Web0.17.0、QQ0.13.4、plugin-sdk4.7.0、ui-sdk4.2.0、plugin-core4.0.0、插件唯一API4，默认不兼容旧版，见[ADR-0015](../decisions/ADR-0015-默认不兼容旧版.md)。系统DSH与官方原样Web见[ADR-0018](../decisions/ADR-0018-系统DSH原生Web与看板移除.md)，原生能力与插件管理见[ADR-0021](../decisions/ADR-0021-DSH原生能力与插件管理.md)，人格模板与默认生命周期见[ADR-0027](../decisions/ADR-0027-人格模板与默认提示词生命周期.md)。

## 外部记忆接入（2026-11-01）

OpenViking0.1.0能力插件按[ADR-0027](../decisions/ADR-0028-OpenViking记忆能力与自动采集.md)实现公开MemoryProvider，Host仅协调当前主回合来源和短期RAM消息。DSH0.12.0采用原生pre-step/turn-end钩子自动召回和采集，不靠模型主动调用MCP；所有准入判断结束后才附历史参考，保留原ACK和主子授权。全局和可读平台/账号/会话Peer按配置保存，原始临时会话完成后清理。其他Harness可使用MCP或采用公开生命周期服务，不等于已支持自动钩子。详细范围、缓冲和故障语义见[使用说明](../operations/OpenViking记忆插件.md)。

## 依赖与唯一控制者

UI、通讯、队列与授权依赖公开Eating契约，具体适配器映射到实际运行时。通用Host不导入DSH Session、Preset或内部Context，插件不引用Host／Web私有源码。同一AI数据集只有一个活跃主认知控制者；子Agent是共享人格的执行者，不创建多个自主身份。

DSH复用系统安装的命令与 Web 组件，使用 Eating 专属的DSH_HOME、DSH_AGENTS_HOME、runtime-home和工作区，不借主DSH的Profile、会话或Key。Cordis是DSH内部实际依赖，不因此成为所有Harness的通用协议，也不代表Host最终插件底座已选定。

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

原生能力与插件使用Eating专属Profile及正式管理入口，配置／安装与管理进程排他。[ADR-0035](../decisions/ADR-0035-会话代理自主处理与默认开放可配置.md)保新main平台全部feature、files写／编辑、web.search及Eating专属danger-full-access／approval never默认，主人可显式再配。main非reserved全局工具与所有Agent功能型native Profile MCP默认自动可用，其他子非MCP仍toolGrants精确选择；schema1可选toolAccessOverrides以同名精确指纹＋类型优先，可关main／空禁用，指纹变化不回落开放，catalog.automaticAccess说明默认，feature选择保持。Host新source默认all含未来类型／工具，custom为该source精确例外且可恢复all，accessPolicy为策略／自管null，grant为有效摘要。策略和来源拓扑一次性重挂，仅恢复原connected且同一启用实例，owner stop优先，不重放unknown；direct在途撤权可能source error需主人显式connect。通讯／资源scope保持。

| 对象 | 受信system顺序 | 工具 |
| --- | --- | --- |
| 主Agent | common→main→启用插件说明→统一当前人格＋必需主分流／联系／自主规则，唯一complete | 会话处理／明确任务／活动／联系；当前策略允许的功能MCP与原生工具 |
| 子Agent | common→subagent→agent类型独有→同一人格＋会话自主规则，唯一complete | 绑定会话自主理解／回复／工具执行；范围化已选通讯＋当前策略允许的功能与原生工具 |

插件通过公开契约贡献类型、默认规则、主使用说明、可选／默认工具和展示标题。QQ提供qq.private／qq.group，通用Host与UI不硬编码QQ目录。未启用人格明确空共享层，最多启用一份；不复制人格到每个角色。

作者只收当前schema2，保留common、subagent、main、agent、plugin、persona共6种scope与9个可信变量，scope/source必填并核对来源。不存在旧群私输入模板、legacy集合或外部正文变量。一次渲染不递归解释替换值，不执行eval；DSH仍使用既有`openai-completions`模型路径。

基础默认由[独立默认模块](../../apps/host/src/authoring-defaults.ts)维护，角色与插件说明默认来自当前注册贡献。[作者服务](../../apps/host/src/authoring.ts)以`updatedAt:null`表示跟随默认，非null时间戳表示主人覆盖；恢复后的跟随文档revision可以大于0，不能仅按revision0识别。存储即使留有旧默认body，快照、Harness配置和组合也只读解析当前默认，不刷新落盘。自定义正文保持；同正文保存先核对CAS，通过后不写。

主人显式恢复一个文档时，`resetPrompt`在同一同步CAS内核对来源和目标revision，再将文档revision及全局revision各加一、`updatedAt:null`。角色／插件记录保留，不能删除后归零导致旧CAS重现；已跟随时只读。来源停用可编辑或恢复但不可执行，卸载后保留记录只读，稳定ID重装后接续当前默认与原revision。恢复保持其他提示词、人格、启用关系、设置、队列与账本；冲突、容量、版本上限或存储失败保原数据。旧schema仍拒绝，不添加迁移读取。

[静态人格模板](../../apps/web/src/persona-templates.ts)本轮仅一份主人批准的“AI女儿”。新增人格页只把模板正文填入未保存草稿，名称由主人填写且保留已填名称，已有非空正文先确认；不自动创建或启用，不写模板目录到`host:authoring`。显式保存后是普通人格，不随模板更新而改变；locale只改UI。当前上下文与可用记忆承载经历连续性，人格可以影响兴趣和表达，但不授予后台权限，也不自动共享全部会话经历。

主 Agent 在所有轮次自主决定行动与委派，子回执后核对真实结果，再判断继续或后续安排。`waiting` 处理新消息后不自动变为 `active`；AI 希望取得后续无输入定时机会时，用 `eating_activity_state`／`eating_plan_activity` 登记，正文或记忆不安排唤醒。`enabled`／`ownerPaused` 只控制无输入定时机会，普通有输入轮次仍可联系获准对象。

按[ADR-0033](../decisions/ADR-0033-主Agent当前轮次联系权限.md)，真实主 Agent 当前原生 turn，无论QQ群／私聊、原生输入、目标续行或定时唤醒，均可用 `eating_list_contact_targets`／`eating_contact_target` 委派联系，无需目标先私聊。跨目标使用当前联系策略，不借用入站批次或旧资源；普通委派保持原 scope。每小时联系上限计所有联系任务；策略保存、turn结束/abort/销毁/运行时停止撤旧许可，真正自主机会取消撤该轮许可。具体架构见[自主活动](自主活动.md)，实际验证层级及限制见[本轮报告](../reports/2026-11-02-主Agent当前轮次联系权限验证.md)；真实目标续行及Web浏览器输入控件未单独端到端验证，未部署。

main负责整体安排、轻量分流与必要协调。普通聊天／问答／生图优先eating_handle_conversation，仅{context_ref}；核对当前真实root、批次／digest、owner绑定及callId，运行时固定中立task＋原始context/events交绑定子独立理解／回复／工具执行，main不先写完整文案或能力猜测。eating_delegate_task留明确执行任务或用户明确逐字用途；跨目标先list再contact，不要求新入站，不继承旧资源。子scope不足由main换执行者，真实目标回执分别核对。入口不接受任意system／tools／persona／scope，见[ADR-0035](../decisions/ADR-0035-会话代理自主处理与默认开放可配置.md)。

适配器使用公开Agent创建钩子、Preset和in-process原生startActivation／sendMessage。正常恢复按plugin＋instance＋account＋conversation＋type复用稳定UUID；本轮主人明确清主／子会话后再运行会创建新UUID，人格身份不变；每个新任务装配最新系统与精确MCP。创建标签为“平台-绑定登录账号-私聊／群聊-目标”，平台取注册元数据真实pluginName，无元数据用canonical pluginId；账号取scope.accountId，不使用instanceId。切号区分新实例，历史归属与UUID不改，不解析旧label猜账号。原生Web显示依官方机制，不再使用agentLabels前端映射，不承诺旧标题一律外观修正。

同批可先查询、主看到结果后再派同一子发送。内部taskId来自公开exec.callId；同context最多32个调用，不淘汰旧ID后放行重放。重复、pending、unknown拒绝；actions／finish必须匹配当前taskId，迟到回调不能撤新权限。当前批正文RAM在主turn/end清理。

每任务独立临时MCP令牌，后台逐调用核对当前类型、账号／目标和引用，结束／断开／停用撤销。主不挂全权QQ，子保持受控委派边界；新main原生文件／Shell等按平台默认开，其他子原生选择保持；功能MCP默认all，主人custom例外按精确类型／工具限制。DSH插件安装管理继续使用正式管理入口。Host回传实际动作回执，集合按任务隔离；子摘要不冒充动作，主普通final文本不自动发QQ。

主系统必需分流／委派／联系／自主规则与owner／persona合入主唯一complete provider，子会话自主规则合入子唯一complete provider。系统rc.5在存在complete时抑制普通section，普通contact／autonomy贡献不能独立承担必需规则；主与子层仍隔离。验收捕获本地模型实际request.system，工具可见、预览或脚本强制调用都不能证明规则已经送达或真实LLM必定自主选同一路径。

## 原生持久与服务边界

主／子入箱与父目录显式flush成功后才能确认接管，原子ACK含匹配nonce／批次／摘要。中断恢复通过当前公开原生记录核对并重建ACK，不重复prompt，不宣称exactly-once。created=false就绪哨兵和同版固定UUID恢复继续保留；缺必要公开API明确失败，不用旧接口兜底。

适配器私有loopback通道仅prepare-task、actions、finish-task，随机令牌／nonce，只处理已绑定当前任务，不搬正文。Host必要scope连接、真实回执和撤权服务必填。

## 模型能力与图片输入

模型列表／测试仅用已保存endpoint/key，选择只写草稿。测试为最小Ping/max_tokens1，15秒、禁止重定向、解压后响应最多1MiB，错误不回显提供商正文或Key。不支持列表可手填；API连通、runtimeReady和业务成功分别表示。

模型能力按[ADR-0022](../decisions/ADR-0022-服务声明模型能力与就地展示.md)在模型名称附近自动读取服务声明。白名单模型目录独立schema1保存，按endpoint／Key摘要及精确model绑定，图片输入、上下文和输出容量自动进入原生模型元数据；未知/矛盾不根据名称推断。仅服务未声明图片能力时，使用专属[数据目录](../technical/数据目录与账号实例.md)的model-capabilities.json人工补充（schema1、初始false、CAS、停止后保存），换endpoint／model失效。每次输出上限保留主人配置，不自动扩大；服务声明不等于真实付费识图验证。

本轮图片CDN主机multimedia.nt.qq.com.cn的dns.lookup仅返回198.18.7.115，符合Fake-IP特征；SSRF对198.18/15保留段的拒绝发生在HTTP GET前。未确认具体代理来源，不记录QQ标识、签名URL、rkey或消息正文。本轮保留图片／SSRF策略，修复方向只说明用户网络DNS层恢复真实公网解析，或未来显式授权受信图片代理，不实施、不全局放行198.18／私网或开放目录。

API4工具必须声明resultFormat为json或content。QQ原39项OneBot工具保持json语义；新增qq_view_received_image返回标准MCP image内容，由原生MCP客户端转为附件并进入支持视觉的子Agent请求。图片只按当前账号／会话已授权的message与resource配对读取，网络取得后再次核验权限；主Agent先取得子摘要，未默认自动接收原图。纯文本能力拒绝真实图片并给明确诊断。网络与图片校验边界见[QQ架构](QQ与平台能力.md)。

## 时间上下文

主、子Agent各在自身ctx挂载一次官方time-context，注入依赖agents与sessionProjections，默认Asia/Shanghai，使用原生600000ms刷新间隔。只在已有合格step准备请求时判断追加读数；运行时user context位于历史末尾，source.kind为time-context，冷恢复从原生日志恢复注入状态。time-context本身没有新时间工具或后台唤醒模型；原生Schedule不再受Eating自主周期人工阻断，Eating暂停只控制其无输入机会，不冻结main或所有原生提醒。

Host通用与QQ角色默认提示词移除动态时间行，其他规则保持。9个受信变量仍注册，主人自定义正文若再次引用当前时间，system仍会动态变化，缓存影响应如实说明。验收system前缀稳定和来源明确注入，不以日志条数或夹具结果推断提供商缓存命中率。

## 官方原生 Web

Eating 自有会话看板、记录组件及 list-sessions／read-session 已移除。会话展示与操作交由官方页面，不保留另一套离线读取实现。系统安装已经包含 Web 组件，不另下载 DSH 或 Web 包，Host 不尝试导入 asar 内部模块。

官方原生Web与SDK挂在同一Eating专属DSH进程及注册表，共用原主子会话；挂载当前官方SessionController host、原生client roster、Gateway与owner鉴权。保持完整官方UI、主题、侧栏、会话操作、消息组件及create／prompt／settings等正常能力，cold follow按官方机制运行。web的printUrl、openBrowser、surfaceContext均为false，避免污染SDK控制通道。关闭网页不影响QQ处理，Harness停止则Web停止；不启动第二个共享会话目录写进程，不修改主DSH或官方npm源码。

Eating仅提供“打开 DSH Web”按钮：主人管理操作`open-native-web`按需返回`{url, rootSessionId}`，URL限定127.0.0.1合法端口及官方鉴权交换，普通`runtimeStatus.nativeWeb`只有`{ready}`，入口不进入普通status或模型上下文。移除readOnly字段，以及Eating readerPeer、connection隔离、HTTP写白名单、readonlyController与冷follow拦截；官方Web不施加Eating根树限制，也不通过隐藏按钮限制原生操作。

删除Eating的src/native-client源码、打包与模块注入，插件 assets 仅包含 launch/dsh-system.mjs 启动资产；不替换官方sidebar／composer／message renderer，不硬编码配色，不挂LocaleBridge或agentLabels前端映射。按[ADR-0024](../decisions/ADR-0024-外部入站的原生执行请求展示.md)，DSH0.10.3在公开agent/pre-step中仅将当前完整校验的SDK入站消息标记为eating-external，保留ID、时间、role=user和正文；SDK入箱与flush/ACK仍记录真实运输事实。官方Web据消费来源显示原生可折叠“收到执行请求”，展开呈现完整JSON；自主机会和原生主人输入保留各自来源，已有记录不改写，不承诺旧标题外观修正。Eating主的受控委派及当前轮次联系工具、按任务受限的QQ子MCP与time-context保持；官方Web创建的普通Agent不作为QQ scope child校验或报错。

系统命令与当前看板移除决策见[ADR-0018](../decisions/ADR-0018-系统DSH原生Web与看板移除.md)。

## 证据与未实现范围

本轮恢复原样Web、构建／严格类型、运行验证与图片DNS根因统一见[恢复原样DSHWeb与图片DNS诊断](../reports/2026-10-29-恢复原样DSHWeb与图片DNS诊断.md)，最终计数与实际部署状态由该报告及[项目状态](../项目状态.md)记录，本页不预填已通过或已部署。此前回环图片wire仅证明夹具图像块进入请求及文本模式拒绝行为，不能据旧报告成功结论声称此次真实公网图片已通，也不证明付费提供商识图准确率。

其他Harness、热切换、完整自主调度、长期记忆、OS沙箱、三平台与真实提供商端到端尚未证明。未来转换或跨Harness数据处理仍须用户明确指令，不默认迁移。
