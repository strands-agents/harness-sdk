"""Deprecated: Use strands.vended_plugins.steering.handlers.llm instead."""

import warnings
from typing import Any

_TARGET_MODULE = "strands.vended_plugins.steering.handlers.llm"


def __getattr__(name: str) -> Any:
    from strands.vended_plugins.steering.handlers import llm

    obj = getattr(llm, name, None)
    if obj is not None:
        warnings.warn(
            f"{name} has been moved to production. Use {name} from {_TARGET_MODULE} instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return obj
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__: list[str] = []
