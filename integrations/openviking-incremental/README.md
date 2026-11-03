# OpenViking 实时增量记忆扩展

> 历史方案：本目录保留记忆0.2.x的扩展实现与当时证据，不再是当前安装前提。openviking-memory0.3.0按[ADR-0045](../../docs/decisions/ADR-0045-官方记忆接口与插件部署提示.md)使用官方Session消息批量追加、commit与Task API；当前操作见[记忆插件说明](../../docs/operations/OpenViking记忆插件.md)。以下协议、安装命令和验证结论只描述旧方案，不要求为本轮Eating更新安装或重启真实OpenViking服务。

这是 Eating 的独立 Python 服务端扩展，安装包名 `eating-openviking-incremental`，导入名 `eating_openviking_incremental`。唯一支持的服务依赖是 **`openviking==0.5.2.1`**；源代码核对基于官方提交 `f5e6203033a13469c3d9a937f2ca39492ea69c51`。

本目录提供可评审的代码与临时数据测试。没有连接用户服务器，没有远程 SSH／HTTP，没有部署或写入真实资料，也没有修改官方源码。

## 入口与范围

ASGI 工厂 `eating_openviking_incremental:create_app` 直接调用官方 `openviking.server.app.create_app`，加入扩展路由，并嵌套原始 lifespan。官方鉴权插件、中间件、异常处理、Studio、MCP、原生服务初始化与退出保持原有生命周期。扩展 worker 在官方服务退出前结束。包提供 `extend_app(stock_app)`，供已有 Python 入口组合使用。

以下命令仅说明将来的独立环境使用方式，本轮没有执行到真实实例：

```bash
python -m pip install ./integrations/openviking-incremental
export OPENVIKING_CONFIG_FILE=/absolute/path/to/ov.conf
uvicorn eating_openviking_incremental:create_app --factory --host 127.0.0.1 --port 1933
```

工厂沿用官方配置路径与环境变量；不自建凭据、不注入私有 service HTTP、不启动第二个模型引擎。不调用 Session.commit，不调用 deleteSession。

提取直接复用官方 `SessionExtractContextProvider`、`ExtractLoop`、`MemoryIsolationHandler`、账号模板 registry 与 `StreamingMemoryUpdater`，后者调用 `MemoryUpdater`。只支持普通 user-stage 长期记忆（包括 Eating 使用的 preferences／entities／events）；不启动 Agent Evolution 训练或 session-skills 提取。显式请求 cases／trajectories／experiences／session_skills 会失败，不冒充已完成这些功能。

## HTTP 协议 v1

所有成功响应沿用 `{ "status": "ok", "result": ... }`。能力路由使用官方 `get_request_context`，会话路由使用官方 `get_session_request_context`；Session 必须已经存在。消息正文不能指定 account／user。会话定位由当前鉴权 account 与 user 的官方 canonical namespace 决定，持久原生 owner 必须一致。

官方 session context **不把 `X-OpenViking-Actor-Peer` 当作会话 ACL**。扩展保持这一语义。消息 peer 用官方 normalize_peer_id 校验；`__self` 是内部 sentinel，不能作为消息来源。可写 peer 只来自当前捕获批次的 user 消息，读写范围交给官方 isolation 与会话 self／peer／memory_types 策略。

- `GET /api/v1/eating-memory/capabilities` 返回 `protocol_version:1`、`server_version:"0.5.2.1"`、`incremental_extraction:true`、`history_segmentation:true`。
- `GET /api/v1/sessions/{id}/incremental-memory` 返回 `protocol_version`、`session_id`、`next_sequence`、`extracted_sequence`、`pending_messages`，以及 `managed`、`blocked`、`error_code`、`live_start_sequence`。
- `POST` 同一路由接收 `{request_id, expected_sequence, messages, archive_max_bytes}`。messages 为 1..1000 个 `{role:"user"|"assistant", content:string, peer_id:string|null, created_at:带时区RFC3339}`。`archive_max_bytes` 默认 8MiB，允许正整数至 64MiB；Eating UI 可限制 1..64MiB。
- `GET /api/v1/sessions/{id}/incremental-memory/requests/{request_id}` 返回权威回执，不依赖官方 TaskAPI 或它的 TTL。
- `POST /api/v1/sessions/{id}/incremental-memory/requests/{request_id}/retry` 只接受 `{}`。只有能够证明停在 updater 调用之前的 failed 请求，且它从当前 extracted_sequence 开始，才恢复原回执为 accepted 并排队。task_id、request_id、raw IDs 与序列不变，不重新追加消息。unknown／applying／processing 返回 HTTP409，不允许重放。已完成请求返回原回执。

回执固定字段：

```json
{
  "protocol_version": 1,
  "session_id": "eating-live-example",
  "request_id": "example-1",
  "status": "accepted",
  "task_id": "eating-incremental-<uuid>",
  "from_sequence": 0,
  "to_sequence": 2,
  "changes": null,
  "error_code": null,
  "archive_uris": []
}
```

游标从 0 开始，范围 `[from_sequence, to_sequence)`，`to_sequence = from_sequence + 消息数`。status 是 accepted／processing／completed／failed／unknown。completed 的 changes 为 `{added:int, updated:int, deleted:int}`，均为非负数，采用官方 memory diff 的文件变更分类；现有文件重写算 updated，原生 version／provenance 改变时即使正文相同也可能算 updated，不宣称它是语义事实净增量。task_id 始终是扩展持久 ID，不承诺可用于原生 TaskAPI。回执 error_code 是固定 `MEMORY_...` 标识，不包含异常正文或凭据。

request_id 为 1..128 个以字母或数字开头的安全字符（字母、数字、点、下划线、冒号、连字符）。同 ID 与同规范化请求 hash 返回原回执；不同 hash 返回 HTTP409。新请求的 expected_sequence 必须等于 next_sequence。回执不存在／已淘汰返回 HTTP404；不能因为这个 404 就重发结果不确定的消息。

默认只保留最近 512 条 completed 回执；未完成、failed、unknown 永不因数量淘汰。最多 128 个待处理请求，每次规范 JSONL 捕获最多 2MiB，未提取 raw 最多 32MiB。超限在捕获前返回 HTTP429。这些是容量保护，不是每天／每小时提取额度。已淘汰请求重试仍携带旧 expected_sequence，会被 HTTP409 拒绝；客户端不能给旧消息重新编造 ID／游标。

## 首次接入与独占写入

先用官方 API 创建独立新 Session，显式 `auto_commit_policy:null`。建议 Eating 使用 `eating-live-<peer>` 和明确的 `-local` 策略根。旧 Session 和资料保留，不迁移、不导入、不删除。

首次接入遇到非空 native live messages、缺失原生元数据、未完成／失败 native archive，返回 HTTP412 `UNMANAGED_SESSION`。原生 auto-commit 仍启用时返回 `NATIVE_AUTO_COMMIT_ENABLED`。GET 不会把已有原文标记为已提取或自行采集。

首次成功捕获后，该 Session 由扩展管理。包装应用给原生会话写路由增加官方鉴权依赖和 ownership gate：原生 append／batch／commit／config／delete 返回 HTTP412 `MANAGED_SESSION`。门锁跨越原生请求执行，防止首次接管与在途原生写的竞态。原生读取和 Studio 历史读取继续使用官方实现。

必须通过这个包装应用访问已管理的 Session。直接运行另一个未包装的 stock 服务、嵌入式代码或拥有底层写权限的调用者可以绕过路由门锁；扩展发现 live hash／消息数／archive cursor 变化会拒绝后续处理，但不能撤销外部进程已经执行的内存写入。Session 的底层原文／journal 文件不是给其它客户端写入的通用文件接口。

## 持久化与恢复语义

状态保存在原生 Session 下两个交替检查点 `.eating-incremental-0.json`／`.eating-incremental-1.json`。每个检查点含 revision、checksum、账号／用户／会话标识、单调游标、回执、策略快照和必要的在途 intent。原生 `.meta.json` 采用读取后更新，保留未知字段。

捕获、游标、快照和分段通过官方 `Session._state_lock` 取得 Session mutex 与子文件 exact leases。另一个官方 exact pathlock 在整个提取期间排他；不同 Session 可并发。同一 Session 可在已有提取期间排队捕获新批次。

写入顺序：

1. 先运行官方 extract_and_store_session_privacy 和 native message builder，保护已注册敏感值；重复 request_id 不再次处理。然后持久保存 capture intent（受保护的完整目标 live JSONL 与原 hash）及回执，再写原生 live JSONL／元数据，再清除 intent。未保护的输入只用于请求 hash，不作为 journal 原文保存。崩溃重启使用相同 raw message IDs 完成同一写入，不重复 append。
2. 在锁内固定本批精确 raw 范围和 hash。只读提取阶段可安全恢复，模型本身只使用官方 ExtractLoop。最多取同 Peer 的最近 4 条、16KiB 已提取原记录作为明确标注的只读背景；已分段记录通过 ArchiveStore 读取。背景独立插入官方 provider prefetch，不加入 provider.messages，所以 native ranges／所有权仍只对应新增 delta。0.5.2.1 的 latest_archive_overview 参数没有消费实现，扩展用一个小型 provider 子类补入这份背景，不另建模型循环。
3. 官方 updater 调用前，先持久保存 applying 检查点。成功返回后再保存 applied、实际 changes 和 extracted_sequence。只有确认成功才推进提取游标。
4. applying 没有 applied 证明时，恢复为 `unknown`／`MEMORY_APPLY_OUTCOME_UNKNOWN` 并阻塞该 Session，不自动再次调用 updater。模型提取失败为 failed，也阻止后续批次越过它。
5. checksum 失败时不从旧槽自动回退写入，避免丢失 apply-start 证据而重复应用。保留损坏的原字节，状态阻塞；能从另一有效槽定位的非完成回执报告 unknown。

这提供保守的 **不盲重放** 行为，**不是端到端 exactly-once 证明**。官方 0.5.2.1 的 memory apply 与扩展回执没有共同事务／可复用的提取 redo 提交原语，调用返回到 applied 检查点之间存在真实未知窗口。官方 updater 的部分写错误同样按 unknown 处理。没有自动“解除 unknown”接口；需要操作者核对内存文件及 journal 后做明确协调，不能通过删除回执再提交来绕过。

恢复在下一次同身份认证的状态／回执／捕获请求触发。扩展不在启动时用提权身份扫描所有用户，也不把 API Key 或请求令牌落盘。没有客户端轮询时，重启前的排队任务不会自行启动；Eating 的持久回执轮询承担唤醒。

底层写入持久性依赖官方 AGFS 对已确认写与 PathLock 的保证。双槽 checksum 能识别截断与修改，不能抵御存储系统回滚所有已确认数据。测试使用临时磁盘及原生核心；不能把故障注入测试等同于所有生产存储后端的断电验证。

## 按大小分段

每个完成批次检查已确认提取、仍在 live 的 raw JSONL 前缀字节数；未达到阈值时不建 archive。达到阈值时只分段这个已提取前缀，保留未提取尾部。单条／单批可以让 archive 超过阈值，按消息边界保存完整原记录。

复用官方 `ArchiveStore` 的编号／raw IDs／读取校验与原生布局：`history/archive_NNN/messages.jsonl`、`.meta.json`、`.done`。ArchiveStore 本身是只读工具，所以扩展负责写入这些原生文件。不会为了分段调用 Session.commit，也不会再次提取。`.done` 明确 working memory 关闭，记录 long_term 完成消息 IDs。

先保存 segment intent，再写 raw archive／元数据／完成标记，读取并核对 archive raw 和 IDs，最后才重写 live 尾部、更新原生 commit_count 与稳定序列。崩溃时允许短暂 raw 重叠；恢复按 journal 完成存储步骤，不重跑 memory updater。只有实际分段的完成回执带 archive_uris。

Studio 能通过官方 ArchiveStore 读取 completed archive 与原始消息；本扩展没有修改 Studio。真实浏览器渲染、工作记忆摘要和向量索引后端未在此代码评审任务中部署验证。

## 本地验证

```bash
uv venv --python python3.12 /tmp/eating-incremental-test
uv pip install --python /tmp/eating-incremental-test/bin/python -e './integrations/openviking-incremental[test]'
cd integrations/openviking-incremental
/tmp/eating-incremental-test/bin/python -m pytest
/tmp/eating-incremental-test/bin/ruff check src tests
```

测试只使用 tmp_path，正式官方 Python 核心、脚本化假模型与本地文件系统；另有 pinned wheel 真实 Rust AGFS／VikingFS／PathLock 的本地绑定测试。故障注入使用假文件系统锁，HTTP 用进程内 ASGI 与真实官方 API-key 插件、假凭据 store；没有访问用户服务器。不调用付费模型、不连接生产资料。最终实跑结果见[验证记录](验证记录.md)。
