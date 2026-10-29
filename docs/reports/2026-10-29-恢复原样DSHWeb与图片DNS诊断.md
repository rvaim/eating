# 恢复原样 DSH Web 与图片 DNS 诊断

日期：2026-10-29，Asia/Shanghai。

## 负责人纠正与范围

负责人明确要求“原生web保持原生，不要去修改”“不要你的只读限制，保持原始dshweb即可”。此前把原生接入扩成自定义侧栏、消息组件、浅色配色及只读层，不符合这一要求；硬编码文字颜色在深色背景也缺乏对比。当前按[ADR-0017](../decisions/ADR-0017-原样接入DSH原生Web.md)撤回这些接管，原[ADR-0016](../decisions/ADR-0016-原生只读Web与多模态会话.md)及[阶段报告](2026-10-29-原生Web时间与图片验证报告.md)保留历史事实。

本轮先修Web；随后用户明确要求“修改读取图片的功能，让功能正常”，因此图片部分由只诊断改为修复取图实现本身。修复不改用户网络、DNS或代理配置，不主动调用真人或付费模型；真实图片只用于验证该条已授权消息能否取到字节，不保存、不展示内容。

## 修复内容

- 删除Eating native-client全部源码、样式、Slot替换、侧栏／composer／消息渲染、LocaleBridge和前端agentLabels映射，DSH清单assets=[]，构建清理dist，避免旧文件混入包。
- 删除reader Peer、Gateway connection隔离、HTTP读白名单和只读SessionController／cold-follow覆写，不再给原生操作加Eating限制。
- 直接挂官方SessionController host与自带client roster、官方Gateway及owner鉴权、官方原生UI和正常操作。同一Eating专属SDK进程／数据集继续共用，未启动第二个写进程。
- 官方Web服务所需配置按当前官方base／web组合显式提供，没有修改上游代码。官方模块保bare specifier和原row ID；Web行通过公开initProfile在Eating专属sdk-minimal Profile层只首次插入，正常保存主题和首次确认、重启不覆写用户patch。原生明暗、导航、消息组件、语言和输入行为均由官方管理。
- Eating的按钮改为“打开DSH原生Web”，入口返回{url,rootSessionId}，状态仅nativeWeb.ready；保当前本地鉴权URL的按需获取，避免进入普通状态或模型。
- 原QQ主子工具／权限、time-context与离线快照功能保持；普通Web创建的Agent不再被误当成必须有QQ任务配置的child。

版本：应用／Host／Web0.10.0、QQ0.10.0、共享三包3.0.0、DSH0.5.1，API3。原官方运行包保持0.2.1-rc.4，未修改其文件、主DSH或当前主GUI。各数据schema不变。

## 验证进度

完整构建及严格类型通过。最终显式EATING_DSH_TEST_RUNTIME运行48文件1139/1139（62.19秒），包括全部真实SDK／Web／图片回环与时间读取用例；Eating主人入口、Harness管理页15/15浏览器（16.2秒）。原生Web定向真实用例1/1通过（4.034秒）：官方首次Continue通过settings.mutate持久化；session/create成功；官方侧栏／输入框与页面完整，无Eating DOM／CSS／LocaleBridge；系统light／dark切换正常；通过官方设置保存dark后切系统light仍dark，SDK完整重启后主题和首次确认均保留，原root UUID不变。两图`.review/official-native-web-light.png`及`official-native-web-dark.png`已实际读取；原地址部署结果见下节。

该验收定位并修复了三项接入错误：官方settings namespace依原Loader row ID，不能加Eating前缀；官方配置写回条件使用模块name，必须保官方bare specifier，不能用绝对路径再由Loader转file URL导致条件不匹配；官方Web行放CLI overlay会锁住设置，现通过公开initProfile放在Eating专属Profile自身可写层，只首次插入，保留后续用户patch。没有绕过首次确认或修改官方ConfigEditor。

另外真实SDK／主子／图片回环7项通过（48.24秒）、主人入口面板15项浏览器通过（16.2秒），72项适配与入口定向通过。快速套件1120通过及19原生跳过属于前轮分项记录，不算完整1139项已全实跑。

新版原生测试断言session/create的正常成功、官方输入框和侧栏、无Eating注入DOM／CSS／LocaleBridge，以及官方系统明暗主题；旧拒写／隐藏输入框断言不再是当前要求。测试只用独立临时资料，不发送真实模型任务。

## 图片失败的实际证据

仅通过当前主人接口执行标准只读qq_get_message，按用户截图的图片file精确匹配到唯一实际图片段；没有把任意URL作为输入授权。

- data.file是jpg文件标识；data.url为HTTPS CDN URL，主机multimedia.nt.qq.com.cn、端口443，无本地路径、URL用户信息或私网字面IP。签名参数、消息正文和账号不进报告。
- 修复前：Node系统dns.lookup(all:true,verbatim:true)唯一结果为198.18.7.115。该地址属于198.18/15保留段，被当时插件的地址段判断视为非公网，触发MEDIA_UNSAFE_SOURCE。
- 拒绝发生在DNS答案检查之后、HTTP GET之前，图片字节为零。它不是目录权限、MIME校验或“模型没看懂”的问题。
- 结果符合Fake-IP DNS映射特征，未核定哪个代理软件造成。macOS HTTP／HTTPS／SOCKS／PAC开关关闭，并不能排除TUN或DNS层映射。
- 只读能力查询imageInput=true，本次错误不是图片声明关闭。

## 图片取图修复（已实施）

先验证网络本身可用：对该主机只做 TLS 握手，`198.18.7.115:443` 以 `multimedia.nt.qq.com.cn` 为 SNI 握手成功、证书校验通过（TLS1.3，61ms）。说明 TUN／Fake-IP 会把连接透明转发到真实 CDN，被拦住的只有插件自己的 DNS 预判。

修复只改取图一处，不做按机器区分的配置：

- 删除 `dns.lookup` 预解析、地址固定和“所有解析结果必须是公网地址”的判断；解析与路由交给系统网络栈，直连、TUN／Fake-IP、系统代理和局域网 OneBot 缓存走同一条路径。
- 保留：只读当前会话已授权的消息与图片引用、URL 必须是 http(s) 且无内嵌账号密码或片段、禁止重定向、不携带 Cookie／Authorization／OneBot 令牌、5MiB 与 10 秒上限、Content-Type 与文件头字节双重校验。
- 新增 `MEDIA_INVALID_SOURCE` 只表示 URL 形态无效，不再用地址段判断“不安全”。

QQ 插件以 0.10.1 交付（同版本内容不可替换）。同一条真实失败消息现在返回 `image/jpeg`、110000 字节、canonical base64 且 JPEG 头正确，220ms 完成；此前同一请求为 `MEDIA_UNSAFE_SOURCE`。完整构建与严格类型通过，48 文件 1103/1103（含真实 SDK／Web／图片回环）。

先前“让用户改 DNS／加 Fake-IP 例外”的建议因此作废：那是把插件的错误判断转嫁给用户网络，而且别人用代理或局域网部署会更早失败。

## 现场同步

已在实际实例完成更新。停机前确认QQ／Harness连接、busy=false、pending=0；完整私有备份至`~/.eating-backups/2026-10-29-restore-official-web/`，仅主人可读。标准API3安装器更新DSH0.5.1后、重启前对10个受保护文件逐项SHA256核对全相同，包括连接／密钥配置、主会话、绑定、图片能力、账号配置及原生日志；没有清空或回滚数据。

现原5180／5181运行QQ0.10.1、DSH0.5.1，二者connected，nativeWeb.ready=true，用户已开启的imageInput仍true。图片修复后由受管服务`bash-2adc271cdf3b4e1c`提供，按保存的自动启动偏好连接，未改配置。

实际浏览器从Eating的“打开DSH原生Web”入口新开页面，官方deepseek品牌／侧栏／新会话／插件／自动化任务／输入框均存在。Eating自定义DOM为0，__EATING_NATIVE_WEB__、强制LocaleBridge及自定义CSS均不存在，pageerror=0。真实深浅图在`.impeccable/review/official-web-restored-live/official-native-live-{dark,light}.png`，已实际读取；没有在真实资料中发送试验消息或接受声明。关闭旧自定义会话标签后需从新入口重开。

Web恢复主体提交736e335，现场证据提交821235a；图片取图修复另作中文提交并正常推送。真实取图已实测，用户网络与代理配置未改。
