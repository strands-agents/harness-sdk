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
from typing import Any, NoReturn, Protocol, cast, runtime_checkable

from ....models.model import Model
from ....types.content import Message, Messages
from ....types.tools import ToolResult, ToolSpec
from ..types.events import BidiInputEvent, BidiOutputEvent
from .configs import AudioConfig, BidiConnectionConfig

logger = logging.getLogger(__name__)


def _validate_tool_result_message(message: Message) -> list[ToolResult]:
    """Validate and extract one complete user tool-result group."""
    if not isinstance(message, dict) or message.get("role") != "user":
        raise ValueError("tool-result message must have role 'user'")

    content = message.get("content")
    if not isinstance(content, list) or not content:
        raise ValueError("tool-result message content must be a non-empty list")

    tool_results: list[ToolResult] = []
    tool_use_ids: set[str] = set()
    for index, block in enumerate(content):
        if not isinstance(block, dict) or set(block) != {"toolResult"}:
            raise ValueError(f"tool-result message content block {index} must contain only 'toolResult'")

        tool_result = block["toolResult"]
        if not isinstance(tool_result, dict):
            raise ValueError(f"tool-result message content block {index} must contain an object-shaped tool result")

        tool_use_id = tool_result.get("toolUseId")
        if not isinstance(tool_use_id, str) or not tool_use_id:
            raise ValueError(f"tool-result message content block {index} must have a non-empty 'toolUseId'")
        if tool_use_id in tool_use_ids:
            raise ValueError(f"tool-result message contains duplicate toolUseId '{tool_use_id}'")

        if tool_result.get("status") not in ("success", "error"):
            raise ValueError(f"tool-result message content block {index} must have status 'success' or 'error'")

        result_content = tool_result.get("content")
        if not isinstance(result_content, list) or not all(isinstance(item, dict) for item in result_content):
            raise ValueError(f"tool-result message content block {index} must have list-shaped 'content'")

        tool_use_ids.add(tool_use_id)
        tool_results.append(tool_result)

    return tool_results


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
    provider-specific protocols while exposing a standardized event-based API. Tool
    calls stream for visibility, then a ``BidiToolUsesCompleteEvent`` authorizes one
    complete provider-defined group. Tool results return through
    ``send_tool_results()`` as one ordered user message.

    Attributes:
        model_id: Provider model identifier.
        usage_is_cumulative: Whether the provider reports cumulative connection token totals
            (True) rather than per-response deltas (False, the default when absent). Providers
            reporting deltas may omit it.
    """

    usage_is_cumulative: bool

    @property
    def model_id(self) -> str:
        """Get the configured model identifier."""
        return cast(str, self.get_config()["model_id"])

    def get_connection_config(self) -> BidiConnectionConfig:
        """Get the configured reconnect timing, or an empty config if unspecified."""
        return cast(BidiConnectionConfig, self.get_config().get("connection", {}))

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
        Providers must emit ``ToolUseStreamEvent`` before
        ``BidiToolUsesCompleteEvent`` for every executable tool group.

        Yields:
            BidiOutputEvent: Standardized event objects containing audio output,
                transcripts, tool calls, or control signals.
        """
        pass

    @abc.abstractmethod
    # pragma: no cover
    async def send(
        self,
        content: BidiInputEvent,
    ) -> None:
        """Send user input to the model over the active connection.

        Tool results are submitted through ``send_tool_results()`` so providers receive
        one complete result group.

        Args:
            content: The user input to send. Must be one of:

                - BidiTextInputEvent: Text message from the user
                - BidiAudioInputEvent: Audio data for speech input
                - BidiImageInputEvent: Image data for visual understanding

        Example:
            ```
            await model.send(BidiTextInputEvent(text="Hello", role="user"))
            await model.send(BidiAudioInputEvent(audio=bytes, format="pcm", sample_rate=16000, channels=1))
            await model.send(BidiImageInputEvent(image=bytes, mime_type="image/jpeg", encoding="raw"))
            ```
        """
        pass

    @abc.abstractmethod
    # pragma: no cover
    async def send_tool_results(self, message: Message) -> None:
        """Send one complete user-role tool-result message.

        Implementations must validate the full group before writing provider events,
        preserve result order, and request at most one model continuation after the
        complete group has been submitted.

        Args:
            message: User message containing only tool-result content blocks.

        Raises:
            ValueError: If the message or provider-specific result content is invalid.
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

    def get_audio_config(self) -> AudioConfig:
        """Get the resolved audio configuration."""
        ...
