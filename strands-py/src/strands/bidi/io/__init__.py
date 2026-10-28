"""IO channel implementations for bidirectional streaming."""

from typing import TYPE_CHECKING, Any

from .configs import AudioIOConfig, AudioProcessorConfig, ConsoleIOConfig

if TYPE_CHECKING:
    from .audio import AudioIO
    from .console import ConsoleIO

__all__ = ["AudioIO", "AudioIOConfig", "AudioProcessorConfig", "ConsoleIO", "ConsoleIOConfig"]


def __getattr__(name: str) -> Any:
    """Lazy load optional I/O implementations only when accessed."""
    if name == "AudioIO":
        from .audio import AudioIO

        return AudioIO
    if name == "ConsoleIO":
        from .console import ConsoleIO

        return ConsoleIO
    raise AttributeError(f"cannot import name '{name}' from '{__name__}' ({__file__})")
