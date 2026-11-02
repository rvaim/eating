"""Thin orchestration over the pinned official extraction and update implementation.

No archive, Session.commit, trainer, private HTTP endpoint, or alternative model loop
is involved. Preparation is read-only; all native memory writes follow apply-start.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from openviking.message import Message
from openviking.session.memory.account_templates import resolve_account_memory_registry
from openviking.session.memory.extract_loop import ExtractLoop
from openviking.session.memory.memory_isolation_handler import MemoryIsolationHandler
from openviking.session.memory.memory_type_registry import get_default_registry
from openviking.session.memory.session_extract_context_provider import SessionExtractContextProvider
from openviking.session.memory.streaming_memory_updater import (
    MemoryUpdateRequest,
    StreamingMemoryUpdater,
)
from openviking.session.memory_policy import MemoryPolicy
from openviking_cli.utils.config import get_openviking_config

from .protocol import IncrementalError


class IncrementalContextProvider(SessionExtractContextProvider):
    """Add background to native prefetch without adding extraction range targets."""

    async def prefetch(self):
        messages = await super().prefetch()
        if self.latest_archive_overview:
            messages.insert(
                0,
                {
                    "role": "user",
                    "content": self.latest_archive_overview,
                },
            )
        return messages


@dataclass
class PreparedExtraction:
    operations: Any
    registry: Any
    isolation: dict[str, Any]
    vlm_resolver: Any
    updater_config: Any


class NativePipeline:
    """Use ExtractLoop and StreamingMemoryUpdater (which applies MemoryUpdater)."""

    async def prepare(
        self,
        session: Any,
        messages: list[Message],
        policy: dict,
        *,
        recent_context: str = "",
    ) -> Any:
        config = get_openviking_config()
        if not config.memory.extraction_enabled:
            raise IncrementalError("EXTRACTION_DISABLED", "Native memory extraction is disabled")
        compressor = session._session_compressor
        if compressor is None or compressor.vlm_resolver is None:
            raise IncrementalError("NATIVE_MODEL_UNAVAILABLE", "Native extraction is unavailable")
        resolved_policy = MemoryPolicy.from_dict(policy)
        # Incremental chat extraction uses ordinary user-stage memories. Agent
        # evolution/training and session skills require different native inputs.
        unsupported = {"cases", "trajectories", "experiences", "session_skills"}
        if resolved_policy.memory_types and resolved_policy.memory_types.intersection(unsupported):
            raise IncrementalError(
                "UNSUPPORTED_MEMORY_TYPES", "Incremental extraction accepts ordinary user memories"
            )
        fs, ctx = session._viking_fs, session.ctx
        registry = await resolve_account_memory_registry(fs, ctx.account_id, get_default_registry())
        allowed_types = {
            schema.memory_type
            for schema in registry.list_all()
            if getattr(schema, "stage", "user") == "user" and schema.memory_type not in unsupported
        }
        if resolved_policy.memory_types is not None:
            resolved_policy.validate_memory_types(set(registry.list_names()))
            allowed_types.intersection_update(resolved_policy.memory_types)
        allowed_peers = (
            {message.peer_id for message in messages if message.role == "user" and message.peer_id}
            if resolved_policy.peer_enabled
            else set()
        )
        isolation_options = {
            "allowed_memory_types": allowed_types,
            "allow_self": resolved_policy.self_enabled,
            "allowed_peer_ids": allowed_peers,
            "peer_memory_enabled": resolved_policy.peer_enabled,
        }
        vlm = await compressor.vlm_resolver.get_vlm(ctx.account_id)
        provider = IncrementalContextProvider(
            messages=messages,
            latest_archive_overview=recent_context,
            ctx=ctx,
            viking_fs=fs,
            memory_registry=registry,
            vlm_config=vlm,
            extraction_scope="eating_incremental_v1",
        )
        await provider.prepare_extraction_messages()
        isolation = MemoryIsolationHandler(ctx, provider.get_extract_context(), **isolation_options)
        provider._isolation_handler = isolation
        isolation.prepare_messages()
        if not allowed_types or not isolation.has_writable_message_target():
            return PreparedExtraction(
                None,
                registry,
                isolation_options,
                compressor.vlm_resolver,
                compressor.streaming_memory_updater_config,
            )
        operations, _ = await ExtractLoop(
            vlm=vlm, viking_fs=fs, ctx=ctx, context_provider=provider, isolation_handler=isolation
        ).run()
        if operations is not None and operations.errors:
            raise IncrementalError("EXTRACTION_FAILED", "Native operation resolution failed")
        # Tags are the native Session default, not caller-supplied untrusted fields.
        for operation in getattr(operations, "upsert_operations", []) or []:
            if operation.memory_type == "events" and session.meta.event_search_tags:
                operation.search_tags = list(session.meta.event_search_tags)
        return PreparedExtraction(
            operations,
            registry,
            isolation_options,
            compressor.vlm_resolver,
            compressor.streaming_memory_updater_config,
        )

    async def apply(
        self, session: Any, messages: list[Message], prepared: PreparedExtraction, receipt: dict
    ) -> dict[str, int]:
        if prepared.operations is None:
            return {"added": 0, "updated": 0, "deleted": 0}
        # Keep ownership of this submitter's flush and its cancellation within the
        # session worker. Native grouping/isolation and memory pathlocks still apply.
        updater = StreamingMemoryUpdater(
            registry=prepared.registry,
            vikingdb=session._vikingdb_manager,
            config=prepared.updater_config,
            vlm_resolver=prepared.vlm_resolver,
        )
        try:
            result = await updater.submit(
                MemoryUpdateRequest(
                    operations=prepared.operations,
                    messages=messages,
                    ctx=session.ctx,
                    strict_extract_errors=True,
                    isolation_options=prepared.isolation,
                    memory_registry=prepared.registry,
                    metadata={
                        "source_extraction_id": receipt["task_id"],
                        "task_id": receipt["task_id"],
                        "session_id": session.session_id,
                        "archive_uri": None,
                        "extracted_at": datetime.now(timezone.utc).isoformat(),
                    },
                )
            )
            applied = result.apply_result
            if applied.errors:
                # Some operations can already have succeeded. Never retry this submit.
                raise IncrementalError(
                    "NATIVE_APPLY_INCOMPLETE", "Native memory apply is incomplete"
                )
            if result.operations.errors:
                raise IncrementalError("NATIVE_APPLY_INCOMPLETE", "Native operation merge failed")
            # The official diff classifies rewritten old files as updates.
            # written_uris alone is not an add count. Native metadata/version
            # changes can make an identical-body rewrite count as an update.
            diff = await session._session_compressor._build_memory_diff(
                result=applied,
                operations=result.operations,
                viking_fs=session._viking_fs,
                ctx=session.ctx,
            )
            summary = diff["summary"]
            return {
                "added": summary["total_adds"],
                "updated": summary["total_updates"],
                "deleted": summary["total_deletes"],
            }
        finally:
            # Native close awaits outstanding flushes before the session lock can
            # be released. Cancellation is handled conservatively by the journal.
            await updater.close()
