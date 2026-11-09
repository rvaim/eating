# ADR-0051：OpenAI云端语音与受控音频资源

状态：Accepted；本地开发与验证完成，未部署。日期：2026-11-09，Asia/Shanghai。

## 已确认需求

主人要求文本转语音使用OpenAI云端，不在服务器运行本地模型。音色由主人保存，会话子Agent结合人格与当前语境选择本段临时语气；语气不写回全局配置，主／子认知和消息选择仍由DSH承担。

## 接口选择与边界

官方[语音指南](https://developers.openai.com/api/docs/guides/text-to-speech)已说明旧Speech模型将于2027-01-06停服，推荐Realtime；本轮采用[官方WebSocket连接](https://developers.openai.com/api/docs/guides/voice-websockets)和[Realtime事件](https://developers.openai.com/api/docs/guides/realtime-conversations)。默认endpoint为wss://api.openai.com/v1/realtime、model为gpt-realtime-2.1-mini、voice为marin。服务地址、模型、十种正式内置音色、Key与超时由主人配置；不根据模型名切换协议，不保旧/audio/speech回退。模型是否可用以用户账号及真实服务为准。

每个任务独立建立一次连接，session.update固定audio/pcm、24kHz、主人音色、tools=[]及tool_choice=none；收到匹配配置后只创建一次conversation=none的response。只传待朗读文本和本段delivery，不传会话历史、人格、MCP或用户授权信息。OpenAI仅负责朗读，不接管DSH对话。接收response.output_audio.delta及完成转写，核对response／item／output／content标识及response.done completed，收齐后关闭连接。

Realtime并非数学意义上的逐字TTS保证。后台对比服务返回的转写和输入，忽略空白、大小写和常见句读；保数字小数点与连接符，不把改字／漏字／翻译接受为成功。失败不提供可发送音频、不自动重新计费；该检查不能证明实际波形中每个字绝对正确，真实音质与中文读法需用户Key实测。

## 插件与任务

独立capability text-to-speech@0.1.0、API4。工具speech_generate提交异步可能计费任务，speech_job_get查询／有界等待，speech_jobs分页找回，speech_get只返回元数据和record发送段。稳定request_id绑定文本、delivery、主人音色／模型和配置摘要；Host持久提交回执完成后才请求云端。重复同意图返回原任务，换参数拒绝；未知、连接中断、服务错误和改写失败均不自动重放或改协议重试。

配置和任务索引均严格schema1。最多200个任务、128MiB真实音频存储，孤立文件也计入容量；超限在请求前拒绝。单段最多1000字符／60秒，24kHz单声道PCM16封装WAV，无ffmpeg新依赖。已接受且请求发出后的任务由插件持有，普通Agent结束不丢结果；停用／dispose取消为未知，queued／running重启转unknown，未发送请求的撤权可明确失败。主人面板可显式确认删除非运行任务及音频，原动作账本不删除、旧请求不重新计费。

## 公开音频契约与QQ

SDK新增PluginAudioAsset、AudioAssetLease、PluginAudioProvider及getAudioAsset，独立于既有图片接口。仅当前标准WAV格式，跨边界核验实际字节、SHA-256、时长和大小；读前后与真正发送前复查同source／caller实例、connection、scope和AbortSignal。AI只见eating-audio://插件/assetId，不能指定任意URL／路径、字节预算或后台文件。

QQ沿用现有发送工具与OneBot标准record段。一条插件语音独立发送，配文另发；后台从授权lease展开Base64，不能通过image／text／合并转发冒用音频引用。语音字节不进模型、普通任务工具结果或Host动作账本。发送幂等及unknown不重发保持，合成成功与平台发送成功分别核对。

只对后台实际解析的音频计算额外预算，最多4MiB编码音频；与图片共用额外14MiB和全JSON15MiB硬上限，普通wire扣除可信媒体后仍≤1MiB，入站／响应／WebSocket普通上限不扩大。默认Base64发送，不新增公网音频路由，不借用图片共享目录配置假定远端音频可读。NapCat转码和远端实际播放依其部署环境；回环不能替代真人播放验证。

## 面板与生命周期

沿用白绿语义令牌、固定滚动区和双语资源。声音／服务配置无手动全局语气字段；保存／连接仅本地检查，不调用付费合成。试听需主人确认，固定自然语气，使用已保存配置；列表有真实queued／running／succeeded／failed／unknown和分页、播放／删除操作。冲突保草稿，语言切换不请求、不保存、不生成；隐藏／离页停止轮询、撤Blob和在途请求，隐藏清未保存Key，非秘密草稿保持。

宿主CSP只增加media-src 'self' blob:以播放授权接口返回的临时音频，不增加unsafe-eval、远程媒体来源或新public路由。默认未配置Key不调用真实服务，不向真人QQ试发。

## 版本与验证

应用／Host／Web0.20.0、plugin-sdk4.10.0、QQ0.15.0、新语音0.1.0。共享SDK产物改变使DSH／表情／生图／记忆压缩字节变化，按封存不可变规则分别升0.18.1／0.2.1／0.3.2／0.3.1，业务功能不改，四处版本同步。ui-sdk4.2.1／core4.0.0／API4保持。复用锁定ws8.22.0与现有React／lucide依赖，锁文件只增加新workspace importer，不新增外部版本或本地推理依赖。

构建／类型、回环Realtime协议、Host资源撤权、QQ大语音与unknown防重、真实系统DSH主→子→合成→发送回执及安装产物面板由[本轮报告](../reports/2026-11-09-OpenAI语音插件本地开发验证报告.md)记录实际结果。本轮用户已要求开发及本地提交；未安装／配置真实Key，未push或云端部署。
