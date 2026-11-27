"""Deprecated alias for :mod:`strands.context_manager`.

Every name here resolves to the same object the stable module exports, except ``StashConfig``, which was
renamed to :class:`~strands.context_manager.ArchiveConfig`.
"""

import warnings

from ...context_manager import (
    STRATEGY_PRESET_NAMES,
    ArchiveConfig,
    ContextManager,
    ContextManagerConfig,
    ContextState,
    ContextStrategy,
    Offload,
    OffloadConditions,
    OffloadStrategy,
    OffloadTarget,
    StrategyPresetName,
    SummarizeConfig,
    TruncateConfig,
)

StashConfig = ArchiveConfig
"""Deprecated name for :class:`~strands.context_manager.ArchiveConfig`. Removed in v1.68.0."""

__all__ = [
    "ContextManager",
    "ContextManagerConfig",
    "ContextState",
    "ContextStrategy",
    "Offload",
    "OffloadConditions",
    "OffloadStrategy",
    "OffloadTarget",
    "STRATEGY_PRESET_NAMES",
    "StashConfig",
    "StrategyPresetName",
    "SummarizeConfig",
    "TruncateConfig",
]

warnings.warn(
    "strands.experimental.context_manager is deprecated and will be removed in v1.68.0. "
    "Import from strands.context_manager instead.",
    DeprecationWarning,
    stacklevel=2,
)
