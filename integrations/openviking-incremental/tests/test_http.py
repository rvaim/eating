"""In-process ASGI only: real stock router, API-key plugin and request contexts."""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest
from conftest import RecordingPipeline, capture_request
from openviking.server.app import create_app as create_stock_app
from openviking.server.auth.plugins.api_key import ApiKeyAuthPlugin
from openviking.server.config import ServerConfig
from openviking.server.dependencies import set_service
from openviking.server.identity import ResolvedIdentity, Role
from openviking_cli.exceptions import UnauthenticatedError

from eating_openviking_incremental import IncrementalMemory, create_app, extend_app


class FakeKeyStore:
    """Only credential verification is fake; native auth/plugin/dependencies run."""

    async def resolve_identity(self, key):
        identities = {
            "alice-key": ResolvedIdentity(role=Role.USER, account_id="account-a", user_id="alice"),
            "bob-key": ResolvedIdentity(role=Role.USER, account_id="account-a", user_id="bob"),
        }
        if key not in identities:
            raise UnauthenticatedError("Invalid test credential")
        return identities[key]

    async def get_user_group_ids(self, account_id, user_id):
        return []


@pytest.fixture
async def api(environment):
    env = environment
    manager = IncrementalMemory(RecordingPipeline(), auto_start=False)
    # Construct the actual stock app with no lifespan initialization of paid
    # providers. The router, handlers and auth plugin below are still official.
    app = create_stock_app(
        config=ServerConfig(
            host="127.0.0.1",
            auth_mode="api_key",
            root_api_key="test-root-key",
        )
    )
    app.state.auth_plugin = ApiKeyAuthPlugin()
    app.state.api_key_manager = FakeKeyStore()
    set_service(SimpleNamespace(sessions=env.sessions))
    extend_app(app, incremental=manager)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://in-process.invalid",
        headers={"X-API-Key": "alice-key"},
    ) as client:
        yield SimpleNamespace(app=app, manager=manager, client=client, env=env)
    await manager.close()
    set_service(None)


async def test_capabilities_require_stock_auth_and_return_exact_contract(api):
    response = await api.client.get("/api/v1/eating-memory/capabilities")
    assert response.status_code == 200
    assert response.json()["result"] == {
        "protocol_version": 1,
        "server_version": "0.5.2.1",
        "incremental_extraction": True,
        "history_segmentation": True,
    }
    response = await api.client.get(
        "/api/v1/eating-memory/capabilities",
        headers={"X-API-Key": "bad-key"},
    )
    assert response.status_code == 401 and response.json()["status"] == "error"


async def test_http_receipt_is_authoritative_and_other_user_cannot_read(api):
    url = f"/api/v1/sessions/{api.env.session.session_id}/incremental-memory"
    response = await api.client.post(url, json=capture_request().model_dump())
    assert response.status_code == 200, response.text
    receipt = response.json()["result"]
    assert receipt["status"] == "accepted"
    assert receipt["archive_uris"] == []
    assert (await api.client.post(url, json=capture_request().model_dump())).json()[
        "result"
    ] == receipt
    await api.manager.run_pending(api.env.session)
    response = await api.client.get(url + "/requests/one")
    assert response.json()["result"]["status"] == "completed"
    response = await api.client.get(url + "/requests/one", headers={"X-API-Key": "bob-key"})
    assert response.status_code == 404
    response = await api.client.get(url + "/requests/not-created")
    assert response.status_code == 404
    response = await api.client.get(url.replace(api.env.session.session_id, "missing"))
    assert response.status_code == 404


async def test_native_session_write_routes_guarded_and_reads_stay_stock(api):
    env = api.env
    url = f"/api/v1/sessions/{env.session.session_id}"
    await api.client.post(url + "/incremental-memory", json=capture_request().model_dump())
    requests = [
        ("POST", "/messages", {"role": "user", "content": "must not append"}),
        ("POST", "/messages/batch", {"messages": [{"role": "user", "content": "no"}]}),
        ("POST", "/commit", {}),
        ("PATCH", "/config", {"auto_commit_policy": None}),
        ("DELETE", "", None),
    ]
    before = len(env.fs.writes)
    for method, suffix, body in requests:
        response = await api.client.request(method, url + suffix, json=body)
        assert response.status_code == 412, (method, suffix, response.text)
        assert response.json()["error"]["code"] == "MANAGED_SESSION"
    assert len(env.fs.writes) == before
    # Official read route returns messages; no custom Studio surface is introduced.
    response = await api.client.get(url)
    assert response.status_code == 200, response.text
    assert response.json()["result"]["message_count"] == 1


async def test_http_shape_and_native_actor_peer_semantics(api):
    url = f"/api/v1/sessions/{api.env.session.session_id}/incremental-memory"
    request = capture_request().model_dump()
    request["account_id"] = "account-b"
    response = await api.client.post(url, json=request)
    assert response.status_code == 400
    request.pop("account_id")
    response = await api.client.post(
        url,
        json=request,
        headers={
            "X-OpenViking-Account": "account-b",
            "X-OpenViking-User": "mallory",
            "X-OpenViking-Actor-Peer": "qq-unrelated",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["result"]["session_id"] == api.env.session.session_id
    raw = await api.env.fs.read_file(api.env.session.uri + "/messages.jsonl", ctx=api.env.ctx)
    assert '"peer_id": "qq-a"' in raw


async def test_retry_endpoint_only_resumes_proven_preapply_failure(api):
    url = f"/api/v1/sessions/{api.env.session.session_id}/incremental-memory"
    await api.client.post(url, json=capture_request().model_dump())
    api.manager.pipeline.prepare_error = RuntimeError("temporary fake model failure")
    await api.manager.run_pending(api.env.session)
    receipt = (await api.client.get(url + "/requests/one")).json()["result"]
    assert receipt["status"] == "failed"
    api.manager.pipeline.prepare_error = None
    response = await api.client.post(url + "/requests/one/retry", json={})
    assert response.status_code == 200
    assert response.json()["result"]["status"] == "accepted"
    assert response.json()["result"]["task_id"] == receipt["task_id"]
    await api.manager.run_pending(api.env.session)
    assert (await api.client.get(url + "/requests/one")).json()["result"]["status"] == "completed"
    assert (
        await api.client.post(url + "/requests/one/retry", json={"replay": True})
    ).status_code == 400


async def test_factory_delegates_stock_arguments_and_preserves_lifespan(monkeypatch):
    from fastapi import FastAPI

    events, received = [], {}

    @asynccontextmanager
    async def lifespan(app):
        events.append("stock-start")
        yield {"stock": True}
        events.append("stock-stop")

    app = FastAPI(lifespan=lifespan)

    def stock(**kwargs):
        received.update(kwargs)
        return app

    monkeypatch.setattr("openviking.server.app.create_app", stock)
    sentinel = object()
    wrapped = create_app(config=sentinel, config_path="/temporary/config.json")
    manager = wrapped.state.eating_incremental
    async with wrapped.router.lifespan_context(wrapped) as state:
        assert state == {"stock": True}
        assert events == ["stock-start"] and not manager._closed
    assert events == ["stock-start", "stock-stop"] and manager._closed
    assert received["config"] is sentinel
    assert received["config_path"] == "/temporary/config.json"
