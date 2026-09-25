"""Snapshot capture and restore for multi-agent orchestrators (Graph and Swarm).

Wraps an orchestrator's :meth:`~strands.multiagent.base.MultiAgentBase.serialize_state`
output in the versioned :class:`~strands.types._snapshot.Snapshot` envelope so the persisted
format can evolve, mirroring the TypeScript SDK's ``multiagent/snapshot.ts``.

Well-known keys in ``data``:

- ``orchestrator_id`` — orchestrator identity, verified on load.
- ``state`` — the orchestrator's serialized execution state.
"""

from typing import TYPE_CHECKING, Any

from ..types._snapshot import SNAPSHOT_SCHEMA_VERSION, Snapshot
from ..types.exceptions import SnapshotException

if TYPE_CHECKING:
    from .base import MultiAgentBase


def take_snapshot(orchestrator: "MultiAgentBase", *, app_data: dict[str, Any] | None = None) -> Snapshot:
    """Capture an orchestrator's execution state as a versioned snapshot.

    Args:
        orchestrator: The Graph or Swarm to capture.
        app_data: Application-owned data. Strands does not read or modify it.

    Returns:
        A ``multiAgent``-scope snapshot wrapping the orchestrator's serialized state.
    """
    return Snapshot(
        scope="multiAgent",
        schema_version=SNAPSHOT_SCHEMA_VERSION,
        data={"orchestrator_id": orchestrator.id, "state": orchestrator.serialize_state()},
        app_data=app_data or {},
    )


def load_snapshot(orchestrator: "MultiAgentBase", snapshot: Snapshot) -> None:
    """Restore an orchestrator's execution state from a snapshot.

    Args:
        orchestrator: The Graph or Swarm to restore into.
        snapshot: The snapshot to load.

    Raises:
        SnapshotException: If the snapshot is not a current-schema ``multiAgent`` snapshot,
            or its ``orchestrator_id`` does not match ``orchestrator.id``.
    """
    snapshot.validate()
    if snapshot.scope != "multiAgent":
        raise SnapshotException(f"Expected snapshot scope 'multiAgent', got {snapshot.scope!r}")

    snapshot_id = snapshot.data.get("orchestrator_id")
    if snapshot_id != orchestrator.id:
        raise SnapshotException(f"Snapshot orchestrator id mismatch: expected {orchestrator.id!r}, got {snapshot_id!r}")

    orchestrator.deserialize_state(snapshot.data["state"])
