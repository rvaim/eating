# Eating

2026-11-14 QQ消息格式统一修复：**修复、提交／push及云端保留数据部署完成**。运行源码`4a24ff5`、QQ0.17.1，统一拒绝文字／图片／语音消息段JSON字符串及内部媒体CQ，返回QQ_MESSAGE_FORMAT_INVALID／not-sent和具体纠正方式；主子提示、工具示例和双语面板同步。全量2017通过／11条件跳过、浏览器6通过，云端514项控制层及489项专项通过；319文件全量私有备份核对，原配置／数据库／会话及4份日志前缀保持，七插件connected、DSH／nativeWeb ready、异常restart0。实际安装后台40项拒绝及公网三类提示、双语桌面手机已核验，无真实付费或真人试发。见[ADR-0060](docs/decisions/ADR-0060-QQ消息格式统一发送校验.md)与[报告](docs/reports/2026-11-14-QQ文字图片语音格式修复部署报告.md)。

2026-11-14 多协议语音与识别：**实现、提交／push及云端部署完成**。运行源码`c4935cd`，应用0.24.0／SDK4.13.0，TTS0.2.0支持OpenAI Realtime与DeepSeek，新增ASR0.1.0；严格新格式、不做旧版兼容。独立工作树整合主分支后删除，再push部署。整合全量1989通过／11条件跳过，浏览器11通过，云端512通过；277文件全量私有备份核对后，仅显式重建旧TTS的8文件，其余配置／数据库／会话及3份日志前缀保持。原五插件connected、DSH／nativeWeb ready、异常restart0；TTS待重新配置Key，ASR待配置并启用。公网双语桌面手机通过，真实付费／真人试发0。见[ADR-0059](docs/decisions/ADR-0059-多协议语音合成与受控语音识别.md)与[报告](docs/reports/2026-11-14-多协议语音与识别部署报告.md)。

2026-11-14 消息聚合与主Agent异步协调：**实现、提交／push及云端保留数据部署完成**。运行源码`3217924`由GitHub拉取构建，应用0.23.0／SDK4.12.0／DSH0.20.0，默认固定10秒聚合和忙碌追加；主Agent自主查询、给同会话子任务追加消息或中断。多批次双确认退休、原租约增量扩展、verify不升级、unknown不重放。云端453项控制层及47项专项通过，253文件私有全量备份核对，显式转换投递设置revision0→1及已接受旧瞬时指针；原配置／数据库／主子UUID／3原生日志前缀／118记忆任务身份保持。六插件connected、DSH／nativeWeb ready、异常restart0；公网桌面手机与双语实读10秒/开启通过，真实试发0。其余插件因SDK产物字节变化按封存规则升补丁：QQ0.16.2、表情0.3.1、生图0.6.1、记忆0.3.3、语音0.1.3；锁文件不变。见[ADR-0058](docs/decisions/ADR-0058-固定聚合窗口与主Agent异步协调.md)与[报告](docs/reports/2026-11-14-消息聚合与异步协调部署报告.md)。

2026-11-13 生图0.6.0已发布部署：新增“请求参数（JSON）”，默认moderation=low，可保存background、output_format等服务参数，文生图和编辑共用。源码`6b326fc`由GitHub构建，原配置和图片历史保留；本地、云端和公网验证见[报告](docs/reports/2026-11-13-生图请求参数配置部署报告.md)。

2026-11-13 生图0.5.0已发布部署：历史图片支持单张、多选及本页批量删除，删除前确认；新增搜索、有界列表、末页回退和预览前后切换。源码`171d93c`从GitHub构建，原图片、任务、配置与会话保留，生产未执行删除。详见[报告](docs/reports/2026-11-13-历史图片删除与列表交互部署报告.md)。

图片JSON文字误发已于2026-11-13修复部署：QQ0.16.1会在发送前拒绝错误字符串并返回可纠正的未发送错误，复用已有图片改用image消息段即可；源码`e34ad83`由GitHub构建，原配置、图片和会话保留。验证和边界见[报告](docs/reports/2026-11-13-图片JSON文字误发强制修复报告.md)。

2026-11-13 生图预览优化已发布部署：生图0.4.1点击即可在当前视口打开图片弹窗，关闭保持列表位置。源码`87edc66`由云端GitHub拉取构建，原配置、图片和会话保留；公网桌面、手机与中英文预览验证通过。该预览阶段仅诊断图片JSON误发；发送约束已在后续QQ0.16.1修复。详见[本轮报告](docs/reports/2026-11-13-生图预览优化与图片文字误发诊断.md)。

2026-11-10 自主执行预算修复：**修复、提交／push及云端保留数据部署完成**。源码`f528d17`由服务器从GitHub拉取构建，应用0.22.0／DSH0.19.0，其余五插件及SDK／依赖不变。严格自主schema3/runUsedMs只累计轮次准入至结算，间隔、额度等待和停机不计，已结算用时跨重启保留；预算暂停与真实故障分开，恢复按钮双语正常。本地全量1915项通过／11项条件跳过、22项相关浏览器最终通过、最终51项专项通过；云端468项通过。空闲停Eating后全量200文件私有备份并核对，显式schema2→3，从0开始新预算，保其余配置、历史、计数、暂停及错误。六插件connected、DSH／nativeWeb ready、异常restart0；公网HTTP桌面／手机及双语实读通过。当前保留原暂停，主人可点击“恢复自主运行”；未自动resume或试发。证据见[本轮报告](docs/reports/2026-11-10-自主执行预算修复部署报告.md)。

2026-11-10 图片大小与云端语音：**源码发布及云端保留数据部署完成**。源码 `de79aee` 已push并由服务器从GitHub拉取构建部署，应用0.21.1、plugin-sdk4.11.0、ui-sdk4.3.0；QQ0.16.0、DSH0.18.2、生图0.4.0、表情0.3.0、记忆0.3.2、语音0.1.2。“设置 → 图片大小”默认单图10MiB、合计20MiB／最多4张，可配1–50MiB；原配置、人格、图片、数据库记录、会话身份及3份原生日志前缀保留。原有五插件connected、DSH／nativeWeb ready、异常restart0。语音插件已安装且待配置／未启用；面板停用不查询任务，保存自己的Key及音色后再启用。本地全量1910项通过／8项条件跳过、19项相关浏览器最终通过，补发修复云端465项通过；首轮云端656项通过。无新增外部依赖、无真实付费合成／真人试发，完整证据见[本轮报告](docs/reports/2026-11-10-图片大小配置验证报告.md)。

2026-11-09 OpenAI云端语音插件：主人已授权开始开发，本地开发与验证完成，本轮已授权本地提交，未push／部署。新增text-to-speech0.1.0，主人保存音色，会话子Agent按次选择delivery，不提供全局语气字段；官方Realtime单次合成、受控音频lease与QQ record发送，未知不重放。应用0.20.0、plugin-sdk4.10.0、QQ0.15.0，其他SDK产物消费者按封存规则补丁升级；锁文件仅新增workspace链接，无新外部版本。未调用真实Key／付费服务或真人QQ，最终实数和限制见[本轮报告](docs/reports/2026-11-09-OpenAI语音插件本地开发验证报告.md)。 完整构建／严格类型、全量1902项通过／11项条件跳过、11项相关浏览器及最终补充语音12项通过；真实Key音质与真人QQ播放未验证。

2026-11-09 自主调度边界：**实现、可行性验证、Git发布及云端保留数据部署完成**。源码`585a52e`由云端从GitHub拉取构建，应用0.19.0、plugin-sdk4.9.0、DSH0.18.0，API4及其他插件／依赖保持。新增主人可配置maxRestMinutes，默认15分钟，sleeping／waiting均到期重新考虑，暂停／忙碌／额度优先，不强制发言。本地构建／严格类型、全量1881项通过／11项条件跳过及21项相关浏览器验证通过；云端551项通过，私有全量备份后显式转换自主schema2并更新，旧次日10:00长休息已缩短到当日22:29:41。五插件connected、DSH／nativeWeb ready，原配置、人格、会话与日志保留。可行性、实际边界及证据见[本轮报告](docs/reports/2026-11-09-自主调度边界与可行性验证报告.md)、[ADR-0050](docs/decisions/ADR-0050-自主思考休息上限.md)。

2026-11-09 自然聊天与自主活动提示词：**本地验证、Git发布及云端保留数据部署完成**。应用0.18.1、QQ0.14.2、DSH0.17.1，源码`551e4af`已push并由云端GitHub取同提交构建。区分正常接话／围观／收尾，普通聊天先回应当下，自主机会明确真实社交选择与sleeping／waiting。现场common按正式CAS从revision1升至2，仅修改相关表达要求和匹配旧默认尾段，其余自定义正文／人格保留。调度、权限、额度、其他插件及依赖保持。本地完整构建／严格类型、全量1868项通过／11项条件跳过，14项相关浏览器验证通过；云端591项回归通过。五插件connected，DSH／nativeWeb ready，配置、会话及日志保留。行为与验证限制见[ADR-0049](docs/decisions/ADR-0049-自然聊天与自主活动提示词.md)，最终证据见[本轮报告](docs/reports/2026-11-09-自然聊天与自主提示词部署验证报告.md)。 既有wake后的自主轮次已完成，AI自行选择sleeping并登记下次唤醒，未暂停、无错误。

2026-11-04 Harness 历史会话清理：**本地验证及云端发布部署完成**。用户先本地查看，随后明确要求部署服务器；本轮由主代理独立提交／push并控制云端GitHub拉取更新，仅部署功能，不清真实历史、不动主 DSH。按[ADR-0048](docs/decisions/ADR-0048-Harness历史会话清理.md)，新增第三个“历史会话”页签：完全停止后扫描真实总／主／子数量，预览有效 5 分钟，勾选后显式确认清理 N 个，取消不删。官方 rc.5 的 SessionController／sessionPersistence 均无删除 API，本功能属于 Eating 专属实例的带外文件维护，使用离线快照计划，不启动可能恢复冷会话的完整 Web helper；清理与保留范围见[操作说明](docs/operations/DSH原生能力与插件.md)。本地 DSH 插件0.17.0，应用0.18.0、QQ0.14.1、生图0.3.1及 SDK 等保持、无新依赖。完整构建／严格类型、最终1871项通过／8项条件跳过及9项历史页浏览器通过；独立预览已扫描1主2子示例并读图，未点击清理。源码 `29387f9` 已提交／push并由服务器从GitHub拉取构建，Linux410项通过，私有全量备份后正式更新DSH0.17.0；公网历史页可见、运行中扫描禁用，五插件正常连接，原历史及配置保留，未执行真实清理。完整证据见[本轮报告](docs/reports/2026-11-04-Harness历史会话清理验证报告.md)，删除测试仅使用隔离数据，下方旧发布及清理记录仅保历史。

2026-11-04 图片消息结构提示修复：**本地验证及云端发布部署完成**。初期按用户“先修改提示词吧”仅在本地修复，用户随后明确“push 发到服务器上”，授权本轮Git发布与云端Eating更新。QQ 主插件说明、默认私聊／群聊规则、消息 schema 的 description／examples 及生图使用说明明确 `message` 直接传 image 段对象／数组，不能 `JSON.stringify` 或把 URI／图片 JSON 当 text；复用已有图片，不为补发重新生图，只有实际 image 调用及成功回执才能称图片发送成功，unknown 不重发。保留 `eating-asset`、现有工具／校验／权限及 file／Base64 选择，不新增后端拦截、回执字段或环境自动检测，不改人格／自定义正文。QQ0.14.1、生图0.3.1，应用0.18.0、Host／DSH／SDK及其余版本保持；不真实QQ试发／付费生图。本地完整构建／严格类型、378项相关测试（0跳过）及7项浏览器通过，未重跑全量；源码 `f8b0d51` 已本地commit／push，云端从GitHub拉取同提交，完整构建／严格类型及Linux11文件363项通过，同data正式安装QQ0.14.1／生图0.3.1；五插件connected、DSH／nativeWeb ready、队列0，公网提示与工具示例实读通过，配置及原数据保持。完整证据见[本轮报告](docs/reports/2026-11-04-图片资源发送提示词验证报告.md)，本轮提示指引不保证真实LLM绝不误用。决策及正反例见[ADR-0047](docs/decisions/ADR-0047-图片消息结构提示.md)，下方旧部署记录与数字保留历史事实。

2026-11-04 官方记忆与可信图片发送已实现、验证并部署更新云端 Eating：记忆改用官方Session消息批量追加／commit／Task API，逐轮synced只表示已同步，提交才归档提取；严格schema3、autoCommit默认true、待处理Token阈值默认20000，压缩／正常结束尊重自动开关，手动可提交，unknown不重发。图片公开PluginImageAsset与Host lease核验来源／scope／字节／SHA-256／MIME，QQ只对主人确认且逐图验证的共享映射用file，否则发送前选Base64；当前默认auto且未保存confirmed mapping，仍走Base64，AI只见opaque引用。生图单次size覆盖保存默认，空串省略用服务默认，最终支持由provider决定，不换尺寸付费重试；DSH区分服务器尚未检测／未安装／版本未知并给官方安装说明，QQ明确需OneBot端先登录，生图Key可选。

当前应用／Host／Web0.18.0、plugin-sdk4.8.0、ui-sdk4.2.1、plugin-core4.0.0，QQ0.14.0、DSH0.16.0、生图0.3.0、记忆0.3.0、表情0.2.0，插件API4，无新依赖、锁文件workspace links保持。源码 `91b18c3` 先本地commit／push；云端首候选构建暴露Linux一项Buffer深比较5秒超时，等价原生`Buffer.equals`及长度断言修复为`72fecad`后再push，从GitHub拉取该提交完整构建及扩展Linux回归通过，才停Eating、私有全数据备份、确认旧记忆state schema2且jobs／scopes均空，由GitHub独立transition工具显式转schema3（config revision+1、archiveMaxMiB→autoCommittrue／commitTokenThreshold20000，保Key／endpoint／user／rules，空state仅schema2→3保其余metadata）。正式五插件同data目录安装运行：五插件全connected、DSH ready、nativeWeb ready、gateway idle、队列0、service active／enabled、异常restart0、云端tracked tree clean。方案不内置生产自动迁移。

记忆真实公网HTTP `isSecureContext=false`，插件ready、schema3 connected、无错误，扩展错误消失；`autoCommit=true`、`commitTokenThreshold=20000`。四插件面板可见、pageerror0、无意外mutation／测试发送／生成。Host settings／各表行数与schema、除本次明确记忆转换外的保存配置、ownerToken及原native UUID保持；两份原生日志prefix全部保留。首次原始hash比较存在11个DSH正常派生／运行文件变化（nonce／outcome／bridge source／systemprompt／url／index record rows／日志追加），没有缺失，故只写语义保留和有私人备份，不宣称全部文件逐字节不变；该strict差异不是数据丢失，不回滚。相关浏览器24项通过，云端扩展Linux回归11文件363项42.70秒通过，完整结果见[本轮报告](docs/reports/2026-11-04-官方记忆与插件能力更新验证报告.md)。另有UI版本写死0.17的修复`e2e9233`已从GitHub拉取构建、再次备份全data后同目录更新；最终公网页面显示`Eating 0.18.0`，记忆schema3 connected、DSH ready、五插件connected、队列0、异常重启0。

媒体当前默认auto、没有主人confirmed mapping，因此仍发送Base64；以后由主人按实际部署一次配置sourceRoot／hostMappingRoot／onebotRoot并确认后，才尝试标准file，机器人可读性未真人probe。用户用原Token链接重新进入即可，无需重装；本机记忆0.1.1不动，不安装/重启真实OpenViking服务端、不装额外依赖、不加TLS／网关／防火墙，真实服务器值与映射留项目外。当前决策见[ADR-0045](docs/decisions/ADR-0045-官方记忆接口与插件部署提示.md)、[ADR-0046](docs/decisions/ADR-0046-可信图片传输与生图尺寸.md)与[变更](docs/changes/2026-11-04-官方记忆与可信图片发送.md)，下方前轮版本／状态／数字保留历史事实。

本轮修复公网 HTTP 的 QQ 面板 `crypto.randomUUID is not a function`：真实非安全上下文缺少该 API，前次 localhost 隧道的 `isSecureContext === true` 掩盖问题。按[ADR-0044](docs/decisions/ADR-0044-HTTP前端安全请求标识.md)，公开 UI SDK `createRequestId()` 始终用 `crypto.getRandomValues` 生成16字节 RFC UUIDv4，统一 workspace／QQ／生图／DSH原生能力／记忆范围前端；同一意图复用原号，unknown 不换号重发，Node后台UUID保持。源码应用／Host／Web0.17.5、ui-sdk4.2.1、QQ0.13.7、DSH0.15.4、生图与记忆源码0.2.1，表情0.1.2功能保持，仅共享SDK产物字节变化按封存规则升级。源码验证与实际云端保留数据更新完成：修复提交 `ab19cbb` 已本地commit／push并由云端GitHub取同提交构建更新；完整构建／类型、最终全量1743项通过／8跳过，最后4项浏览器通过。真实公网HTTP secure=false、randomUUID不可用时QQ配置可见、UUIDv4 ID切页签复用且零页面异常；12受保护文件哈希、Host设置／数据库、插件配置摘要及ownerToken保持。用户用原Token链接重新进入并刷新即可，无需重装，端口与Token不变。证据见[本轮报告](docs/reports/2026-11-03-公网HTTP面板修复与保留数据更新验证报告.md)；见[变更](docs/changes/2026-11-03-HTTP前端安全请求标识.md)。修复当前 HTTP 平台契约，不移除安全随机或强制HTTPS；不加依赖／网关／防火墙，真实连接值留项目外。下方前轮发布版本、运行状态和数字保留当时事实。

服务器本轮采用明确授权的HTTP公网直连，默认本机 `127.0.0.1` 保持；显式 `0.0.0.0` 必须配置publicOrigin及随机32至256字符URLsafe ownerToken。只用根GET `?token=<OWNER_TOKEN>`（已有query用 `&token=`）交换入口Cookie、303去Token，随后沿用bootstrap／session／CSRF，无登录表单或账号密码；MCP仍独立Bearer，官方DSH Web保持。HTTP传输不加密。本轮应用／Host／Web0.17.4已完成源码、隔离及实际服务器部署验证，运行release为本地修复验证并push后云端GitHub拉取的 `6afda68`；QQ0.13.6、DSH插件0.15.3及记忆0.2.0等五插件已安装，仅表情connected，其余unconfigured，未迁本机资料或连接真实QQ／模型。实际IPv4公网监听及Token／session／CSRF检查通过；用户仍需自行放行防火墙并配置所需插件，未证明WAN直连已打通。证据见[报告](docs/reports/2026-11-03-服务器Git拉取与Token入口部署验证报告.md)。见[ADR-0043](docs/decisions/ADR-0043-公网Token入口与Git发布部署.md)、[变更](docs/changes/2026-11-03-公网Token入口与Git发布部署.md)及[部署说明](docs/operations/服务器部署与更新.md)。

代码和通用脚本必须本地验证、commit／push后由云端GitHub拉取对应commit构建；缺少依赖先说明并询问安装，真实目标／端口／路径／Token及最终用户链接留在项目外。不增加HTTPS、证书或网关，不操作防火墙，只管理用户级Eating托管服务和新数据五插件，不迁本机真实AI数据。已批准保留应用专用Node24.22.0／pnpm11.28.5／DSH0.2.1-rc.5并安装仓库锁定依赖；此前先安装事实及新确认流程见部署说明。新服务器记忆0.2.0未配置、不连接，本机0.1.1保持。下方前轮描述保留当时事实，最终发布及live证据由本轮报告收口。

本机SSH别名配置后可用[私钥导入脚本](scripts/导入SSH私钥.py)自行输入PEM路径，完成项目外复制、600权限及对应别名定向编辑；不自动连接，见[说明](docs/operations/配置SSH别名.md)。

Eating 是一个独立管理应用，用于连接通讯平台和用户选择的 AI 运行程序（Harness）。同一个 AI 共享核心人格，主 Agent 负责整体安排、轻量分流和必要协调，绑定子 Agent 自行理解会话、组织回复、选择工具并执行。Eating 负责连接、运行、授权和可靠交接，不另建一套认知循环。

当前已实现 QQ OneBot v11、系统 DeepSeek Harness、双来源 MCP 管理、统一插件管理、表情包和独立生图能力插件。生图插件支持文生图与受控单图编辑。应用仍在开发，尚未发布。

**除非用户明确要求，否则默认不兼容旧版本；即使以后发布也遵循此规则。** 当前代码不提供旧 API、配置或数据库的自动迁移、字段补齐、旧入口别名或回退分支。旧格式会明确报错，原数据不会被自动覆盖或删除。已有旧数据时，请先选择全新数据目录；任何转换或清理都须另行明确要求。

本轮主Agent核实交接与只读任务阶段：源码已实现，隔离验证及实际Eating部署完成；主人“修复问题”已授权修复并部署实际 Eating。按[ADR-0040](docs/decisions/ADR-0040-主Agent核实交接与只读任务阶段.md)，主先理解请求和判断事实，再调用 handle 的必填 `{context_ref,mode:'reply'|'verify'}`，可选 `context_notes`≤8000字符交接可披露事实／来源／未知，不预写全文；contact 必填 `{target_id,task,mode}`，delegate schema保持且内部固定reply。verify以临时只读scope贯穿通讯和功能MCP目录＋调用守卫，仅 `tool.readOnly === true`，direct未知metadata拒绝；原生feature／全局工具本阶段不挂，零只读工具允许空集合。同canonical UUID后续reply重取原普通授权并撤旧lease，scope／policy／readOnly仅RAM，存储schema不改。只保证显式verify受控阶段不能发／写，不保证LLM每次选对阶段或事实绝对正确。前轮共享身份、自然多句／多条、统一UUID、整批和冷恢复一并部署完成，已有重复历史不合并删除，旧unknown不重放或自动review。现场联系额度12／小时、native revision5 time＋web和真实记忆0.1.1保持；记忆源码0.2只构建。详见[本轮变更](docs/changes/2026-11-03-主Agent核实交接与只读任务阶段.md)，严格类型／完整构建、最终1691项通过／8条件跳过及实际部署／页面读图／配置历史保留证据见[本轮报告](docs/reports/2026-11-03-主Agent核实交接与实际部署验证报告.md)。ADR-0040仅替代0035／0039的旧交接契约，以下前轮段落保留各阶段事实。

此前修复见[ADR-0037](docs/decisions/ADR-0037-未知委派隔离与受控图片发送预算.md)：普通入站unknown按原contextRef／taskId隔离，新批次＋新call可复用同child，pending仍串行；授权资源图片的后台发送预算容纳Base64展开，普通JSON与入站上限保持1MiB。联系额度仍每小时6次，状态只读显示used／resetAt，控制错误保code／outcome与脱敏details；不清历史或动作账本、不重放unknown。最终测试、Git及部署以[本轮报告](docs/reports/2026-11-03-未知委派隔离与受控图片发送验证报告.md)为准，当前全量仍待父代理完成。

本轮已实现并完成隔离验证，未部署：按[ADR-0038](docs/decisions/ADR-0038-空闲整批交接与统一会话身份.md)，入站先排队，主Agent忙时等待，空闲时将全部可交接来源按全局顺序一次交主自行分配；条数／体积仅提前触发。DSH逐组contexts绑定、原生idle反馈、同对象普通／联系后续UUID复用及实际scope记忆隔离同步整合；已有重复历史不合并或删除。见[本轮变更](docs/changes/2026-11-03-空闲整批交接与统一会话身份.md)，最终验证以[本轮报告](docs/reports/2026-11-03-空闲整批交接与统一会话身份验证报告.md)为准，尚未部署。另[主动活动行为改进](docs/plans/2026-11-03-主动活动行为改进方案.md)仅为待审方案，未改主动行为、默认值、主人配置或人格。

本轮统一身份核实与自然短消息：源码实现与隔离验证完成，未部署。按[ADR-0039](docs/decisions/ADR-0039-统一身份核实与自然短消息.md)，跨群／私聊仍是同一 AI，局部缺记录先核实；主协调已有记录、获准记忆及对应会话事实，只核实不向被查询会话发言，核实后原会话子自然回答。普通聊天允许一条多句、一次回复多条，不设句数或条数配额；短聊不插大空行，独立气泡实际另发，不套固定追问结尾。每条真实发送、稳定独立 request_id、顺序回执，unknown 停止续发；原文／代码／链接和必要细节保持完整。必需规则进入主／子唯一 complete，即使主人自定义正文也送达；保存正文与人格保留，须部署相应应用／插件并加载新规则后实际实例才生效。范围见[变更](docs/changes/2026-11-03-统一身份核实与自然短消息.md)，最终证据见[报告](docs/reports/2026-11-03-统一身份核实与自然短消息验证报告.md)；不实施前轮主动活动方案，不改额度或 sleeping／waiting。

本轮聊天参与感与人格场景指引新增源码实现与隔离验证完成、未部署、未二次提交，见[ADR-0041](docs/decisions/ADR-0041-聊天参与感与人格场景指引.md)和[变更](docs/changes/2026-11-03-聊天参与感与人格场景指引.md)。群聊先看真实 @／引用／说话对象、读完本批再选择接话，有具体态度、新信息、好奇或联想可自然参与；对方不接、拒绝或翻篇就停。共享规则、Host common 与 QQ group defaults 同步，AI女儿新增草稿补四类场景示例，已存人格保持；多句／多条自由、verify／reply与权限契约不变。父代理先提交 `71e20cd` 并成功 push `origin/main`，之后才新增本轮规则；本轮留工作区，不再自动 commit／push，不部署、不重启。最终验证见父代理维护的[报告](docs/reports/2026-11-03-聊天参与感与人格场景指引验证报告.md)，不承诺真实LLM必然学会；主动活动正向社交动机仅补方案文档。

本轮交付供用户自行运行的本机 SSH 别名配置脚本，见[使用说明](docs/operations/配置SSH别名.md)与[ADR-0042](docs/decisions/ADR-0042-项目外SSH配置与部署隐私.md)：真实连接值及映射只存项目外，忽略文件也不得入项目；未运行真实 setup、未连接服务器、未 commit／push。

## 已实现功能

- **云端语音合成与识别**：独立text-to-speech支持OpenAI Realtime与DeepSeek TTS，按实际协议提供音色与临时语气；独立speech-to-text识别获准会话语音或主人上传的音频。受控资源、防重与unknown不重试，见[操作说明](docs/operations/多协议语音与语音识别.md)。

- **插件管理**：通讯、Harness、能力三类插件统一安装、更新、启停和卸载，左侧固定插件目录、右侧当前单项面板，顶部右侧返回管理列表。当前支持本机可信构建目录，先预览同份代码快照再确认，卸载保留数据。
- **MCP 管理**：左侧固定服务目录，右侧一次查看／编辑一个服务，工具目录可搜索并独立滚动。直接配置stdio／Streamable HTTP，或使用插件服务；已启用且connected的功能型MCP新来源默认all，全部当前及未来工具／Agent类型自动开放；主人可保存custom精确类型／工具例外并恢复all。连接状态、工具发现和实际挂载分别显示，秘密不回显；通讯权限仍由来源插件按账号／目标／资源范围管理。
- **生图插件**：配置独立的OpenAI Images Base URL、模型、可选Key、默认尺寸／质量及超时。单次size优先，省略沿用保存值，空串用服务默认，支持由提供商决定，不自动换尺寸重试。支持文生图、受控单图编辑、MCP任务／查询／取图和独立资源库；稳定请求ID和来源哈希防重复计费，未知结果不自动重发。详见[生图插件](docs/operations/生图插件.md)。
- **OpenViking 记忆**：独立服务配置和可读平台／账号／私聊／群聊Peer，全局记忆默认开启，主Agent自动召回与回合采集，不依赖保存工具、不设每日提取上限。使用官方API逐轮同步，autoCommit开启时按待处理Token阈值、压缩或正常结束提交，主人可手动提交；synced与官方提取完成分别展示。固定eating-standard会话及旧记录保留，不要求服务端扩展；群成员过滤、主人显式跨会话和unknown不重发保持。详见[记忆插件](docs/operations/OpenViking记忆插件.md)。
- **表情包库**：手动添加或由 AI 从当前获准消息收藏，带描述／标签／去重和版本保护；描述关键词、标签AND筛选及有界分页。AI先读元数据，选中后取图或把资源引用交给QQ发送，不依赖QQ原生收藏接口。完整操作见[使用说明](docs/operations/MCP插件与表情包.md)。

- **QQ 连接与工具**：使用已登录的 OneBot v11 服务，保留39项标准 JSON 工具，另提供受控“查看本会话图片”扩展，共40项。多个主人／管理员与私聊、群聊工具授权均由后台核验。
- **会话代理与联系**：主／子共享人格，正常恢复按真实账号、会话、目标和类型复用独立原生会话；本次明确清会话后再运行创建新UUID，人格身份不变。普通聊天、当前问答和生图优先由main调用eating_handle_conversation，先理解请求及事实充分性，再传当前context_ref、显式mode与必要context_notes；verify只核实回报，reply由绑定子自行理解原话、历史、可披露事实和人格，决定回复／工具／发送，main核对Host真实回执。eating_delegate_task留给明确执行任务或用户明确逐字内容，内部固定reply。跨私／群先list当前联系对象再contact，必填target_id／task／mode，自动启动／恢复对应子，无需新入站；群context不授权私聊，子scope不足交回main协调。当前交接见[ADR-0040](docs/decisions/ADR-0040-主Agent核实交接与只读任务阶段.md)，默认开放与可配置部分继续按[ADR-0035](docs/decisions/ADR-0035-会话代理自主处理与默认开放可配置.md)。
- **提示词与人格**：通用前置、主 Agent、子代理前置、插件说明和角色提示词分别编辑；支持变量补全、诊断、版本冲突保护及已保存组合预览。未编辑或已恢复的提示词跟随当前默认，自定义内容保持；“恢复默认”可先预览再确认，版本持续递增。新增人格可从“AI 女儿”模板填入可编辑草稿，第一人称、有具体语气和脾气，名称自定，保存与启用分开，不预设成长阶段；通过上下文与可用记忆延续经历，不绑定具体记忆插件。一次最多启用一个人格，也可全部停用。详见[提示词与人格模板](docs/operations/提示词与人格模板.md)。
- **模型配置**：保存服务地址、模型和 Key 后，可获取模型列表、选择填入草稿并测试模型连接。模型名称下自动显示服务声明的图片／工具／推理支持和上下文／输出容量，输入能力自动采用；服务未声明时才在同一区域折叠手动补充。不支持列表的服务可手动填写模型名称，未知能力不猜测。
- **自主运行**：设置→自主运行配置活动节奏、额度、时长与重启恢复，查看安排及最近结果；常用设置优先、高级项折叠，保存栏跨页签可达。单次连续活动上限只累计实际自主活动时间，休息和等待不消耗额度；开启／暂停只控制无输入时的定时机会，普通有输入轮次仍可联系获准目标。AI 可在自主运行开启且未暂停时安排未来一次性任务消息，到点作为同一主 Agent 的自主机会处理；概览显示并可取消待执行任务，仍服从主人暂停、额度、运行时和周期限制。全部放行／白名单／黑名单统一筛选私聊和群聊，可从当前好友、已加入群搜索选择，或手动添加精确号码；工具由代理权限页管理。所有联系任务共用每小时上限；保存联系策略会暂停定时活动并撤销旧许可，轮次结束／取消或运行时停止也撤权，未知结果不重放。核对策略后再明确开始定时活动，新实例默认关闭。详见[使用说明](docs/operations/自主运行配置与查看.md)。
- **DSH 原生能力与插件**：新Harness仅默认开启主／子时间上下文，文件、命令行、网页、技能、目标、待办等原生功能由主人按需开启；功能型插件仍默认开放。面板可编辑模块、代理范围与参数，管理原生插件检查／确认安装／启停／配置／卸载，并查看实际版本和挂载。main非reserved全局工具与所有Agent功能型native Profile MCP默认开放；每tool可选择自动／自定义，精确指纹＋类型覆盖默认，可关main或空列表禁用。指纹变化不回落开放；feature选择独立保持。详见[使用说明](docs/operations/DSH原生能力与插件.md)。
- **使用系统 DSH**：Eating 不再下载自己的 DSH 运行时，而是检测系统安装的 DeepSeek Harness（`dsh` 命令或桌面应用），用它启动 Eating 专属实例。`DSH_HOME`、`DSH_AGENTS_HOME` 与工作区仍在 `~/.eating` 下，配置、会话和凭据与用户自己的 DSH 互不可见。
- **时间上下文**：默认系统规则不含每轮实时时间；官方 `time-context` 在主、子 Agent 合格步骤中按默认10分钟间隔追加上海时区读数，不另开调度器或时间工具。
- **图片输入**：子代理可按授权消息／图片引用获取真实图片，MCP 返回标准 image 块，DSH 转为原生附件。模型服务必须支持视觉；服务已声明的图片能力自动采用，未声明时可在模型区域手动补充。声明不会验证提供商。受控取图入口不接受任意文件路径；主是否具有原生文件能力以当前配置为准，不能用某QQ子的范围不足推断整个主的能力。远端仅有文件路径且没有可用获取接口时明确不可用。
- **可靠投递**：有界消息聚合，可选本地暂存或内存队列；可靠接管后删除队列正文，外部动作使用稳定请求 ID 防重，结果未知时不自动重做。
- **原生执行请求展示**：QQ 私聊、群聊入站在 DSH 主会话中与自主机会一样显示为可折叠的“收到执行请求”，展开查看原始信封。来源经后台验证后标记，模型正文和可靠回执保持；原生 Web 直接输入仍为普通对话，已有历史记录不改写。见[来源决策](docs/decisions/ADR-0024-外部入站的原生执行请求展示.md)。
- **中英文界面与暗黑模式**：语言切换保留草稿、选区和撤销历史；界面颜色统一走语义令牌，跟随系统深浅色偏好自动切换，白绿主题在深色下保持可读对比度。

主人已明确主Agent自主协调、会话子代理自主处理，功能型MCP默认开放给所有Agent并保留主人配置例外；Eating专属官方permission默认danger-full-access／approval never，通讯和资源仍核验真实scope。逻辑工具边界不是OS沙箱。其他 Harness、跨 Harness 无损迁移、长期记忆内容质量、Tauri 桌面壳和三平台完整运行仍未完成验证。

## 环境

- 普通 Node.js **>=24.9.0**，本轮使用24.22.0。
- pnpm **11.28.5**，以仓库 [package.json](package.json) 为准。
- QQ 接入需单独运行已登录的 OneBot v11 协议服务；Eating 不实现 QQ 登录。
- AI 接入需支持 OpenAI 接口的模型服务，以及系统中已安装的 DeepSeek Harness。Eating 使用自己的数据目录，不借用用户主 DSH 的 Profile、会话或凭据。

## 从全新数据目录启动

先克隆仓库、安装依赖和构建：

```bash
git clone https://github.com/rvaim/eating.git
cd eating
pnpm install --frozen-lockfile
pnpm build
```

为 `EATING_HOME` 选择一个**尚未使用的新目录**。以下路径仅是示例；新数据根会产生新的账号实例与会话，不会继承旧数据。

```bash
export EATING_HOME="$HOME/.eating-current"
pnpm plugin install plugins/communication/qq/dist
pnpm plugin install plugins/harness/dsh/dist
pnpm plugin install plugins/capabilities/stickers/dist
pnpm plugin install plugins/capabilities/image-generation/dist
pnpm plugin install plugins/capabilities/text-to-speech/dist
pnpm plugin install plugins/capabilities/speech-to-text/dist
pnpm plugin install plugins/capabilities/openviking-memory/dist
pnpm dev
```

打开 <http://127.0.0.1:5180/>，Host使用5181。开发启动器会监视Host及其已导入依赖，变化时重启后台，Vite同步更新界面。页面的插件管理可由持锁的Host执行验证后的安装／更新／卸载；CLI仍要求Host停止。按已安装产物加载，不扫描插件源码。修改数据契约后须核对实际运行实例与数据格式，不能把临时测试通过当作现有服务已更新。

需要只运行已构建应用时，在同一个 `EATING_HOME` 下执行：

```bash
pnpm start
```

Host默认在 <http://127.0.0.1:5181/> 同源提供界面、API、插件资源和MCP，可通过 `EATING_HOST_PORT` 修改端口。开发模式的Vite不能单独替代Host。

如需在保留配置的情况下先检查资料、暂不自动连接，可用 `EATING_AUTO_CONNECT=false pnpm dev`（或同样前缀的 `pnpm start`）。该选项只控制本次进程启动，页面仍可手动连接，不改任何插件保存的自动启动偏好；省略时沿用正常自动连接行为。

### 连接 QQ

1. 打开“机器人 → QQ → 连接配置”，填写统一的 `ws://` 或 `wss://` OneBot 地址、访问令牌和连接设置，保存后连接。
2. 在“代理与权限”配置多个主人／管理员 QQ，并分别选择私聊和群聊子代理可用的工具。保存权限不重连 QQ；后台仍会逐次核对账号、目标与引用。
3. “功能测试”用于主人主动执行真实工具；副作用操作需要确认。自动开发测试只向本地协议夹具发送，不向真人试发。

### 配置 AI

1. 打开“Harness → DeepSeek Harness”，保存 API 基础地址、模型名称和 Key。Key 不会回显。
2. 可获取模型列表；选择只写入草稿，保存才生效。测试模型连接会向已保存的服务发出一次最小真实请求，可能产生提供商费用。
3. 检测到系统 DSH 后启动 Harness。模型 API 测试、运行时就绪和实际任务成功是不同状态。模型错误会显示脱敏后的提供商原因；`RATE_LIMIT`／HTTP 429 表示模型服务限流，请按提供商提示等待或选择其他可用模型，重启 DSH 不会恢复提供商额度。
4. 在“提示词管理”和“人格管理”调整AI规则。主系统使用通用前置、主规则、启用插件说明和统一人格，运行时必需分流／联系／自主规则合入主唯一complete系统组合；子会话自主规则合入子唯一complete，保类型规则和同一人格。升级不自动reset自定义正文。提示词显示跟随默认或自定义，可预览并恢复当前默认；“人格管理→新增人格→从模板新建”可填入AI女儿草稿，填写名称后保存，再手动启用。模板更新不改已保存人格。
5. 面板顶部和“系统 DSH”卡片区分正在检测／尚未确认、服务器未安装、找到命令但版本未知及实际运行错误；version为null不等于未安装。检测的是运行Eating的机器，按官方链接在该机器手动安装DeepSeek Harness后再点“重新检测”，不根据浏览器OS判断或自动安装。启动就绪后点击“打开 DSH Web”，在新页签查看同一个 Eating 实例的官方会话页面。复用系统已有组件，无需额外安装 Web 或 DSH 运行时；原自有会话看板已移除。关闭页面不停止消息处理，停止 Harness 后 Web 服务一起停止。
6. 模型名称下的“模型能力”自动读取当前服务声明，支持图片时直接采用；仅服务未声明时才展开“手动补充”，先停止Harness再独立保存。QQ图片读取仍需在“代理与权限”授权“查看本会话图片”。换模型／服务后重新读取能力，原每次输出上限和连接密钥不会自动改变。
7. 默认时间来自原生 `time-context`。手写系统规则若仍引用 `{{当前时间}}` 会主动引入动态前缀；需要稳定缓存时应使用运行时读数。
8. 在“原生能力与插件”选择原生功能及允许使用的代理，编辑模块参数并独立保存；停止状态也能读取真实目录，无需先配置模型。DSH 插件可检查来源后确认安装、启停、配置和卸载；main与所有Agent功能型native MCP默认开放，每个全局tool可保存自动／自定义覆盖；其他子非MCP工具仍按精确名称／指纹选择。保存后启动检查真实挂载，目录变化同步更新scope限制。详见[原生管理说明](docs/operations/DSH原生能力与插件.md)。

## 开发与验证

```bash
pnpm build
pnpm test
pnpm exec playwright test
```

原生 SDK 集成需要已准备好的**独立测试运行时**，并显式提供目录：

```bash
EATING_DSH_TEST_RUNTIME="<独立测试运行时目录>" pnpm exec vitest run --maxWorkers=4
```

底层内核测试仍可使用已有独立缓存目录；系统 DSH 与原生 Web 集成使用 `EATING_DSH_TEST_SYSTEM_BIN="/系统中/dsh/的路径"` 显式启用。未提供对应变量时按需测试会跳过，不能当作实跑。所有验证使用临时数据、本地模型和 OneBot，不读取真实账号配置或向真人发送；Web 测试会启动独立 Chromium。

历史DSH0.12.1在Node24.22.0／pnpm11.28.5下通过严格类型与完整构建；显式系统DSH全量1422项通过、8项按条件跳过，版本构建后相关130项复验通过，自主设置浏览器11项通过并检查390px截图。四项真实系统回环覆盖群转私聊、官方Web session/prompt输入、定时联系和暂停unknown；真实目标续行及Web浏览器输入控件未单独端到端验证。未部署、未向真人或付费模型试发，详情见[本轮报告](docs/reports/2026-11-02-主Agent当前轮次联系权限验证.md)。原生Web、时间与图片的旧阶段事实保留在[历史报告](docs/reports/2026-10-29-原生Web时间与图片验证报告.md)。

当前平台折叠和固定布局的验证见[面板修复记录](docs/changes/2026-10-29-平台提示词折叠与面板滚动修复.md)；默认不兼容策略及其验证保留在[删除旧版兼容验证报告](docs/reports/2026-10-29-删除旧版兼容验证报告.md)。不支持的旧格式有负向测试，当前格式下的重启、可靠 ACK、幂等和独立安装仍有正向验证。

## 仓库结构

```text
apps/host                 Node／SQLite Host、安装器与受控API
apps/web                  React 管理界面
packages/plugin-core      当前注册器与共享配置类型
packages/plugin-sdk       公开后台与代理契约
packages/ui-sdk           公开面板、API客户端与共享国际化
plugins/communication/qq  QQ OneBot v11 插件
plugins/harness/dsh       系统 DSH 适配插件
plugins/capabilities/stickers 表情包能力插件
docs                      当前规范、决策与历史验证
```

以下为前轮历史：应用／Host／Web0.17.5、plugin-sdk4.7.0、ui-sdk4.2.1、plugin-core4.0.0、QQ0.13.7、DSH0.15.4、表情包0.1.2、生图0.2.1、记忆源码0.2.1，插件API4；当时HTTP前端安全请求标识源码验证与云端保留数据更新完成，运行修复提交为 `ab19cbb`，最终全量1743项通过／8跳过，最后4项浏览器通过，详细证据见本轮报告。以下公网Token入口源码、隔离及实际服务器部署验证完成为前轮事实，当时运行release `6afda68`；五插件已安装，仅表情connected，其余unconfigured，未迁本机资料或连接真实QQ／模型，剩余用户防火墙放行与插件配置，未证明WAN直连已通。前轮应用0.17.3隔离验证与实际本机部署完成、五插件connected和DSH ready／nativeWeb就绪为当时事实，不能作为新服务器状态。以下保留前轮交付事实：以main `bfc381f`为基线落实会话自主处理与默认开放可配置，修复f611adb已合并main并push，完整验证与本地清理完成，原5180／5181管理页已更新；详细[本轮报告](docs/reports/2026-11-02-会话代理自主处理与默认开放可配置验证清理报告.md)记录1522项测试及38项相关浏览器验证。真实记忆保持0.1.1，不安装0.2.0或远端部署；自定义提示词／人格、配置、资源与账本保留。主人现已授权删除Eating本地主／子会话，精确白名单与混合字段清理已由父代理执行并独立复核，数量与保留证据见报告；前轮清理后的停止只为当时交付状态，当前QQ／DSH／记忆已正常connected；本轮不再清真实会话或操作云端。浏览器localStorage草稿及OS快照未覆盖，不声称全机抹除。工具必填resultFormat，清单必填assets；DSH通过launch/dsh-system.mjs转交系统dsh启动。各存储schema独立编号，无旧格式自动迁移。

## 文档

- [工程规则](AGENTS.md)：默认不兼容、权限、代码和提交要求。
- [当前状态](docs/项目状态.md)与[开发交接](docs/开发交接.md)。
- [默认不兼容决策](docs/decisions/ADR-0015-默认不兼容旧版.md)与[当前变更](docs/changes/2026-10-29-删除旧版兼容与完善文档.md)。
- [QQ 配置与功能测试](docs/operations/QQ配置与功能测试.md)、[数据目录与账号实例](docs/technical/数据目录与账号实例.md)。
- [工程结构与插件发布](docs/architecture/工程结构与插件发布.md)、[Harness 适配](docs/architecture/Harness适配.md)、[权限与授权](docs/security/权限与授权.md)。
- [完整文档索引](docs/项目说明.md)和[变更日志](变更日志.md)。

历史报告保留当时实现与数字；其中的旧迁移或旧入口描述不代表当前维护承诺。当前规范以本页、工程规则和最新决策为准。

## MCP 与插件能力

Eating0.18.0／plugin-sdk4.8.0只加载API4插件。已启用且connected的功能来源默认all，当前／未来类型与工具自动开放；主人可在MCP页保存custom精确例外并恢复all，新source仍默认all。accessPolicy返回策略、自管来源null，grant是当前有效摘要；通讯仍由机器人权限页和真实账号／目标／资源scope管理。save-grants接受严格all/custom DTO，direct save只收连接／秘密，文件仍严格schema2。新host:mcp-access-policies严格schema1／revision／policies，CAS为direct＋policy；旧host:capability-grants不读／不写／不迁移／不删。策略、连接及目录变化使用一次性重挂：只恢复原connected且同一实例／启用的Harness，owner stop优先，不重放unknown。direct在途撤权可能中断transport并使source error，需主人显式connect。详见[当前接口](docs/technical/接口契约.md)。

表情包列表默认20条、最多50条，只返回描述、标签等元数据；不为浏览目录逐张调用识图。库上限1000张／256MiB，单图按“设置 → 图片大小”（默认10MiB，可配1–50MiB），支持PNG/JPEG/GIF/WebP，描述必填。AI收藏须有当前会话图片引用与相应工具权限，图片预览还需模型图像输入支持；收藏、检索和发送是分别可核对的动作。

当前会话职责、可配置默认与主／子complete组合见[ADR-0035](docs/decisions/ADR-0035-会话代理自主处理与默认开放可配置.md)和[本轮变更](docs/changes/2026-11-02-会话代理自主处理与默认开放可配置.md)，此前默认开放决定保留在[ADR-0034](docs/decisions/ADR-0034-主Agent自主决策与功能能力默认开放.md)。验收须核对实际本地模型request.system；scripted mock证明预设普通回复／生图查询取图／mock私聊链路可执行，不证明真实LLM必然自主选择同一路径。历史字段和证据保留在[ADR-0019](docs/decisions/ADR-0019-统一插件与MCP能力管理.md)、[实施契约](docs/plans/2026-10-30-MCP与能力插件实施契约.md)及[阶段报告](docs/reports/2026-10-30-MCP插件与表情包验证.md)。
