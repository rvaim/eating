# ADR-0044：HTTP 前端安全请求标识

状态：Accepted。日期：2026-11-03，Asia/Shanghai。依据：负责人要求修复公网 HTTP 的 QQ 面板 `crypto.randomUUID is not a function`，统一公开 UI SDK 的请求标识生成并保留未知结果与同一意图的幂等语义。Accepted 表示决策已确认，当前源码验证中，实际云端保留数据更新及最终测试实数由本轮报告记录。

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

父代理统一完成严格类型、完整构建、相关单元／浏览器与读图、表情封存产物与版本核对，再按已授权链路本地 commit／push，云端从 GitHub 拉取确认提交并保留既存数据更新。实际配置、人格、会话、权限、资源、动作账本与 unknown 保留须以更新前后证据验收，不能凭构建成功声称已完成。缺运行时、依赖或工具仍须先说明并询问安装。

## 版本、隐私与替代关系

应用／Host／Web0.17.5、ui-sdk4.2.1、QQ0.13.7、DSH0.15.4、生图0.2.1、记忆源码0.2.1、表情包0.1.2；plugin-sdk4.7.0、plugin-core4.0.0、插件API4与所有数据 schema 保持。workspace 依赖继续使用已有 link，不新增依赖。

真实 host、端口、部署目录、SSH 别名、Token 及关联映射全部留项目外，不读取或复制服务器私有配置实际值到仓库。测试域名只用于隔离回环夹具，不代表真实部署目标。本 ADR 补充0043的 HTTP 前端平台能力要求，不替代其入口鉴权、Git发布、安装确认与隐私约束；旧 ADR 与报告保留当时事实。

源码范围见[本轮变更](../changes/2026-11-03-HTTP前端安全请求标识.md)。最终测试计数、真实公网浏览器、Git与保留数据更新证据由父代理维护的[本轮报告](../reports/2026-11-03-公网HTTP面板修复与保留数据更新验证报告.md)收口，当前不预填完成。
