# OneBot 完整 MCP 接入

日期：2026-10-28，Asia/Shanghai。用户要求完善QQ MCP、加入OneBot支持的全部功能并提交；随后明确删除QQ空间发布／评论等不支持的占位项。以前置ac78d48为基线，本轮完成代码、验证、部署和中文本地提交，不推送。

## 内容与版本

主程序／Host／Web0.7.0、plugin-sdk1.5.0、ui-sdk1.6.0、QQ0.7.0；DSH保持0.2.0，apiVersion1。SDK仅新增可选工具protocolAction与sensitiveResult元数据，OneBot专用schema仍归QQ，不进入宿主业务契约。

按官方固定SHA d4456ee706f9ada9c2dfde56a2bcfc69752600e4逐项实现38公开API＋隐藏框架快速操作，39唯一工具含完整标准字段与别名。旧9工具名保留，目录新增19只读／20写分类中的完整功能，3凭据查询有敏感标记。QQ空间和反向连接占位从后台／资源／面板删除。

统一prepareOneBotCall剥离本地控制参数、处理安全整数ID和受控sync／async／rate_limited模式；副作用继续使用账号作用域稳定request_id账本。未决异步或丢回复不声称完成，重用原ID不会重复发送。快速操作按事件类型约束字段并匹配实际self_id，事件角色或正文不升级授权。

消息支持文本、数组和单对象，19种可发送段及递归node，forward只收。auto_escape缺省true保持旧行为、显式false启用CQ。文件／URI／URL／Base64交由OneBot处理，不代读本机或下载。完整API映射及限制见[覆盖清单](../technical/OneBot标准功能覆盖.md)。

## 界面与校验

功能测试从Host同一schema生成bool／enum／number／JSON／消息格式字段，双语说明、默认值和确认预览完整；真实副作用均需确认，修改参数会使旧确认和ID失效。unknown保持至核对，敏感凭据结果离开／隐藏／停用清理、取消未决并拒迟到恢复，普通面板记录最近10条。

正式页面CSP禁止unsafe-eval，初选编译型validator无法在浏览器执行；根因修正为@cfworker/json-schema4.1.1解释型库，不放宽CSP。共用validator私有clone schema并用LRU128，避免引用索引写入共享目录；JSON guard限制大小／深度／节点、禁危险形状且不回显秘密。工具body1MiB，普通配置保持256KiB；深JSON预览也先guard，不崩溃丢草稿。

## 验证与部署

完整构建／严格TypeScript、34文件653/653（33.04秒）及浏览器34/34通过（原29项13.4秒＋新增5项5.9秒）。包含2项真实官方SDK／独立安装产物会话恢复，以及14项真实Host／官方MCP／回环WS覆盖39动作、78后缀、19段和28形态、非法输入、敏感结果不持久化、丢回复／重启幂等、320KiB与64深度。新5UI流程核生产CSP、默认值／复杂参数／确认／unknown／敏感迟到清理及中英390，4截图实际审阅SHIP。详情见[本轮报告](../reports/2026-10-28-OneBot完整MCP验证报告.md)。

旧服务停机后正式CLI安装QQ0.7.0，当前job bash-833db30a9c45472b运行5180／5181。QQ connected、39工具，无占位；DSH保持unconfigured／runtimeinstalled／未启动。原6待交接与账号、QQ配置、动作账本、Host设置及凭据五摘要保持，不触碰主DSH，不真人试发。

## 回退与限制

回退先停Host，再恢复对应主程序／SDK并激活旧QQ版本，保留全部业务数据和动作账本；不得清空队列或更改不可变版本内容。新标准工具实际可用性由OneBot实现、账号权限和媒体环境决定；真实提供商认证、腾讯权限／凭据、所有媒体转换及Windows／Linux未由本地夹具证明。输入资源限制是有界支持，不承诺无限媒体。事件向Harness仍只交接私聊／群消息，未新增请求或通知历史；专有OneBot扩展与其他传输方式不算官方公开API覆盖。
