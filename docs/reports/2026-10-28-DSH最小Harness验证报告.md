# DSH最小Harness验证报告

日期：2026-10-28，Asia/Shanghai。当前应用/Host/Web0.5.0、公开SDK1.4.0、QQ0.5.0、DSH插件0.1.0，apiVersion仍为1。

## 交付与执行顺序

用户要求的顺序已履行：先将日志与无历史队列提交为`fea2f7a`；随后实现提示词管理、多候选人格唯一启用及变量编辑器，完成456/19验证后提交`93a3d51`；此后才创建DSH插件代码。本阶段DSH实现留在工作区，未另行自动提交或推送。

最小DSH不是新的Host认知循环。QQ外部批次进入同一真实专属DSH Session，模型选择是否调用QQ MCP；Host不读取finalResponse作为QQ发送内容。使用公开官方SDK与匹配rc.4运行时，普通Node启动，不使用桌面app.asar、主DSH/Profile/凭据或50749服务。

## 独立插件与数据

[DSH包](../../plugins/harness/dsh/)独立产物仍为清单、server.mjs、ui/index.js和ui/style.css。SDK client捆入插件后台；庞大运行时依赖不捆入Host或16MiB插件包，而在`EATING_HOME/harness/dsh/runtime`独立安装。同版本公开DSH/provider/MCP三包固定，实际完整锁文件保留；本轮pi-ai实际解析1.4.0，不能拿旧源码锁的1.3加补丁冒充相同构建。

运行数据包含config.json、session.json、dsh-home、agents-home、workspace、runtime-home、bridge与版本化runtime。目录0700、配置0600；模型Key只写不回显，留空保留、明确勾选清除。子进程环境允许清单、双home与HOME分别专属，QQ MCP凭据由Host按授权通讯插件提供。管理安装不进入MCP工具表。

安装使用静态npm/pnpm参数、不经Shell、禁安装脚本、独立HOME/npmrc/cache，保留完整lockfile与原子current指针，支持10分钟上限和取消；只有明确ESRCH的旧进程锁、经路径/ino/dev再次核对后才可回收。失败不删除旧运行时或任何主人会话。首版关闭原生文件、工作目录、持久Shell、MCP资源及无用终端/PTY后端；真实模型请求仅出现9个QQ MCP工具。此组合限制不等于OS沙箱。

## 持久交接、恢复和策略

固定UUID在明确启动时创建。首次空会话经过公开持久屏障后写session-ready哨兵，才记created；重启显式resume同ID，缺失/占用/损坏失败不会新建替代会话。读到已在磁盘的同ID会话可先恢复哨兵，覆盖首次flush后本地状态尚未更新的窗口。

每批信封外层含Host生成的magic、nonce、sessionId、batchId和digest；外部QQ正文不能靠嵌套同名字段伪装主人控制。主人主提示词与唯一启用人格通过公开systemPrompt.section complete=true、interpolate=false贡献唯一system正文，群/私聊模板及外部消息只在user JSON中。策略按批固定，主人编辑作用于下一请求，会话不变。

SDK排队、matching inbox/spliced、root idle都不是独立fsync凭证。桥等待事件持久监听器接纳后调用公开sessions.flush，必须成功且true，才原子写仅元数据ACK。适配器逐项匹配nonce、会话、批次与digest，Host本地确认后删除队列正文。flush后ACK前的窗口通过公开persistence只读handle核对持久记录并重签当前nonce，不再次prompt；没有SDK调用方幂等入口，因此不承诺exactly-once。

运行时单批一直占用至模型idle和交接处理结束；ACK早到不释放模型busy。Gateway isReady=false不选批、不耗拒收次数、不启空轮询，模型结束wake恢复。本地确认写入重试优先，不被busy挡住。下一批元数据成功保存后安全移除上一批ACK，正常连续处理仅保留当前恢复证据，不累积永久ACK历史或后台清理计时器。元数据失败且尚未run时，启动只清无归属固定expected控制文件。

原生DSH会话JSONL属于所选Harness的上下文和恢复数据；Eating不建立第二份聊天历史。停止/停用不删除原生会话。可靠交接、模型本轮失败、工具成功与平台发送结果分开；SDK事件显示turn/end错误时提供固定错误说明，不回显原始失败或转发模型文本。

## Host与通讯边界

清单kind区分communication/harness，数据分别位于bot/harness，跨kind升级拒绝隐式改绑。只有Harness入口获得注册sink、wake、只读主人配置和已授权通讯MCP连接服务；只读快照冻结，不提供persona修改能力。Host同时只允许一个主sink，管理接口沿用owner session、CSRF、Host/Origin边界。

停用先持久化disabled并撤销日志、sink及权限，再等待断开；disconnect失败也不恢复启用状态，明确重新enable后才可重新订阅。旧实时日志回归保持订阅数量、心跳清理和新视图无历史等严格断言。

QQ0.5增加可选messageId/targetId到规范化信封，旧待投递信封仍可读；机器人自己的消息回显不转给Harness，避免回复反馈循环，临时可见日志仍可观察该接收准入。用户账号配置、动作幂等和原队列不重写。

## 已执行验证

普通Node24.22.0、pnpm11.28.5，测试只用本地模型SSE端与OneBot WebSocket端。没有向真人发送自动测试消息，没有使用真实提供商Key。

| 检查 | 实际结果 |
| --- | --- |
| 完整SDK/Host/Web与两个插件构建 | 通过，Host不静态捆插件源码 |
| 根严格TypeScript、diff空白检查 | 通过 |
| Vitest | 24文件541/541，31.55秒 |
| Playwright | 23/23，10.9秒，含旧19项完整回归 |
| DSH配置/适配器定向 | 35/35 |
| 运行时安装/持久桥定向 | 24/24 |
| Host/Gateway/安装器定向 | 146/146（23+57+66） |
| 真实官方SDK集成 | 2/2，一项独立安装产物约28.5秒 |
| 实际部署UI截图 | 1440与390px已逐一读取，pageerror0、无横向溢出 |
| 独立限定UI交付复核 | SHIP，material findings=0，无需重采 |

完整实跑命令：

```bash
pnpm build
EATING_DSH_TEST_RUNTIME="$PWD/.impeccable/runtime-cache/dsh" pnpm test
pnpm test:e2e
```

`EATING_DSH_TEST_RUNTIME`必须指向已准备的独立DSH数据目录（内含runtime/current.json及版本依赖树）；未设置时默认跳过两项真实SDK测试，不能称已完整跑过541项。本轮实际独立npm安装已成功，运行依赖路径全部核在专属目录。该缓存为开发验证准备，不进Git。

第一项实际SDK测试验证QQ私聊→同会话→桥持久ACK→Host删除正文→模型QQ MCP→OneBot发送；下一条模型仅返回非空内部文本、没有工具调用，OneBot无新增发送；更新main与active persona后下一system变化而旧策略及外部文本不混入；群聊调用正确目标；停止再启动同ID且无额外模型请求或发送。

第二项复制独立QQ/DSH产物到临时批准安装源，校验安装后删除来源；将正式npm运行时图物理复制到该临时Home的harness/dsh专属目录，使用正式默认后台入口，未注入假SDK、ACK或运行时。实际回复后关闭整个Host，重建Host并恢复同一会话；后续沉默无额外发送，队列正文可靠删除。

浏览器新增四项验证Harness/通讯分类、空配置与Key只写/保留/清除、异步安装/启动停止/unknown不重复提交、隐藏与迟到响应、资源失败隔离、390px操作；其中忙闲状态展示用明确UI DTO夹具，不把它当SDK实跑。真实SDK忙闲与MCP链由上述独立集成覆盖。

## 当前部署

当前联合服务job为`bash-7b27e976826d465e`，界面[Harness管理](http://127.0.0.1:5180/#harness/dsh)，Host5181。正式CLI安装QQ0.5.0与DSH0.1.0，预装运行时来自本轮实际npm安装通过的依赖图；仅在目标目录不存在时克隆到Eating专属目录，未覆盖任何既有配置。

- QQ已启用且connected；DSH已启用但unconfigured。
- DSH runtime installed=true、installing=false、ready=false、busy=false、sessionId=null、lastError=null。
- Harness not-attached，原3条待投递消息保留；不会自动启动空配置模型或消费这些消息。
- QQ账号索引、配置文件、队列正文、actions发送账本四项指纹与升级前完全一致。
- 两插件logViewerCount均0，无后台消息日志查看者或模型进程。

真实5180的1440/390截图已读取并由新鲜只读复核判SHIP；两图均如实同时显示“待配置/未启动”和“运行时已安装”，没有模型已认证或在线的假成功。继承既有白底绿色两级管理设计，无需重定设计系统。

使用时填写独立的API基础地址、模型名称和API Key（允许无Key的服务可不填），保存后点击“启动Harness”。运行时已预装可跳过安装按钮；QQ需已连接并开启转交。启动就绪不等于真实提供商认证成功，模型请求结果按实际处理状态显示。

## 限制与后续

真实外部提供商认证未验证，不能用夹具结果代替；无主DSH/现有账户凭据借用。没有原生Web会话页、历史查看、完整自主生活调度、长期记忆、OS沙箱、跨Harness无损迁移或三平台打包承诺。运行时空闲意外退出会在下一SDK操作发现，当前不加常驻健康轮询；无ACK不会删除Host正文。断电/文件系统损坏的全部组合不在本轮实际进程终止证明范围，错误恢复单元与公开屏障证据各自标明。

完整变更见[本轮变更](../changes/2026-10-28-DSH最小Harness接入.md)，当前入口见[项目状态](../项目状态.md)，先前提示词管理验收保持在[历史报告](2026-10-27-提示词与人格管理验证报告.md)。
