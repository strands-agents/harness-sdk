"""Experimental context management types for strategy-driven context reduction.

This module is experimental and subject to change in future revisions without notice.

The ContextManager is a first-class agent component that manages context reduction
via an ordered strategy pipeline. Pass it via the ``context_manager`` parameter on
the Agent constructor.
"""

from ..._context_manager.context_manager import ContextManager
from ..._context_manager.methods.summarize import SummarizeConfig
from ..._context_manager.methods.truncate import TruncateConfig
from ..._context_manager.strategies.offload import Offload
from ..._context_manager.strategies.offload.base import OffloadConditions, OffloadTarget
from ..._context_manager.types import ContextState, ContextStrategy, StashConfig

__all__ = [
    "ContextManager",
    "ContextState",
    "ContextStrategy",
    "Offload",
    "OffloadConditions",
    "OffloadTarget",
    "StashConfig",
    "SummarizeConfig",
    "TruncateConfig",
]
