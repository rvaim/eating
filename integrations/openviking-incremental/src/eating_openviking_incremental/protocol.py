"""The Eating incremental-memory HTTP v1 contract."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Literal

from openviking.core.peer_id import normalize_peer_id
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator

PROTOCOL_VERSION = 1
SERVER_VERSION = "0.5.2.1"
DEFAULT_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024


class CaptureMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    role: Literal["user", "assistant"]
    content: str = Field(max_length=1024 * 1024)
    peer_id: str | None = None
    created_at: str

    @field_validator("peer_id")
    @classmethod
    def valid_peer(cls, value: str | None) -> str | None:
        peer = normalize_peer_id(value)
        if peer == "__self":
            raise ValueError("__self is an internal memory target, not a message peer")
        return peer

    @field_validator("created_at")
    @classmethod
    def valid_time(cls, value: str) -> str:
        if not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})",
            value,
        ):
            raise ValueError("created_at must be an RFC3339 timestamp with a timezone")
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("created_at must be an RFC3339 timestamp with a timezone")
        return value


class CaptureRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    request_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    expected_sequence: StrictInt = Field(ge=0)
    messages: list[CaptureMessage] = Field(min_length=1, max_length=1000)
    archive_max_bytes: StrictInt = Field(
        default=DEFAULT_ARCHIVE_MAX_BYTES, ge=1, le=MAX_ARCHIVE_BYTES
    )

    def payload_hash(self) -> str:
        return sha256(canonical_json(self.model_dump(mode="json")))


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class IncrementalError(Exception):
    """A stable public error; messages never contain raw model/provider exceptions."""

    def __init__(self, code: str, message: str, http_status: int = 412, **details: object):
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.details = details
