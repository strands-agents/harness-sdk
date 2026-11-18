"""Deprecated alias for :mod:`strands.bidi.hooks`."""

from typing import Any

from strands.bidi import hooks as _real
from strands.bidi.hooks import (
    BidiAfterConnectionRestartEvent,
    BidiAgentStopEvent,
    BidiBargeInEvent,
    BidiBeforeConnectionRestartEvent,
    BidiResponseStopEvent,
)

__all__ = [
    "BidiAgentStopEvent",
    "BidiResponseStopEvent",
    "BidiBargeInEvent",
    "BidiBeforeConnectionRestartEvent",
    "BidiAfterConnectionRestartEvent",
]


def __getattr__(name: str) -> Any:
    """Forward attribute access to :mod:`strands.bidi.hooks`."""
    return getattr(_real, name)
