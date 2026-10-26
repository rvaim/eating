# Eating QQ 协议与 MCP 核对

更新：2026-10-26。官方源码分析与运行测试分别记录；没有使用真实QQ账号测试，更没有向真人发送。

## 固定依据

OneBot v11官方仓库提交 `d4456ee706f9ada9c2dfde56a2bcfc69752600e4`：

- [正向WebSocket](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/communication/ws.md)：`/`统一API/事件、action/params/echo、响应关联。
- [鉴权](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/communication/authorization.md)：Bearer头；协议允许query但Eating拒绝将令牌放URL。
- [公开API](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/public.md)：账号/状态/好友/群/get_msg/发送/撤回。未定义QQ空间发布/评论。
- [HTTP响应](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/communication/http.md)与[API概述](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/README.md)：async/retcode1不提供最终成功保证。
- [消息事件](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/event/message.md)：self_id、sender、目标与原message_id；发送者字段可能不完整/过期，不作为可信主人验证。

通过正常HTTPS读取固定内容，无TLS/hosts修改。web_fetch因域名解析限制不能直接读GitHub，使用官方raw普通HTTPS完成。

MCP运行依据是实际安装 `@modelcontextprotocol/sdk@1.32.2` 发布类型和示例，而非把main/v2 API抄进1.x。使用Server、StreamableHTTPServerTransport、官方Client/StreamableHTTPClientTransport；官方main固定SHA `951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5` 的[stateless-legacy例](https://github.com/modelcontextprotocol/typescript-sdk/blob/951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5/examples/stateless-legacy/server.ts)明确其新旧形态差异。实际源文件/精确依赖见[锁文件](../../pnpm-lock.yaml)。

## 真实运行结果

macOS arm64、普通Node24.22.0、pnpm11.28.5。`pnpm build`严格TS+Vite通过；`pnpm test`共10文件215项通过：

| 范围 | 数量 | 覆盖 |
| --- | ---: | --- |
| OneBot客户端 | 67 | Bearer、健康、echo并发、事件、retcode/async、超时unknown、有限重连、旧连接隔离、负载/存活 |
| MCP官方客户端/服务端 | 30 | initialize、list/call/schema、stateless隔离、错误/unknown、关闭清理、方法/版本 |
| 完整Host集成 | 8 | HTTP→QQ→SQLite→官方MCP，确认/重启幂等/权限/停用/损坏配置局部失败 |
| 消息与动作存储 | 18 | 去重/实例筛选、重开、scope隔离、未知不重做、真实SIGKILL后running恢复unknown |
| Harness预留投递 | 11 | 无sink等待、单主接收、有限拒收/超时、在途唤醒、接收者替换、多批次 |
| 统一路径 | 11 | EATING_HOME/默认/波浪线/绝对与相对，真实home被测试mock隔离 |
| 实例/配置文件 | 22 | 稳定UUID/第二条索引设计、越界/损坏拒绝、权限/原子替换/失败保旧/各实例独立 |
| 原纯业务核心与Host工作区 | 48 | 注册16、遗留配置结构26、正式异步Host6 |

`pnpm test:e2e`5/5，生产dist+真实Host+测试目录OneBot夹具：账号配置/实例文件/令牌不回显；工具实际查询/发送确认；消息去重/pending/MCP令牌按需；超时复用ID不二发；390px停用恢复。测试自行开临时工作区并校验清理，不向真实账号或好友发动作。

## 定位并修正的根因

- Gateway原先在flushing时丢notify，导致新事件或立即更换接收者后滞留。新增wakeRequested结束后补调度，回归通过。
- Host改异步加载后，前端在目录未加载时误判QQ路由不存在；改为就绪且无读取错误后才判断，真实浏览器恢复。
- 初次浏览器断开提示断言同时匹配toast和正文，限定配置面板后通过；不是产品断开失败。
- 依赖安装被pnpm阻止esbuild构建脚本，按明确开发授权仅批准esbuild，未全放开脚本。
- MCP副作用原先缺稳定ID会自动补UUID，HTTP丢响应后重试可能重复真实发送。改为调用方必须先持稳定request_id，缺失/无效直接not-sent；官方MCP测试和完整Host夹具验证零发送。
- 初次在线核验之后原先不消费离线心跳/状态结果，WS仍活时账号掉线未降级。现在离线/未知健康先撤销发送资格，查询仍返回真实离线数据，重新在线须fresh登录核验，不重发在途动作。
- QQPlugin构造传入旧timeout使新配置仅对普通调用生效。移除固定override，新增重配连接期限回归，确保连接/health使用本次配置。

## 尚未验证/不支持

真实QQ协议实现/账号、WSS证书部署、反向WS、OneBot分离双连接、QQ空间/媒体发送、多账号并行/切换、真实Harness/MCP自动注册、OS恶意代码隔离、Windows/Linux/Tauri。Node内置SQLite/文件权限只在所述环境测过，不能声称三平台已完成。

截图只证明界面状态；正式默认home尚未填端点/令牌，显示未配置。detector有10项旧样式字阶对DESIGN映射的advisory，非本轮新增阻断；没有据此无授权重做设计系统。
