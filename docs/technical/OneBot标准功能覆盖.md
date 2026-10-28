# OneBot 标准功能覆盖

更新：2026-10-28。QQ 插件0.7.0以官方OneBot v11固定提交`d4456ee706f9ada9c2dfde56a2bcfc69752600e4`为基线，提供38个公开API和1个框架快速操作工具。工具覆盖表示Eating已接入该协议调用；实际可用性仍由OneBot实现、QQ账号权限及服务配置决定，失败按真实协议结果返回。

官方依据：[公开API](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/public.md)、[框架快速操作](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/hidden.md)、[参数与调用模式](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/README.md)、[消息段](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/message/segment.md)。本地独立测试基线见[协议清单](../../tests/fixtures/onebot-v11-contract.ts)和[逐项请求](../../tests/fixtures/onebot-v11-cases.ts)，产品源码不导入测试夹具。

## API 与 MCP 工具

旧9个工具名保持可用；新增接口采用固定名称，没有提供任意action透传入口。功能测试表单、MCP与DSH均读取[同一目录](../../plugins/communication/qq/src/backend/operations.ts)。其中19项只读、20项有副作用，3项QQ凭据查询标注敏感结果。

| OneBot action | MCP工具 | 用途 |
| --- | --- | --- |
| send_private_msg | qq_send_private_message | 私聊消息 |
| send_group_msg | qq_send_group_message | 群消息 |
| send_msg | qq_send_message | 按类型或唯一目标发送 |
| delete_msg | qq_delete_message | 撤回消息 |
| get_msg | qq_get_message | 查询指定消息 |
| get_forward_msg | qq_get_forward_message | 查询合并转发内容 |
| send_like | qq_send_like | 好友赞 |
| set_group_kick | qq_set_group_kick | 移出成员，可拒绝后续申请 |
| set_group_ban | qq_set_group_ban | 禁言或取消普通成员禁言 |
| set_group_anonymous_ban | qq_set_group_anonymous_ban | 匿名成员禁言 |
| set_group_whole_ban | qq_set_group_whole_ban | 全员禁言开关 |
| set_group_admin | qq_set_group_admin | 设置或取消管理员 |
| set_group_anonymous | qq_set_group_anonymous | 群匿名聊天开关 |
| set_group_card | qq_set_group_card | 设置或清除群名片 |
| set_group_name | qq_set_group_name | 设置群名称 |
| set_group_leave | qq_set_group_leave | 退出群，群主可选择解散 |
| set_group_special_title | qq_set_group_special_title | 设置或清除专属头衔 |
| set_friend_add_request | qq_set_friend_add_request | 同意或拒绝好友请求 |
| set_group_add_request | qq_set_group_add_request | 处理加群申请或邀请 |
| get_login_info | qq_get_login_info | 登录账号信息 |
| get_stranger_info | qq_get_stranger_info | QQ用户资料 |
| get_friend_list | qq_get_friend_list | 好友列表 |
| get_group_info | qq_get_group_info | 群资料 |
| get_group_list | qq_get_group_list | 群列表 |
| get_group_member_info | qq_get_group_member_info | 指定群成员资料 |
| get_group_member_list | qq_get_group_member_list | 群成员列表 |
| get_group_honor_info | qq_get_group_honor_info | 群荣誉分类或全部 |
| get_cookies | qq_get_cookies | QQ Cookies，敏感结果 |
| get_csrf_token | qq_get_csrf_token | QQ CSRF Token，敏感结果 |
| get_credentials | qq_get_credentials | QQ接口凭据，敏感结果 |
| get_record | qq_get_record | 语音转换与服务端文件路径 |
| get_image | qq_get_image | 图片服务端文件路径 |
| can_send_image | qq_can_send_image | 查询图片发送能力 |
| can_send_record | qq_can_send_record | 查询语音发送能力 |
| get_status | qq_get_status | 协议端在线及运行状态 |
| get_version_info | qq_get_version_info | 实现与协议版本 |
| set_restart | qq_set_restart | 请求OneBot重启，原生为异步 |
| clean_cache | qq_clean_cache | 清理OneBot缓存 |
| .handle_quick_operation | qq_handle_quick_operation | 框架级事件快速操作 |

QQ空间发布、评论和未实现反向连接的占位能力已从当前目录及面板删除，未用伪工具替代。OneBot实现专有扩展不自动算作上述官方标准；本轮不恢复聊天历史工具。

## 参数与结果

MCP参数保留官方名称，QQ／群号码及消息ID接受安全整数或十进制字符串，消息ID限制为有符号int32；发送前转换为协议数值。合并转发ID、flag、域名等原文不作数字转换，用户消息不被模板解释或语言翻译。

`send_msg`显式指定类型时要求对应目标，未指定类型时只允许一个目标，避免歧义发送。匿名禁言支持`anonymous`、`anonymous_flag`和`flag`，匿名对象优先；`flag`别名规范化为`anonymous_flag`。群请求的`type`别名规范化为`sub_type`，两者同时提供时必须一致。名片、头衔、备注等保留空字符串及省略的标准语义；普通禁言0表示取消，匿名禁言不以0取消。

所有工具可提供本地`instance_id`，省略使用默认账号；本版不自动切换其他实例。写工具必须提供8至128位稳定`request_id`，只读工具不写动作账本。`instance_id`、`request_id`与`onebot_call_mode`仅供Eating控制，不转发为OneBot参数。

`onebot_call_mode`可选`sync`、`async`、`rate_limited`，分别使用原action、`_async`或`_rate_limited`后缀。异步／限速应答和原生`set_restart`的`status=async`仅说明接纳／排队，显示结果待核对。相同写请求ID和参数重用既有账本结果，未知状态不向OneBot再次发送；更换ID可能重复执行，必须先核对实际状态。

快速操作支持私聊回复、群消息回复／撤回／踢人／禁言、好友申请及群申请／邀请处理。上下文必须为相应原始事件，`self_id`与当前登录账号一致，操作字段按事件类型校验。事件可精简，但不得改造为主人授权；sender角色与任意正文仍是外部数据。该接口不新增事件历史或自动批准机制。

## 消息格式

发送与快速回复接受字符串、消息段数组、单个消息段对象三种格式。为保留既有文本行为，Eating缺省补`auto_escape=true`；这是与OneBot自身默认false的明确差别。需要CQ码时显式传false，结构化消息不因该参数改变原内容。

19种可发送类型为：text、face、image、record、video、at、rps、dice、shake、poke、anonymous、share、contact、location、music、reply、node、xml、json。contact包括好友／群推荐，music包括标准平台／自定义分享，node包括已有消息ID／自定义节点并支持递归content。无参数段允许data为null，布尔型消息段参数兼容标准的0／1、no／yes、false／true及相应JSON值。forward是标准只收消息段，通过get_forward_msg读取，不作为可发送段冒充支持。

文件名、file URI、HTTP(S) URL和Base64按原值交给OneBot，Eating不读取本机文件、不代下载，不将远程OneBot路径当作本机上传。语音转换等依赖OneBot端能力（例如ffmpeg），返回失败不编造路径或成功。

工具HTTP/MCP输入及OneBot帧均有1MiB上限，普通配置请求仍为256KiB。JSON最多64层／50000节点，单消息段数组最多1000项，文本字符与标识符还按公开schema限制。超过边界在动作发送前拒绝，不能将有限资源支持写成无限媒体大小或深度。

## 功能测试与敏感结果

QQ功能测试根据相同schema生成布尔、枚举、整数及JSON输入；消息格式由用户明确选择，普通文本以方括号开头也不会自动当作JSON。字段帮助与默认值随中英文切换，确认预览显示schema缺省值，但不自行填入请求。所有真实副作用需勾选确认，未知结果复用原ID核对。

QQ Cookies、CSRF Token和接口凭据只在主动执行后显示，不进入面板普通执行记录；离开测试页签、隐藏页面或停用时清除并阻止迟到响应恢复。普通执行记录只保留当前面板最近10条，结果待核对保持至显式处理；不是聊天历史，也不写浏览器持久存储。

Eating不将这三项只读查询结果写进动作账本、账号配置、消息历史或日志。MCP调用方收到实际返回后自行负责保管，其原生会话可能保留工具结果，不能将Eating侧不持久化扩大成所有Harness都不保存。实际验证及限制以本轮报告和当前[项目状态](../项目状态.md)为准。
