# Eating 当前验证结果

更新：2026-10-27 凌晨；本轮任务开始于 2026-10-26。**当前已进入正式开发，QQ OneBot v11、Node Host、持久消息/动作、插件MCP与功能面板已实现。** 测试夹具只在测试目录，不是产品demo。真实用户OneBot参数尚未配置，不能宣称本人QQ已连通。

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

## 单仓独立包重组实际执行（2026-10-27）

以下为主流程实际执行并交接的结果，完整证据见[重组报告](../reports/2026-10-26-单仓独立包重组报告.md)，文档子任务未重跑测试。

- 完整 build/严格 TypeScript 通过；Vitest 12 文件 280/280（旧 215 + 安装 63 + 产物 2）。
- Playwright 8/8：原 5 项改为安装 QQ 产物并校验后台/JS/CSS；另含坏配置局部错误、合法 0.2.1+local 和面板资源 abort 局部失败/CSS 清理。
- plugin-sdk、plugin-core、ui-sdk、QQ 四个包各自 pnpm pack 成功，检查不含 src、node_modules、测试和 workspace: 依赖，未发布 registry。
- 普通 Node 不带 tsx，从仓库外工作目录和临时 home 运行编译后的 CLI/Host，完成产物安装启动、协议夹具健康检查、官方 MCP 查询及 JS/CSS/React runtime 资源 200；实际执行由主流程完成。
- 两项产物测试真实复制 QQ dist 到仓库外，安装→官方 MCP 调用→升级 0.2.1→删除构建源→重启正确→卸载，账号索引和配置文件逐字保持；空 home 不扫描源码。
- 安装 63 项覆盖原子/摘要/API、Host 停机、同版本不可变、并发和当前 active 数据目录冲突/同 ID 改绑拒绝。目录绑定只对当前激活记录生效；索引提交后目录 fsync 失败明确 unknown 并保留已激活版本。
- 独立复核三项 P2（坏配置版本 0.0、build 元数据与 coreSemVer/资源 URL、不当数据目录冲突/改绑）已修复，最终定向 PASS；复核者只读，实际测试由主流程执行。
- 新目录联合服务 managed job bash-6956b2d146be4a95 已启动，默认 home 安装 QQ 0.2.0，原 bot 数据不动；5180/5181 实际四页签、安装 JS/CSS 200、pageerror 0、390px 无溢出。未配置真人 OneBot、不自动连接，未向真人发送消息。

## 正式 QQ 阶段实际执行（重组前）

macOS arm64、普通Node24.22.0、pnpm11.28.5。Node最低24.9.0。精确依赖见[package.json](../../package.json)与[锁文件](../../pnpm-lock.yaml)。本节记录形成时基线为 6da6044、QQ 功能尚未提交；正式 QQ 后已收录于 2532469。独立包重组结果另列于上节，原数量不作为本轮结果。

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
