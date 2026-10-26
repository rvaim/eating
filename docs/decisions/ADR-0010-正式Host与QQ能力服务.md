# ADR-0010：正式 Host 与 QQ 平台能力服务

- 状态：Accepted（当前正式开发实现，非所有平台完成）
- 日期：2026-10-26
- 依据：负责人明确停止产品demo，先提交代码后正式实现QQ/OneBot v11、平台MCP、Harness输入预留与插件功能测试。
- 前置基线提交：6da6044；新功能改动尚未提交/推送。

## 背景与决定

仅浏览器配置无法保持QQ收消息或保护认证信息。采用Node.js/TypeScript独立Host，普通Node最低24.9.0，使用内置SQLite保存接收/待投递与动作账本。管理HTTP与插件MCP仅绑定回环，通过不同认证入口访问。

QQ自有后台实现OneBot v11正向统一WebSocket，前端插件提供配置、工具测试、消息、MCP能力。10项工具在插件内同源声明/实现，HTTP测试与MCP复用，不在通用Host枚举QQ动作。实际发送以稳定请求ID持久防重复，结果未知不盲目重做；副作用MCP必须由调用方提供稳定ID，不能服务端补键后执行。

Host提供HarnessMessageSink接口，收到消息先持久化；目前没有真实Harness，pending不代表模型已读。不新建Agent Loop或回复生成器。

## 原因与备选

复用官方MCP SDK而非伪协议接口，OneBot使用ws实现标准鉴权/echo。SQLite内置路径减少本阶段额外原生驱动分发，实际平台验证仍必要。未把浏览器localStorage当正式账号/消息库，也没有先引入未验证Cordis或假QQ空间能力。

## 影响

启动方式从前端单进程改为Host+Web。令牌不回显，配置放插件实例目录，数据目录受限。此逻辑模块与认证边界不能替代OS恶意插件沙箱。需要用户已登录并开启协议的OneBot端，不附带QQ登录实现。

## 证据与后续

官方依据与实际测试见[核对](../research/QQ协议与MCP核对.md)，使用见[QQ操作](../operations/QQ配置与功能测试.md)。真实用户账号、WSS证书、反向WS、QQ空间、实际Harness与三平台打包未验证或未实现。

替代关系：扩展 ADR-0009 的前端工程，原前端验证报告保留历史；不把 ADR-0008 Cordis Proposed提升为采用。
