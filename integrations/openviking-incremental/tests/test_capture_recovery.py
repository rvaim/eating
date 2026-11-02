from __future__ import annotations

import asyncio
import json

import pytest
from conftest import RecordingPipeline, SimulatedCrash, capture_request
from openviking.message import Message, TextPart
from openviking.server.identity import RequestContext, Role
from openviking.session.archive_store import ArchiveStore
from openviking_cli.session.user_id import UserIdentifier

from eating_openviking_incremental import IncrementalError, IncrementalMemory
from eating_openviking_incremental.service import LOCKED_FILES, SLOTS, JournalCorrupt


async def reopened(env):
    return await env.sessions.open(env.session.session_id, env.ctx)


async def test_small_captures_retain_raw_and_do_not_archive(environment):
    env = environment
    pipeline = RecordingPipeline()
    manager = IncrementalMemory(pipeline, auto_start=False)
    assert (await manager.status(env.session))["next_sequence"] == 0
    first = await manager.capture(env.session, capture_request())
    assert (first["from_sequence"], first["to_sequence"], first["status"]) == (0, 1, "accepted")
    assert isinstance(first["task_id"], str)
    await manager.run_pending(env.session)
    receipt = await manager.request_receipt(await reopened(env), "one")
    assert receipt["status"] == "completed"
    assert receipt["changes"] == {"added": 1, "updated": 0, "deleted": 0}
    assert receipt["archive_uris"] == []
    assert not await env.fs.exists(env.session.uri + "/history", ctx=env.ctx)
    raw = await env.fs.read_file(env.session.uri + "/messages.jsonl", ctx=env.ctx)
    assert json.loads(raw)["parts"][0]["text"] == "I like tea."
    second = await manager.capture(await reopened(env), capture_request("two", 1))
    assert second["from_sequence"] == 1
    await manager.run_pending(await reopened(env))
    state = await manager.status(await reopened(env))
    assert (state["next_sequence"], state["extracted_sequence"], state["pending_messages"]) == (
        2,
        2,
        0,
    )
    assert len(pipeline.applied) == 2
    assert pipeline.applied[0] != pipeline.applied[1]


async def test_idempotent_hash_and_stale_sequence(environment):
    env = environment
    manager = IncrementalMemory(RecordingPipeline(), auto_start=False)
    req = capture_request()
    receipt = await manager.capture(env.session, req)
    assert await manager.capture(await reopened(env), req) == receipt
    assert (
        len((await env.fs.read_file(env.session.uri + "/messages.jsonl", ctx=env.ctx)).splitlines())
        == 1
    )
    with pytest.raises(IncrementalError, match="payload differs") as exc:
        await manager.capture(await reopened(env), capture_request(text="Different"))
    assert exc.value.http_status == 409
    with pytest.raises(IncrementalError) as exc:
        await manager.capture(await reopened(env), capture_request("two", 0))
    assert exc.value.code == "SEQUENCE_CONFLICT"


async def test_receipts_bounded_and_evicted_request_cannot_append(environment):
    env = environment
    manager = IncrementalMemory(RecordingPipeline(), auto_start=False, max_receipts=2)
    old_request = capture_request()
    for index in range(4):
        req = old_request if index == 0 else capture_request(f"req-{index}", index)
        await manager.capture(await reopened(env), req)
        await manager.run_pending(await reopened(env))
    async with env.session._state_lock(*LOCKED_FILES):
        state = await manager._load(env.session)
    assert len(state["records"]) == 2
    with pytest.raises(IncrementalError) as exc:
        await manager.request_receipt(await reopened(env), "one")
    assert exc.value.http_status == 404
    with pytest.raises(IncrementalError) as exc:
        await manager.capture(await reopened(env), old_request)
    assert exc.value.code == "SEQUENCE_CONFLICT"


async def test_capture_queues_while_one_distributed_extractor_runs(environment):
    env = environment
    pipeline = RecordingPipeline()
    pipeline.release = asyncio.Event()
    first = IncrementalMemory(pipeline, auto_start=False)
    second = IncrementalMemory(pipeline, auto_start=False)
    await first.capture(env.session, capture_request())
    worker = asyncio.create_task(first.run_pending(env.session))
    await asyncio.wait_for(pipeline.entered.wait(), 1)
    await asyncio.wait_for(second.capture(await reopened(env), capture_request("two", 1)), 1)
    await second.run_pending(await reopened(env))
    assert len(pipeline.prepared) == 1
    pipeline.release.set()
    await asyncio.wait_for(worker, 2)
    assert len(pipeline.prepared) == len(pipeline.applied) == 2
    assert (await second.status(await reopened(env)))["extracted_sequence"] == 2
    assert not env.fs._async_agfs.held


async def test_native_unmanaged_messages_are_never_adopted(environment):
    env = environment
    await env.session.add_message_async("user", [TextPart("Old native message")], peer_id="qq-a")
    before = list(env.fs.writes)
    manager = IncrementalMemory(RecordingPipeline(), auto_start=False)
    for action in (manager.status(env.session), manager.capture(env.session, capture_request())):
        with pytest.raises(IncrementalError) as exc:
            await action
        assert exc.value.code == "UNMANAGED_SESSION"
    assert env.fs.writes == before


async def test_native_auto_commit_rejected_without_mutation(environment):
    env = environment
    await env.session.update_config(auto_commit_policy={"message_count_threshold": 2})
    manager = IncrementalMemory(RecordingPipeline(), auto_start=False)
    with pytest.raises(IncrementalError) as exc:
        await manager.capture(env.session, capture_request())
    assert exc.value.code == "NATIVE_AUTO_COMMIT_ENABLED"
    assert not await manager.is_managed(env.session)


@pytest.mark.parametrize("crash_after_live", [False, True])
async def test_capture_write_ahead_recovers_without_duplicate_append(environment, crash_after_live):
    env = environment
    manager = IncrementalMemory(RecordingPipeline(), auto_start=False)

    def crash(uri, content):
        if uri.endswith("/messages.jsonl") if crash_after_live else uri.endswith(SLOTS[1]):
            raise SimulatedCrash()

    env.fs.after_write = crash
    req = capture_request()
    with pytest.raises(SimulatedCrash):
        await manager.capture(env.session, req)
    env.fs.after_write = None
    recovered = IncrementalMemory(RecordingPipeline(), auto_start=False)
    receipt = await recovered.capture(await reopened(env), req)
    assert receipt["from_sequence"] == 0 and receipt["to_sequence"] == 1
    raw = await env.fs.read_file(env.session.uri + "/messages.jsonl", ctx=env.ctx)
    assert len(raw.splitlines()) == 1
    await recovered.run_pending(await reopened(env))
    assert (await recovered.status(await reopened(env)))["extracted_sequence"] == 1


async def test_crash_during_read_only_extraction_can_resume(environment):
    env = environment
    failed = RecordingPipeline()
    failed.prepare_error = SimulatedCrash()
    manager = IncrementalMemory(failed, auto_start=False)
    await manager.capture(env.session, capture_request())
    with pytest.raises(SimulatedCrash):
        await manager.run_pending(env.session)
    recovered = RecordingPipeline()
    manager = IncrementalMemory(recovered, auto_start=False)
    await manager.run_pending(await reopened(env))
    assert len(recovered.applied) == 1
    assert (await manager.request_receipt(await reopened(env), "one"))["status"] == "completed"


async def test_crash_after_native_apply_blocks_replay_and_cursor(environment):
    env = environment
    pipeline = RecordingPipeline()
    pipeline.apply_error = SimulatedCrash()
    manager = IncrementalMemory(pipeline, auto_start=False, max_receipts=1)
    await manager.capture(env.session, capture_request())
    await manager.capture(env.session, capture_request("two", 1))
    with pytest.raises(SimulatedCrash):
        await manager.run_pending(env.session)
    recovered_pipeline = RecordingPipeline()
    recovered = IncrementalMemory(recovered_pipeline, auto_start=False)
    await recovered.run_pending(await reopened(env))
    receipt = await recovered.request_receipt(await reopened(env), "one")
    assert receipt["status"] == "unknown"
    assert receipt["error_code"] == "MEMORY_APPLY_OUTCOME_UNKNOWN"
    assert receipt["changes"] is None
    state = await recovered.status(await reopened(env))
    assert state["extracted_sequence"] == 0 and state["pending_messages"] == 2
    assert len(pipeline.applied) == 1 and not recovered_pipeline.applied
    with pytest.raises(IncrementalError) as exc:
        await recovered.capture(await reopened(env), capture_request("three", 2))
    assert exc.value.code == "SESSION_BLOCKED"
    assert (await recovered.request_receipt(await reopened(env), "two"))["status"] == "accepted"


async def test_failed_extraction_blocks_following_batches(environment):
    env = environment
    pipeline = RecordingPipeline()
    pipeline.prepare_error = RuntimeError("do not expose model credentials or response")
    manager = IncrementalMemory(pipeline, auto_start=False)
    await manager.capture(env.session, capture_request())
    await manager.capture(env.session, capture_request("two", 1))
    await manager.run_pending(env.session)
    receipt = await manager.request_receipt(await reopened(env), "one")
    assert receipt["status"] == "failed"
    assert receipt["error_code"] == "MEMORY_EXTRACTION_FAILED"
    assert "credentials" not in json.dumps(receipt)
    assert (await manager.status(await reopened(env)))["extracted_sequence"] == 0
    assert not pipeline.applied


async def test_segmentation_preserves_raw_ids_and_does_not_reextract_tail(environment):
    env = environment
    pipeline = RecordingPipeline()
    manager = IncrementalMemory(pipeline, auto_start=False)
    req = capture_request().model_copy(update={"archive_max_bytes": 1})
    await manager.capture(env.session, req)
    await manager.capture(env.session, capture_request("two", 1))
    all_before = await env.fs.read_file(env.session.uri + "/messages.jsonl", ctx=env.ctx)
    await manager.run_pending(env.session)
    receipt = await manager.request_receipt(await reopened(env), "one")
    assert receipt["status"] == "completed" and len(receipt["archive_uris"]) == 1
    store = ArchiveStore(env.fs, env.ctx, env.session.uri)
    archived = await store.read_messages(receipt["archive_uris"][0])
    assert archived[0].id == json.loads(all_before.splitlines()[0])["id"]
    assert len(archived) == 1
    assert (await store.scan_states())[0].state == "completed"
    live = await env.fs.read_file(env.session.uri + "/messages.jsonl", ctx=env.ctx)
    assert Message.from_dict(json.loads(live)).id == json.loads(all_before.splitlines()[1])["id"]
    assert (await manager.status(await reopened(env)))["live_start_sequence"] == 1
    assert pipeline.applied[0] != pipeline.applied[1]
    assert len(pipeline.applied) == 2
    second = await manager.request_receipt(await reopened(env), "two")
    assert second["archive_uris"] == []


@pytest.mark.parametrize("stage", ["archive_raw", "archive_done", "live_truncate", "native_meta"])
async def test_segmentation_crash_recovers_without_reapplying_memory(environment, stage):
    env = environment
    pipeline = RecordingPipeline()
    manager = IncrementalMemory(pipeline, auto_start=False)
    req = capture_request().model_copy(update={"archive_max_bytes": 1})
    await manager.capture(env.session, req)
    raw_before = await env.fs.read_file(env.session.uri + "/messages.jsonl", ctx=env.ctx)

    def crash(uri, content):
        matches = (
            stage == "archive_raw"
            and "/history/" in uri
            and uri.endswith("messages.jsonl")
            or stage == "archive_done"
            and uri.endswith("/.done")
            or stage == "live_truncate"
            and uri == env.session.uri + "/messages.jsonl"
            and not content
            or stage == "native_meta"
            and uri == env.session.uri + "/.meta.json"
        )
        if matches:
            raise SimulatedCrash()

    env.fs.after_write = crash
    with pytest.raises(SimulatedCrash):
        await manager.run_pending(env.session)
    env.fs.after_write = None
    recovered_pipeline = RecordingPipeline()
    recovered = IncrementalMemory(recovered_pipeline, auto_start=False)
    await recovered.run_pending(await reopened(env))
    receipt = await recovered.request_receipt(await reopened(env), "one")
    assert receipt["status"] == "completed"
    archive_raw = await env.fs.read_file(
        receipt["archive_uris"][0] + "/messages.jsonl", ctx=env.ctx
    )
    assert archive_raw == raw_before
    assert await env.fs.read_file(env.session.uri + "/messages.jsonl", ctx=env.ctx) == ""
    assert len(pipeline.applied) == 1 and not recovered_pipeline.applied


async def test_corrupt_latest_journal_never_falls_back_and_replays(environment):
    env = environment
    manager = IncrementalMemory(RecordingPipeline(), auto_start=False)
    await manager.capture(env.session, capture_request())
    async with env.session._state_lock(*LOCKED_FILES):
        state = await manager._load(env.session)
    latest = SLOTS[state["_revision"] % 2]
    await env.fs.write_file(env.session.uri + "/" + latest, b"{torn", ctx=env.ctx)
    with pytest.raises(JournalCorrupt):
        await manager.capture(await reopened(env), capture_request("two", 1))
    receipt = await manager.request_receipt(await reopened(env), "one")
    assert receipt["status"] == "unknown"
    assert receipt["error_code"] == "MEMORY_JOURNAL_CORRUPT"
    assert (await manager.status(await reopened(env)))["blocked"] is True


async def test_account_user_isolation_and_owner_check(environment):
    env = environment
    manager = IncrementalMemory(RecordingPipeline(), auto_start=False)
    await manager.capture(env.session, capture_request())
    other_ctx = RequestContext(user=UserIdentifier("account-b", "alice"), role=Role.USER)
    other = await env.sessions.create(
        other_ctx,
        env.session.session_id,
        auto_commit_policy=None,
        update_auto_commit_policy=True,
    )
    assert (await manager.status(other))["next_sequence"] == 0
    with pytest.raises(IncrementalError) as exc:
        await manager.request_receipt(other, "one")
    assert exc.value.http_status == 404
    meta = json.loads(await env.fs.read_file(env.session.uri + "/.meta.json", ctx=env.ctx))
    meta["created_by_user_id"] = "mallory"
    await env.fs.write_file(env.session.uri + "/.meta.json", json.dumps(meta), ctx=env.ctx)
    with pytest.raises(IncrementalError) as exc:
        await manager.status(await reopened(env))
    assert exc.value.code == "SESSION_OWNER_MISMATCH"


async def test_pending_capacity_and_unknown_native_metadata_preserved(environment):
    env = environment
    uri = env.session.uri + "/.meta.json"
    meta = json.loads(await env.fs.read_file(uri, ctx=env.ctx))
    meta["future_native_metadata"] = {"opaque": [1, 2, 3]}
    await env.fs.write_file(uri, json.dumps(meta), ctx=env.ctx)
    manager = IncrementalMemory(RecordingPipeline(), auto_start=False, max_pending_requests=1)
    await manager.capture(env.session, capture_request())
    with pytest.raises(IncrementalError) as exc:
        await manager.capture(env.session, capture_request("two", 1))
    assert exc.value.http_status == 429
    await manager.run_pending(env.session)
    assert json.loads(await env.fs.read_file(uri, ctx=env.ctx))["future_native_metadata"] == {
        "opaque": [1, 2, 3]
    }


async def test_native_mutation_guard_refuses_managed_sessions(environment):
    env = environment
    manager = IncrementalMemory(RecordingPipeline(), auto_start=False)
    async with manager.native_mutation_guard(env.session):
        pass
    await manager.capture(env.session, capture_request())
    with pytest.raises(IncrementalError) as exc:
        async with manager.native_mutation_guard(env.session):
            pytest.fail("Managed native write was allowed")
    assert exc.value.code == "MANAGED_SESSION"
