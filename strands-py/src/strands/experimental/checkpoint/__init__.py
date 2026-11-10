"""Experimental checkpoint types for durable agent execution.

This module is experimental and subject to change in future revisions without notice.

Checkpoints enable crash-resilient agent workflows by capturing agent state at
cycle boundaries in the agent loop. A durability provider (e.g. Temporal) can
persist checkpoints and resume from them after failures.
"""

from .checkpoint import CHECKPOINT_SCHEMA_VERSION, Checkpoint, CheckpointPosition

__all__ = ["CHECKPOINT_SCHEMA_VERSION", "Checkpoint", "CheckpointPosition"]
