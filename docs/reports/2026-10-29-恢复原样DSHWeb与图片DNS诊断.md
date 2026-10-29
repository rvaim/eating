# 恢复原样 DSH Web 与图片 DNS 诊断

日期：2026-10-29，Asia/Shanghai。

## 负责人纠正与范围

负责人明确要求“原生web保持原生，不要去修改”“不要你的只读限制，保持原始dshweb即可”。此前把原生接入扩成自定义侧栏、消息组件、浅色配色及只读层，不符合这一要求；硬编码文字颜色在深色背景也缺乏对比。当前按[ADR-0017](../decisions/ADR-0017-原样接入DSH原生Web.md)撤回这些接管，原[ADR-0016](../decisions/ADR-0016-原生只读Web与多模态会话.md)及[阶段报告](2026-10-29-原生Web时间与图片验证报告.md)保留历史事实。

本轮先修Web，图片只核对真实失败原因并说明方案，不改图片／DNS／代理策略，不下载用户图片，不主动调用真人或付费模型。

## 修复内容

- 删除Eating native-client全部源码、样式、Slot替换、侧栏／composer／消息渲染、LocaleBridge和前端agentLabels映射，DSH清单assets=[]，构建清理dist，避免旧文件混入包。
- 删除reader Peer、Gateway connection隔离、HTTP读白名单和只读SessionController／cold-follow覆写，不再给原生操作加Eating限制。
- 直接挂官方SessionController host与自带client roster、官方Gateway及owner鉴权、官方原生UI和正常操作。同一Eating专属SDK进程／数据集继续共用，未启动第二个写进程。
- 官方Web服务所需配置按当前官方base／web组合显式提供，没有修改上游代码。官方模块保bare specifier和原row ID；Web行通过公开initProfile在Eating专属sdk-minimal Profile层只首次插入，正常保存主题和首次确认、重启不覆写用户patch。原生明暗、导航、消息组件、语言和输入行为均由官方管理。
- Eating的按钮改为“打开DSH原生Web”，入口返回{url,rootSessionId}，状态仅nativeWeb.ready；保当前本地鉴权URL的按需获取，避免进入普通状态或模型。
- 原QQ主子工具／权限、time-context与离线快照功能保持；普通Web创建的Agent不再被误当成必须有QQ任务配置的child。

版本：应用／Host／Web0.10.0、QQ0.10.0、共享三包3.0.0、DSH0.5.1，API3。原官方运行包保持0.2.1-rc.4，未修改其文件、主DSH或当前主GUI。各数据schema不变。

## 验证进度

完整构建及严格类型通过。最终显式EATING_DSH_TEST_RUNTIME运行48文件1139/1139（62.19秒），包括全部真实SDK／Web／图片回环与时间读取用例；Eating主人入口、Harness管理页15/15浏览器（16.2秒）。原生Web定向真实用例1/1通过（4.034秒）：官方首次Continue通过settings.mutate持久化；session/create成功；官方侧栏／输入框与页面完整，无Eating DOM／CSS／LocaleBridge；系统light／dark切换正常；通过官方设置保存dark后切系统light仍dark，SDK完整重启后主题和首次确认均保留，原root UUID不变。两图`.review/official-native-web-light.png`及`official-native-web-dark.png`已实际读取。全量最终计数与实际同步在下节补记。

该验收定位并修复了三项接入错误：官方settings namespace依原Loader row ID，不能加Eating前缀；官方配置写回条件使用模块name，必须保官方bare specifier，不能用绝对路径再由Loader转file URL导致条件不匹配；官方Web行放CLI overlay会锁住设置，现通过公开initProfile放在Eating专属Profile自身可写层，只首次插入，保留后续用户patch。没有绕过首次确认或修改官方ConfigEditor。

另外真实SDK／主子／图片回环7项通过（48.24秒）、主人入口面板15项浏览器通过（16.2秒），72项适配与入口定向通过。快速套件1120通过及19原生跳过属于前轮分项记录，不算完整1139项已全实跑。

新版原生测试断言session/create的正常成功、官方输入框和侧栏、无Eating注入DOM／CSS／LocaleBridge，以及官方系统明暗主题；旧拒写／隐藏输入框断言不再是当前要求。测试只用独立临时资料，不发送真实模型任务。

## 图片失败的实际证据

仅通过当前主人接口执行标准只读qq_get_message，按用户截图的图片file精确匹配到唯一实际图片段；没有把任意URL作为输入授权。

- data.file是jpg文件标识；data.url为HTTPS CDN URL，主机multimedia.nt.qq.com.cn、端口443，无本地路径、URL用户信息或私网字面IP。签名参数、消息正文和账号不进报告。
- 当前Node系统dns.lookup(all:true,verbatim:true)唯一结果为198.18.7.115。该地址属于198.18/15保留段，生产isPublicQQImageAddress返回false，触发MEDIA_UNSAFE_SOURCE。
- 拒绝发生在全部DNS答案检查，HTTP GET尚未发起、图片字节为零。它不是目录权限、MIME校验或“模型没看懂”的问题。
- 结果符合Fake-IP DNS映射特征，未核定哪个代理软件造成。macOS HTTP／HTTPS／SOCKS／PAC开关关闭，并不能排除TUN或DNS层映射。
- 当前只读能力查询imageInput=true，本次错误不是图片声明关闭；没有发起真实识图请求证明提供商支持。

## 图片应如何修

优先在实际DNS／代理配置中让multimedia.nt.qq.com.cn绕过Fake-IP映射，使用真实DNS解析到公网地址，并清理相关缓存后再次核对系统lookup；Eating的资源配对和公网校验保持。若使用Mihomo／Clash类工具，可在实际配置的Fake-IP排除规则中加这个已确认域名；不能凭代理软件猜配置文件或未经确认修改。

如果该网络必须经代理取图，则应另行接入显式受信图片代理，由代理解析真实CDN域名；保授权账号／消息／图片配对、固定源、禁凭据传播／跳转、5MiB／10秒及图片格式校验。当前transport没有显式图片代理能力，不能把系统代理开关当已经接通。

本张图实际是CDN URL，没有证据需要读取远端路径。开放本地目录不能改变DNS结果，全局放行198.18/15或关闭SSRF也不是此次已实施方案。**本轮图片策略未修改，真实取图问题尚未修复。**

## 现场同步

待官方原生页面验收后，停止当前Eating、私有备份、安装0.5.1并保原Key／人格／原生UUID／能力配置和当前运行选择。实际原地址检查、版本、进程与Git结果完成后追加；不将隔离通过当现场已更新。
