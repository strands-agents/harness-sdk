"""IO channel implementations for bidirectional streaming."""

from typing import TYPE_CHECKING, Any

from .configs import BidiAudioIOConfig, BidiAudioProcessorConfig

if TYPE_CHECKING:
    from .audio import BidiAudioIO
    from .text import BidiTextIO

__all__ = ["BidiAudioProcessorConfig", "BidiAudioIO", "BidiAudioIOConfig", "BidiTextIO"]


def __getattr__(name: str) -> Any:
    """Lazy load optional I/O implementations only when accessed."""
    if name == "BidiAudioIO":
        from .audio import BidiAudioIO

        return BidiAudioIO
    if name == "BidiTextIO":
        from .text import BidiTextIO

        return BidiTextIO
    raise AttributeError(f"cannot import name '{name}' from '{__name__}' ({__file__})")
