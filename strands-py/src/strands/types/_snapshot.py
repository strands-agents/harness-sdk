"""Snapshot types, constants, and helpers for agent state capture."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from .exceptions import SnapshotException

SnapshotField = Literal[
    "messages",
    "state",
    "conversation_manager_state",
    "interrupt_state",
    "system_prompt",
    "model_state",
]
SnapshotPreset = Literal["session"]
Scope = Literal["agent", "multiAgent"]

ALL_SNAPSHOT_FIELDS: tuple[SnapshotField, ...] = (
    "messages",
    "state",
    "conversation_manager_state",
    "interrupt_state",
    "system_prompt",
    "model_state",
)

VALID_SCOPES: tuple[Scope, ...] = ("agent", "multiAgent")

SNAPSHOT_SCHEMA_VERSION = "1.0"

SNAPSHOT_PRESETS: dict[str, tuple[SnapshotField, ...]] = {
    "session": ("messages", "state", "conversation_manager_state", "interrupt_state", "model_state"),
}


@dataclass
class Snapshot:
    """Point-in-time capture of agent state as a versioned JSON-compatible object."""

    scope: Scope
    schema_version: str
    data: dict[str, Any]
    app_data: dict[str, Any]
    created_at: str = field(default="")  # ISO 8601 UTC; auto-filled if empty

    def __post_init__(self) -> None:
        if not self.created_at:
            self.created_at = _utc_now_iso()

    def validate(self) -> None:
        """Validate that this snapshot can be loaded by the current SDK version.

        Raises:
            SnapshotException: If schema_version is not "1.0" or scope is invalid.
        """
        if self.schema_version != SNAPSHOT_SCHEMA_VERSION:
            raise SnapshotException(
                f"Unsupported snapshot schema version: {self.schema_version!r}. "
                f"Current version: {SNAPSHOT_SCHEMA_VERSION}"
            )
        if self.scope not in VALID_SCOPES:
            raise SnapshotException(f"Invalid snapshot scope: {self.scope!r}. Valid scopes: {sorted(VALID_SCOPES)}")

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a plain JSON-compatible dict."""
        return {
            "scope": self.scope,
            "schema_version": self.schema_version,
            "created_at": self.created_at,
            "data": self.data,
            "app_data": self.app_data,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Snapshot:
        """Reconstruct a Snapshot from a dict produced by to_dict().

        Raises:
            SnapshotException: If schema_version is not "1.0".
        """
        snapshot = cls(
            scope=d.get("scope", "agent"),
            schema_version=d.get("schema_version", ""),
            created_at=d["created_at"],
            data=d["data"],
            app_data=d.get("app_data", {}),
        )
        snapshot.validate()
        return snapshot


def resolve_snapshot_fields(
    *,
    preset: SnapshotPreset | None = None,
    include: list[SnapshotField] | None = None,
    exclude: list[SnapshotField] | None = None,
) -> set[SnapshotField]:
    """Resolve the set of fields to capture based on options.

    Applies: preset → include → exclude (in that order).

    Raises:
        SnapshotException: If any field name is invalid or the resolved set is empty.
    """
    valid = set(ALL_SNAPSHOT_FIELDS)

    # Validate include/exclude field names
    for f in include or []:
        if f not in valid:
            raise SnapshotException(f"Invalid snapshot field: {f!r}. Valid fields: {sorted(valid)}")
    for f in exclude or []:
        if f not in valid:
            raise SnapshotException(f"Invalid snapshot field: {f!r}. Valid fields: {sorted(valid)}")

    # Step 1: start with preset
    if preset is not None:
        fields: set[SnapshotField] = set(SNAPSHOT_PRESETS[preset])
    else:
        fields = set()

    # Step 2: union with include
    if include:
        fields |= set(include)

    # Step 3: subtract exclude
    if exclude:
        fields -= set(exclude)

    if not fields:
        raise SnapshotException(
            "No snapshot fields resolved. Provide a preset or at least one field in 'include'. "
            "Note: passing only 'exclude' without a preset or 'include' always results in an empty set."
        )

    return fields


def _utc_now_iso() -> str:
    """Return the current UTC time as an ISO 8601 string ending in 'Z'."""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
