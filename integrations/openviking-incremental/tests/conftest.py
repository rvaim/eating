"""Temporary disk storage and scripted models; no production config or network."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from openviking.pyagfs.exceptions import AGFSNotFoundError
from openviking.server.identity import RequestContext, Role
from openviking.service.session_service import SessionService
from openviking.storage.errors import LockAcquisitionError
from openviking_cli.session.user_id import UserIdentifier
from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton

from eating_openviking_incremental import CaptureRequest


class SimulatedCrash(BaseException):
    """A process disappearing, deliberately bypassing ordinary error handlers."""


class DiskPathLocks:
    def __init__(self):
        self.held: dict[str, str] = {}
        self.condition = asyncio.Condition()
        self.events = []

    async def pathlock_acquire_exact(self, path, timeout_secs=0, owner_lease_ref=None):
        return await self.pathlock_acquire_exact_batch([path], timeout_secs, owner_lease_ref)

    async def pathlock_acquire_exact_batch(self, paths, timeout_secs=0, owner_lease_ref=None):
        owner = owner_lease_ref["owner"] if owner_lease_ref else uuid4().hex
        async with self.condition:

            async def wait_for_paths():
                while any(path in self.held and self.held[path] != owner for path in paths):
                    await self.condition.wait()

            if timeout_secs == 0 and any(
                path in self.held and self.held[path] != owner for path in paths
            ):
                raise LockAcquisitionError("busy")
            await asyncio.wait_for(wait_for_paths(), timeout_secs or 1)
            acquired = [path for path in paths if path not in self.held]
            for path in acquired:
                self.held[path] = owner
            lease = {"owner": owner, "acquired": acquired, "covered": list(paths)}
            self.events.append(("acquire", tuple(paths)))
            return lease

    async def pathlock_acquire_exact_tree_batch(
        self,
        exact_paths,
        tree_paths,
        timeout_secs=0,
        owner_lease_ref=None,
    ):
        return await self.pathlock_acquire_exact_batch(
            exact_paths + tree_paths,
            timeout_secs,
            owner_lease_ref,
        )

    async def pathlock_release(self, lease):
        async with self.condition:
            for path in lease["acquired"]:
                assert self.held.pop(path) == lease["owner"]
            self.condition.notify_all()
            self.events.append(("release", tuple(lease["acquired"])))


class LocalTemplateStore:
    def __init__(self, root):
        self.root = root

    def read(self, path, **_kwargs):
        target = self.root / path.lstrip("/")
        assert target.is_relative_to(self.root)
        try:
            return target.read_bytes()
        except FileNotFoundError as exc:
            raise AGFSNotFoundError(path) from exc


class DiskFS:
    """A real temporary file tree with fault hooks and a faithful exact-lock fake."""

    def __init__(self, root: Path):
        self.root = root
        self._async_agfs = DiskPathLocks()
        self.agfs = LocalTemplateStore(root / "templates")
        self.writes: list[tuple[str, str]] = []
        self.before_write = None
        self.after_write = None

    def _uri_to_path(self, uri, ctx=None):
        assert uri.startswith("viking://")
        assert ctx is not None
        parts = uri.removeprefix("viking://").split("/")
        assert all(part not in {"..", "."} for part in parts)
        return str(self.root / ctx.account_id / "/".join(parts))

    async def exists(self, uri, ctx=None):
        return Path(self._uri_to_path(uri, ctx)).exists()

    async def stat(self, uri, ctx=None, skip_count=False):
        path = Path(self._uri_to_path(uri, ctx))
        stat = path.stat()
        return {"isDir": path.is_dir(), "size": stat.st_size}

    async def read_file(self, uri, ctx=None, **_kwargs):
        return Path(self._uri_to_path(uri, ctx)).read_text(encoding="utf-8")

    async def write_file(self, uri, content, ctx=None, lease_ref=None, **_kwargs):
        text = content.decode() if isinstance(content, bytes) else content
        path = Path(self._uri_to_path(uri, ctx))
        if lease_ref:
            assert str(path) in lease_ref["covered"]
        if self.before_write:
            self.before_write(uri, text)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp-" + uuid4().hex)
        with tmp.open("w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        # Both paths are verified descendants of this fixture's own tmp_path.
        assert tmp.parent == path.parent and path.is_relative_to(self.root)
        os.replace(tmp, path)
        self.writes.append((uri, text))
        if self.after_write:
            self.after_write(uri, text)

    async def mkdir(self, uri, exist_ok=True, ctx=None):
        Path(self._uri_to_path(uri, ctx)).mkdir(parents=True, exist_ok=exist_ok)

    async def ls(self, uri, ctx=None, **_kwargs):
        root = Path(self._uri_to_path(uri, ctx))
        return [
            {"name": path.name, "uri": uri.rstrip("/") + "/" + path.name, "isDir": path.is_dir()}
            for path in root.iterdir()
        ]

    async def rm(self, uri, ctx=None, **_kwargs):
        path = Path(self._uri_to_path(uri, ctx))
        assert path.is_relative_to(self.root)
        path.unlink()


class RecordingPipeline:
    def __init__(self):
        self.prepared = []
        self.applied = []
        self.entered = asyncio.Event()
        self.release = None
        self.prepare_error = None
        self.apply_error = None

    async def prepare(self, session, messages, policy, *, recent_context=""):
        self.prepared.append(([message.id for message in messages], policy))
        self.recent_context = recent_context
        self.entered.set()
        if self.release is not None:
            await self.release.wait()
        if self.prepare_error:
            raise self.prepare_error
        return None

    async def apply(self, session, messages, prepared, receipt):
        self.applied.append([message.id for message in messages])
        if self.apply_error:
            raise self.apply_error
        return {"added": 1, "updated": 0, "deleted": 0}


def capture_request(request_id="one", expected_sequence=0, *, text="I like tea.", peer="qq-a"):
    return CaptureRequest.model_validate(
        {
            "request_id": request_id,
            "expected_sequence": expected_sequence,
            "messages": [
                {
                    "role": "user",
                    "content": text,
                    "peer_id": peer,
                    "created_at": "2026-11-02T05:00:00+00:00",
                }
            ],
        }
    )


@pytest.fixture(autouse=True)
def isolated_config(tmp_path, monkeypatch):
    # Never load the developer's default ~/.config/OpenViking config.
    OpenVikingConfigSingleton.reset_instance()
    config = OpenVikingConfigSingleton.initialize(
        config_dict={
            "storage": {"workspace": str(tmp_path), "agfs": {"backend": "local"}},
            "memory": {"extraction_output_format": "json", "link_enabled": False},
        }
    )
    monkeypatch.setenv("OPENVIKING_CONFIG_FILE", str(tmp_path / "unused-config.json"))
    yield config
    OpenVikingConfigSingleton.reset_instance()


@pytest.fixture
async def environment(tmp_path):
    fs = DiskFS(tmp_path / "fs")
    ctx = RequestContext(user=UserIdentifier("account-a", "alice"), role=Role.USER)
    sessions = SessionService(viking_fs=fs)
    session = await sessions.create(
        ctx,
        "eating-live-qq-a",
        auto_commit_policy=None,
        update_auto_commit_policy=True,
        memory_policy={
            "self": {"enabled": False},
            "peer": {"enabled": True},
            "memory_types": ["events"],
        },
    )
    return SimpleNamespace(fs=fs, ctx=ctx, sessions=sessions, session=session)
