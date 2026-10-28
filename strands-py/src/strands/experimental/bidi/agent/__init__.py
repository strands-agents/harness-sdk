"""Deprecated alias for :mod:`strands.bidi.agent`."""

from typing import Any

from strands.bidi import agent as _real
from strands.bidi.agent import BidiAgent

__all__ = ["BidiAgent"]


def __getattr__(name: str) -> Any:
    """Forward attribute access to :mod:`strands.bidi.agent`."""
    return getattr(_real, name)
