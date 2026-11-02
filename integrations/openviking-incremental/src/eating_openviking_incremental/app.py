"""Stock OpenViking ASGI factory with authenticated incremental-memory routes."""

from __future__ import annotations

from contextlib import asynccontextmanager
from importlib.metadata import version
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, FastAPI, Path
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from openviking.server.auth import get_request_context, get_session_request_context
from openviking.server.dependencies import get_service
from openviking.server.identity import RequestContext
from openviking.server.models import Response

from .protocol import PROTOCOL_VERSION, SERVER_VERSION, CaptureRequest, IncrementalError
from .service import IncrementalMemory

SessionId = Annotated[str, Path(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$")]


async def _session(
    session_id: SessionId,
    ctx: RequestContext = Depends(get_session_request_context),
) -> Any:
    # Native SessionService constructs the current authenticated user's canonical
    # namespace and refuses a missing session. No account/user fields in the body.
    return await get_service().sessions.open(session_id, ctx, auto_create=False)


def extend_app(app: FastAPI, *, incremental: IncrementalMemory | None = None) -> FastAPI:
    """Extend an already-created *stock* app, preserving its auth and lifespan."""
    if getattr(app.state, "eating_incremental", None) is not None:
        raise ValueError("Incremental extension is already attached")
    if version("openviking") != SERVER_VERSION:
        raise RuntimeError(f"This extension requires openviking=={SERVER_VERSION}")
    manager = incremental or IncrementalMemory()
    app.state.eating_incremental = manager

    @app.exception_handler(IncrementalError)
    async def incremental_error(_request, exc: IncrementalError):
        return JSONResponse(
            status_code=exc.http_status,
            content={
                "status": "error",
                "result": None,
                "error": {"code": exc.code, "message": str(exc), "details": exc.details or None},
            },
        )

    router = APIRouter(tags=["eating-memory"])

    @router.get("/api/v1/eating-memory/capabilities")
    async def capabilities(_ctx: RequestContext = Depends(get_request_context)):
        return Response(
            status="ok",
            result={
                "protocol_version": PROTOCOL_VERSION,
                "server_version": SERVER_VERSION,
                "incremental_extraction": True,
                "history_segmentation": True,
            },
        )

    @router.get("/api/v1/sessions/{session_id}/incremental-memory")
    async def status(session: Any = Depends(_session)):
        return Response(status="ok", result=await manager.status(session))

    @router.post("/api/v1/sessions/{session_id}/incremental-memory")
    async def capture(body: CaptureRequest, session: Any = Depends(_session)):
        return Response(status="ok", result=await manager.capture(session, body))

    @router.get("/api/v1/sessions/{session_id}/incremental-memory/requests/{request_id}")
    async def receipt(request_id: str, session: Any = Depends(_session)):
        return Response(status="ok", result=await manager.request_receipt(session, request_id))

    @router.post("/api/v1/sessions/{session_id}/incremental-memory/requests/{request_id}/retry")
    async def retry(
        request_id: str,
        body: Annotated[dict, Body()],
        session: Any = Depends(_session),
    ):
        if body:
            raise IncrementalError("INVALID_RETRY", "Retry body must be an empty object", 400)
        return Response(status="ok", result=await manager.retry(session, request_id))

    async def guard_native_mutation(session: Any = Depends(_session)):
        async with manager.native_mutation_guard(session):
            yield

    # Register the same official mutating endpoints with one extra dependency,
    # before the stock inclusions. APIRouter's public include API composes the
    # dependency correctly even when FastAPI includes the stock routers lazily.
    # No global stock router, original endpoint or native file is modified.
    from openviking.server.routers.sessions import router as stock_sessions_router

    mutations = [
        route
        for route in stock_sessions_router.routes
        if isinstance(route, APIRoute)
        and route.path.startswith("/api/v1/sessions/{session_id}")
        and route.methods.intersection({"POST", "PATCH", "PUT", "DELETE"})
    ]
    guarded = APIRouter()
    guarded.include_router(
        APIRouter(routes=mutations),
        dependencies=[Depends(guard_native_mutation)],
        include_in_schema=False,
    )
    previous_count = len(app.router.routes)
    app.include_router(guarded)
    app.router.routes[:] = app.router.routes[previous_count:] + app.router.routes[:previous_count]
    app.include_router(router)

    stock_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        async with stock_lifespan(application) as state:
            try:
                yield state
            finally:
                # Stop extension workers while native storage/model services are
                # still available to preserve their last receipt checkpoint.
                await manager.close()

    app.router.lifespan_context = lifespan
    return app


def create_app(
    config: Any = None,
    service: Any = None,
    config_path: str | None = None,
    server_overrides: dict | None = None,
) -> FastAPI:
    """uvicorn eating_openviking_incremental:create_app --factory."""
    from openviking.server.app import create_app as create_stock_app

    return extend_app(
        create_stock_app(
            config=config,
            service=service,
            config_path=config_path,
            server_overrides=server_overrides,
        )
    )
