"""Execute official ExtractLoop, isolation, streaming updater and MemoryUpdater."""

from __future__ import annotations

import json
from importlib.metadata import version

import pytest
from conftest import SimulatedCrash, capture_request
from openviking.models.vlm.base import VLMResponse
from openviking.session.compressor_v3 import SessionCompressorV3
from openviking.session.memory.dataclass import MemoryField, MemoryTypeSchema
from openviking.session.memory.memory_type_registry import MemoryTypeRegistry
from openviking.session.memory.merge_op import FieldType, MergeOp
from openviking.session.memory.streaming_memory_updater import StreamingMemoryUpdaterConfig
from openviking.session.memory.utils.memory_file_utils import MemoryFileUtils

from eating_openviking_incremental import IncrementalMemory
from eating_openviking_incremental.native import NativePipeline


class ScriptedModel:
    model = "scripted-no-network"
    max_tokens = 4096

    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    async def get_completion_async(self, **kwargs):
        self.calls.append(kwargs)
        response = next(self.responses)
        for items in response.values():
            if isinstance(items, list):
                for index, item in enumerate(items):
                    item.setdefault("page_id", 100 + index)
        return VLMResponse(content=json.dumps(response))

    async def get_vlm(self, account_id):
        assert account_id == "account-a"
        return self


@pytest.fixture
def native_setup(environment, monkeypatch):
    env = environment
    registry = MemoryTypeRegistry(load_schemas=False)
    registry.register(
        MemoryTypeSchema(
            memory_type="events",
            description="Atomic events",
            directory="viking://user/{{ user_space }}/memories/events",
            filename_template="{{ event_name }}.md",
            operation_mode="add_only",
            fields=[
                MemoryField(
                    name="event_name", field_type=FieldType.STRING, merge_op=MergeOp.IMMUTABLE
                ),
                MemoryField(name="content", field_type=FieldType.STRING, merge_op=MergeOp.REPLACE),
                MemoryField(name="ranges", field_type=FieldType.STRING, merge_op=MergeOp.IMMUTABLE),
            ],
        )
    )
    monkeypatch.setattr(
        "eating_openviking_incremental.native.get_default_registry", lambda: registry
    )
    monkeypatch.setattr("openviking.storage.viking_fs._base._instance", env.fs)
    return env


async def run_native(env, model, requests):
    compressor = SessionCompressorV3(
        vikingdb=None,
        vlm_resolver=model,
        streaming_memory_updater_config=StreamingMemoryUpdaterConfig(
            max_operations_per_update=1,
            max_wait_seconds=0.01,
            timer_check_interval_seconds=0.01,
        ),
    )
    env.sessions._session_compressor = compressor
    pipeline = NativePipeline()
    original_prepare = pipeline.prepare
    env.native_prepared = []

    async def prepare(*args, **kwargs):
        prepared = await original_prepare(*args, **kwargs)
        env.native_prepared.append(prepared)
        return prepared

    pipeline.prepare = prepare
    manager = IncrementalMemory(pipeline, auto_start=False)
    errors = []
    original_failure = manager._record_failure

    async def record_failure(*args, **kwargs):
        errors.append(kwargs.get("error"))
        await original_failure(*args, **kwargs)

    manager._record_failure = record_failure
    receipts = []
    for req in requests:
        session = await env.sessions.open(env.session.session_id, env.ctx)
        await manager.capture(session, req)
        await manager.run_pending(session)
        receipts.append(await manager.request_receipt(session, req.request_id))
        if req.request_id != "one" or len(requests) > 1:
            assert not errors, [repr(error) for error in errors]
    manager.test_errors = errors
    return manager, receipts


async def test_real_native_chain_creates_peer_memory_and_readonly_context(native_setup):
    env = native_setup
    assert version("openviking") == "0.5.2.1"
    model = ScriptedModel(
        [
            {
                "events": [
                    {"event_name": "tea", "content": "Likes tea", "ranges": "0", "peer_id": "qq-a"}
                ]
            },
            {
                "events": [
                    {
                        "event_name": "coffee",
                        "content": "Likes coffee",
                        "ranges": "0",
                        "peer_id": "qq-a",
                    }
                ]
            },
        ]
    )
    manager, receipts = await run_native(
        env,
        model,
        [
            capture_request(),
            capture_request("two", 1, text="Also coffee."),
        ],
    )
    assert [receipt["status"] for receipt in receipts] == ["completed", "completed"]
    assert env.native_prepared[0].operations.upsert_operations, env.native_prepared
    assert [receipt["changes"] for receipt in receipts] == [
        {"added": 1, "updated": 0, "deleted": 0},
        {"added": 1, "updated": 0, "deleted": 0},
    ]
    prefix = "viking://user/alice/peers/qq-a/memories/events/"
    tea = MemoryFileUtils.read(await env.fs.read_file(prefix + "tea.md", ctx=env.ctx))
    assert tea.content == "Likes tea"
    assert not await env.fs.exists("viking://user/alice/memories/events/tea.md", ctx=env.ctx)
    assert len(model.calls) == 2
    # Old message appears as bounded background, while the current range remains 0.
    second_prompt = json.dumps(model.calls[1]["messages"], ensure_ascii=False)
    assert "Previously extracted background" in second_prompt
    assert "I like tea" in second_prompt and "Also coffee" in second_prompt
    assert (await manager.status(env.session))["extracted_sequence"] == 2


async def test_real_native_replacement_counts_updates_for_existing_files(native_setup):
    env = native_setup
    model = ScriptedModel(
        [
            {
                "events": [
                    {"event_name": "tea", "content": "Likes tea", "ranges": "0", "peer_id": "qq-a"}
                ]
            },
            *[
                {
                    "events": [
                        {
                            "event_name": "tea",
                            "content": "Prefers green tea",
                            "ranges": "0",
                            "peer_id": "qq-a",
                        }
                    ]
                }
                for _ in range(8)
            ],
        ]
    )
    _, receipts = await run_native(
        env,
        model,
        [
            capture_request(),
            capture_request("two", 1, text="Now I prefer green tea."),
            capture_request("three", 2, text="Still green tea."),
        ],
    )
    assert [receipt["status"] for receipt in receipts] == ["completed"] * 3
    assert receipts[1]["changes"] == {"added": 0, "updated": 1, "deleted": 0}
    # Native apply bumps durable version/provenance even for identical body text.
    assert receipts[2]["changes"] == {"added": 0, "updated": 1, "deleted": 0}


async def test_real_native_model_cannot_write_an_unmentioned_peer(native_setup):
    env = native_setup
    model = ScriptedModel(
        [
            {
                "events": [
                    {"event_name": "leak", "content": "Forbidden", "ranges": "0", "peer_id": "qq-b"}
                ]
            },
        ]
        * 8
    )
    _, receipts = await run_native(env, model, [capture_request()])
    assert receipts[0]["status"] in {"completed", "failed"}
    forbidden = "viking://user/alice/peers/qq-b/memories/events/leak.md"
    assert not await env.fs.exists(forbidden, ctx=env.ctx)
    assert not [uri for uri, _ in env.fs.writes if "/peers/qq-b/" in uri]


async def test_real_native_empty_operations_success_has_zero_changes(native_setup):
    env = native_setup
    model = ScriptedModel([{}])
    _, receipts = await run_native(env, model, [capture_request()])
    assert receipts[0]["status"] == "completed"
    assert receipts[0]["changes"] == {"added": 0, "updated": 0, "deleted": 0}


async def test_real_memory_write_crash_becomes_unknown_without_reapply(native_setup):
    env = native_setup
    model = ScriptedModel(
        [
            {"events": [{"event_name": "tea", "content": "Likes tea", "ranges": "0"}]},
        ]
    )
    env.sessions._session_compressor = SessionCompressorV3(vikingdb=None, vlm_resolver=model)
    manager = IncrementalMemory(NativePipeline(), auto_start=False)
    await manager.capture(env.session, capture_request())

    def crash_after_real_memory_write(uri, content):
        if uri.endswith("/memories/events/tea.md"):
            raise SimulatedCrash()

    env.fs.after_write = crash_after_real_memory_write
    session = await env.sessions.open(env.session.session_id, env.ctx)
    with pytest.raises(SimulatedCrash):
        await manager.run_pending(session)
    env.fs.after_write = None
    uri = "viking://user/alice/peers/qq-a/memories/events/tea.md"
    written = await env.fs.read_file(uri, ctx=env.ctx)
    recovered = IncrementalMemory(NativePipeline(), auto_start=False)
    receipt = await recovered.request_receipt(session, "one")
    assert receipt["status"] == "unknown"
    assert receipt["error_code"] == "MEMORY_APPLY_OUTCOME_UNKNOWN"
    with pytest.raises(Exception) as exc:
        await recovered.capture(session, capture_request("two", 1))
    assert exc.value.code == "SESSION_BLOCKED"
    await recovered.run_pending(session)
    assert await env.fs.read_file(uri, ctx=env.ctx) == written
    assert len(model.calls) == 1
    assert (await recovered.status(session))["extracted_sequence"] == 0


async def test_native_resolution_errors_fail_before_apply(native_setup, monkeypatch):
    from openviking.session.memory.dataclass import ResolvedOperations

    env = native_setup
    model = ScriptedModel([])

    async def invalid_resolution(self):
        return ResolvedOperations(
            upsert_operations=[], delete_file_contents=[], errors=["fake unresolved operation"]
        ), []

    monkeypatch.setattr("eating_openviking_incremental.native.ExtractLoop.run", invalid_resolution)
    _, receipts = await run_native(env, model, [capture_request()])
    assert receipts[0]["status"] == "failed"
    assert receipts[0]["error_code"] == "MEMORY_EXTRACTION_FAILED"
    assert receipts[0]["changes"] is None
    assert not [uri for uri, _ in env.fs.writes if "/memories/" in uri]
