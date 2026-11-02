"""Pinned wheel's real Rust AGFS binding, VikingFS, Session and ArchiveStore."""

from __future__ import annotations

import asyncio

from conftest import RecordingPipeline, capture_request
from openviking.server.identity import RequestContext, Role
from openviking.service.session_service import SessionService
from openviking.session.archive_store import ArchiveStore
from openviking.storage.viking_fs import VikingFS
from openviking.utils.agfs_utils import RagfsBindingConfig, create_agfs_client
from openviking_cli.session.user_id import UserIdentifier
from openviking_cli.utils.config.agfs_config import AGFSConfig

from eating_openviking_incremental import IncrementalMemory


async def test_actual_native_storage_locking_capture_segment_and_reopen(tmp_path, monkeypatch):
    # An explicit config and isolated local backend: no default user config,
    # remote storage, Redis, model, or long-lived application is initialized.
    monkeypatch.setattr("openviking.utils.agfs_utils.resolve_config_path", lambda *args: None)
    agfs = create_agfs_client(
        RagfsBindingConfig(
            agfs=AGFSConfig(
                path=str(tmp_path / "native-agfs"),
                backend="local",
            )
        )
    )
    fs = VikingFS(agfs=agfs)
    ctx = RequestContext(user=UserIdentifier("account-a", "alice"), role=Role.USER)
    sessions = SessionService(viking_fs=fs)
    session = await sessions.create(
        ctx,
        "native-local-test",
        auto_commit_policy=None,
        update_auto_commit_policy=True,
        memory_policy={"self": {"enabled": False}, "peer": {"enabled": True}},
    )
    pipeline = RecordingPipeline()
    pipeline.release = asyncio.Event()
    first = IncrementalMemory(pipeline, auto_start=False)
    second = IncrementalMemory(pipeline, auto_start=False)
    await first.capture(session, capture_request().model_copy(update={"archive_max_bytes": 1}))
    worker = asyncio.create_task(first.run_pending(session))
    await asyncio.wait_for(pipeline.entered.wait(), 3)
    reopened = await sessions.open(session.session_id, ctx)
    await asyncio.wait_for(second.capture(reopened, capture_request("two", 1)), 3)
    await second.run_pending(reopened)  # Native PathLock excludes this worker.
    assert len(pipeline.prepared) == 1
    pipeline.release.set()
    await asyncio.wait_for(worker, 5)
    receipt = await second.request_receipt(reopened, "one")
    assert receipt["status"] == "completed"
    assert receipt["archive_uris"] == [session.uri + "/history/archive_001"]
    states = await ArchiveStore(fs, ctx, session.uri).scan_states()
    assert len(states) == 1 and states[0].state == "completed"
    assert len(await ArchiveStore(fs, ctx, session.uri).read_messages(states[0].archive_uri)) == 1
    # New managers/Session handles recover durable cursors without reapplying.
    third = IncrementalMemory(RecordingPipeline(), auto_start=False)
    status = await third.status(await sessions.open(session.session_id, ctx))
    assert (status["next_sequence"], status["extracted_sequence"]) == (2, 2)
    assert status["live_start_sequence"] == 1
    assert len(pipeline.applied) == 2
    await third.run_pending(await sessions.open(session.session_id, ctx))
    assert not third.pipeline.applied
    await first.close()
    await second.close()
    await third.close()
