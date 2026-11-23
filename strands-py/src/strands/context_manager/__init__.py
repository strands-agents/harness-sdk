"""Context management for strategy-driven context reduction.

The :class:`ContextManager` is a first-class agent component that reduces context through an ordered
pipeline of strategies, built with the :class:`Offload` builders. Pass a manager, a config dict, or a
preset name to the Agent's ``context_manager`` parameter; the Agent registers it, and it owns overflow
recovery and proactive compression.

Example:
    ```python
    from strands import Agent
    from strands.context_manager import ContextManager, Offload

    agent = Agent(context_manager=ContextManager(strategies=[Offload.truncate("tool_results")]))
    ```
"""

from .._context_manager.context_manager import ContextManager
from .._context_manager.methods.truncate import TruncateConfig
from .._context_manager.presets import STRATEGY_PRESET_NAMES, StrategyPresetName
from .._context_manager.strategies.offload import Offload, OffloadConditions, OffloadStrategy, OffloadTarget
from .._context_manager.strategies.offload.summarize import SummarizeConfig
from .._context_manager.types import ArchiveConfig, ContextManagerConfig, ContextState, ContextStrategy

__all__ = [
    "ArchiveConfig",
    "ContextManager",
    "ContextManagerConfig",
    "ContextState",
    "ContextStrategy",
    "Offload",
    "OffloadConditions",
    "OffloadStrategy",
    "OffloadTarget",
    "STRATEGY_PRESET_NAMES",
    "StrategyPresetName",
    "SummarizeConfig",
    "TruncateConfig",
]
