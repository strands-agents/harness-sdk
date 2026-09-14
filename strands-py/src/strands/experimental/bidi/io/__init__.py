"""IO channel implementations for bidirectional streaming."""

from typing import TYPE_CHECKING, Any

from .text import BidiTextIO

if TYPE_CHECKING:
    from .audio import BidiAudioIO, BidiAudioIOConfig, BidiAudioProcessorConfig

__all__ = ["BidiAudioProcessorConfig", "BidiAudioIO", "BidiAudioIOConfig", "BidiTextIO"]


def __getattr__(name: str) -> Any:
    """Lazy load the audio IO implementation only when accessed."""
    if name == "BidiAudioProcessorConfig":
        from .audio import BidiAudioProcessorConfig

        return BidiAudioProcessorConfig
    if name == "BidiAudioIO":
        from .audio import BidiAudioIO

        return BidiAudioIO
    if name == "BidiAudioIOConfig":
        from .audio import BidiAudioIOConfig

        return BidiAudioIOConfig
    raise AttributeError(f"cannot import name '{name}' from '{__name__}' ({__file__})")
