"""Deprecated: Steering has moved to strands.vended_plugins.steering.

This module provides backwards-compatible aliases that emit deprecation warnings.
"""

import warnings
from typing import Any

_DEPRECATED_NAMES = {
    "ToolSteeringAction",
    "ModelSteeringAction",
    "Proceed",
    "Guide",
    "Interrupt",
    "SteeringHandler",
    "SteeringContextCallback",
    "SteeringContextProvider",
    "LedgerBeforeToolCall",
    "LedgerAfterToolCall",
    "LedgerProvider",
    "LLMSteeringHandler",
    "LLMPromptMapper",
}


def __getattr__(name: str) -> Any:
    if name in _DEPRECATED_NAMES:
        from strands.vended_plugins import steering

        warnings.warn(
            f"{name} has been moved to production. Use {name} from strands.vended_plugins.steering instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return getattr(steering, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__: list[str] = []
