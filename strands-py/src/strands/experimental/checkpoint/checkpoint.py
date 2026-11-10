"""Checkpoint system for durable agent execution.

A ``Checkpoint`` is a pause-point marker emitted at agent cycle boundaries.
It captures the position (which boundary fired) and the cycle index. It does
**not** capture conversation state — pair with a ``SessionManager`` for
cross-process state continuity.

Positions per ReAct cycle:
- ``after_model``: model returned tool_use; tools have not run yet.
- ``after_tools``: tools finished; the next model call has not happened yet.

Per-tool granularity within a cycle is the ``ToolExecutor``'s responsibility.

Usage (mirrors interrupts):
- Pause: ``AgentResult`` with ``stop_reason="checkpoint"`` and ``checkpoint`` populated.
- Resume: pass back ``{"checkpointResume": {"checkpoint": ckpt.to_dict()}}``.

Precedence:
- Interrupt > checkpoint: an interrupt during a checkpointing cycle returns
  ``stop_reason="interrupt"`` and skips ``after_tools``.
- Cancel > checkpoint: a cancel signal at either boundary returns
  ``stop_reason="cancelled"``.

Notes:
- Checkpoints are only emitted on tool_use cycles. A turn with no tool calls
  emits no checkpoint; use a ``SessionManager`` for durability of every turn.
- ``EventLoopMetrics`` resets per invocation; aggregate yourself if needed.
- ``BeforeInvocationEvent`` / ``AfterInvocationEvent`` fire on every resume,
  same as interrupts.
"""

import logging
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from ...types.exceptions import CheckpointException

logger = logging.getLogger(__name__)

CHECKPOINT_SCHEMA_VERSION = "1.0"

CheckpointPosition = Literal["after_model", "after_tools"]


@dataclass(frozen=True)
class Checkpoint:
    """Pause-point marker. Treat as opaque — pass back to resume.

    Attributes:
        position: Which boundary fired (``after_model`` or ``after_tools``).
        cycle_index: ReAct loop cycle (0-based).
        schema_version: Rejects incompatible checkpoints on resume.
    """

    position: CheckpointPosition
    cycle_index: int = 0
    schema_version: str = field(init=False, default=CHECKPOINT_SCHEMA_VERSION)

    def to_dict(self) -> dict[str, Any]:
        """Serialize for persistence."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Checkpoint":
        """Reconstruct from a dict produced by to_dict().

        Args:
            data: Serialized checkpoint data.

        Raises:
            CheckpointException: If schema_version doesn't match the current version.
        """
        version = data.get("schema_version", "")
        if version != CHECKPOINT_SCHEMA_VERSION:
            raise CheckpointException(
                f"Checkpoints with schema version {version!r} are not compatible "
                f"with current version {CHECKPOINT_SCHEMA_VERSION}."
            )
        known_keys = {k for k in cls.__dataclass_fields__ if k != "schema_version"}
        unknown_keys = set(data.keys()) - known_keys - {"schema_version"}
        if unknown_keys:
            logger.warning("unknown_keys=<%s> | ignoring unknown fields in checkpoint data", unknown_keys)
        return cls(**{k: v for k, v in data.items() if k in known_keys})
