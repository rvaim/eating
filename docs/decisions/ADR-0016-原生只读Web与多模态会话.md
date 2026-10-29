# ADR-0016 原生只读 Web 与多模态会话

状态：Accepted。

日期：2026-10-29，Asia/Shanghai。

确认来源：负责人明确批准[原生Web与多模态改造清单](../plans/2026-10-29-原生Web与多模态改造确认清单.md)的五项功能与实施边界。源码在隔离工作树实施；实际部署、构建与验证结果另见[验证报告](../reports/2026-10-29-原生Web时间与图片验证报告.md)和[项目状态](../项目状态.md)，不由本决策推断已更新真实实例。

## 背景

原生子实例显示名缺少绑定登录账号，无法区分同目标的不同账号。会话reader平铺原始system更新及inbox splices，丢失native source和替换关系，容易将内部协作、运行时通知或模型输出误当平台发言。每轮动态时间放在system会改变前缀；图片URL／Base64普通文字也不等于模型实际看图。

Eating需要复用所选Harness的会话、附件和请求准备机制，同时继续保持主子权限、统一人格、唯一认知控制者及无第二聊天档案。原生Web必须共享当前Eating专属运行进程和原有会话，不能另开写进程或借用用户主DSH。

## 决策

1. **显示身份与稳定绑定分开。** 通用agentInstanceLabel以注册元数据真实pluginName、scope.accountId、中文私聊／群聊及targetId生成四段名；无元数据用canonical pluginId，不猜大写别名。原生activation、摘要与renderer使用一致来源；历史显示经受信agentLabels映射，不解析旧label猜账号。绑定key、原生UUID与权限不因改名变化，切号区分新实例，历史保原账号归属。
2. **会话读取采用原生有效surface。** 只通过公开persistence、Session.fromRestore和当前message projections恢复有效上下文，正确处理system替换／清空、图片offload及用户入箱编辑／撤回。保messageId、turn、step、callId、native source、surfaceOp／sourceEventSeqs和核验后的platformEvents；不把最新binding revision套历史，没有证据不造昵称。区分agent-message、subagent-settled、time-context和model-output，模型输出不表示QQ已发。原生日志事实仍在原生存储，不新增Eating聊天档案。
3. **时间采用官方time-context。** 主、子在自身ctx各挂载一次，依赖agents／sessionProjections，Asia/Shanghai、原生600000ms默认。只在已有合格step准备请求时向末尾追加来源明确的user runtime context，冷恢复从日志去重；没有新时钟工具、scheduler或后台模型唤醒。通用与QQ角色默认提示移除动态时间行，保其他正文；9个可信变量仍注册，自定义system若用当前时间仍会动态，缓存收益不承诺。
4. **原生Web与SDK同进程。** 在Eating专属sdk-minimal组合官方必要服务／前端及Eating renderer，共用原主子会话、预设和权限。主人通过open-native-web取得`{url, rootSessionId, readOnly: true}`并在新页签打开；URL仅127.0.0.1合法端口与鉴权交换，普通状态仅ready／readOnly，不公开token。关闭页面不影响QQ处理，Harness停止则Web停止。
5. **只读限制由后端执行。** readerPeer与Gateway allowed-read共同限制当前root及后代树，处理owner默认旁路。冷热follow不提升权限、不为读取启动模型；禁止create、prompt、settings、install、file和upload。首版只有已有会话、工具回执、系统和时间查看，不开放直接聊天、任意新会话或第二套模型／人格配置。renderer显示平台sender／account／group、主任务／子回报和真实工具outcome，system／time折叠，reasoning不展示。
6. **图片经受控MCP内容交原生附件。** QQ原39项OneBot工具保持json语义，新增qq_view_received_image为content工具，共40项。只读取当前账号／会话已授权的message与resource配对，取得字节后再次检查权限。公共DNS校验并固定公网地址、禁重定向且不传认证，上限5MiB／10秒，校验MIME与字节。只有远端路径无获取接口时MEDIA_UNAVAILABLE，不读本机、不登录远程、不猜URL。真实MCP image由DSH原生附件进入视觉子Agent，主先收摘要，不默认自动收原图。
7. **模型能力独立声明。** 不改变原7字段连接配置及密钥；独立model-capabilities.json仅含schemaVersion1、revision、imageInput，初始false。主人管理入口CAS保存，只在runtime停止时允许；endpoint／model变化重置false，Key／超时不重置。不凭型号猜视觉，文本模式明确拒绝真实图片，不通过能力声明制造提供商支持。
8. **发布采用唯一API3。** 共享包3.0.0，PluginToolDefinition.resultFormat必填json或content；清单assets必填readonly string[]，QQ明确[]。DSH交付native-client/host.mjs、client.js、package.json三个资源，integrity覆盖原3基础文件与全部assets，安装验证树／重复／路径／哈希并独立复制，不能依赖仓库邻接源码。旧API2不接受，不设计自动兼容分支。

## 原因与备选

仅改界面标题不能同步原生实例身份，仅按原始事件列表展示不能正确解释surface替换和消息来源。自造简化替换算法会偏离用户撤回／steer与原生投影，因此使用公开Session语义。有效surface是当前模型上下文，被shadow的历史事实仍保存在原生日志，不能把二者混成同一含义。

替换整个sdk-minimal为standard会引入未授权提示词和工具；启动第二Web写进程又会争用同目录。采用同进程必要组合，并在后端对读取身份与网关同时约束。只隐藏按钮不足以保证只读。

把时间写system会使前缀变化，另造时间工具或调度器会增加模型权限。原生time-context已有合格步骤判断和可重放状态。普通get_image仍是协议查询，图片扩展负责范围内真实字节与标准MCP image，不把文本URL当图像输入。

## 数据、权限与影响

Eating继续只保有界未交接信封与动作账本。Host普通JSON执行记录不存Base64，浏览器预览临时Blob离开revoke；已给模型的图像可能由Harness原生附件持久化，不承诺全链路无媒体留存。原生会话看板停机可读，不启Agent／模型／新会话，继续树授权、分页容量、reasoning／秘密过滤及只读SHA核对。

实际版本为应用／Host／Web0.10.0、QQ0.10.0、DSH0.5.0；包／API编号与各存储schema独立。现有连接密钥、人格、配置与原生UUID不得因本次开发清空重建。真实实例更新按本次显式授权停机、核对完整栈、备份并保持数据；隔离测试通过不表示已部署。

## 证据、后续与替代关系

[验证报告](../reports/2026-10-29-原生Web时间与图片验证报告.md)统一记录构建、严格类型、原生Web读写／外树限制、冷热读取、SDK存活、独立资源安装、来源与SHA、时间注入及图片wire证据和最终计数。图片wire确认视觉child收到真实image_url、root不自动带图，以及文本模式诊断；时间用例核对主子两次请求system各自相等且每会话一次time-context。全部自动模型／OneBot回环，不验证真人付费模型识图准确率或缓存命中率。

其他Harness、跨Harness无损切换、主动调度、长期记忆、多账号并行、OS沙箱和三平台完整运行仍分别验证。直接原生聊天／写配置、更广媒体或权限能力若扩展，须另行明确范围。

本决策补充ADR-0006、ADR-0013、ADR-0014的Harness与存储边界；ADR-0015的默认不兼容继续生效。本页不改写历史ADR与验证数字，也不把只读Web或图片工具批准扩大为任意原生写权限。
