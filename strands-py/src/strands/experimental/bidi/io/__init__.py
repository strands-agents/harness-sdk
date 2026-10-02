"""Deprecated alias for :mod:`strands.bidi.io`."""

from typing import TYPE_CHECKING, Any

from strands.bidi import io as _real
from strands.bidi.io import AudioIOConfig, AudioProcessorConfig, ConsoleIOConfig

if TYPE_CHECKING:
    from strands.bidi.io import AudioIO, ConsoleIO

__all__ = ["AudioIO", "AudioIOConfig", "AudioProcessorConfig", "ConsoleIO", "ConsoleIOConfig"]


def __getattr__(name: str) -> Any:
    """Forward attribute access to :mod:`strands.bidi.io`."""
    return getattr(_real, name)
