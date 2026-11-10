"""Deprecated: Use strands.vended_plugins.steering.handlers instead."""

import warnings
from typing import Any

_TARGET_MODULE = "strands.vended_plugins.steering.handlers"


def __getattr__(name: str) -> Any:
    from strands.vended_plugins.steering import handlers

    obj = getattr(handlers, name, None)
    if obj is not None:
        warnings.warn(
            f"{name} has been moved to production. Use {name} from {_TARGET_MODULE} instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return obj
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__: list[str] = []
