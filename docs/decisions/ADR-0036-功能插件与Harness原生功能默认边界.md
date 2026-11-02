# ADR-0036：功能插件与 Harness 原生功能默认边界

状态：Accepted。日期：2026-11-03，Asia/Shanghai。主人明确：“功能性插件默认开启，harness插件里面的功能不要默认全开……有些功能作为聊天机器人不需要默认开启”。本决策收窄ADR-0034／0035中将main平台全部原生feature默认开启的部分；保留功能MCP默认开放且可配置、主子会话职责及真实通讯范围。

## 规则

1. 生图、记忆、表情包等Host功能型capability／direct MCP仍采用默认all策略，当前及未来类型／工具自动纳入；主人可保存custom例外并恢复all。来源连接和真实业务就绪按各插件报告，默认授权不替代Key／服务配置。
2. 新Harness原生配置仅time默认开启，供main及已知子类型使用，上海时区、600000ms。files、search、directory、Bash／PowerShell、jobs、web、skills、schedule、goal、todo、questions、deliverables均默认关闭、类型列表为空。模块配置采用模块自身默认，不额外启用文件写／编辑或网页搜索。
3. 原生功能目录、JSON配置、代理范围、逐工具自动／自定义及保存入口完整保留，主人按需开启。已安装原生插件的全局工具和native Profile MCP访问规则、toolAccessOverrides、真实scope与来源守卫保持；本次调整的是feature加载默认。
4. 只有真正没有原生配置文件的新实例使用此工厂。已有schema1配置照常严格读取，读不补写，不以新默认覆盖主人选择，不迁移或重置配置。现场原生revision5中time及web由主人选给main／qq.private／qq.group，其余关闭，应逐字节保留。
5. Eating主子职责、eating_handle_conversation、跨目标list/contact、自主agenda、人格与会话、原生Web及官方权限preset保持既有契约；默认工具精简不代表撤销主Agent可信授权。

## 验证和部署

须同时验证新实例只有time、手动启用仍可保存／执行、已有time＋web配置读取不写，以及精简原生能力后9个Eating工具和功能MCP仍存在、生图／通讯链路正常。旧测试不得要求默认read/write/bash/web_search/goal等工具存在，需原生功能的测试应明确开启自己的feature。

本轮应用／Host／Web0.17.1、DSH0.15.1，QQ0.13.4、SDK4.7.0／UI4.2.0／API4保持。实际命令、验证数、用户配置保持和运行恢复记录于[本轮报告](../reports/2026-11-03-Harness聊天默认功能修正验证部署报告.md)。历史ADR与报告保留当时事实，不要求复现旧全开默认。
