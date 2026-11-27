"""Experimental tools package."""

import warnings
from typing import Any

_DEPRECATED_NAMES = {"ToolProvider", "stop", "make_stop"}


def __getattr__(name: str) -> Any:
    if name in _DEPRECATED_NAMES:
        if name == "ToolProvider":
            from ...tools import ToolProvider

            warnings.warn(
                "ToolProvider has been moved to production. Use ToolProvider from strands.tools instead.",
                DeprecationWarning,
                stacklevel=2,
            )
            return ToolProvider
        if name == "stop":
            from ...vended_tools import stop

            warnings.warn(
                "stop has been moved to production. Use stop from strands.vended_tools instead.",
                DeprecationWarning,
                stacklevel=2,
            )
            return stop
        if name == "make_stop":
            from ...vended_tools import make_stop

            warnings.warn(
                "make_stop has been moved to production. Use make_stop from strands.vended_tools instead.",
                DeprecationWarning,
                stacklevel=2,
            )
            return make_stop
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = []
