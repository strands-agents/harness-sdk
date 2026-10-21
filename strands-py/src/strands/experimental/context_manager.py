"""Deprecated: Context management has moved to strands.context_manager.

This module provides backwards-compatible aliases that emit deprecation warnings.
"""

import importlib
import warnings
from typing import Any

# Name -> submodule of strands.context_manager that defines it.
_PUBLIC_NAMES = {
    "ContextManager": "_context_manager",
    "ContextManagerConfig": "_types",
    "Offload": "_strategies.offload",
    "OffloadTarget": "_strategies.offload.base",
    "StashConfig": "_types",
    "SummarizeConfig": "_methods.summarize",
    "TruncateConfig": "_methods.truncate",
}

# Exported here but not from strands.context_manager.
_INTERNAL_NAMES = {
    "ContextState": "_types",
    "ContextStrategy": "_types",
    "OffloadConditions": "_strategies.offload.base",
    "STRATEGY_PRESET_NAMES": "_presets",
    "StrategyPresetName": "_presets",
}

_DEPRECATED_NAMES = {**_PUBLIC_NAMES, **_INTERNAL_NAMES}

_MIGRATION_GUIDE_URL = "https://strandsagents.com/docs/user-guide/sdk/context-management/#updating-experimental-imports"


def __getattr__(name: str) -> Any:
    if name not in _DEPRECATED_NAMES:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    replacement = (
        f"Import {name} from strands.context_manager instead."
        if name in _PUBLIC_NAMES
        else "It has no public replacement."
    )
    warnings.warn(
        f"strands.experimental.context_manager.{name} is deprecated and will be removed in v1.63.0. {replacement} "
        f"See migration guide: {_MIGRATION_GUIDE_URL}",
        DeprecationWarning,
        stacklevel=2,
    )
    module = importlib.import_module(f"strands.context_manager.{_DEPRECATED_NAMES[name]}")
    return getattr(module, name)


__all__: list[str] = []
