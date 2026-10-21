"""Strategy-driven context management for agents.

The ContextManager is a first-class agent component that manages context reduction
via an ordered strategy pipeline. Pass it via the ``context_manager`` parameter on
the Agent constructor.
"""

from ._context_manager import ContextManager
from ._methods.summarize import SummarizeConfig
from ._methods.truncate import TruncateConfig
from ._strategies.offload import Offload
from ._strategies.offload.base import OffloadTarget
from ._types import ContextManagerConfig, StashConfig

__all__ = [
    "ContextManager",
    "ContextManagerConfig",
    "Offload",
    "OffloadTarget",
    "StashConfig",
    "SummarizeConfig",
    "TruncateConfig",
]
