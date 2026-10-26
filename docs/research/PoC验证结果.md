# Eating 当前验证结果

更新：2026-10-26。**当前已进入正式开发，QQ OneBot v11、Node Host、持久消息/动作、插件MCP与功能面板已实现。** 测试夹具只在测试目录，不是产品demo。真实用户OneBot参数尚未配置，不能宣称本人QQ已连通。

## 当前状态

| 范围 | 状态 | 证据边界 |
| --- | --- | --- |
| 平台UI与QQ自有面板 | 已运行 | 双层导航、配置/工具/消息/MCP，生产bundle浏览器流程 |
| OneBot v11连接器 | 已实现并协议测试 | 正向统一WS、鉴权/echo/健康/超时/有限恢复；真实实现另验 |
| Host持久化 | 已实现并运行 | SQLite接收去重、待投递/unknown、动作幂等、单home锁 |
| 每插件MCP | 已实现 | 官方SDK初始化/list/call、Bearer、稳定副作用键、停用 |
| 多账号结构 | 已实现设计/文件结构，本版单账号 | 稳定UUID索引、独立文件/消息/动作scope；无第二账号UI/并行 |
| Harness消息输入 | 接口/队列已实现，实际Harness未接 | 无sink时pending；accepted不代表Agent已读 |
| Cordis/动态未知包安装 | 未实现 | 仍为候选/独立权限工程，未伪造沙箱 |
| 自主性/记忆/桌面 | 未开始 | 无模型、长期记忆或Tauri/三平台发布证据 |

## 正式QQ本轮实际执行

macOS arm64、普通Node24.22.0、pnpm11.28.5。Node最低24.9.0。精确依赖见[package.json](../../package.json)与[锁文件](../../pnpm-lock.yaml)。基线提交6da6044，QQ功能改动尚未提交/推送。

- `pnpm build`：全量严格TS与Vite生产构建通过。
- `pnpm test`：10文件215/215：OneBot67、MCP30、完整Host8、持久化18、Harness投递11、路径11、账号/配置22、纯注册16/遗留配置结构26/正式Host工作区6。
- `pnpm test:e2e`：5/5，生产dist+临时Host+回环协议夹具，配置实例文件、真实健康、发送确认、unknown同ID不二发、事件去重/pending、MCP令牌按需和390px停用恢复。
- 正式开发服务：5180界面+5181Host，使用默认~/.eating，未填端点，不自动连账号；真实页面截图无pageerror，390px无横向溢出。
- detector10项advisory均为旧styles字阶与DESIGN映射漂移，不是本轮新硬错误；不以此擅自重做设计系统。

独立审查P1/P2三项分别是MCP随机补动作键、心跳/状态离线不降级、构造旧timeout覆盖新配置；均已修复并新增官方SDK/协议回归。完整根因和官方依据见[QQ核对](QQ协议与MCP核对.md)，使用见[QQ操作](../operations/QQ配置与功能测试.md)。

## 测试安全与局限

没有使用真实QQ账号或令牌，没有向真人发送；全部自动发送到测试夹具，临时数据清理核绝对路径。测试真实Host/SQLite/SDK链路，不将fixture的QQ身份冒充产品连通。

真实OneBot实现、WSS证书、反向WS、QQ空间、媒体复杂消息、多账号并行/切换、真实Harness/自动MCP注册、Windows/Linux/Safari、完整OS与安装审批边界未验证或未实现。

## 首版前端结果（历史）

此前前端验证为65业务测试/5浏览器，仅浏览器保存与随附示例；结果保留在[首版报告](../reports/2026-10-26-首版平台验证报告.md)与[变更](../changes/2026-10-26-首版平台验证.md)。之后用户明确正式开发，产品示例已删除，不能将该历史当当前运行说明。

此前DSH bundledNode加载Rolldown遇TeamID不同的根因已确认，使用普通项目子进程，不改DSH签名。新正式Host同样要求普通Node，完整说明见[正式报告](../reports/2026-10-26-QQ正式开发报告.md)。
