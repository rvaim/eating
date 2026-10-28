# OneBot 完整 MCP 验证报告

日期：2026-10-28，Asia/Shanghai。基线ac78d48；用户要求完善QQ MCP，加入OneBot支持的全部功能并提交，并明确可删除QQ空间发布／评论等未实现项。本轮应用／Host／Web0.7.0、plugin-sdk1.5.0、ui-sdk1.6.0、QQ0.7.0、DSH0.2.0，apiVersion1。

## 覆盖与实现证据

官方固定提交`d4456ee706f9ada9c2dfde56a2bcfc69752600e4`的[公开API](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/public.md)列38项，另有[隐藏框架快速操作](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/hidden.md)。本轮逐项接入39工具，并对照同提交消息／事件规范核全部字段、别名及类型，不把同一发送入口当作媒体全覆盖。

[生产目录](../../plugins/communication/qq/src/backend/operations.ts)是Host、MCP与面板唯一业务目录，声明protocolAction、schema、readOnly／destructive／sensitiveResult；[消息schema](../../plugins/communication/qq/src/message-schema.ts)支持三种格式及19发送类型。[独立协议清单](../../tests/fixtures/onebot-v11-contract.ts)与[手写case](../../tests/fixtures/onebot-v11-cases.ts)作为测试oracle，产品不导入夹具。完整映射见[标准覆盖清单](../technical/OneBot标准功能覆盖.md)。

## 实际自动验证

普通Node24.22.0、pnpm11.28.5、macOS。已执行：

```bash
pnpm build
EATING_DSH_TEST_RUNTIME="$PWD/.impeccable/runtime-cache/dsh" pnpm test
pnpm test:e2e
```

| 项目 | 已执行结果 |
| --- | --- |
| SDK、QQ、DSH、Host、Web完整构建 | 通过 |
| 根严格TypeScript | 通过 |
| Vitest全套 | 34文件653/653，33.04秒 |
| 原有浏览器流程 | 29/29，13.4秒 |
| 新增完整工具面板流程 | 5/5，5.9秒 |
| 浏览器合计 | 34/34，分两组运行 |
| 新生产目录单测 | 57/57 |
| 新共享校验单测 | 11/11 |
| 新字段解析单测 | 7/7 |
| QQ资源与展示 | 5/5，覆盖全部39项 |
| 新真实Host／官方MCP／回环WS集成 | 14/14 |
| 新Host输入大小／深度回归 | 3/3 |
| 官方DSH SDK实际集成 | 2/2，独立安装产物整Host恢复约29.5秒 |

总数由原561＋新增92组成，未删旧断言。SDK2项是显式opt-in实际执行，未设置运行时环境变量时默认跳过，不能算本轮653全实跑。独立QQ产物安装／升级／卸载保同账号数据，以及原Host、日志、无历史队列、人格／提示词、DSH能力限制与恢复回归全部通过。

### 协议集成的实际路径

14项集成启动临时EATING_HOME、真实EatingHost与OneBot回环WebSocket，使用官方MCP Client及StreamableHTTP完成初始化、带实际Host注册的私有Bearer调用，不绕过鉴权或CSRF。

- SDKlistTools精确39项＝38公开＋1隐藏，workspace协议元数据一一对应独立官方清单；完整字段与别名、所有工具instance／mode、写工具request_id均核对。
- 39个基础调用逐项精确比对wire，19只读、20写，3凭据只读敏感；副作用scope为实例与实际登录账号，同ID重复不再发WS。
- 每个工具的async／rate_limited两模式共78个变体均经真实MCP→WS，40项写请求的unknown入账后不重发；查询unknown不写动作账本。
- 19种发送段加9种模式／表示变体共28形态实际传输，包含CQ字符串、数组、单对象、file／URL／Base64、递归node、音乐／contact两模式和无参数data=null。forward仅收不可发，查询结果原始内容不改写。
- 21种别名／数值／枚举边界核实际规范化；28种非法字段／嵌套消息／不安全数值／模式等在发送前not-sent，缺稳定ID与不存在空间工具也拒绝，WS与账本均不增加。
- quick操作核消息及好友／群请求上下文、实际self_id绑定与原始主人配置不变，外部内容不会触发人格授权修改。
- 成功动作跨HTTP／MCP／重启重用结果；刻意丢WS回复等待1秒，unknown跨同home重启仍只发送1次。
- 三项假QQ凭据确实返回MCP调用方，但动作账本0、配置原字节保持、SSE及临时home所有文件扫描无该假凭据，无聊天历史表。
- 约320KiB结构化Base64图片经MCP及手动HTTP均可传输，普通配置超过256KiB仍413；64深度边界与超限65层均按规范结果且之后连接仍可用。

## 正式界面与CSP

实际发现初选编译型validator在Host的script-src self下需动态Function，导致正式表单校验失败。修正采用精确@cfworker/json-schema4.1.1解释型库，不放宽CSP、不引入unsafe-eval；库会给schema加引用索引，所以先私有克隆，保证Host目录和共享schema不变。缓存128项，仅以schema键存储，不缓存输入或凭据。

新增5浏览器case使用已构建独立QQ产物、临时已安装Host及本地OneBot，生产CSP响应实际生效：

1. 逐个切换39工具，英文标题／字段／帮助无中文UI残留或裸键；切语言保JSON草稿、请求ID与确认，不发POST；双语桌面／390px无横向溢出，占位空间与反向功能0。
2. 文本／消息段数组／单对象由用户明确选择，布尔false和枚举经实际WS保持原值；方括号普通文本不误解析。
3. 群管理、quickJSON使用通用确认，schema默认值有明确展示；字段／JSON／跨字段校验和20k深预览拒绝不崩溃，普通记录限10条。
4. 凭据结果及未决请求在离开页签、隐藏、pagehide和停用时清理，迟到回包不恢复；敏感查询不进入普通执行记录。
5. 未知结果保持原ID直到核对，复用原ID不重复WS，限速async不假报完成；普通未知状态不因隐藏而丢失。

这5项实际通过，pageerror与CSP动态执行错误均0；4张中英桌面／手机图已由实现代理逐一read_image审阅，结论SHIP、无阻塞。实际生产5180另以只读方式核对39项、双语表单和占位移除，采集并实际读取中英桌面／手机4图，pageerror0、横向溢出0、写请求0，不执行任何QQ工具。

独立freshreview逐项回读固定规范和当前生产代码，结论PASS、无material阻塞；覆盖action／alias／消息schema、readOnly凭据账本路径、quick账号绑定、unknown幂等、CSP解释型校验与敏感清理。其范围仅源码与本地规范缓存，没有冒充重跑653项、34浏览器或部署摘要。

## 部署与用户资料

旧job bash-f61da2d5400c4291已停止，正式CLI安装QQ0.7.0，新job bash-833db30a9c45472b运行于5180／5181。API真实确认QQ enabled/connected、39工具、19只读／20写／3敏感、占位能力0。DSH0.2未重新安装或更换运行时，仍enabled/unconfigured、installed=true、ready=false、busy=false、session=null、lastError=null，Harness not-attached。

本轮升级前真实队列6条，与前轮3条快照的差异来自运行期间新消息，本轮以升级前最新摘要为准。账号索引、QQ配置、队列正文、动作账本、全部Host设置与凭据五项摘要逐项完全相同，6条待交接保留，日志查看者双方0；仅插件安装索引按升级选择新版本。不记录正文、令牌或账号实际标识到报告，不修改主DSH、Profile、已有凭据或当前GUI。

## 限制

全部自动动作与模型请求使用本地夹具，没有真人发送、退群、禁言、请求批准、真实Cookies读取或付费模型调用。协议接入完整不表示各OneBot实现、腾讯权限、真实媒体转换／下载或所有平台都已验证。MCP调用方会收到查询结果，其原生会话可能按自有策略保留，不把Eating侧不落持久层扩大为全链路不保存。

本轮没有新增反向WS、HTTP传输、专有OneBot扩展或request／notice事件向Harness的自动交接；标准请求处理工具接受调用方提供的原始flag／事件，保原私聊／群消息投递边界。真实提供商认证、主人通讯身份绑定、其他Harness及OS沙箱不在本轮完成范围。当前状态与维护入口见[状态](../项目状态.md)、[交接](../开发交接.md)和[变更](../changes/2026-10-28-OneBot完整MCP接入.md)。
