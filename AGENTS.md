# Eating 开发规则

2026-11-10 部署收尾：图片大小与语音源码8920db9已push并部署0.21.0，云端656项通过，原数据保留。公网检查补充修复语音停用时仍查询任务的根因；应用0.21.1、ui-sdk4.3.0、语音0.1.2，由Host传入真实enabled，停用只编辑配置、启用恢复读取、运行中任务才轮询。修复继续沿用本轮push／部署授权；最终状态见[本轮报告](docs/reports/2026-11-10-图片大小配置验证报告.md)。

2026-11-10 发布授权：主人明确要求“push 部署到服务器上”，授权本轮图片大小配置与已本地提交的语音插件一并提交／push，并由云端从GitHub拉取同一提交构建、备份和保留数据更新。当前发布处理中，完成以本轮部署报告的实际结果为准。

2026-11-10 图片大小：主人要求把 Eating 本地 5 MiB 限制改为可配置、默认 10 MiB。按[ADR-0052](docs/decisions/ADR-0052-统一可配置图片大小.md)，Host 独立 `host:image-limits` 严格 schema1／CAS，通过 `context.imageLimits()` 实时提供 1–50 MiB 单图上限，批次 2 倍／最多 4 张，可信 Base64／wire／上传预算统一计算。内置生图、表情、QQ 和预览共用；存储验证独立 50 MiB，调低保原图与索引，旧发送 lease 撤销，已接受生图沿用提交时上限。本地修改验证完成，本轮已授权提交／push／部署，发布处理中；前轮语音已本地提交 `66f01c0`。证据见[本轮报告](docs/reports/2026-11-10-图片大小配置验证报告.md)。

2026-11-09 OpenAI云端语音插件：主人已授权开始开发，本地开发与验证完成，本轮已授权本地提交，未push／部署。新增text-to-speech0.1.0，主人保存音色，会话子Agent按次选择delivery，不提供全局语气字段；官方Realtime单次合成、受控音频lease与QQ record发送，未知不重放。应用0.20.0、plugin-sdk4.10.0、QQ0.15.0，其他SDK产物消费者按封存规则补丁升级；锁文件仅新增workspace链接，无新外部版本。未调用真实Key／付费服务或真人QQ，最终实数和限制见[本轮报告](docs/reports/2026-11-09-OpenAI语音插件本地开发验证报告.md)。 完整构建／严格类型、全量1902项通过／11项条件跳过、11项相关浏览器及最终补充语音12项通过；真实Key音质与真人QQ播放未验证。

2026-11-09 自主调度边界：**实现、可行性验证、Git发布及云端保留数据部署完成**。源码`585a52e`由云端从GitHub拉取构建，应用0.19.0、plugin-sdk4.9.0、DSH0.18.0，API4及其他插件／依赖保持。新增主人可配置maxRestMinutes，默认15分钟，sleeping／waiting均到期重新考虑，暂停／忙碌／额度优先，不强制发言。主人同意修改并要求先完成实现再展示可行性，沿用会话内已有push部署授权。自主文件严格schema2；本次停Eating、私有全量备份与原SHA核对后，由GitHub独立工具显式转换schema1→2，保其余配置、note、历史、计数、暂停及错误状态。旧次日10:00长休息缩短到当日22:29:41，原人格／自定义正文／Host settings／数据库行数与schema／会话身份／3份原生日志前缀／Token保持，五插件connected、DSH／nativeWeb ready、异常restart0。本地1881项通过／11项条件跳过、21项相关浏览器通过，云端551项通过；未清历史，不改主DSH或官方Web。证据见[可行性与部署报告](docs/reports/2026-11-09-自主调度边界与可行性验证报告.md)与[ADR-0050](docs/decisions/ADR-0050-自主思考休息上限.md)。

2026-11-09 自然聊天与自主活动提示词：**本地验证、Git发布及云端保留数据部署完成**。应用0.18.1、QQ0.14.2、DSH0.17.1，源码`551e4af`已push并由云端GitHub取同提交构建。区分正常接话／围观／收尾，普通聊天先回应当下，自主机会明确真实社交选择与sleeping／waiting。现场common按正式CAS从revision1升至2，仅修改相关表达要求和匹配旧默认尾段，其余自定义正文／人格保留。调度、权限、额度、其他插件及依赖保持。主人已明确授权本轮修改、push与部署，由主代理独立完成。全量1868项通过／11项条件跳过、14项浏览器验证通过；云端591项回归及构建／类型通过，私有全量备份后更新，五插件connected、DSH／nativeWeb ready、异常重启0。原配置、会话与3份原生日志前缀核验通过，未清历史。自主运行原已开启且未暂停，本轮通过既有wake给同一主Agent一次重新规划机会，最终安排与证据见[本轮报告](docs/reports/2026-11-09-自然聊天与自主提示词部署验证报告.md)及[ADR-0049](docs/decisions/ADR-0049-自然聊天与自主活动提示词.md)。 既有wake后的自主轮次已完成，AI自行选择sleeping并登记下次唤醒，未暂停、无错误。

2026-11-04 Harness 历史会话清理最新授权：**本地验证及云端发布部署完成**。用户在独立预览后明确要求“部署到服务器上”，授权本轮commit／push、云端GitHub拉取构建和Eating更新，由主代理独立完成，不再启动子代理。仅部署功能，不执行真实历史清理，不动主 DSH 或当前 GUI。按[ADR-0048](docs/decisions/ADR-0048-Harness历史会话清理.md)实现主人专用“历史会话”页签及离线扫描／确认清理，全部 SDK、子运行时、原生 Web／helper 真正退出且 Host 无待交接消息才可维护；API 不注册为 MCP 工具。应用0.18.0、QQ0.14.1、生图0.3.1保持，本地 DSH 插件从前轮云端0.16.0升至0.17.0，SDK等保持、无新依赖。本地实现与验证完成：完整构建／严格类型、最终1871项通过／8项条件跳过及9项历史页浏览器通过；独立预览已扫描1主2子示例，未点击清理。源码 `29387f9` 已commit／push，服务器从GitHub拉取同提交完整构建和Linux14文件410项回归通过后，私有全量备份并同data更新DSH0.17.0。公网历史页和运行中拒绝扫描已核验，五插件connected、DSH／nativeWeb ready、异常重启0；配置、图片、3份原生日志前缀、会话身份、账本、17条记忆任务身份和Token保留。未调用真实清理接口；记忆范围仅lastSeenAt动态时间变化，设置不变。完整证据见[本轮报告](docs/reports/2026-11-04-Harness历史会话清理验证报告.md)；下方旧发布与真实清理记录保留历史事实。

2026-11-04 本轮最新授权：**本地验证及云端发布部署完成**。用户初期“先修改提示词吧”阶段仅本地修复，随后明确“push 发到服务器上”，授权本轮Git发布与云端Eating更新，替代此前云端只读限制。按[ADR-0047](docs/decisions/ADR-0047-图片消息结构提示.md)明确 `message` 为 image 段对象／数组，不 `JSON.stringify` 或把 URI／图片 JSON 当 text；复用已有图片，实际 image 调用及成功回执才可称发送成功，unknown 不重发。只调整 QQ 共享规则、默认私聊／群聊及主插件说明、消息 schema 的 description／examples、生图使用说明与取图描述；不新增图片工具／后端拦截／回执字段／环境自动检测，保留 `eating-asset`、参数校验、权限与 file／Base64 选择，不覆盖人格／自定义正文。QQ0.14.1、生图0.3.1各四处版本同步，其他版本保持；不真实QQ试发／付费生图。本地完整构建／严格类型、378项相关测试（0跳过）及7项浏览器通过，未重跑全量；源码 `f8b0d51` 已commit／push，云端从GitHub拉取同提交，完整构建／严格类型及Linux363项通过后，只停Eating并私有全量备份，同data安装QQ0.14.1／生图0.3.1。正式四提示／主bridge及工具description／数组examples已更新；五插件connected、DSH／nativeWeb ready、service active／enabled、异常restart0、队列0，保存配置／人格／业务数据保持，公网页面与工具示例实读通过。完整证据见父代理维护的[本轮报告](docs/reports/2026-11-04-图片资源发送提示词验证报告.md)，不将提示指引宣称为代码强制防漏保证；下方旧阶段授权与证据保留历史事实。

## 当前授权与默认兼容策略

负责人已明确：**除非用户明确要求，否则默认不兼容旧版本。当前未发布，即使以后发布，也不自动保留旧 API、旧配置、旧存储格式或旧功能的兼容行为。**

- 功能代码只实现当前契约。不得自行添加旧版读取、自动迁移、字段补齐、默认种类推断、转发文件、旧别名入口、双分支或“先试新接口再回退旧接口”。
- 当前调用方、测试和文档随架构一起更新。旧格式明确报错且不覆盖原数据；不能为维持旧测试而恢复兼容层，不能通过改名隐藏兼容逻辑。
- 真正的新实例可以使用完整当前默认配置；当前接口明确规定的 PATCH、空 Key 保持、正常重连、同版故障恢复、原生 ACK 重建和幂等不是旧版兼容，应保留其正确性。
- OneBot v11 的正式参数、消息形态和协议别名，以及 OpenAI 接口支持，是当前外部协议能力，不属于旧 Eating API 兼容，不因本规则删除。
- 删除兼容代码不授权删除、重置或自动转换用户真实数据。没有明确数据处置指令时保留原文件，让用户显式选择当前格式的数据或新的 `EATING_HOME`。

负责人于2026-10-29进一步明确：**“原生web保持原生，不要去修改”“不要你的只读限制，保持原始dshweb即可”。** 原生Web必须使用官方界面、侧栏、主题、消息组件及正常操作；不得注入Eating客户端、CSS、Slot替换、LocaleBridge或额外reader Peer／命令白名单／只读Controller。只保留同一Eating专属DSH进程的服务接入与主人按需取得官方鉴权入口。此前[清单](docs/plans/2026-10-29-原生Web与多模态改造确认清单.md)中的自定义显示与只读部分由本次明确纠正替代，其余受控QQ代理、time-context和MCP图片能力保留。Web恢复完成后，用户进一步明确要求“修改读取图片的功能，让功能正常”，授权修改取图实现本身：删除插件自行预判公网地址的做法，改由系统网络栈解析与路由，使直连、TUN／Fake-IP、系统代理和局域网部署一致可用；仍保会话授权引用、禁重定向、不传认证头、大小／超时与格式校验，不改用户网络或代理配置。不清空资料、不改主DSH，不force push或自动发布。

负责人于2026-11-02最新明确：**主 Agent 负责整体安排、轻量分流与必要协调；普通会话由绑定子 Agent 自行理解、组织回复、选择工具、执行并回报真实回执。默认功能全开放，同时保留主人显式配置能力。** 按[ADR-0035](docs/decisions/ADR-0035-会话代理自主处理与默认开放可配置.md)，已启用且connected的capability／direct MCP新来源默认all，当前／未来工具和类型自动纳入；主人可保存custom精确类型／工具例外并恢复all。原生全局工具也保留自动／自定义覆盖。此纠正替代[ADR-0034](docs/decisions/ADR-0034-主Agent自主决策与功能能力默认开放.md)中删除save-grants／不可配置及普通会话都经task预写的部分。通讯仍核验真实账号／目标／资源scope；新Harness原生feature按ADR-0036仅time默认开启；Eating专属danger-full-access／approval never默认保持，主人可显式再配。必需主／子规则各合入唯一complete provider，不reset自定义正文／人格，不改主人主DSH或官方Web。主人另已授权删除Eating本地主／子会话，云端自行删除；实际清理、测试、Git与部署由[本轮报告](docs/reports/2026-11-02-会话代理自主处理与默认开放可配置验证清理报告.md)记录，不把审计视为apply完成。

负责人于2026-11-03进一步明确：功能型插件默认开放，不代表Harness内置功能默认全开。按[ADR-0036](docs/decisions/ADR-0036-功能插件与Harness原生功能默认边界.md)，新Harness只开启time，其他原生feature保留配置、按需启用；既存主人选择不自动覆盖。现场revision5的time＋web由主人明确保存，部署须保持。

负责人于2026-11-03明确公网HTTP面板修复按[ADR-0044](docs/decisions/ADR-0044-HTTP前端安全请求标识.md)：公网非安全上下文没有randomUUID，localhost隧道secure=true不能替代真实HTTP回归。前端统一公开UI SDK `createRequestId()`，始终getRandomValues16字节构造RFC UUIDv4，无randomUUID分支或Math.random／时间／计数器；同意图与unknown保原ID，不自动换号重发。Node后台UUID保持；表情包功能保持，仅共享SDK导出使压缩UI产物字节变化，按封存不可变规则升0.1.2，不加依赖／HTTPS／网关／防火墙。本轮源码验证与既存云端数据保留更新已完成，修复提交 `ab19cbb` 已本地commit／push并由云端GitHub取同提交构建运行；最终全量1743项通过／8跳过、最后4项浏览器通过，真实公网HTTP非secure下QQ面板与UUIDv4原号复用正常，12受保护文件哈希、Host设置／数据库、插件配置摘要与ownerToken保持。前轮“不操作云端”不撤回本次明确授权，本机真实记忆0.1.1不动。真实服务器值与别名仍只存项目外，缺依赖仍先询问安装；最终证据见[本轮报告](docs/reports/2026-11-03-公网HTTP面板修复与保留数据更新验证报告.md)，未验证不写完成。

负责人于2026-11-04明确授权本轮修复及云端Eating更新：按[ADR-0045](docs/decisions/ADR-0045-官方记忆接口与插件部署提示.md)重做官方OpenViking connector，逐轮标准messages/batch同步、commit归档提取、Task API查询，不强制server extension、不只删guard、不保双协议fallback。config／state严格schema3，移除archiveMaxMiB，autoCommit默认true／commitTokenThreshold默认20000（1～1000000），阈值／压缩／正常结束尊重开关，manual可强制；固定eating-standard-<peer>[-local]，不接管旧eating-live，unknown不重发，已知task只GET恢复。按[ADR-0046](docs/decisions/ADR-0046-可信图片传输与生图尺寸.md)增加可信图片asset／lease及主人确认共享目录，发送前逐图校验，否则选Base64，不宣称已自动实测OneBot远端file；AI只见opaque refs。生图单次size优先默认、空串省略用服务默认，provider决定支持，不换尺寸付费重试；Key可选，DSH提示以服务器检测为准，QQ须OneBot先登录。

本轮已实现并完成本地及云端验证与部署。源码 `91b18c3` 先本地commit／push；首候选云端构建exposed Linux Buffer深比较5s超时，等价native `Buffer.equals`＋长度断言修复为 `72fecad`；云端GitHub拉取该提交完整build及扩展Linux回归通过后，只停Eating、私有全数据备份、确认旧记忆state schema2且jobs0／scopes0，再由GitHub独立transition工具显式转schema3：config revision+1、archiveMaxMiB→autoCommittrue／commitTokenThreshold20000，保Key／endpoint／user／rules，空state仅schema2→3保其余metadata。正式五插件同data目录安装运行，全部connected、DSH ready、nativeWeb ready、gateway idle／queue0、service active／enabled、异常restart0、tracked tree clean；生产无自动迁移。

本地完整1824项通过／8跳过（122.16s）、build／type通过、24项相关浏览器通过，官方stock3项实跑、未加载扩展。首raw hash比较有11个DSH正常派生／运行文件变化（nonce／outcome／bridge source／systemprompt／url／index record rows／日志追加），无缺失；不写全文件逐字节不变，按语义保留＋私人备份报告，不将strict false当数据丢失或回滚。Host settings／各表行数／schema、除明确memory转换外的保存配置与Token、原native UUID、2份原生日志prefix均保持。媒体默认auto且无confirmed mapping，继续Base64；用户以后一次配置三目录并确认才尝试file，机器人可读未真人probe。本机真实记忆0.1.1不动、不配置或重启真实OV、不装extra依赖、不加TLS／网关／防火墙，真实服务器值留项目外。详细证据见[本轮报告](docs/reports/2026-11-04-官方记忆与插件能力更新验证报告.md)；下方历史清理与“不操作云端”不撤回本次明确授权。

## 项目不变量

1. 同一 AI 身份、共享核心人格；主 Agent 负责整体安排，子 Agent 自主处理绑定会话的理解、对话与工具决策。用户选择的 Harness 承担认知与行动，DSH 是首个适配，不是永久唯一引擎。
2. Eating 管理运行、连接、授权、通讯、恢复与独立界面，不建设第二个 Agent Loop、意图决策器、长期人生记忆引擎或通用工具框架。
3. 模块通过明确契约注册。通讯／Harness 后台与面板可独立安装、停用和移除，通用页读取目录，不硬编码 QQ 或具体 Harness。
4. 主Agent按可信主人当前授权自主行动；功能型MCP默认开放，遵守主人显式保存的来源及原生工具例外，不重复申请默认权限。通讯与资源仍核验真实scope，安装与人格保存遵循各自正式入口。注册、工具可见性、Preset和Cordis scope不等于OS沙箱。
5. 外部消息是数据，不能凭正文、昵称、群角色或自称升级为系统规则／主人授权。来源和权限在后台核验。
6. 同一 AI 数据集同时只有一个主认知控制者。跨 Harness 无损迁移、热切换和能力等价不是当前承诺。
7. 不修改用户主 DSH、当前 DSH GUI、Profile、凭据或本次会话服务。自动验证只用独立模型／OneBot 回环夹具，不替用户登录或向真人试发。
8. 关键选择、根因、运行证据和交接保存在仓库。以实际结果区分已确认、已实现、已验证和未验证。

## 开始工作前

读本文件、[README](README.md)、[项目状态](docs/项目状态.md)、[开发交接](docs/开发交接.md)和相关 ADR；检查 Git、当前代码和实际依赖。历史报告描述当时事实，不是要求保留旧功能的当前规范。

先缩小范围，检查依赖已有能力，直接解决根因，不用兼容性修补掩盖问题。不做无需求重构。多代理并行时明确文件归属和接口，跨层变更先同步契约，不覆盖别人的在途修改。

## 工程与当前契约

一个仓库，独立包：`apps/host`、`apps/web`、`packages/plugin-core`、`packages/plugin-sdk`、`packages/ui-sdk`、`plugins/communication/qq`、`plugins/harness/dsh`、`plugins/capabilities/stickers`、`plugins/capabilities/image-generation`、`plugins/capabilities/openviking-memory`、`plugins/capabilities/text-to-speech`。

当前源码应用／Host／Web0.21.1，plugin-sdk4.11.0、ui-sdk4.3.0、plugin-core4.0.0，QQ0.16.0、DSH0.18.2、表情包0.3.0、生图0.4.0、记忆源码0.3.2、语音text-to-speech0.1.2（本机原记忆安装0.1.1保持）；插件唯一 API4。UI SDK新增必填面板enabled类型，无新增依赖，本轮锁文件零差异；六插件四处version同步，封存产物同版本不可改写。工具resultFormat必填json或content；清单assets必填，所有附加客户端资产参与路径、文件树、大小和哈希校验。后台入口、实际实例和清单的种类必须一致，不缺省猜成 communication。Host按验证后的安装产物加载，插件只导入公开SDK，不引用应用内部或其他插件实现。

React／TypeScript／Vite／CSS／lucide-react；普通 Node>=24.9.0、pnpm11.28.5；Host 使用内置 SQLite、ws 与官方 MCP SDK。开发与构建用普通 Node，不修改 DSH 签名或借主运行时绕过原生依赖问题。Host 最终插件底座、Tauri、OS 隔离和其他平台能力仍须独立验证。

QQ授权资源通过getAsset取得Host lease，读前后复核同source／callerlease／scope／signal／图片设置revision及实际字节／SHA-256／MIME；AI预览仍走Base64读取，发送不先展开预览。主人确认且逐图验证共享映射后可用标准file，否则发送前选Base64；未知不换传输重发。仅最终可信Base64计算额外预算：单图默认10MiB／可配1–50MiB，批次2倍／最多4张，Base64及wire按ADR-0052派生；扣媒体后普通wire≤1MiB，入站／响应／ws1MiB保持，模型不能提供预算、任意路径或映射。独立media-transport.json/schema1在账号data、owner-only get/save，不新增public媒体服务。autonomy按code区分额度／暂停／禁用／stale／CAS／输入，contactLimit只读派生，签lease前及计数时核验，保持主人实际小时额度；控制层保真实statusCode／outcome及脱敏details，不按409猜unknown。

跨进程输入有协议版本、严格形状校验、超时、来源与关联标识。错误区分不支持、未发送、失败、未知和成功；未知外部动作不盲重做。不得吞异常或把缺必要接口当成默认成功。

## 数据与持久化

统一 `EATING_HOME`，默认 `~/.eating`。QQ 账号放 `bot/qq-bot/accounts/<instanceId>/config.json`，索引为 `accounts.json`；Host 队列、动作账本和锁放 `host`；Harness 数据放 `harness/<声明目录>`。DSH 使用自己独立的 DSH_HOME、DSH_AGENTS_HOME、runtime-home 与工作区，不借主 DSH 的 Profile／Key。

只接受各自当前格式：Host SQLite `user_version=1`、作者 schema2、QQ 配置 wrapper schema2、DSH 代理绑定 schema2；账号索引、安装索引和 DSH 配置／会话各自保持其当前严格 schema1。direct MCP连接文件改为严格schema2且无grant；旧schema1拒绝并保原文件，不转换。Host策略独立存host:mcp-access-policies，严格schema1／revision／policies，目录CAS为direct＋policy；旧host:capability-grants不读／不写／不迁移／不删。native-capabilities schema1允许可选toolAccessOverrides，缺省不补写，保存省略保持、[]恢复自动。版本号不是统一迁移开关。旧 schema／缺字段／旧表在写入前拒绝，不自动转换或标成新版本。

Eating 不建立聊天历史库；只保存有界未交接规范化信封。senderRole／resourceIds 等公开来源元数据必须经队列校验和持久保留。可靠交接要求原生 `sessions.flush` 成功与匹配原子 ACK，接收不等于模型已读、任务成功或动作完成。保留当前重启恢复和幂等，不自动重放 unknown。

内存队列退出丢失未交接消息；持久队列可恢复。容量、聚合和冷却必须真实生效。清空／缩容有明确确认，不删除账号配置和发送账本。实时日志仅可见页签订阅，浏览器内存有界，隐藏／离开停止并清空，不落盘、不后台缓存、不补历史。

本轮主人已授权删除Eating本地主／子会话；执行者须先停所有目标Eating端口和worker，再按审计精确白名单清原生日志／派生缓存／附件及相关备份，混合文件只清会话／任务字段，旧备份queue单独清，保config／凭据／persona／资源／actions／dedup／settings。记忆0.1.1正文仅RAM，停机后清本地及备份state任务元数据；不生成含正文新backup。审计不等于apply；上述清理及停机属于前轮历史交付，当前QQ／DSH／记忆已正常connected，不沿用停止指令；本轮不再清历史、不操作云端。助手主DSH／60182绝不动；localStorage草稿和OS快照未覆盖，不声称全机forensic抹除。

## 代理、人格与工具

主系统层：common→main→启用插件使用说明→统一当前人格；子：common→subagent→类型独有→同一人格。DSH必需的主分流／委派／联系／自主规则与主人组合进入主唯一complete provider，子会话自主规则合入子唯一complete provider，不能另注册会被complete抑制的普通section；owner／persona与子类型保持隔离。只有6种模板作用域和9个可信变量，无旧群私消息模板和外部正文变量。人格最多启用一个，也可全部停用，明确显示空共享层，不编造其他 AI 身份。

人格模板只生成新增人格的可编辑草稿，不自动保存或启用，名称由主人填写；保存后是普通人格，模板更新不改已有正文。本轮AI女儿模板依据上下文与可用记忆延续经历，不指定记忆插件或预设成长阶段。提示词文档 updatedAt:null 表示跟随当前默认，非null为主人覆盖；恢复默认保留记录并递增文档/全局revision，不删除归零或自动覆盖自定义。schema2保持，普通读取不回写默认。见[ADR-0027](docs/decisions/ADR-0027-人格模板与默认提示词生命周期.md)。

DSH主提供会话处理／列类型／明确任务委派、活动状态／安排、联系对象／联系委派工具。普通会话优先eating_handle_conversation，仅{context_ref}；核对真实root／当前批次及digest／owner绑定／callId后，固定中立task＋原始context/events交绑定子，main不预写完整回复或未经核对的能力结论。eating_delegate_task用于明确执行任务或用户明确逐字内容。新Harness仅time默认开启并供主子使用，文件、shell、网页、目标等原生feature默认关闭且可按需配置；main非reserved全局工具、所有Agent功能型native Profile MCP默认自动可用，其他子非MCP仍精确名称／指纹选择。主人可用同名toolAccessOverrides按精确指纹＋类型覆盖默认及toolGrants，可关main、空列表禁用；指纹变化仍限制，不回落开放，reserved／来源／scope不绕过。UI逐项自动／自定义可保存，catalog.automaticAccess说明默认；tools/change更新native.restrict。Host功能MCP默认all，custom来源只按精确类型＋工具，新增项不自动获该例外source。子按真实账号／会话／目标／类型绑定独立原生会话，挂受限通讯及当前有效功能能力。deliverBatch仍唯一交接接口，scope／真实回执／撤权服务必需，不回退主人全权令牌。

同批允许查询→主判断→继续委派同子。内部以公开 `ToolExecutionInput.callId` 防重；不把任意 system／scope／tools 参数交模型，不用任务文本 hash 代替调用 ID。普通入站最多32引用；pending拒并发，unknown只拒原contextRef或原taskId，新context＋新call允许复用同child并重取scope；仅淘汰旧completed／failed，unknown／当前批次不淘汰，满则capacity。启动旧pending转unknown保原nonce；迟到actions／finish须匹配当前pending任务，不能覆盖新任务或撤新权限。详见[ADR-0037](docs/decisions/ADR-0037-未知委派隔离与受控图片发送预算.md)。当前正文在主 turn/end 清理，不能在第一次委派后清掉。

QQ保留39项标准JSON工具，另有qq_view_received_image内容扩展，共40项。手动副作用需确认和稳定request_id；子只用当前类型可范围化的已选集合，每次核对账号、目标及消息／图片引用配对，异步查询和下载后复查权限。保存读取不自动给已保存权限补新工具；本次显式部署的必要许可更新使用完整字段＋CAS且保留其他选择。

MCP scope、Prompt、Preset不等于远端资源或OS沙箱。标准OneBot文件／URL／Base64仍交协议端处理；仅受控图片扩展取得真实收到段的图片URL，解析与路由交给系统网络栈（兼容TUN／Fake-IP、系统代理与局域网部署），禁重定向／凭据传播，当前图片设置／10秒与格式校验，不接受任意URL／路径，不读磁盘或猜远端下载端点。MCP图片通过原生附件，可随原生会话持久化；Eating不新建媒体聊天库。凭据及图片payload不进普通UI执行记录，临时Blob在隐藏／离开／停用／取消时撤销；不声称全链路不落盘。

模型列表／最小真实连接测试使用已保存配置；选择只改草稿。按[ADR-0022](docs/decisions/ADR-0022-服务声明模型能力与就地展示.md)，模型能力紧邻模型名称自动读取服务声明，图片输入及容量元数据自动采用；未知不猜，只有服务未声明时才在同区折叠手动补充。人工图片声明保持独立schema1＋CAS，默认false，仅停止Harness可保存，换endpoint／model失效；模型目录独立schema1，以服务／Key摘要和精确模型绑定。每次输出上限不自动扩大。声明不等于提供商已验证，API连通、运行时就绪与任务成功分别报告。

DSH 不自行下载运行时：检测系统安装的 `dsh`（EATING_DSH_BIN → PATH → 常见路径 → macOS 应用包），用 `launch/dsh-system.mjs` 转交层启动，`DSH_HOME`／`DSH_AGENTS_HOME` 仍指向 `~/.eating`。找不到时明确提示用户安装，不猜路径、不静默回退到自装。CLI overlay 只列官方裸包名（从系统安装解析），我们自己的 bridge 用绝对路径。用户已要求移除插件自有会话看板，改为“打开 DSH Web”按钮。复用系统已有官方 Web 组件与 SDK 同进程、同会话运行，配置保留在 Eating Profile 自身可写层；不额外下载 Web 或运行时。公开状态仅 nativeWeb.ready，主人点击时按需取得鉴权 URL；URL 不入普通状态、模型上下文或本地存储。不保留 list-sessions／read-session 或备用看板。原生 UI 和正常操作不增加自定义只读层。详见[ADR-0018](docs/decisions/ADR-0018-系统DSH原生Web与看板移除.md)。

实例名含真实绑定账号，正常恢复复用稳定UUID，不从旧label猜账号；本轮主人明确清主／子会话后，再运行创建新UUID，人格身份不变。默认系统层去实时时间；原生time-context在主、子对应scope各挂一次，上海时区、600000ms，不另加调度或时钟工具。当前9变量仍可手写使用，含动态变量的自定义正文对缓存的影响应如实报告。

无输入时的定时机会按[ADR-0023](docs/decisions/ADR-0023-自主活动协调与主动通讯授权.md)由同一主Agent原生followup接受，外部消息/原生目标/Inbox优先，机械检查不请求模型。autonomy.json/schema2保存配置CAS、主人maxRestMinutes（默认15分钟）及有界sleeping／waiting安排、主人暂停、AI安排revision、窗口额度、周期nonce及有界无正文结果；保存与开启分开、默认关闭。enabled/ownerPaused只控制此类定时机会，普通有输入轮次仍可联系获准目标；真正自主机会取消撤销该轮许可。

AI未来一次性任务按[ADR-0032](docs/decisions/ADR-0032-AI定时任务.md)，主Agent在自主运行开启且未暂停时用eating_schedule_task/eating_cancel_scheduled_task按agenda revision创建／取消，eating_activity_state返回agenda。autonomy-agenda.json/schema1独立保存最多50条、128KiB、每条最多2000字符、未来1秒至365天的任务。到期每轮最多10条合并为同一eating-autonomy机会，可打断sleeping/waiting，仍受主人暂停、额度、runtime及周期限制；cycle持久登记后移出agenda，投递与读取间中断按unknown处理，不重放已进入会话的任务。主人概览可见可取消，取消不撤回已进入会话的机会；当前agenda无重复规则。按ADR-0034移除自主周期对原生DSH schedule_create/schedule_update的人工阻断，原生Schedule保官方语义；Eating暂停不冻结main其他能力，也不承诺暂停所有原生提醒／目标。

联系权限按[ADR-0033](docs/decisions/ADR-0033-主Agent当前轮次联系权限.md)绑定真实主Agent当前原生turn；QQ群/私聊、原生主输入、目标续行、定时唤醒均可自主调用eating_list_contact_targets/eating_contact_target委派受限子代理，无需目标先发私聊。先选实际行动目标：当前会话普通聊天／问答／生图优先eating_handle_conversation，仅真实context_ref交绑定子自主处理；明确执行任务或用户明确逐字内容才用eating_delegate_task；跨私聊／群聊先list当前对象再contact，工具自动启动／恢复对应受限子，不要求新入站。群context不能冒充私聊；某子scope不足不等于主无能力，群回复成功不等于私聊成功。逐次核对账号/对象/工具，所有联系任务计入maxContactsPerHour；策略保存、turn结束/abort/销毁/运行时停止撤旧许可，资源取得后及发送前复查。proactive-bindings.json保持schema1，cycleId保留为内部轮次引用，不迁移或恢复旧许可，新runtime把pending转unknown。每目标当前轮次32个callId上限防遗忘，重复/pending/unknown拒绝，迟到回调不改unknown；核对后解除任务阻塞不删动作账本。普通入站保持deliverBatch，内部活动有独立受信来源，不伪装external或主人指令。

## UI 与文档

保持白绿风格、固定视口、主区／二级栏独立滚动、页签完整吸顶范围、键盘焦点可达。平台提示词按pluginId合为一个可折叠条目，名称来自当前目录元数据，折叠不能改变编辑器／路由／草稿。看板正文滚动时会话导航保持可见，长目录自身滚动；页签使用宿主边距与统一上下留白，正文末端／页脚不能推出导航。保留[滚动回归](tests/browser/scrolling.spec.ts)与[面板布局回归](tests/browser/panel-layout.spec.ts)，不能只凭DOM坐标宣称绘制正确。

固定 UI 文案、ARIA、诊断、补全、错误、数值和日期使用模块双语资源及公开 ui-sdk；默认简体中文，可切英文。locale 不进入网络 effect 或重挂 key，不能丢草稿／选区／撤销或触发保存／发送。用户内容、Key、URL、模型名、消息与 canonical 变量不翻译。严格 CSP 不增加 unsafe-eval。

界面颜色只能使用 `apps/web/src/styles.css` 的语义令牌，禁止在组件或插件 CSS 里写颜色字面量；新增颜色须同时给出浅色与 `prefers-color-scheme: dark` 值，并保持正文 ≥4.5:1、次要文字 ≥3:1。

README 用中文作为标准入口；其他文档标题／文件名中文，技术标准名可保留。每次有意义变更同步 README、规范、状态、交接、待确认问题、变更日志和相应 ADR。历史报告保留数字和当时结论，当前策略变更另写决策，不篡改历史证据。

## 服务器连接信息与部署隐私

负责人于2026-11-03明确：**真实服务器连接信息不得写入本项目；即使文件已被Git忽略，也不得放在项目目录中。**

- 真实IP／域名、SSH端口、登录用户名、主机指纹、密钥内容或位置、密码／Token、跳板机、实际部署目录及它们的关联映射，只保存在项目外的本机SSH配置、凭据存储或私有部署配置中；不写入源码、环境文件、脚本、测试夹具、文档、报告、截图、构建产物、Git提交或提交说明。仓库只使用明显的示例占位符和通用参数，不登记真实SSH别名到目标的映射。
- 用户可以仅提供本机SSH别名。助手只在已授权部署所需的最小范围解析和使用外部配置，不要求用户在聊天中粘贴私钥或密码；不得把实际连接值另存到项目、临时项目文件或长期记忆中。
- 通用部署脚本从项目外配置或运行时参数取得目标；配置路径、实际服务器目录等用户私有值同样不硬编码到仓库。Git忽略规则不是允许保存真实服务器信息的例外。
- 部署命令、工具输出与日志采取最小展示和脱敏，不使用会回显连接配置／秘密的调试方式，不把完整SSH配置、带凭据URL、原始远端日志或未经检查的截图复制到对话或项目报告。部署报告只记录必要的脱敏目标标识、版本、验证结果及限制。
- 提交／push前核对暂存路径和新增内容，确认不含真实连接值、密钥或私有部署配置；误入工作区时先停止传播，明确报告并按用户指令处理，不擅自删除真实配置、改SSH配置、轮换凭据或改写Git历史。
- 本约束规定信息保存与披露边界，不构成连接服务器、安装、重启、迁移、自动部署或持续后台更新的额外授权；实际动作仍按用户当前明确范围执行。
- 负责人进一步明确服务器部署流程：缺少运行时、依赖或工具时，必须先说明清单、用途和影响并询问是否安装，不因部署授权自行批量安装。只处理Eating部署，不擅自增加HTTPS、证书、网关或其他外围服务；防火墙由用户自行配置，完成时提供必要端口，不操作防火墙。
- 云端项目代码及通用部署脚本统一由本地修改和验证，先commit并push到GitHub，再控制云端从GitHub拉取已确认提交进行构建／更新。不得直接改写云端项目源码、上传本地工作区或用源码包绕过该链路。真实服务器连接值、密钥、部署位置及其他私有运行配置仍按前述约束留在项目外，不能因要求云端拉取而提交到GitHub。

## Git 与完成条件

所有提交使用中文标题和说明，包含“修改原因”“修改内容”，必要时列“验证结果”。用户要求先提交再重构时履行指定顺序；当前任务的提交与推送按其明确授权执行。

```text
用中文概括本次修改

修改原因：
说明已确认需求与具体问题。

修改内容：
- 列出本次功能、接口、目录和边界变化。

验证结果：
记录实际检查与未验证范围。
```

提交前核对暂存范围和敏感数据，禁止提交用户配置／凭据／聊天正文／构建产物／临时截图。保留未授权修改，不 force push 或重写旧历史。

前端至少完整构建和严格类型、相关单元／集成与浏览器验证，并实际读图。原生 SDK 测试须显式设置独立 `EATING_DSH_TEST_RUNTIME`，系统 DSH／Web 集成通过 `EATING_DSH_TEST_SYSTEM_BIN` 选择系统命令并使用临时数据，默认跳过不能冒充实跑；没有旧版本迁移测试要求。真实数据未经授权不部署、不重置。

最终用简洁结果说明代码、文档、验证、提交／push及剩余限制；详细证据放本轮报告，未运行不得写已验证。实际本地模型request.system含规则是必需证据；工具可见和强制脚本回环不能证明真实LLM一定自主选择相同链路。

## MCP 与能力插件（2026-10-30）

侧栏的“插件”统一管理communication／harness／capability，机器人和Harness是业务视图；每个插件自带独立面板，通用页面不能硬编码QQ或表情库。MCP支持直接stdio／StreamableHTTP与插件来源，复用官方SDK。新功能来源默认all，全部当前／未来工具与Agent类型可用；主人可保存custom精确名单及恢复all。McpServiceSummary.accessPolicy为当前策略，自管来源null；grant为当前有效目录摘要。save-grants严格收{id,expectedRevision,mode:all}或{id,expectedRevision,mode:custom,agentTypeIds,toolNames}，direct save仍只收连接不混grant。策略变更随来源拓扑一次性重挂，owner stop优先、unknown不重放；direct在途撤权可能中断transport并使source error，需主人显式connect。通讯仍permissionsManagedByPlugin，不通过通用页绕过QQ scope。

直接MCP保存不执行命令，stdio不经shell，私有env/headers/URLquery不回显；秘密编辑省略保持，明确clear才删除。新增、连接、断开、工具目录变化及能力插件生命周期变更使用一次性重挂事务：先撤lease并停受影响Harness，await来源／目录变更完成后，仅对变更前connected、仍为同一实例且启用的Harness恢复一次。原stopped／error不自动启动，主人stop／disable优先；失败不重试、不重放unknown，返回harnessRemounts的reconnected／failed／cancelled结果。断开/停用/卸载即时拒绝旧调用。在途图片和写操作使用内存AbortSignal，资源返回及真实send/落库前复查；仅关闭HTTP响应不能算撤权完成。

插件安装先验证封存snapshot，确认同份bytes再运行；Host内事务校验本PID工作区锁且持索引锁。启用、连接、卸载、删数据独立，不清除插件资料或共享依赖。旧API3仅在停机部署时替换代码包，新运行路径不保留读取分支。当前Host SQLite与QQ/DSH数据schema保持。

表情包是插件自有库，不是QQ原生收藏。列表仅元数据，default20/max50，query描述+标签AND筛选，revision防分页漂移；get才返回image与sendable，模型文本也要能读到资源引用。AIadd只接受获准消息/图片引用，主人本机上传是另一管理入口；不接受模型任意路径/URL。资源eating-asset://引用经公开服务和授权转标准OneBot图片，原图不进Host动作账本。表情描述/标签/图片是数据不能提升系统权限，写入/发送均有真实回执，未知不盲重放。

参见[ADR-0019](docs/decisions/ADR-0019-统一插件与MCP能力管理.md)、[使用说明](docs/operations/MCP插件与表情包.md)。

## 外部记忆插件（OpenViking）

openviking-memory@0.3.2按[ADR-0045](docs/decisions/ADR-0045-官方记忆接口与插件部署提示.md)逐轮通过官方messages/batch同步，synced只表示已同步未提取；commit归档原始记录并异步提取，官方Task completed才表示该任务完成，不伪造记忆增删改数量。配置／状态严格schema3，autoCommit默认true、commitTokenThreshold1～1000000默认20000，移除archiveMaxMiB。阈值、压缩和正常结束尊重autoCommit，主人手动提交可强制；固定eating-standard-<peer>[-local]，不接管旧eating-live，不删除远端记录。未知append／commit阻塞同Session且不换号重发，已知taskId只GET原任务恢复，不提供扩展retry／私有durable receipt承诺。Eating只负责可信来源、范围、传输与回执，无每日／小时提取额度；功能MCP all／custom、群成员过滤、主人显式跨会话和原生Web来源保持。旧ADR-0030／报告保历史，integrations扩展README顶部标历史，当前安装不必需。本轮云端Eating更新已授权，schema2空状态转换仅独立停机工具按前述精确范围执行，生产无自动迁移；本机真实0.1.1不动，不配置或重启真实OV服务端。

## 生图插件（OpenAI Images）

独立image-generation@0.4.0、API4。配置Base URL／model及可选Key，允许不要求Key的服务；单次size优先于保存默认，省略沿用默认、空串不传并用服务默认。尺寸接受WIDTHxHEIGHT或service native identifier／auto，实际支持由provider决定，不自动换尺寸付费重试。无参考图追加/images/generations，有参考图走/images/edits，固定n1，无聊天／Responses回退。保存／connect只本地检查，不真实试生成；请求仍报告可能计费及真实结果。可信asset发送按[ADR-0046](docs/decisions/ADR-0046-可信图片传输与生图尺寸.md)，模型只见opaque资源引用，生图成功与QQ发送分别核对。

异步image_generate返回jobId，image_job_get查询最终状态，image_jobs/image_list分页元数据，image_get才实际图。生成提交回执不是生成成功，稳定request_id防重复计费，queued/running重启转unknown不重发。单图编辑只接受三种来源：主人面板本机上传、当前会话已授权消息的{messageId,imageId}、本插件已有assetId；不接受任意路径/URL或其它插件私有图片，来源哈希计入幂等。提交前检查调用signal；已接受后台任务由插件持有，普通Agent结束不丢已付费结果，停用/dispose取消为unknown，后续读取仍须当前授权。owner离页只停UI轮询；隐藏清Key、参考图和Blob，locale不请求。私有配置和资源schema1，500任务/500图/256MiB保持；单图使用主人图片设置，存储格式支持50MiB，调低不清原图，满在请求前拒绝。错误不回显提供商原body、Key、签名URL，URL结果不传认证下载。无真实Key时不声称付费服务验证。见[ADR-0020](docs/decisions/ADR-0020-独立OpenAI生图能力.md)与[ADR-0026](docs/decisions/ADR-0026-生图单图编辑与受控图片来源.md)。
