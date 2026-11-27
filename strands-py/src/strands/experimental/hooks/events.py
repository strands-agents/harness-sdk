"""Deprecated aliases for hook events promoted to strands.hooks."""

import warnings
from typing import Any

from ...hooks.events import AfterModelCallEvent, AfterToolCallEvent, BeforeModelCallEvent, BeforeToolCallEvent

# Deprecated aliases - warning emitted on access via __getattr__
_DEPRECATED_ALIASES = {
    "BeforeToolInvocationEvent": BeforeToolCallEvent,
    "AfterToolInvocationEvent": AfterToolCallEvent,
    "BeforeModelInvocationEvent": BeforeModelCallEvent,
    "AfterModelInvocationEvent": AfterModelCallEvent,
}


def __getattr__(name: str) -> Any:
    if name in _DEPRECATED_ALIASES:
        warnings.warn(
            f"{name} has been moved to production with an updated name. "
            f"Use {_DEPRECATED_ALIASES[name].__name__} from strands.hooks instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return _DEPRECATED_ALIASES[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
