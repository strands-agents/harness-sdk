"""Experimental features.

This module implements experimental features that are subject to change in future revisions without notice.
"""

import importlib
from typing import Any

from . import checkpoint, steering, tools
from .agent_config import config_to_agent

# `bidi` and `context_manager` are deprecated aliases for stable packages and are left out: importing
# them here would warn on every `strands.experimental` import.
__all__ = ["checkpoint", "config_to_agent", "tools", "steering"]

_DEPRECATED_SUBMODULES = ("bidi", "context_manager")


def __getattr__(name: str) -> Any:
    """Import a deprecated alias submodule on first attribute access.

    Keeps ``strands.experimental.context_manager`` resolving for code that imports only the parent
    package, which the aliases' absence from the eager imports above would otherwise break.

    Args:
        name: Attribute being read.

    Returns:
        The alias module, which warns as it is imported.

    Raises:
        AttributeError: For any name that is not a deprecated alias submodule.
    """
    if name in _DEPRECATED_SUBMODULES:
        return importlib.import_module(f"{__name__}.{name}")
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
