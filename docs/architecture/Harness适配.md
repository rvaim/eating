# Eating Harness 适配设计

更新：2026-11-03。用户选择的 Harness 承担认知与行动，Eating 提供连接、运行、授权和可靠交接。DSH0.15.3是当前具体适配；其他Harness不自动继承其能力。当前源码应用／Host／Web0.17.3、QQ0.13.6、plugin-sdk4.7.0、ui-sdk4.2.0、plugin-core4.0.0、插件唯一API4，默认不兼容旧版，见[ADR-0015](../decisions/ADR-0015-默认不兼容旧版.md)。系统DSH与官方原样Web见[ADR-0018](../decisions/ADR-0018-系统DSH原生Web与看板移除.md)，原生能力与插件管理见[ADR-0021](../decisions/ADR-0021-DSH原生能力与插件管理.md)，人格模板与默认生命周期见[ADR-0027](../decisions/ADR-0027-人格模板与默认提示词生命周期.md)。

## 主Agent核实交接与只读阶段（2026-11-03，已实现、隔离验证及实际部署完成）

按[ADR-0040](../decisions/ADR-0040-主Agent核实交接与只读任务阶段.md)，主先理解请求并判断事实充分性，handle严格必填context_ref／mode（reply或verify），可选context_notes≤8000传可披露事实／来源／未知；子信封新增coordination，不替换原context／events，不预写回复全文。contact必填target_id／task／mode，delegate schema保持且内部固定reply。verify由控制层构造临时readOnly scope，贯穿Host通讯及功能capability／direct MCP目录与最终调用guard，仅tool.readOnly===true，direct未知metadata拒绝；零只读工具空MCP可用，AgentMcpConnection.toolNames必填且为实际过滤集合。子原生feature／全局工具本阶段完全不挂，也不额外挂time。同canonical UUID的后续reply从原普通授权重新取scope与工具，旧lease撤销；readOnly／scope／闭包policy只在RAM，原持久schema保持。只保证显式verify受控阶段不能发／写；是否需核实仍是LLM语义判断，不保证事实绝对正确。

主人已授权的实际Eating修复部署完成，最终类型／构建、回归及运行桥SHA一致、正常连接和页面读图证据见[本轮报告](../reports/2026-11-03-主Agent核实交接与实际部署验证报告.md)。前轮共享身份、自然多句／多条、canonical、整批和cold恢复一并部署完成，已有重复历史不merge／delete，旧unknown不重放或自动review。现场实际联系额度12／小时、native revision5 time＋web保持；记忆源码0.2只构建、真实0.1.1不安装替换。ADR-0040部分替代0035／0039的旧交接契约，以下阶段记录不代表本轮部署状态。

## 身份核实与自然表达（前轮阶段）

按[ADR-0039](../decisions/ADR-0039-统一身份核实与自然短消息.md)，[共享策略](../../plugins/harness/dsh/src/backend/conversation-policy.ts)提供身份／表达与主、子协调规则，[runtime-agents](../../plugins/harness/dsh/src/backend/runtime-agents.ts)将共享层及对应角色层合入各自唯一 complete provider。主人即使完全自定义正文，必需规则仍进入实际 request.system，保存正文／人格与类型隔离保持。跨会话事实由主先核实已有记录、获准记忆及对应会话事实；查询任务只核实回报不发言，随后给原会话子可披露事实与未知范围，自主自然回答，不以局部缺记录否认参与。独立短消息分别真实发送、不同且稳定 request_id、顺序回执，unknown 停止续发；不增加自动切句发送器、任意历史读取或第二Loop。范围与最终证据见[变更](../changes/2026-11-03-统一身份核实与自然短消息.md)及[报告](../reports/2026-11-03-统一身份核实与自然短消息验证报告.md)；真实实例需获准部署并加载后生效，脚本模型不保证真实LLM必然选同一路径，前轮自主活动／额度／sleeping／waiting不改。

## 本轮整合（2026-11-03，已实现并隔离验证、未部署）

[ADR-0038](../decisions/ADR-0038-空闲整批交接与统一会话身份.md)将交接改为空闲时整批取得所有可交接来源，并统一同对象普通入站／主动联系的后续子会话 UUID 选择。DSH 使用逐组 contexts 绑定和原生 idle／入箱反馈；记忆按真实来源分离。源码修复与隔离验证已完成，结果见[本轮报告](../reports/2026-11-03-空闲整批交接与统一会话身份验证报告.md)，尚未部署、不合并或删除已有历史。[主动活动行为改进](../plans/2026-11-03-主动活动行为改进方案.md)仅为方案，主动行为、默认值和主人配置未改。

## 外部记忆接入（2026-11-01）

外部记忆能力以[ADR-0028](../decisions/ADR-0028-OpenViking记忆能力与自动采集.md)、[ADR-0029](../decisions/ADR-0029-持续记忆会话与记录保留.md)和[ADR-0030](../decisions/ADR-0030-增量记忆提取与历史分段解耦.md)为当前契约：Host协调真实来源和短期RAM消息，DSH在原生准入之后召回及采集，固定Peer会话保留记录，增量提取与体积分段解耦。本轮整批输入逐组核验账号／目标与主人身份、分别召回并附scope标签；混合主轮次没有唯一记忆scope，不能拿首组授权用于整轮。各Peer只采集其原始来源，混合协调输出不复制给各Peer；原生主人追加输入保持self范围。记忆MCP范围含糊时明确拒绝，由对应会话子代理以真实scope查询。记忆故障不撤运输ACK；真实安装不升级、不远端部署。其他Harness需独立实现生命周期，详细范围见[使用说明](../operations/OpenViking记忆插件.md)。

## 依赖与唯一控制者

UI、通讯、队列与授权依赖公开Eating契约，具体适配器映射到实际运行时。通用Host不导入DSH Session、Preset或内部Context，插件不引用Host／Web私有源码。同一AI数据集只有一个活跃主认知控制者；子Agent是共享人格的执行者，不创建多个自主身份。

DSH复用系统安装的命令与 Web 组件，使用 Eating 专属的DSH_HOME、DSH_AGENTS_HOME、runtime-home和工作区，不借主DSH的Profile、会话或Key。Cordis是DSH内部实际依赖，不因此成为所有Harness的通用协议，也不代表Host最终插件底座已选定。

## 当前输入与交接

[公开SDK](../../packages/plugin-sdk/src/index.ts)定义HarnessEvent、HarnessDeliveryBatch和回执。规范化事件包含稳定eventId、插件／账号实例／登录账号／会话／发送者、时间和结构化content/text；接收时核验的角色、目标和资源引用经队列白名单保存，source始终external。外部正文不能产生主人授权。

[Gateway](../../apps/host/src/harness.ts)仅接受必填`deliverBatch(batch, signal)`，不存在单条deliver或逐条兼容循环。同工作区只允许一个主要接收者。可选isReady未就绪时不选批、不耗尝试，处理结束用wake恢复。

以pluginId／instanceId／accountId／conversationId／source.kind／targetId完整身份分组，SDK的groupHarnessEvents保持各组事件相对顺序。默认静默500ms、最长2000ms、条数触发10条、体积触发32KiB；静默从同身份可交接末条计，最长从首条固定。maxBatchMessages／batchTargetBytes只提前触发、不截断；任一身份就绪时，将所有身份无冷却的可交接前缀按global sequence一次交主Agent，不逐会话调用。单一完整身份的batch.conversationId为其ID，多身份为null；仍受总队列硬容量约束，不等于模型token或请求次数。

默认交接超时15秒，明确拒收后间隔10秒，最多5次包含首次；在途任务保开始时设置。同完整身份遇到冷却项即停，后续不能越过，其他身份继续。isReady=false不消费attempts；wake重新取全队列。DSH就绪依据受认证、递增且未过期的root原生idle／nextTurn及nextStep入箱为空反馈，500ms刷新、3s有效期，SDK run结束或turn/end本身不能证明空闲。状态检查与SDK enqueue非原子，其间竞争输入由原生串行Inbox承接，不能保证严格原子idle-only enqueue。反馈和wake只协调交接，Host不做第二认知Loop。

## 可靠性与无历史责任

只有accepted=true、durable=true、非空receiptId，且Host本地确认成功，才删除队列正文并记可靠接管。它不代表模型已读、轮次完成、任务成功或平台动作完成。

明确拒收才有限重试。超时、异常、中断、缺耐久证据与尝试耗尽保留uncertain，不能推断未发送并补投。本地确认写失败时最多保存一个无正文结果，只重试本地提交，不再次调用sink；注销／关闭的有限处理和重新登记恢复不构成旧版兼容。

[HostStore](../../apps/host/src/store.ts)只保存有界未交接信封，默认persistent、1000条、10MiB、reject-new。memory正文只在RAM，Host退出丢失；当前模式切换原子转移队列，失败保设置与正文。drop-oldest仅移最旧pending，保护delivering／uncertain；缩容／清空需要明确操作并保留账号和动作账本。

不转交的正文不保存，原始OneBot包和额外正文列不落库。短期去重为24小时小标识，常态最多10000个；磁盘清理也失败时含内存后备最多20000个。不存在历史库转换，旧schema／旧表写前拒绝，不自动读取成新队列。已交给模型的图片由Harness原生附件机制负责持久化；Eating不另建聊天或媒体库，不能据此承诺图片全链路不落盘。

## 分层规则与原生委派

原生能力与插件使用Eating专属Profile及正式管理入口，配置／安装与管理进程排他。[ADR-0036](../decisions/ADR-0036-功能插件与Harness原生功能默认边界.md)将新Harness原生feature收窄为仅time默认开启，其他由主人按需配置；Eating专属danger-full-access／approval never默认保持，已有feature选择不重写。main非reserved全局工具与所有Agent功能型native Profile MCP默认自动可用，其他子非MCP仍toolGrants精确选择；schema1可选toolAccessOverrides以同名精确指纹＋类型优先，可关main／空禁用，指纹变化不回落开放，catalog.automaticAccess说明默认，feature选择保持。Host新source默认all含未来类型／工具，custom为该source精确例外且可恢复all，accessPolicy为策略／自管null，grant为有效摘要。策略和来源拓扑一次性重挂，仅恢复原connected且同一启用实例，owner stop优先，不重放unknown；direct在途撤权可能source error需主人显式connect。通讯／资源scope保持。

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

main负责整体安排、轻量分流与必要协调。普通聊天／问答／生图优先eating_handle_conversation，必填context_ref／mode，可选≤8000的context_notes；主先理解请求和事实充分性，核对真实root、批次／digest、owner绑定及callId后，运行时固定中立task＋原始context/events＋coordination交绑定子。verify仅只读核实，reply子自主理解／回复／执行，main不预写全文或能力猜测。eating_delegate_task留明确执行任务或用户明确逐字用途，内部固定reply；跨目标先list再contact并显式mode，不要求新入站，不继承旧资源。子scope不足由main换执行者，真实目标回执分别核对。入口不接受任意system／tools／persona／scope，当前交接见[ADR-0040](../decisions/ADR-0040-主Agent核实交接与只读任务阶段.md)，默认策略继续按[ADR-0035](../decisions/ADR-0035-会话代理自主处理与默认开放可配置.md)。

适配器使用公开Agent创建钩子、Preset和in-process原生startActivation／sendMessage。后续普通入站与主动联系按parent root＋pluginId＋instanceId＋accountId＋agentTypeId＋kind＋targetId选择同一稳定UUID；优先现有普通绑定，否则现有联系绑定，否则新建。外部conversationId仍用于分组及逐组消息／资源scope，不把入口不同当成另建子会话的理由。已有重复UUID、原生日志和历史不自动合并、删除或搬运；本轮不清任何真实会话。普通／联系在途任务互斥，联系不继承旧入站引用，每任务取得最新系统与精确MCP。创建标签为“平台-绑定登录账号-私聊／群聊-目标”，名称使用注册pluginName或canonical pluginId及scope.accountId，不解析旧label猜账号；官方Web显示依官方机制，不承诺旧标题外观修正。

一个整批信封保留全局events并列出context.conversations，各contextRef与owner policy绑定一一对应；主在原生准入核对batch／digest后激活contexts映射，按组引用轻量分配，子只收到其组events和精确scope。同批可先查询再派同子发送；同对象多组可共用UUID，但引用及资源范围不合并。内部taskId来自公开exec.callId；同context最多32引用，pending拒并发，unknown只拒原contextRef／taskId，新批次新call可按ADR-0037复用child。actions／finish须匹配当前任务，迟到回调不能撤新权限；正文RAM在所属主turn/end清理，不在首次委派后清空，也不能由旧turn清掉尚未准入的新批次。

每任务独立临时MCP令牌，后台逐调用核对当前类型、账号／目标和引用，结束／断开／停用撤销。主不挂全权QQ，子保持受控委派边界；新Harness原生feature仅time默认，既存主人原生选择保持，verify子阶段完全不挂原生工具；普通任务功能MCP默认all，主人custom例外按精确类型／工具限制。DSH插件安装管理继续使用正式管理入口。Host回传实际动作回执，集合按任务隔离；子摘要不冒充动作，主普通final文本不自动发QQ。

主系统必需分流／委派／联系／自主规则与owner／persona合入主唯一complete provider，子会话自主规则合入子唯一complete provider。系统rc.5在存在complete时抑制普通section，普通contact／autonomy贡献不能独立承担必需规则；主与子层仍隔离。验收捕获本地模型实际request.system，工具可见、预览或脚本强制调用都不能证明规则已经送达或真实LLM必定自主选同一路径。

## 原生持久与服务边界

主／子入箱与父目录显式flush成功后才能确认接管，原子ACK含匹配nonce／批次／摘要。中断恢复通过当前公开原生记录核对并重建ACK，不重复prompt，不宣称exactly-once。ACK后尚未claim的持久输入按messageId／digest及existing bindings恢复受控路由，旧nonce不误归self记忆；原生send／remove无正文sentinel仅唤醒原已有Inbox输入，避免非空Inbox持续busy，不重新prompt正文或重放unknown。created=false就绪哨兵和同版固定UUID恢复继续保留；缺必要公开API明确失败，不用旧接口兜底。

每组路由结果独立：类型不可用或绑定100容量耗尽以context.routingError unavailable向主保留原事件，其他组可继续。对同child先reserve及本地flight gate，再drain／激活；临时scope保本批引用，Host每类最多100000项且两类UTF-8合计≤100MiB，超限拒绝不静默截断；持久binding仍严格schema2、各256历史尾项。memory context区分单scope实际值、混合null明确拒绝main记忆MCP、无flight undefined保原语义；capture按序列化messages每段最多200条／256KiB减1KiB预留，多来源或单外部分段只采各组原始user，native追加self独立。

适配器私有loopback通道仅prepare-task、actions、finish-task，随机令牌／nonce，只处理已绑定当前任务，不搬正文。Host必要scope连接、真实回执和撤权服务必填。

## 模型能力与图片输入

模型列表／测试仅用已保存endpoint/key，选择只写草稿。测试为最小Ping/max_tokens1，15秒、禁止重定向、解压后响应最多1MiB，错误不回显提供商正文或Key。不支持列表可手填；API连通、runtimeReady和业务成功分别表示。

模型能力按[ADR-0022](../decisions/ADR-0022-服务声明模型能力与就地展示.md)在模型名称附近自动读取服务声明。白名单模型目录独立schema1保存，按endpoint／Key摘要及精确model绑定，图片输入、上下文和输出容量自动进入原生模型元数据；未知/矛盾不根据名称推断。仅服务未声明图片能力时，使用专属[数据目录](../technical/数据目录与账号实例.md)的model-capabilities.json人工补充（schema1、初始false、CAS、停止后保存），换endpoint／model失效。每次输出上限保留主人配置，不自动扩大；服务声明不等于真实付费识图验证。

本轮图片CDN主机multimedia.nt.qq.com.cn的dns.lookup仅返回198.18.7.115，符合Fake-IP特征；SSRF对198.18/15保留段的拒绝发生在HTTP GET前。未确认具体代理来源，不记录QQ标识、签名URL、rkey或消息正文。本轮保留图片／SSRF策略，修复方向只说明用户网络DNS层恢复真实公网解析，或未来显式授权受信图片代理，不实施、不全局放行198.18／私网或开放目录。

API4工具必须声明resultFormat为json或content。QQ原39项OneBot工具保持json语义；新增qq_view_received_image返回标准MCP image内容，由原生MCP客户端转为附件并进入支持视觉的子Agent请求。图片只按当前账号／会话已授权的message与resource配对读取，网络取得后再次核验权限；主Agent先取得子摘要，未默认自动接收原图。纯文本能力拒绝真实图片并给明确诊断。网络与图片校验边界见[QQ架构](QQ与平台能力.md)。

## 时间上下文

主及普通reply子按已保存feature选择，在自身ctx各挂一次官方time-context；verify子本阶段不挂任何原生feature或time-context。注入依赖agents与sessionProjections，默认Asia/Shanghai，使用原生600000ms刷新间隔。只在已有合格step准备请求时判断追加读数；运行时user context位于历史末尾，source.kind为time-context，冷恢复从原生日志恢复注入状态。time-context本身没有新时间工具或后台唤醒模型；原生Schedule不再受Eating自主周期人工阻断，Eating暂停只控制其无输入机会，不冻结main或所有原生提醒。

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
