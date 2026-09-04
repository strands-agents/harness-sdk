"""Bidirectional streaming model interface.

Defines the abstract interface for models that support real-time bidirectional
communication with persistent connections. Unlike traditional request-response
models, bidirectional models maintain an open connection for streaming audio,
text, and tool interactions.

Features:

- Persistent connection management with connect/close lifecycle
- Real-time bidirectional communication (send and receive simultaneously)
- Provider-agnostic event normalization
- Support for audio, text, image, and tool result streaming
"""

import abc
import logging
from collections.abc import AsyncIterable
from typing import Any, NoReturn, Protocol, TypedDict, runtime_checkable

from typing_extensions import Unpack

from ....models._validation import validate_config_keys
from ....models.model import Model
from ....types._events import ToolResultEvent
from ....types.content import Messages
from ....types.tools import ToolSpec
from ..types.events import BidiInputEvent, BidiOutputEvent
from ..types.model import AudioConfig, BidiConnectionConfig

logger = logging.getLogger(__name__)


class BidiModelConfig(TypedDict, total=False):
    """Configuration shared by bidirectional model providers.

    Attributes:
        model_id: Provider model identifier.
        params: Provider-specific keyword arguments passed to the model request or session.
        connection: Reconnect timing overrides.
    """

    model_id: str
    params: dict[str, Any] | None
    connection: BidiConnectionConfig


@runtime_checkable
class Restartable(Protocol):
    """A bidirectional model that can replace its active connection while preserving context."""

    async def restart(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **restart_kwargs: Any,
    ) -> None:
        """Replace the active connection while preserving conversation context.

        Args:
            system_prompt: System instructions for the new connection.
            tools: Tool specifications for the new connection.
            messages: Conversation history to replay when required by the provider.
            **restart_kwargs: Provider-specific restart options.
        """
        ...


class BidiModel(Model, abc.ABC):
    """Abstract base class for bidirectional streaming models.

    This interface defines the contract for models that support persistent streaming
    connections with real-time audio and text communication. Implementations handle
    provider-specific protocols while exposing a standardized event-based API.

    Attributes:
        config: Configuration dictionary with provider-specific settings.
        model_id: Provider model identifier.
        connection_config: Declared connection limit and reconnect timing. Providers that
            support proactive reconnect populate this; an empty config means reactive-only
            behavior.
        usage_is_cumulative: Whether the provider reports cumulative connection token totals
            (True) rather than per-response deltas (False, the default when absent). Providers
            reporting deltas may omit it.
    """

    config: BidiModelConfig
    model_id: str
    connection_config: BidiConnectionConfig
    usage_is_cumulative: bool

    def update_config(self, **model_config: Unpack[BidiModelConfig]) -> None:  # type: ignore[override]
        """Update the model configuration with the provided arguments.

        Args:
            **model_config: Configuration overrides.
        """
        validate_config_keys(model_config, BidiModelConfig)
        self.config.update(model_config)

    def get_config(self) -> BidiModelConfig:
        """Return a copy of the model configuration."""
        return self.config.copy()

    def structured_output(self, *args: Any, **kwargs: Any) -> NoReturn:
        """Raise because bidirectional models do not support structured output."""
        raise NotImplementedError("structured output is not supported by bidirectional models")

    def stream(self, *args: Any, **kwargs: Any) -> NoReturn:
        """Raise because bidirectional models use their persistent streaming API."""
        raise NotImplementedError("regular streaming is not supported by bidirectional models")

    @abc.abstractmethod
    # pragma: no cover
    async def start(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **kwargs: Any,
    ) -> None:
        """Establish a persistent streaming connection with the model.

        Opens a bidirectional connection that remains active for real-time communication.
        The connection supports concurrent sending and receiving of events until explicitly
        closed. Must be called before any send() or receive() operations.

        Args:
            system_prompt: System instructions to configure model behavior.
            tools: Tool specifications that the model can invoke during the conversation.
            messages: Initial conversation history to provide context.
            **kwargs: Provider-specific configuration options.
        """
        pass

    @abc.abstractmethod
    # pragma: no cover
    async def stop(self) -> None:
        """Close the streaming connection and release resources.

        Terminates the active bidirectional connection and cleans up any associated
        resources such as network connections, buffers, or background tasks. After
        calling close(), the model instance cannot be used until start() is called again.
        """
        pass

    @abc.abstractmethod
    # pragma: no cover
    def receive(self) -> AsyncIterable[BidiOutputEvent]:
        """Receive streaming events from the model.

        Continuously yields events from the model as they arrive over the connection.
        Events are normalized to a provider-agnostic format for uniform processing.
        This method should be called in a loop or async task to process model responses.

        The stream continues until the connection is closed or an error occurs.

        Yields:
            BidiOutputEvent: Standardized event objects containing audio output,
                transcripts, tool calls, or control signals.
        """
        pass

    @abc.abstractmethod
    # pragma: no cover
    async def send(
        self,
        content: BidiInputEvent | ToolResultEvent,
    ) -> None:
        """Send content to the model over the active connection.

        Transmits user input or tool results to the model during an active streaming
        session. Supports multiple content types including text, audio, images, and
        tool execution results. Can be called multiple times during a conversation.

        Args:
            content: The content to send. Must be one of:

                - BidiTextInputEvent: Text message from the user
                - BidiAudioInputEvent: Audio data for speech input
                - BidiImageInputEvent: Image data for visual understanding
                - ToolResultEvent: Result from a tool execution

        Example:
            ```
            await model.send(BidiTextInputEvent(text="Hello", role="user"))
            await model.send(BidiAudioInputEvent(audio=bytes, format="pcm", sample_rate=16000, channels=1))
            await model.send(BidiImageInputEvent(image=bytes, mime_type="image/jpeg", encoding="raw"))
            await model.send(ToolResultEvent(tool_result))
            ```
        """
        pass


class BidiModelTimeoutError(Exception):
    """Model timeout error.

    Bidirectional models are often configured with a connection time limit. Bedrock Nova Sonic, for example, keeps the
    connection open for 8 minutes max. Upon receiving a timeout, the agent loop is configured to restart the model
    connection so as to create a seamless, uninterrupted experience for the user.
    """

    def __init__(self, message: str, **restart_config: Any) -> None:
        """Initialize error.

        Args:
            message: Timeout message from model.
            **restart_config: Configure restart specific behaviors in the call to model start.
        """
        super().__init__(message)

        self.restart_config = restart_config


@runtime_checkable
class AudioCapable(Protocol):
    """Protocol for models that support audio input and output."""

    @property
    def audio_config(self) -> AudioConfig:
        """Get the resolved audio configuration."""
        ...
