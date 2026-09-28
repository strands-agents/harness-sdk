"""IO channel implementations for bidirectional streaming."""

from typing import TYPE_CHECKING, Any

from .configs import AudioIOConfig, AudioProcessorConfig

if TYPE_CHECKING:
    from .audio import AudioIO
    from .text import ConsoleIO

__all__ = ["AudioIO", "AudioIOConfig", "AudioProcessorConfig", "ConsoleIO"]


def __getattr__(name: str) -> Any:
    """Lazy load optional I/O implementations only when accessed."""
    if name == "AudioIO":
        from .audio import AudioIO

        return AudioIO
    if name == "ConsoleIO":
        from .text import ConsoleIO

        return ConsoleIO
    raise AttributeError(f"cannot import name '{name}' from '{__name__}' ({__file__})")
