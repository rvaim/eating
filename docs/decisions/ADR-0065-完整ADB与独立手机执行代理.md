# ADR-0065：完整 ADB 与独立手机执行代理

日期：2026-11-15。状态：Accepted，实现、Git发布及云端保留数据部署完成；新插件待配置执行端，未连接真实手机。

## 用户确认与范围

用户要求机器人玩安卓手机，使用 USB／网络 ADB；已否定固定点击动作集合、命令白名单，以及单次娱乐时长、每日额度、强制冷却／操作次数。当前方案提供完整 ADB argv、任意设备端 shell、交互 stdin／PTY、持续进程、文件与截图，通过 MCP 向 Harness 开放。手机活动交独立子代理自主理解、探索、继续、休息或结束，主继续处理聊天与整体协调。

不扩展另一套 Agent Loop，不修改用户主 DSH 或官方 Web，不重置现有人格、配置、权限和会话。Root／remount 等命令的实际可用性由设备权限决定，插件不伪造成功，也不将“完整 ADB”解释为本机 shell 的任意可执行程序接口。

## 插件与执行端

新增 capability android-control0.1.0，工具为 android_adb_exec、android_process_read／write／stop、android_files、android_screenshot、android_executor_control。全部 ADB 子命令与全局选项原样传到固定 ADB 可执行文件；本机进程不经过 shell，设备端 shell 程序按 ADB 正式语义执行。Host request_id 与执行端 HMAC 意图摘要核对，同号不换动作、不重放 unknown。

本机模式直接执行 ADB；远程模式经官方 Streamable HTTP MCP 访问同一执行核心。封存包带 executor.mjs，可在手机旁电脑启动，默认配置示例监听回环，经已有私有网络／SSH 隧道接入云端 Eating。远程配置独立严格 schema1，Token 只从私有文件读取；不增加公网 ADB 服务、网关、防火墙或 HTTP 自定义 Host 路由。

进程首次等待与命令总生命周期分开，首次等待最多30秒然后返回 process_id，没有娱乐总倒计时。持续进程支持 stdin、EOF、Ctrl-C／SIGINT、SIGTERM，POSIX PTY使用执行端已有 Python3 标准库，以解决 Eating 自身没有终端时 /usr/bin/script 无法工作的根因。未安装 Python3 或 Windows PTY 时明确报告终端能力不可用，不伪造交互或静默安装；普通完整 ADB 仍走原生子进程。

stdout/stderr 各保留前16MiB，真实总字节／保留量／截断状态可见；文本分块不截断 UTF-8 字符。文件分块64KiB并支持绝对执行端路径／工作目录相对路径，目录分页；工作目录不是沙箱。截图返回标准 MCP image，模型能看到实际图片而非路径或JSON文字。

执行端 SQLite schema1持久保存有键意图摘要、命令／输入／文件回执；原始 argv、stdin、Token 不写 Host 动作账本。命令输出仅在执行端私有文件保留；模型原生会话仍可能保存工具结果及图片，不宣称全链路不落盘。清理完成记录和输出保留回执墓碑，因此清理不能使旧 request_id 重新执行。元数据缓存有界不等于操作次数额度。长时间未确认的远程停止明确标记 unknown，旧请求不重放，新任务可查询执行端并由主协调接管。

## 独立执行角色

AgentTypeDefinition.conversationKind 新增 null，表示功能插件独立执行角色；communication 类型仍为 private/group。android-control.phone 不是QQ会话，不构造假账号／context_ref。Host将角色、可编辑类型提示和插件说明列入既有提示词管理，手机角色组合 common→subagent→类型→本插件可编辑使用说明→同一人格。原通讯角色组合保持。

主新增 eating_start_execution({type_id,task})。运行时只允许真实 root 使用原生 callId，后台从注册类型选择角色、创建／恢复稳定UUID并签发当前能力lease；模型不能提供scope、令牌或任意系统提示。独立 execution-bindings.json/schema1 保存有界身份与无正文任务索引，旧 pending中断后核对回执，不自动重做，迟到finish不得关闭新任务。

手机子代理使用原生 startActivation／sendMessage，没有普通任务15分钟截止；主轮次正常结束或取消不会机械取消它。主可用既有 eating_task_control 查询、message追加说明或interrupt。独立执行不绑定自主周期nonce，不等待主自主周期结算，不占住通讯批次退休；appendWhileBusy关闭时也不因独立手机任务阻挡主接收新消息。状态仍显示真实活动，以便停服维护核对。

持续任务使用任务回执 retention={continuous:true,trimmed}。普通任务沿用原有有界回执契约；持续任务超过100项时只淘汰已确认的近期视图，未知动作不淘汰，原始动作幂等账本保留，查询返回actionsTruncated。该可选字段属于当前保留策略，不读取任何旧schema或迁移数据，既有无retention记录保持原语义。手机活动不因已确认动作计数而停止。

## 面板与发布

面板包含执行端配置、连接／停止、完整命令JSON数组、交互终端、进程与输出流、stdin、截图、文件分块上传／下载、接管及清理完成输出。双语、固定视口与手机布局沿现有语义令牌；语言切换不写配置或执行命令，隐藏停止轮询并撤图片、清未保存Token，不自动杀后台命令。未知输入／命令保原ID，不能换号重试。

应用／Host／Web0.26.0、plugin-sdk4.15.0、DSH0.22.0，API4保持；新增android-control0.1.0。其他插件封存须逐一比较，实际字节不变不升版本。锁文件仅新增已有依赖的workspace importer，不引入新的外部包版本。构建及通用服务安装清单加入新插件，实际发布部署仍以主人本轮指令为准。

本地验证必须包含实际安装包、本机与远程执行端、真实系统DSH与回环模型、可编辑说明入主子实际system、截图入模型请求、手机忙时主处理另一消息、重连复用UUID、超15分钟不取消与持续回执超过100项。真实硬件／应用、网络无线配对和USB驱动兼容性未验证时明确说明。证据见[报告](../reports/2026-11-15-玩手机插件本地实现验证报告.md)。
