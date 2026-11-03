# ADR-0044：HTTP 前端安全请求标识

状态：Accepted。日期：2026-11-03，Asia/Shanghai。依据：负责人要求修复公网 HTTP 的 QQ 面板 `crypto.randomUUID is not a function`，统一公开 UI SDK 的请求标识生成并保留未知结果与同一意图的幂等语义。源码验证与实际云端保留数据更新已完成。修复提交 `ab19cbb` 已本地commit／push并由云端GitHub取同提交完整构建及Host回归后更新原数据目录，最终证据由本轮报告记录。

## 背景与根因

公网非 HTTPS Origin 不是浏览器安全上下文，`crypto.randomUUID()` 受 secure context 限制，在该环境不可用；QQ 面板创建初始请求 ID 时直接调用它会抛出 TypeError，阻断面板渲染。前次通过 localhost 隧道核验页面时，浏览器将 localhost 视作可信来源，`isSecureContext === true`，掩盖了真实公网 HTTP 缺少该 API 的问题。后台插件安装、数据格式或 QQ 连接不是这一前端异常的根因。

[ADR-0043](ADR-0043-公网Token入口与Git发布部署.md)已确立本轮 HTTP 公网直连平台契约。本次修复让当前前端使用该环境实际提供的安全随机 API，不移除安全随机、不强制 HTTPS，也不引入 HTTPS、证书、网关或防火墙变更。HTTP 传输不加密的事实及入口鉴权边界保持。

## 决策

公开 `@eating/ui-sdk` 导出同步 `createRequestId(): string`。所有上下文都只调用 `globalThis.crypto.getRandomValues` 填充16字节，将第6字节高四位设为 `0100`、第8字节高两位设为 `10`，格式化为小写十六进制 `8-4-4-4-12` RFC UUIDv4。该算法保留122位安全随机熵。

不调用 `randomUUID`，不设置 `randomUUID` 优先分支或 fallback；不使用 `Math.random`、时间或计数器，不增加依赖。若平台没有可用的 `getRandomValues`，明确失败，不伪造请求标识。

调用方只从公开 UI SDK 导入 helper，覆盖应用 workspace、QQ 面板、生图面板、DSH NativeCapabilities 和记忆 ranges 五处前端文件。Node 后台继续使用其当前 UUID 生成方式，本轮后台文件仅同步对应插件 version。表情包没有引用该 helper，功能保持；统一构建后的封存差异核对发现共享SDK入口新增导出使其压缩UI产物字节变化，后台与CSS在版本升级前保持。同版本产物不可变规则仍严格执行，因此只将表情包四处version升至0.1.2，不绕过封存校验、不扩展功能。

## 请求意图与未知结果

生成算法只决定新 ID 的字节来源，不改变 ID 的生命周期。一个意图创建一次请求 ID，提交、查询、重试或未知结果核对继续复用原 ID；未知结果不得自动换号重发。编辑为新意图或主人明确新建操作时，按现有调用方语义生成新 ID。QQ 手动副作用确认、生图可能计费请求、DSH 管理操作与记忆增量回执的原幂等契约保持，数据 schema 与原有动作账本不迁移、不清空。

## 验证要求

浏览器回归使用明显的测试域名 `eating-http.test`，仅在测试浏览器内映射至 `127.0.0.1`，以真实 HTTP Origin 运行并断言 `isSecureContext === false`。不得 mock、删除或替换浏览器 crypto API 来模拟非安全上下文；须确认原生 `randomUUID` 不可用、`getRandomValues` 可用，检查 QQ 与相关面板可打开、操作 ID 符合 UUIDv4，以及 unknown 后原 ID 保持／同一意图复用原号。localhost 成功只能作本机对照，不能代替该回归或真实公网浏览器验证。

严格类型与完整构建通过，最终全量1743项通过／8项条件跳过（114.58秒）；最后真实非secure HTTP三项与表情真实安装保库一项共4项浏览器通过（8.2秒）。此前两轮全量各有一项QQ／表情旧version literal断言失败，已随当前版本修正，生产封存guard未放宽。

实际公网浏览器确认 `isSecureContext === false`、`crypto.randomUUID === undefined`、getRandomValues为function，QQ配置可见、UUIDv4请求ID切tab复用，pageerror／UUIDerror均0，无POST mutation，入口Token已从URL去除。该验证使用当前HTTP入口，不再以localhost隧道代替。

云端从GitHub取修复提交 `ab19cbb` 完整构建／Host回归期间原服务不停；停Eating前确认idle=true、队列0，项目外备份既存小数据，再通过正式服务脚本更新同一数据目录。12受保护文件哈希全部相同，Host settings摘要、数据库各表行数与schema、保存插件公开配置canonical摘要和ownerToken全相同，原所有系统服务仍running。五插件实际为QQ0.13.7、DSH0.15.4、表情0.1.2、生图与记忆0.2.1。用户用原Token链接重新进入并刷新即可，无需重装，端口与Token不变；没有新增依赖、TLS、网关、防火墙或本机运行时改动。缺运行时、依赖或工具仍须先说明并询问安装。

## 版本、隐私与替代关系

应用／Host／Web0.17.5、ui-sdk4.2.1、QQ0.13.7、DSH0.15.4、生图0.2.1、记忆源码0.2.1、表情包0.1.2；plugin-sdk4.7.0、plugin-core4.0.0、插件API4与所有数据 schema 保持。workspace 依赖继续使用已有 link，不新增依赖。

真实 host、端口、部署目录、SSH 别名、Token 及关联映射全部留项目外，不读取或复制服务器私有配置实际值到仓库。测试域名只用于隔离回环夹具，不代表真实部署目标。本 ADR 补充0043的 HTTP 前端平台能力要求，不替代其入口鉴权、Git发布、安装确认与隐私约束；旧 ADR 与报告保留当时事实。

源码范围见[本轮变更](../changes/2026-11-03-HTTP前端安全请求标识.md)。最终测试计数、真实公网浏览器、Git与保留数据更新证据见[本轮报告](../reports/2026-11-03-公网HTTP面板修复与保留数据更新验证报告.md)，旧报告及当时数字不改写。
