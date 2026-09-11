"""Bidirectional streaming package."""

from typing import TYPE_CHECKING, Any

# Main components - Primary user interface
# Re-export standard agent events for tool handling
from ...types._events import (
    ToolResultEvent,
    ToolStreamEvent,
    ToolUseStreamEvent,
)
from .agent.agent import BidiAgent

# Model interface (for custom implementations)
from .models.configs import AudioConfig, BidiConnectionConfig, BidiModelConfig
from .models.model import AudioCapable, BidiModel, Restartable

# Built-in tools (deprecated - use strands_tools.stop instead)
from .tools import stop_conversation

# Event types - For type hints and event handling
from .types.events import (
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiConnectionCloseEvent,
    BidiConnectionRestartEvent,
    BidiConnectionStartEvent,
    BidiConnectionWarningEvent,
    BidiErrorEvent,
    BidiImageInputEvent,
    BidiInputEvent,
    BidiInterruptionEvent,
    BidiOutputEvent,
    BidiResponseCompleteEvent,
    BidiResponseStartEvent,
    BidiTextInputEvent,
    BidiTranscriptCompleteEvent,
    BidiTranscriptStreamEvent,
    BidiUsageEvent,
    ModalityUsage,
)

if TYPE_CHECKING:
    from .io.audio import BidiAudioIO, BidiAudioIOConfig, BidiAudioProcessorConfig

__all__ = [
    # Main interface
    "BidiAgent",
    # Input Event types
    "BidiTextInputEvent",
    "BidiAudioInputEvent",
    "BidiImageInputEvent",
    "BidiInputEvent",
    # Output Event types
    "BidiConnectionStartEvent",
    "BidiConnectionRestartEvent",
    "BidiConnectionWarningEvent",
    "BidiConnectionCloseEvent",
    "BidiResponseStartEvent",
    "BidiResponseCompleteEvent",
    "BidiAudioStreamEvent",
    "BidiTranscriptStreamEvent",
    "BidiTranscriptCompleteEvent",
    "BidiInterruptionEvent",
    "BidiUsageEvent",
    "ModalityUsage",
    "BidiErrorEvent",
    "BidiOutputEvent",
    # Reconnect configuration
    "BidiConnectionConfig",
    # Tool Event types (reused from standard agent)
    "ToolUseStreamEvent",
    "ToolResultEvent",
    "ToolStreamEvent",
    # Model interface
    "AudioCapable",
    "AudioConfig",
    "BidiModel",
    "BidiModelConfig",
    "Restartable",
    # IO channels and configuration
    "BidiAudioProcessorConfig",
    "BidiAudioIOConfig",
    "BidiAudioIO",
    "BidiTextIO",
    # Built-in tools (deprecated)
    "stop_conversation",
]


def __getattr__(name: str) -> Any:
    """Lazy load IO implementations only when accessed.

    This defers the import of optional dependencies until actually needed.
    """
    if name == "BidiAudioProcessorConfig":
        from .io.audio import BidiAudioProcessorConfig

        return BidiAudioProcessorConfig
    if name == "BidiAudioIOConfig":
        from .io.audio import BidiAudioIOConfig

        return BidiAudioIOConfig
    if name == "BidiAudioIO":
        from .io.audio import BidiAudioIO

        return BidiAudioIO
    if name == "BidiTextIO":
        from .io.text import BidiTextIO

        return BidiTextIO
    raise AttributeError(f"cannot import name '{name}' from '{__name__}' ({__file__})")
