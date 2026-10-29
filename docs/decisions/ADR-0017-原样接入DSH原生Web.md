# ADR-0017：原样接入DSH原生Web

状态：Accepted。日期：2026-10-29，Asia/Shanghai。确认来源：用户最新直接指令“原生web保持原生，不要去修改”“不要你的只读限制，你就保持原始dshweb即可”。

## 背景与纠正原因

前次将“接入原生Web”扩大为Eating界面替换和只读控制，不符合用户要求。此次只做官方原生Web的原样接入，不另改主题、修配色或设计受限界面。ADR-0016保留阶段事实和已提交历史正文，其Web自定义／只读部分由本决策替代；时间、受控QQ代理、MCP图片及Eating自有离线summary／source规则继续适用。

## 决策与替代范围

- 在同一Eating专属DSH进程及注册表挂当前官方SessionController host、原生client roster、Gateway和owner鉴权，复用原主子会话、UUID、独立凭据与工作区；不另启共享目录写进程，不修改用户主DSH或官方npm源码。web的printUrl、openBrowser、surfaceContext均为false，避免污染SDK控制通道。
- 保留官方完整UI、主题、侧栏、消息组件及会话操作，create／prompt／settings等正常功能已获用户授权，cold follow与会话激活遵循官方机制。
- 完全删除Eating src/native-client源码、打包、模块注入，以及sidebar／composer／message renderer替换、硬编码配色、LocaleBridge和agentLabels前端映射。平台JSON与工具结果使用官方默认渲染，原生会话会原样呈现JSON。四段实例名仅用于创建标签与Eating离线summary，原生显示依官方机制，不保证全部旧标题外观修正。
- 完全移除Eating readerPeer、connection隔离、HTTP写白名单、readonlyController及冷follow拦截；不再给官方Web施加Eating根树／只读限制，也不隐藏按钮限制正常功能。
- Eating仅提供“打开DSH原生Web”按钮，主人按需`open-native-web`返回`{url, rootSessionId}`，删除readOnly字段；`runtimeStatus.nativeWeb`仅`{ready}`。当前官方鉴权URL不进普通status或模型上下文。
- Eating SDK主原有列类型／受控委派两工具、QQ子按任务scope受限MCP及官方time-context保持；官方Web创建的普通Agent不作为QQ scope child校验或报错。Eating离线看板仍是Eating自有页面，不向DSH注入展示。

不保留旧自定义客户端或只读模式作为备选。此次不是主题或配色调整。

## 版本、图片与数据影响

应用／Host／Web与QQ保持0.10.0，三个共享包3.0.0、API3不变；DSH补丁版本0.5.1。清单assets字段及完整校验契约保留，QQ与DSH均assets=[]，不再交付Eating原生客户端资源。保配置、人格、会话UUID、凭据和工作区，不因恢复Web重建或清空资料。

图片取图按用户明确要求修复（后续同一日期）：删除dns.lookup预解析、地址固定与“解析结果必须是公网地址”的判定，改由系统网络栈解析和路由，使直连、TUN／Fake-IP、系统代理与局域网部署走同一路径；保授权引用、禁重定向、不传认证头、5MiB／10秒与MIME／字节校验。QQ0.10.1，同一条真实消息取得image/jpeg、110000字节；imageInput保持true，不记录QQ标识、签名URL、rkey或消息正文。

## 证据与后续

本决策记录已确认的现行要求；本轮实际构建、验证、图片取图修复和真实部署状态以[恢复原样DSHWeb与图片DNS诊断](../reports/2026-10-29-恢复原样DSHWeb与图片DNS诊断.md)为准，不预填最终计数，不沿用旧报告成功结论声称此次真实公网图片已通。

替代关系：[ADR-0016](ADR-0016-原生只读Web与多模态会话.md)仅Web自定义／只读与其专属客户端交付部分被本决策替代；历史正文不改。索引见[架构决策索引](项目说明.md)，现行接入契约见[Harness适配](../architecture/Harness适配.md)与[接口契约](../technical/接口契约.md)。
