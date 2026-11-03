"""Stock 0.5.2.1 HTTP contract fixture; no extension, paid models or live config.

Run with the selected interpreter's -I -S flags. Only its adjacent site-packages
is added, so editable-extension .pth files and user site packages never run.
The ASGI app, auth plugin, request models, SessionService, Session, ArchiveStore,
TaskTracker, PersistentTaskStore and SessionCommitProcessor are official code.
Doubles: temporary filesystem/locks, credential lookup, in-process queue transport
and a compressor returning no memories. This does not test a real model, vector
index, AGFS backend, QueueFS durability, or semantic extraction quality. The stock
lifespan is disabled to avoid initializing providers; dependencies are explicit.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import importlib.util
import json
import logging
import os
import socket
import sys
import time
from pathlib import Path
from uuid import uuid4


def isolated_packages():
    assert sys.flags.isolated and sys.flags.no_site
    environment = Path(sys.executable).absolute().parent.parent
    package_roots = [
        environment / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages",
        environment / "Lib" / "site-packages",
    ]
    packages = next((path for path in package_roots if path.is_dir()), None)
    if packages is None:
        raise RuntimeError("Selected Python has no adjacent isolated site-packages")
    sys.path.insert(0, str(packages))
    assert importlib.util.find_spec("eating_openviking_incremental") is None
    assert importlib.metadata.version("openviking") == "0.5.2.1"


isolated_packages()
sys.dont_write_bytecode = True
protocol_output = sys.stdout
sys.stdout = sys.stderr
logging.basicConfig(level=logging.WARNING)

import uvicorn
from openviking.pyagfs.exceptions import AGFSNotFoundError
from openviking.server.app import create_app
from openviking.server.auth.plugins.api_key import ApiKeyAuthPlugin
from openviking.server.config import ServerConfig
from openviking.server.dependencies import set_service
from openviking.server.identity import RequestContext, ResolvedIdentity, Role
from openviking.service.session_service import SessionService
from openviking.service.task_domain import TaskRetentionPolicy
from openviking.service.task_store import PersistentTaskStore
from openviking.service.task_tracker import TaskTracker, set_task_tracker
from openviking.session import Session
from openviking.session.archive_store import ArchiveStore
from openviking.storage.errors import LockAcquisitionError
from openviking.storage.queuefs import QueueManager
from openviking.storage.queuefs import queue_manager
from openviking.storage.queuefs.session_commit_processor import SessionCommitProcessor
from openviking_cli.exceptions import UnauthenticatedError
from openviking_cli.session.user_id import UserIdentifier
from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton

ACCOUNT = "stock-account"
USER = "stock-user"
API_KEY = "stock-fixture-user-key"
CONTROL = "/__openviking_stock__/"


class LocalAgfs:
    def __init__(self, root):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, value):
        target = (self.root / value.lstrip("/")).resolve()
        assert target.is_relative_to(self.root)
        return target

    def read(self, path, **kwargs):
        try:
            return self.path(path).read_bytes()
        except FileNotFoundError as exc:
            raise AGFSNotFoundError(path) from exc

    def write(self, path, content, **kwargs):
        target = self.path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".tmp-" + uuid4().hex)
        temporary.write_bytes(content.encode() if isinstance(content, str) else content)
        assert temporary.parent == target.parent and target.is_relative_to(self.root)
        os.replace(temporary, target)

    def mkdir(self, path, **kwargs):
        self.path(path).mkdir(parents=True, exist_ok=True)

    def ls(self, path, **kwargs):
        try:
            return [{"name": entry.name, "path": path.rstrip("/") + "/" + entry.name,
                     "isDir": entry.is_dir()} for entry in sorted(self.path(path).iterdir())]
        except FileNotFoundError as exc:
            raise AGFSNotFoundError(path) from exc

    def rm(self, path, **kwargs):
        target = self.path(path)
        assert target.is_relative_to(self.root) and target != self.root
        target.unlink()


class LocalLocks:
    def __init__(self):
        self.held = {}
        self.condition = asyncio.Condition()

    async def pathlock_acquire_exact(self, path, timeout_secs=0, owner_lease_ref=None):
        return await self.pathlock_acquire_exact_batch([path], timeout_secs, owner_lease_ref)

    async def pathlock_acquire_exact_batch(self, paths, timeout_secs=0, owner_lease_ref=None):
        owner = owner_lease_ref["owner"] if owner_lease_ref else uuid4().hex
        async with self.condition:
            async def wait_available():
                while any(path in self.held and self.held[path] != owner for path in paths):
                    await self.condition.wait()
            if not timeout_secs and any(path in self.held and self.held[path] != owner for path in paths):
                raise LockAcquisitionError("Fixture path busy")
            await asyncio.wait_for(wait_available(), timeout_secs or 1)
            acquired = [path for path in paths if path not in self.held]
            for path in acquired:
                self.held[path] = owner
            return {"owner": owner, "acquired": acquired, "covered": paths}

    async def pathlock_release(self, lease):
        async with self.condition:
            for path in lease["acquired"]:
                assert self.held.pop(path) == lease["owner"]
            self.condition.notify_all()


class LocalVikingFS:
    def __init__(self, root):
        self.agfs = LocalAgfs(root)
        self._async_agfs = LocalLocks()

    def _uri_to_path(self, uri, ctx=None):
        assert uri.startswith("viking://") and ctx is not None
        suffix = uri.removeprefix("viking://")
        assert all(part not in {".", ".."} for part in suffix.split("/"))
        return "/" + ctx.account_id + "/" + suffix

    async def exists(self, uri, ctx=None):
        return self.agfs.path(self._uri_to_path(uri, ctx)).exists()

    async def stat(self, uri, ctx=None, **kwargs):
        target = self.agfs.path(self._uri_to_path(uri, ctx))
        return {"isDir": target.is_dir(), "size": target.stat().st_size}

    async def read_file(self, uri, ctx=None, **kwargs):
        return self.agfs.read(self._uri_to_path(uri, ctx)).decode()

    async def write_file(self, uri, content, ctx=None, lease_ref=None, **kwargs):
        path = self._uri_to_path(uri, ctx)
        if lease_ref:
            assert path in lease_ref["covered"]
        self.agfs.write(path, content)

    async def mkdir(self, uri, ctx=None, **kwargs):
        self.agfs.mkdir(self._uri_to_path(uri, ctx))

    async def ls(self, uri, ctx=None, **kwargs):
        return self.agfs.ls(self._uri_to_path(uri, ctx))


class FixtureCredentials:
    async def resolve_identity(self, api_key):
        users = {API_KEY: USER, "stock-fixture-other-key": "stock-other-user"}
        if api_key not in users:
            raise UnauthenticatedError("Invalid fixture credential")
        return ResolvedIdentity(role=Role.USER, account_id=ACCOUNT, user_id=users[api_key])

    async def get_user_group_ids(self, account_id, user_id):
        return []


class EmptyCompressor:
    def __init__(self):
        self.calls = []

    async def extract_long_term_memories(self, *, messages, **kwargs):
        self.calls.append({"message_ids": [message.id for message in messages],
                           "session_id": kwargs["session_id"]})
        return []


class LocalQueueTransport:
    def __init__(self, sessions):
        self.processor = SessionCommitProcessor(sessions)
        self.release = asyncio.Event()
        self.tasks = []
        self.errors = []

    async def enqueue(self, queue_name, data):
        assert queue_name == QueueManager.SESSION_COMMIT
        async def consume():
            await self.release.wait()
            result = await self.processor.on_dequeue(data)
            if result.outcome.value != "success":
                self.errors.append(result.outcome.value)
        self.tasks.append(asyncio.create_task(consume()))
        return data["task_id"]

    async def drain(self):
        self.release.set()
        await asyncio.gather(*self.tasks)


class InjectedService:
    def __init__(self, sessions, fs):
        self.sessions = sessions
        self.fs = fs
        self._initialized = True

    async def initialize_user_directories(self, ctx):
        await self.fs.mkdir(f"viking://user/{ctx.user.user_id}", ctx=ctx)


def registered_routes(routes):
    for route in routes:
        if hasattr(route, "effective_candidates"):
            yield from registered_routes(route.effective_candidates())
        elif hasattr(route, "methods"):
            yield {"path": route.path, "methods": sorted(route.methods),
                   "module": route.endpoint.__module__}


class StockFixture:
    def __init__(self, root):
        OpenVikingConfigSingleton.reset_instance()
        OpenVikingConfigSingleton.initialize(config_dict={
            "storage": {"workspace": str(root), "agfs": {"backend": "local"}},
            "memory": {"extraction_output_format": "json", "link_enabled": False},
        })
        self.fs = LocalVikingFS(root / "fs")
        self.compressor = EmptyCompressor()
        self.sessions = SessionService(viking_fs=self.fs, session_compressor=self.compressor)
        self.task_store = PersistentTaskStore(LocalAgfs(root / "tasks"))
        self.tracker = TaskTracker(self.task_store)
        set_task_tracker(self.tracker)
        self.queue = LocalQueueTransport(self.sessions)
        queue_manager._instance = self.queue
        service = InjectedService(self.sessions, self.fs)
        self.app = create_app(config=ServerConfig(host="127.0.0.1", auth_mode="api_key",
                              root_api_key="stock-fixture-root-key"), service=service)
        self.app.state.auth_plugin = ApiKeyAuthPlugin()
        self.app.state.api_key_manager = FixtureCredentials()
        set_service(service)
        self.ctx = RequestContext(user=UserIdentifier(ACCOUNT, USER), role=Role.USER)
        self.requests = []
        self.proof = {
            "version": importlib.metadata.version("openviking"),
            "extension_importable": importlib.util.find_spec("eating_openviking_incremental") is not None,
            "extension_loaded": any(name.startswith("eating_openviking_incremental") for name in sys.modules),
            "routes": list(registered_routes(self.app.routes)),
            "official_components": [component.__module__ + "." + component.__name__ for component in
                                    (SessionService, Session, ArchiveStore, TaskTracker,
                                     PersistentTaskStore, SessionCommitProcessor, ApiKeyAuthPlugin)],
            "doubles": ["temporary filesystem and process-local exact locks", "fixture credential lookup",
                        "in-process queue transport", "compressor returning zero memories"],
            "stock_lifespan": False,
        }
        assert not self.proof["extension_importable"] and not self.proof["extension_loaded"]
        assert all("eating-memory" not in route["path"] and "incremental-memory" not in route["path"]
                   for route in self.proof["routes"])

    async def controls(self, operation):
        if operation == "proof":
            return self.proof
        if operation == "release":
            await self.queue.drain()
            return {"drained": True}
        if operation == "finish-and-expire":
            await self.queue.drain()
            deleted = await self.task_store.delete_expired(TaskRetentionPolicy(0, 0),
                                                           now=time.time() + 1, limit=256)
            return {"deleted": deleted.deleted_count}
        if operation == "state":
            sessions = []
            for item in await self.sessions.sessions(self.ctx):
                session = await self.sessions.get(item["session_id"], self.ctx, auto_create=False)
                archives = ArchiveStore(self.fs, self.ctx, session.uri)
                refs = await archives.list_refs()
                sessions.append({"session_id": session.session_id, "meta": session.meta.to_dict(),
                                 "messages": [message.to_dict() for message in session.messages],
                                 "archives": [dict(ref, state=await archives.terminal_state(ref["archive_uri"]))
                                              for ref in refs]})
            return {"requests": self.requests, "sessions": sessions,
                    "compressor_calls": self.compressor.calls, "queue_errors": self.queue.errors}
        raise ValueError("Unknown fixture control")

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if scope["path"].startswith(CONTROL):
            headers = dict(scope["headers"])
            if headers.get(b"x-api-key") != API_KEY.encode():
                status, result = 401, {"error": "Invalid fixture credential"}
            else:
                status, result = 200, await self.controls(scope["path"][len(CONTROL):])
            payload = json.dumps(result).encode()
            await send({"type": "http.response.start", "status": status,
                        "headers": [(b"content-type", b"application/json")]})
            return await send({"type": "http.response.body", "body": payload})
        request_bytes, response_bytes = bytearray(), bytearray()
        record = {"method": scope["method"], "path": scope["path"],
                  "probe": dict(scope["headers"]).get(b"x-stock-probe") == b"1"}
        async def record_receive():
            message = await receive()
            if message["type"] == "http.request":
                request_bytes.extend(message.get("body", b""))
            return message
        async def record_send(message):
            if message["type"] == "http.response.start":
                record["status"] = message["status"]
            if message["type"] == "http.response.body":
                response_bytes.extend(message.get("body", b""))
            await send(message)
        await self.app(scope, record_receive, record_send)
        record["body"] = json.loads(request_bytes) if request_bytes else None
        record["response"] = json.loads(response_bytes) if response_bytes else None
        self.requests.append(record)


async def main():
    root = Path.cwd().resolve()
    assert root.name.startswith("eating-openviking-stock-")
    fixture = StockFixture(root)
    if "--probe" in sys.argv:
        protocol_output.write(json.dumps(fixture.proof) + "\n")
        protocol_output.flush()
        return
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    server = uvicorn.Server(uvicorn.Config(fixture, lifespan="off", access_log=False, log_level="warning"))
    async def announce():
        while not server.started:
            await asyncio.sleep(0.01)
        protocol_output.write(json.dumps({"port": listener.getsockname()[1], "proof": fixture.proof}) + "\n")
        protocol_output.flush()
    announcement = asyncio.create_task(announce())
    try:
        await server.serve(sockets=[listener])
    finally:
        announcement.cancel()
        for task in fixture.queue.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*fixture.queue.tasks, return_exceptions=True)
        await fixture.tracker.close()
        set_service(None)
        set_task_tracker(None)
        queue_manager._instance = None
        listener.close()


if __name__ == "__main__":
    asyncio.run(main())
