# ADR-0043：公网 Token 入口与 Git 发布部署

状态：Accepted。日期：2026-11-03，Asia/Shanghai。依据：负责人明确要求本次服务器公网直连、不设置登录页面或账号密码，只用根页面 Token 入口；代码与通用部署脚本必须本地验证并提交推送，再由云端从 GitHub 拉取对应提交构建。Accepted 表示当前决策已确认，源码验证及实际部署结果另行记录。

## 背景与原因

此前 Host 仅按本机回环使用，管理 bootstrap 以本机访问为前提，不能直接把监听地址改成公网后继续沿用这个前提。本次增加显式外部模式，在进入管理页面及 bootstrap 前核验主人入口；本机默认仍为 `127.0.0.1`。负责人选择 HTTP 公网直连，本轮不增加 HTTPS、证书或网关，不操作防火墙。HTTP 传输不加密。

真实地址、端口、目录、Token、密钥及目标映射继续按[ADR-0042](ADR-0042-项目外SSH配置与部署隐私.md)保存在项目外，即使忽略文件也不得进入项目。最终可用链接另存本机项目外私有文件，报告只记录脱敏结果。

## 监听与入口决策

- `EATING_LISTEN_HOST` 只接受 `127.0.0.1` 或 `0.0.0.0`，省略时为前者。外部 `0.0.0.0` 必须同时配置 `EATING_PUBLIC_ORIGIN` 与 `EATING_OWNER_TOKEN`，缺失明确拒绝启动。
- `EATING_PUBLIC_ORIGIN` 是规范 HTTP(S) Origin，只含协议、主机及可选端口，不含路径、尾斜线、query、fragment 或凭据，用于现有 Host／Origin 检查。`EATING_HOST_PORT` 仍指定监听端口。
- `EATING_OWNER_TOKEN` 由部署者随机生成，长度32至256字符，只用字母、数字、下划线和短横线；不写入公开状态、前端持久存储、普通日志或报告。
- 入口只接受根路径 `GET /?token=<OWNER_TOKEN>`；根地址已有 query 时追加 `&token=<OWNER_TOKEN>`。Token 只出现一次，错误 Token、重复 Token、非根路径或非 GET 不能交换权限。
- 校验成功后签发独立随机入口 Cookie，设置 `HttpOnly; SameSite=Strict; Path=/`，再以 `303` 跳转到删除 Token、保留其他 query 的根地址；响应 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`。HTTPS Origin 下 Cookie 另带 `Secure`，这不表示本轮安装 HTTPS。
- 随后页面正常请求 `GET /api/bootstrap`，建立原有管理 session 与 CSRF；管理 API 继续核验 session，写操作继续核验 CSRF，Host／Origin／跨站及请求结构检查继续生效。入口 Cookie 随 Host 进程更新而失效，重启后重新使用私有入口链接。

不引入账号、密码、登录表单或另一套用户系统。仅打开根地址而没有有效入口 Cookie 时不能获取页面及 bootstrap。默认本机模式在没有配置 ownerToken 时保持原有流程；显式配置 ownerToken 时同样启用入口核验。

## 独立鉴权与官方 Web

`/mcp/:pluginId` 与 `/mcp-services/:id` 仍核验各自 Bearer；owner URL Token 和浏览器入口 Cookie 不代替 MCP 令牌或任务 scope。管理 session／CSRF 也不改成用 query Token 调 API。

系统 DSH 及官方 Web 按[ADR-0018](ADR-0018-系统DSH原生Web与看板移除.md)保持原样，其回环监听及官方鉴权入口不随 Eating Host 公网入口改写，不增加公网代理、客户端注入或额外只读层。Eating 公网页面可访问不等于远程浏览器已能访问官方 DSH Web 的回环地址。

## 发布与服务决策

1. 缺少运行时、项目依赖或工具时，先说明清单、用途及影响并询问安装。先前曾在新确认流程落实前安装 Node 等，已向用户承认；不能将这段事实改写成事先已获批准。用户随后批准保留应用专用 Node24.22.0／pnpm11.28.5／DSH0.2.1-rc.5，并批准安装仓库锁文件项目依赖；这不授权其他安装。
2. 所有代码及通用部署脚本本地修改、验证、commit、push；云端仅从 GitHub clone／pull 对应已确认 commit，不直接改云端源码，不上传本地工作区或源码包。
3. [构建脚本](../../scripts/server-build.mjs)由 `EATING_DEPLOY_CONFIG` 读取项目外私有配置，校验 commit、锁文件 SHA256、明确依赖安装批准和 pnpm 版本后，执行锁文件安装、完整构建及所列 Host／控制层回归。该脚本已在 `34feb79` 提交；此提交事实不表示本轮 Token 入口已发布或服务已启动。
4. [服务脚本](../../scripts/server-service.mjs)由 `EATING_SERVICE_CONFIG` 读取项目外私有配置，只管理用户级 `eating-managed.service` 和该 Eating 实例的当前五个插件，拒绝 root 执行及同名非托管 unit；不停止其他服务。服务数据、运行时、工具、unit、状态及配置留在项目外；脚本不自动安装系统软件、HTTPS 或防火墙规则。
5. 首次部署使用新数据目录，只安装当前插件产物，不迁入本机真实 AI、账号、模型 Key、人格或会话。新服务器记忆0.2.0未配置时保持未连接；本机真实记忆0.1.1保持。目标应用／Host／Web0.17.4，QQ0.13.6、DSH插件0.15.3及其他插件版本保持。

## 备选与影响

负责人已选择带 Token 的根入口和 HTTP 公网直连，因此本次不采用账号密码登录、SSH 转发入口或新增网关方案。默认回环模式保留为明确的本机使用方式，不能把旧回环说明解释成所有部署都只能本机访问。

服务启动、页面可用、Token 交换、管理鉴权、MCP Bearer、插件安装、外部连接和模型业务结果分别验收，不能把源码实现、构建成功或 unit active 当作全部业务连接成功。需要新增依赖、外围服务或变更真实配置时，按当前授权范围处理。

## 证据、后续与替代关系

本轮初始记录：源码实现验证中，云端尚未启动服务；不预填公网可用、测试通过或部署完成。最终命令、计数、提交／push、云端拉取及 live 验证由父代理维护的《2026-11-03-服务器Git拉取与Token入口部署验证报告》据实收口，报告创建后补链接。操作步骤见[服务器部署与更新](../operations/服务器部署与更新.md)，变更范围见[本轮变更](../changes/2026-11-03-公网Token入口与Git发布部署.md)。

本决策补充 ADR-0042 的发布和安装流程，部分替代 ADR-0010 中 Host 仅绑定回环的部署范围；默认本机行为、MCP 独立鉴权、其他功能及官方 DSH Web 边界保持。旧 ADR、报告、当时版本和数字不改写。
