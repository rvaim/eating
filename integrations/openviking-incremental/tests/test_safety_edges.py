from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from conftest import RecordingPipeline, SimulatedCrash, capture_request
from openviking.privacy.sanitizer import PrivacyReplacement
from pydantic import ValidationError

from eating_openviking_incremental import CaptureRequest, IncrementalError, IncrementalMemory
from eating_openviking_incremental.service import LOCKED_FILES


async def test_explicit_preapply_retry_preserves_ids_and_never_reappends(environment):
    env = environment
    pipeline = RecordingPipeline()
    pipeline.prepare_error = RuntimeError("temporary")
    manager = IncrementalMemory(pipeline, auto_start=False)
    accepted = await manager.capture(env.session, capture_request())
    await manager.capture(env.session, capture_request("two", 1))
    before = await env.fs.read_file(env.session.uri + "/messages.jsonl", ctx=env.ctx)
    await manager.run_pending(env.session)
    assert (await manager.request_receipt(env.session, "one"))["status"] == "failed"
    pipeline.prepare_error = None
    retried = await manager.retry(env.session, "one")
    assert retried["status"] == "accepted" and retried["task_id"] == accepted["task_id"]
    assert await env.fs.read_file(env.session.uri + "/messages.jsonl", ctx=env.ctx) == before
    await manager.run_pending(env.session)
    assert len(pipeline.applied) == 2
    assert (await manager.status(env.session))["extracted_sequence"] == 2
    assert (await manager.retry(env.session, "one"))["status"] == "completed"


async def test_unknown_retry_is_rejected_without_clearing_block(environment):
    env = environment
    pipeline = RecordingPipeline()
    pipeline.apply_error = SimulatedCrash()
    manager = IncrementalMemory(pipeline, auto_start=False)
    await manager.capture(env.session, capture_request())
    with pytest.raises(SimulatedCrash):
        await manager.run_pending(env.session)
    for _ in range(2):
        with pytest.raises(IncrementalError) as exc:
            await manager.retry(env.session, "one")
        assert exc.value.code == "RETRY_UNSAFE"
    await manager.run_pending(env.session)
    assert (await manager.request_receipt(env.session, "one"))["status"] == "unknown"
    assert (await manager.status(env.session))["blocked"]
    assert len(pipeline.applied) == 1


async def test_native_privacy_runs_before_any_journal_or_raw_write(environment):
    env = environment
    secret = "registered-secret-for-temporary-test"
    reference = "{{ov_privacy:alice:credentials:service:key}}"

    def matcher(text):
        start = text.find(secret)
        return [PrivacyReplacement(start, start + len(secret), reference)] if start >= 0 else []

    sanitizer = SimpleNamespace(prepare_matcher=AsyncMock(return_value=matcher))
    privacy = SimpleNamespace(insert_values=AsyncMock())
    env.session._privacy_config_service = privacy
    env.session._privacy_sanitizer = sanitizer
    pipeline = RecordingPipeline()
    manager = IncrementalMemory(pipeline, auto_start=False)
    req = capture_request(text="Key=" + secret)
    accepted = await manager.capture(env.session, req)
    await manager.capture(env.session, req)
    assert sanitizer.prepare_matcher.await_count == 1
    await manager.run_pending(env.session)
    for uri, content in env.fs.writes:
        assert secret not in content, uri
    raw = await env.fs.read_file(env.session.uri + "/messages.jsonl", ctx=env.ctx)
    assert reference in raw
    async with env.session._state_lock(*LOCKED_FILES):
        state = await manager._load(env.session)
    assert state["records"][0]["payload_hash"] == req.payload_hash()
    assert accepted["to_sequence"] == 1
    privacy.insert_values.assert_not_awaited()


async def test_recent_background_stays_bounded_after_archive_and_excludes_other_peer(environment):
    env = environment
    pipeline = RecordingPipeline()
    manager = IncrementalMemory(pipeline, auto_start=False)
    await manager.capture(
        env.session, capture_request().model_copy(update={"archive_max_bytes": 1})
    )
    await manager.run_pending(env.session)
    await manager.capture(env.session, capture_request("two", 1, text="Another fact."))
    await manager.run_pending(env.session)
    assert "I like tea" in pipeline.recent_context
    assert len(pipeline.recent_context.encode()) <= 16 * 1024 + 512
    await manager.capture(env.session, capture_request("three", 2, peer="qq-b"))
    await manager.run_pending(env.session)
    assert pipeline.recent_context == ""


async def test_worker_shutdown_settles_before_releasing_apply_ownership(environment):
    env = environment
    pipeline = RecordingPipeline()
    pipeline.release = asyncio.Event()
    manager = IncrementalMemory(pipeline)
    await manager.capture(env.session, capture_request())
    await asyncio.wait_for(pipeline.entered.wait(), 1)
    await manager.close()
    receipt = await manager.request_receipt(env.session, "one")
    assert receipt["status"] == "accepted"  # Cancelled before apply is retry-safe.
    assert not env.fs._async_agfs.held


@pytest.mark.parametrize(
    "change",
    [
        {"expected_sequence": True},
        {"archive_max_bytes": 0},
        {"messages": []},
        {"request_id": "../bad"},
        {"request_id": ""},
    ],
)
def test_strict_request_shape(change):
    request = capture_request().model_dump()
    request.update(change)
    with pytest.raises(ValidationError):
        CaptureRequest.model_validate(request)


@pytest.mark.parametrize(
    "change",
    [
        {"role": "system"},
        {"peer_id": "../peer"},
        {"peer_id": "__self"},
        {"created_at": "2026-11-02T05:00:00"},
        {"created_at": "2026-11-02 05:00:00Z"},
    ],
)
def test_strict_message_identity_and_time(change):
    request = capture_request().model_dump()
    request["messages"][0].update(change)
    with pytest.raises(ValidationError):
        CaptureRequest.model_validate(request)


def test_atomic_capture_message_count_matches_eating_contract():
    request = capture_request().model_dump()
    message = request["messages"][0]
    request["messages"] = [message] * 1000
    assert len(CaptureRequest.model_validate(request).messages) == 1000
    request["messages"] = [message] * 1001
    with pytest.raises(ValidationError):
        CaptureRequest.model_validate(request)


async def test_unmanaged_native_mutation_detected_without_overwriting_it(environment):
    env = environment
    manager = IncrementalMemory(RecordingPipeline(), auto_start=False)
    await manager.capture(env.session, capture_request())
    uri = env.session.uri + "/messages.jsonl"
    changed = json.dumps({"id": "unmanaged", "role": "user", "parts": []}) + "\n"
    await env.fs.write_file(uri, changed, ctx=env.ctx)
    with pytest.raises(IncrementalError) as exc:
        await manager.status(env.session)
    assert exc.value.code == "NATIVE_STATE_CHANGED"
    assert await env.fs.read_file(uri, ctx=env.ctx) == changed
