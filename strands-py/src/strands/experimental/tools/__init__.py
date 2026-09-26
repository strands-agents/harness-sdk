"""Experimental tools package."""

import warnings
from typing import Any

from .stop import make_stop, stop

_DEPRECATED_NAMES = {"ToolProvider"}


def __getattr__(name: str) -> Any:
    if name in _DEPRECATED_NAMES:
        from ...tools import ToolProvider

        warnings.warn(
            f"{name} has been moved to production. Use {name} from strands.tools instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return ToolProvider
    # python_repl pulls the optional ``python-repl`` extra, so it is lazy-loaded to keep
    # the base import free of those dependencies.
    if name in ("make_python_repl", "python_repl"):
        # python_repl is prefixed with '_' to avoid name collision with its exported tool.
        from ._python_repl import make_python_repl, python_repl

        if name == "python_repl":
            return python_repl
        return make_python_repl
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "make_stop",
    "stop",
]
