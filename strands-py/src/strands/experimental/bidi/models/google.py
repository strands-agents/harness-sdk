"""Google Gemini Live model provider using the Gemini Live API and official Google GenAI SDK.

Implements the BidiModel interface for Google's Gemini Live API using the
official Google GenAI SDK for simplified and robust WebSocket communication.

Key improvements over custom WebSocket implementation:

- Uses official google-genai SDK with native Live API support
- Simplified session management with client.aio.live.connect()
- Built-in tool integration and event handling
- Automatic WebSocket connection management and error handling
- Native support for audio/text streaming and interruption
"""

import base64
import json
import logging
import uuid
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Any, cast

from google import genai
from google.genai import types as genai_types
from google.genai.types import LiveConnectConfigOrDict, LiveServerContent, LiveServerMessage, UsageMetadata
from typing_extensions import Unpack

from ....models._validation import validate_config_keys
from ....types._events import ToolResultEvent, ToolUseStreamEvent
from ....types.content import Messages
from ....types.tools import ToolResult, ToolSpec, ToolUse
from .._async import stop_all
from ..types.events import (
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiConnectionStartEvent,
    BidiImageInputEvent,
    BidiInputEvent,
    BidiInterruptionEvent,
    BidiOutputEvent,
    BidiResponseCompleteEvent,
    BidiResponseStartEvent,
    BidiTextInputEvent,
    BidiTranscriptStreamEvent,
    BidiUsageEvent,
    ModalityUsage,
)
from ..types.model import AudioConfig, BidiConnectionConfig
from .model import AudioCapable, BidiModel, BidiModelConfig, BidiModelTimeoutError

logger = logging.getLogger(__name__)


@dataclass
class _TurnState:
    """Per-reader tracking for Gemini's inferred turn bracketing.

    A turn is open from the first model output until ``turn_complete``. Kept on the reader (created
    in ``receive()``), not the model, so a superseded reader draining its closing session cannot
    flip the replacing connection's turn state.
    """

    response_open: bool = False
    response_id: str | None = None


class GoogleGeminiLiveModel(BidiModel, AudioCapable):
    """Google Gemini Live implementation using the official Google GenAI SDK.

    Combines model configuration and connection state in a single class.
    Provides a clean interface to Gemini Live API using the official SDK,
    eliminating custom WebSocket handling and providing robust error handling.
    """

    def __init__(
        self,
        *,
        client_args: dict[str, Any] | None = None,
        audio: AudioConfig | None = None,
        **model_config: Unpack[BidiModelConfig],
    ) -> None:
        """Initialize the Google Gemini Live bidirectional model.

        Args:
            client_args: Arguments for the underlying Google GenAI client.
            audio: Audio configuration.
            **model_config: Model configuration.
        """
        validate_config_keys(model_config, BidiModelConfig)
        self.config = BidiModelConfig(**model_config)
        self.model_id = self.config.setdefault("model_id", "gemini-2.5-flash-native-audio-preview-09-2025")

        # Gemini caps a single connection at ~10 min; reconnect before that, resuming the same
        # session via its handle. The GoAway message remains the reactive backstop.
        self.connection_config = BidiConnectionConfig(**{"restart_after_s": 540, **self.config.get("connection", {})})
        # Gemini reports per-response token deltas, not cumulative session totals.
        self.usage_is_cumulative = False

        self._audio_config = AudioConfig(
            **{
                "input_rate": 16000,
                "output_rate": 24000,
                "channels": 1,
                "format": "pcm",
                **(audio or {}),
            }
        )

        self.config["params"] = dict(self.config.get("params") or {})
        self.config["connection"] = self.connection_config

        self.client_args = dict(client_args or {})
        self._client = genai.Client(**self.client_args)

        # Connection state (initialized in start())
        self._live_session: Any = None
        self._live_session_context_manager: Any = None
        self._live_session_handle: str | None = None
        self._connection_id: str | None = None

    @property
    def audio_config(self) -> AudioConfig:
        """Get the resolved audio configuration."""
        return self._audio_config

    async def start(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **kwargs: Any,
    ) -> None:
        """Establish bidirectional connection with Gemini Live API.

        Args:
            system_prompt: System instructions for the model.
            tools: List of tools available to the model.
            messages: Conversation history to initialize with.
            **kwargs: Additional configuration options.
        """
        if self._connection_id:
            raise RuntimeError("model already started | call stop before starting again")

        # A fresh start (no handle) drops any handle from a prior session; otherwise the next
        # proactive reconnect would resume that conversation into this one. Resume paths pass the
        # handle explicitly and keep it.
        if "live_session_handle" not in kwargs:
            self._live_session_handle = None

        self._connection_id = str(uuid.uuid4())

        # Build live config — only enable initial-history mode when text content exists
        # (tool-only history is dropped by _send_message_history and would leave the server
        # stuck waiting for turn_complete that never arrives)
        has_messages = (
            messages is not None
            and any("text" in block for message in messages for block in message["content"])
            and "live_session_handle" not in kwargs
        )
        live_config = self._build_live_config(system_prompt, tools, has_messages=has_messages, **kwargs)

        # Create the context manager and session
        self._live_session_context_manager = self._client.aio.live.connect(
            model=self.model_id, config=cast(LiveConnectConfigOrDict, live_config)
        )
        self._live_session = await self._live_session_context_manager.__aenter__()

        # Gemini itself restores message history when resuming from session
        if messages and "live_session_handle" not in kwargs:
            await self._send_message_history(messages)

    async def _send_message_history(self, messages: Messages) -> None:
        """Send conversation history to Gemini Live API.

        Collects text content from messages into a list of turns and sends them
        in a single send_client_content call with turn_complete=True to signal
        that history seeding is complete and realtime mode can begin.
        """
        if not messages:
            return

        # Collect all content turns
        turns_to_send: list[genai_types.Content] = []
        for message in messages:
            content_parts = []
            for content_block in message["content"]:
                if "text" in content_block:
                    content_parts.append(genai_types.Part(text=content_block["text"]))

            if content_parts:
                role = "model" if message["role"] == "assistant" else message["role"]
                turns_to_send.append(genai_types.Content(role=role, parts=content_parts))

        if turns_to_send:
            await self._live_session.send_client_content(turns=turns_to_send, turn_complete=True)

    async def receive(self) -> AsyncGenerator[BidiOutputEvent, None]:
        """Receive Gemini Live API events and convert to provider-agnostic format."""
        if not self._connection_id:
            raise RuntimeError("model not started | call start before receiving")

        yield BidiConnectionStartEvent(connection_id=self._connection_id, model=self.model_id)

        # Bind session and turn state to this reader so that after a reconnect swaps
        # self._live_session, a still-draining reader keeps its own closing session and turn state
        # rather than mutating the connection that replaced it.
        session = self._live_session
        turn_state = _TurnState()

        # Wrap in while loop to restart after turn_complete (SDK limitation workaround)
        while True:
            async for message in session.receive():
                for event in self._convert_gemini_live_event(message, turn_state):
                    yield event

    def _convert_gemini_live_event(self, message: LiveServerMessage, turn_state: _TurnState) -> list[BidiOutputEvent]:
        """Convert Gemini Live API events to provider-agnostic format.

        Handles different types of content:

        - inputTranscription: User's speech transcribed to text
        - outputTranscription: Model's audio transcribed to text
        - modelTurn text: Text response from the model
        - usageMetadata: Token usage information

        `usageMetadata` sits outside the `messageType` union, so it can accompany any other field and
        is collected independently of the content events.

        Args:
            message: The Gemini Live server message to convert.
            turn_state: The calling reader's turn bracketing state.

        Returns:
            List of event dicts (empty list if no events to emit).

        Raises:
            BidiModelTimeoutError: If gemini responds with go away message.
        """
        if message.go_away:
            raise BidiModelTimeoutError(
                message.go_away.model_dump_json(), live_session_handle=self._live_session_handle
            )

        events: list[BidiOutputEvent] = []

        if message.session_resumption_update:
            resumption_update = message.session_resumption_update
            if resumption_update.resumable and resumption_update.new_handle:
                self._live_session_handle = resumption_update.new_handle
                logger.debug("session_handle=<%s> | updating gemini session handle", self._live_session_handle)

        if message.server_content:
            events.extend(self._convert_server_content(message.server_content, has_audio=bool(message.data)))

        # Handle audio output using SDK's built-in data property
        if message.data:
            # Convert bytes to base64 string for JSON serializability
            audio_b64 = base64.b64encode(message.data).decode("utf-8")
            events.append(
                BidiAudioStreamEvent(
                    audio=audio_b64,
                    format="pcm",
                    sample_rate=self.audio_config["output_rate"],
                    channels=self.audio_config["channels"],
                )
            )

        if message.tool_call and message.tool_call.function_calls:
            for func_call in message.tool_call.function_calls:
                tool_use_event: ToolUse = {
                    "toolUseId": cast(str, func_call.id),
                    "name": cast(str, func_call.name),
                    "input": func_call.args or {},
                }
                # Create ToolUseStreamEvent for consistency with standard agent
                events.append(
                    ToolUseStreamEvent(
                        delta={
                            "toolUse": {
                                "toolUseId": tool_use_event["toolUseId"],
                                "name": tool_use_event["name"],
                                "input": json.dumps(tool_use_event["input"]),
                            }
                        },
                        current_tool_use=dict(tool_use_event),
                    )
                )

        if message.usage_metadata:
            events.append(self._convert_usage_metadata(message.usage_metadata))

        return self._wrap_turn_events(message, events, turn_state)

    def _wrap_turn_events(
        self, message: LiveServerMessage, events: list[BidiOutputEvent], turn_state: _TurnState
    ) -> list[BidiOutputEvent]:
        """Bracket a turn's content with response start/complete events.

        Gemini has no explicit response-start signal, so a model turn is inferred as open from its
        first model output until ``turn_complete``. This surfaces the turn boundary the agent loop
        needs to align a proactive reconnect (and to know when a swap cut a turn short).

        Args:
            message: The server message being converted.
            events: Content events already derived from ``message``.
            turn_state: The calling reader's turn bracketing state, mutated as the turn opens/closes.

        Returns:
            The content events, prefixed with a response-start when a turn opens and suffixed with
            a response-complete when it closes.
        """
        server_content = message.server_content
        interrupted = bool(server_content and server_content.interrupted)
        turn_complete = bool(server_content and server_content.turn_complete)
        produced_model_output = any(
            isinstance(event, (BidiAudioStreamEvent, ToolUseStreamEvent))
            or (isinstance(event, BidiTranscriptStreamEvent) and event.role == "assistant")
            for event in events
        )

        wrapped: list[BidiOutputEvent] = []
        # An interruption ends a turn, it does not start one, so it never opens a response.
        if produced_model_output and not turn_state.response_open and not interrupted:
            turn_state.response_open = True
            turn_state.response_id = str(uuid.uuid4())
            wrapped.append(BidiResponseStartEvent(response_id=turn_state.response_id))

        wrapped.extend(events)

        if interrupted:
            turn_state.response_open = False
        elif turn_complete and turn_state.response_open:
            wrapped.append(
                BidiResponseCompleteEvent(
                    response_id=turn_state.response_id or str(uuid.uuid4()), stop_reason="complete"
                )
            )
            turn_state.response_open = False
            turn_state.response_id = None

        return wrapped

    def _convert_server_content(self, server_content: LiveServerContent, has_audio: bool) -> list[BidiOutputEvent]:
        """Convert the server content of a Gemini Live message.

        Args:
            server_content: Server content to convert.
            has_audio: Whether the enclosing message carries audio output. Text from `model_turn` is
                skipped when it does, since the two represent the same response in different modalities.

        Returns:
            List of events derived from the server content.
        """
        events: list[BidiOutputEvent] = []

        if server_content.interrupted:
            events.append(BidiInterruptionEvent(reason="user_speech"))

        # Transcriptions arrive independently of other fields and of each other
        input_transcript = server_content.input_transcription
        if input_transcript and input_transcript.text:
            logger.debug("text_length=<%d> | gemini input transcription detected", len(input_transcript.text))
            events.append(
                BidiTranscriptStreamEvent(
                    delta={"text": input_transcript.text},
                    text=input_transcript.text,
                    role="user",
                    # TODO: https://github.com/googleapis/python-genai/issues/1504
                    is_final=bool(input_transcript.finished),
                    current_transcript=input_transcript.text,
                )
            )

        output_transcript = server_content.output_transcription
        if output_transcript and output_transcript.text:
            logger.debug("text_length=<%d> | gemini output transcription detected", len(output_transcript.text))
            events.append(
                BidiTranscriptStreamEvent(
                    delta={"text": output_transcript.text},
                    text=output_transcript.text,
                    role="assistant",
                    # TODO: https://github.com/googleapis/python-genai/issues/1504
                    is_final=bool(output_transcript.finished),
                    current_transcript=output_transcript.text,
                )
            )

        # Reading model_turn parts directly avoids the mixed-content warning raised by message.data
        if not has_audio and server_content.model_turn and server_content.model_turn.parts:
            # Concatenate all text parts (Gemini may send multiple parts)
            text_parts = [part.text for part in server_content.model_turn.parts if part.text]
            if text_parts:
                full_text = " ".join(text_parts)
                events.append(
                    BidiTranscriptStreamEvent(
                        delta={"text": full_text},
                        text=full_text,
                        role="assistant",
                        is_final=True,
                        current_transcript=full_text,
                    )
                )

        return events

    def _convert_usage_metadata(self, usage: UsageMetadata) -> BidiUsageEvent:
        """Convert Gemini usage metadata into a usage event.

        Args:
            usage: Usage metadata reported by Gemini.

        Returns:
            Usage event carrying token counts and per-modality details.
        """
        modality_details: list[dict[str, Any]] = []

        if usage.prompt_tokens_details:
            for detail in usage.prompt_tokens_details:
                if detail.modality and detail.token_count:
                    modality_details.append(
                        {
                            "modality": str(detail.modality).lower(),
                            "input_tokens": detail.token_count,
                            "output_tokens": 0,
                        }
                    )

        if usage.response_tokens_details:
            for detail in usage.response_tokens_details:
                if detail.modality and detail.token_count:
                    # Find or create modality entry
                    modality_str = str(detail.modality).lower()
                    existing = next((m for m in modality_details if m["modality"] == modality_str), None)
                    if existing:
                        existing["output_tokens"] = detail.token_count
                    else:
                        modality_details.append(
                            {"modality": modality_str, "input_tokens": 0, "output_tokens": detail.token_count}
                        )

        return BidiUsageEvent(
            input_tokens=usage.prompt_token_count or 0,
            output_tokens=usage.response_token_count or 0,
            total_tokens=usage.total_token_count or 0,
            modality_details=cast(list[ModalityUsage], modality_details) if modality_details else None,
            cache_read_input_tokens=usage.cached_content_token_count if usage.cached_content_token_count else None,
        )

    async def send(
        self,
        content: BidiInputEvent | ToolResultEvent,
    ) -> None:
        """Unified send method for all content types. Sends the given inputs to the Gemini Live API.

        Dispatches to appropriate internal handler based on content type.

        Args:
            content: Typed event (BidiTextInputEvent, BidiAudioInputEvent, BidiImageInputEvent, or ToolResultEvent).

        Raises:
            ValueError: If content type not supported (e.g., image content).
        """
        if not self._connection_id:
            raise RuntimeError("model not started | call start before sending")

        if isinstance(content, BidiTextInputEvent):
            await self._send_text_content(content.text)
        elif isinstance(content, BidiAudioInputEvent):
            await self._send_audio_content(content)
        elif isinstance(content, BidiImageInputEvent):
            await self._send_image_content(content)
        elif isinstance(content, ToolResultEvent):
            tool_result = content.get("tool_result")
            if tool_result:
                await self._send_tool_result(tool_result)
        else:
            raise ValueError(f"content_type={type(content)} | content not supported")

    async def _send_audio_content(self, audio_input: BidiAudioInputEvent) -> None:
        """Internal: Send audio content using Gemini Live API.

        Gemini Live expects continuous audio streaming via send_realtime_input.
        This automatically triggers VAD and can interrupt ongoing responses.
        """
        # Decode base64 audio to bytes for SDK
        audio_bytes = base64.b64decode(audio_input.audio)

        # Create audio blob for the SDK
        mime_type = f"audio/pcm;rate={self.audio_config['input_rate']}"
        audio_blob = genai_types.Blob(data=audio_bytes, mime_type=mime_type)

        # Send real-time audio input - this automatically handles VAD and interruption
        await self._live_session.send_realtime_input(audio=audio_blob)

    async def _send_image_content(self, image_input: BidiImageInputEvent) -> None:
        """Internal: Send image content using Gemini Live API.

        Sends image frames following the same pattern as the GitHub example.
        Images are sent as base64-encoded data with MIME type.
        """
        # Image is already base64 encoded in the event
        msg = {"mime_type": image_input.mime_type, "data": image_input.image}

        # Send using the same method as the GitHub example
        await self._live_session.send(input=msg)

    async def _send_text_content(self, text: str) -> None:
        """Internal: Send text content using Gemini Live API.

        Uses send_realtime_input for mid-session text input. Turn completion
        is handled by Gemini's automatic activity detection rather than
        explicit turn boundaries. send_client_content is reserved for
        seeding initial history at session start (see _send_message_history).
        """
        await self._live_session.send_realtime_input(text=text)

    async def _send_tool_result(self, tool_result: ToolResult) -> None:
        """Internal: Send tool result using Gemini Live API."""
        tool_use_id = tool_result.get("toolUseId")
        content = tool_result.get("content", [])

        # Validate all content types are supported
        for block in content:
            if "text" not in block and "json" not in block:
                # Unsupported content type - raise error
                raise ValueError(
                    f"tool_use_id=<{tool_use_id}>, content_types=<{list(block.keys())}> | "
                    f"Content type not supported by Gemini Live API"
                )

        # Optimize for single content item - unwrap the array
        if len(content) == 1:
            result_data = cast(dict[str, Any], content[0])
        else:
            # Multiple items - send as array
            result_data = {"result": content}

        # Create function response
        func_response = genai_types.FunctionResponse(
            id=tool_use_id,
            name=tool_use_id,  # Gemini uses name as identifier
            response=result_data,
        )

        # Send tool response
        await self._live_session.send_tool_response(function_responses=[func_response])

    async def stop(self) -> None:
        """Close Gemini Live API connection."""

        async def stop_session() -> None:
            if not self._live_session_context_manager:
                return

            try:
                await self._live_session_context_manager.__aexit__(None, None, None)
            finally:
                # Clear so a second stop() during restart does not
                # re-exit an already-exited context manager.
                self._live_session_context_manager = None
                self._live_session = None

        async def stop_connection() -> None:
            self._connection_id = None

        await stop_all(stop_session, stop_connection)

    async def restart(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **restart_kwargs: Any,
    ) -> None:
        """Restart by closing the connection and resuming the same session via its handle.

        Resumes the Gemini session using the last resumption handle so server-side context
        carries across the swap without replaying history. The handle is supplied by the reactive
        (GoAway) path via ``restart_kwargs`` or read from the tracked handle on the proactive path.
        When no handle is available yet, falls back to a fresh connection with history replay.

        Args:
            system_prompt: System instructions for the resumed connection.
            tools: Tool specifications for the resumed connection.
            messages: Conversation history, replayed only when resuming without a handle.
            **restart_kwargs: Provider restart options; ``live_session_handle`` resumes the session.
        """
        handle = restart_kwargs.pop("live_session_handle", None) or self._live_session_handle
        logger.debug("session_handle=<%s> | gemini restart starting", handle)
        await self.stop()

        if handle is not None and await self._try_resume(system_prompt, tools, handle, **restart_kwargs):
            logger.debug("connection_id=<%s> | gemini restart complete via resume", self._connection_id)
            return

        # No handle, or the server refused it: start fresh and replay history so the conversation
        # continues rather than going silent.
        await self.start(system_prompt, tools, messages, **restart_kwargs)
        logger.debug("connection_id=<%s> | gemini restart complete via fresh session", self._connection_id)

    async def _try_resume(
        self, system_prompt: str | None, tools: list[ToolSpec] | None, handle: str, **restart_kwargs: Any
    ) -> bool:
        """Attempt to resume the session via ``handle``; report whether it succeeded.

        On refusal the handle is dropped (it would fail every retry) and the half-started connection
        torn down, leaving the model ready for a fresh start.

        Args:
            system_prompt: System instructions for the resumed connection.
            tools: Tool specifications for the resumed connection.
            handle: The session resumption handle to resume with.
            **restart_kwargs: Additional provider restart options.

        Returns:
            ``True`` if the session resumed, ``False`` if the handle was refused.
        """
        try:
            await self.start(system_prompt, tools, live_session_handle=handle, **restart_kwargs)
            return True
        except Exception as error:
            logger.warning("error=<%s> | gemini resume failed | falling back to fresh session", error)
            self._live_session_handle = None
            await self._teardown_after_failed_resume()
            return False

    async def _teardown_after_failed_resume(self) -> None:
        """Tear down the half-started connection so the caller can start fresh.

        Best-effort: a failing ``__aexit__`` on the half-entered context manager must not mask the
        resume failure or block the fresh-start fallback (stop() still clears the connection id).
        """
        try:
            await self.stop()
        except Exception as stop_error:
            logger.debug("error=<%s> | teardown after failed resume", stop_error)

    def _build_live_config(
        self, system_prompt: str | None = None, tools: list[ToolSpec] | None = None, **kwargs: Any
    ) -> dict[str, Any]:
        """Build LiveConnectConfig for the official SDK.

        Passes through model params so users can configure Gemini Live API fields directly.
        """
        config_dict = {
            "response_modalities": ["AUDIO"],
            "outputAudioTranscription": {},
            "inputAudioTranscription": {},
            # Sliding-window context compression removes the ~15-min audio-only session cap, so a
            # session resumed across proactive reconnects can continue indefinitely rather than
            # dying at the cap (gemini_session.md).
            "context_window_compression": genai_types.ContextWindowCompressionConfig(
                sliding_window=genai_types.SlidingWindow()
            ),
            **(self.config.get("params") or {}),
        }

        live_session_handle = kwargs.get("live_session_handle")
        config_dict["session_resumption"] = genai_types.SessionResumptionConfig(handle=live_session_handle)

        # Enables send_client_content for initial history seeding before realtime mode.
        # Not supported on Vertex AI; HistoryConfig requires google-genai>=1.67 (floor bump tracked separately).
        has_messages = kwargs.get("has_messages", False)
        if has_messages and getattr(self._client, "vertexai", False) is not True:
            config_dict["history_config"] = genai_types.HistoryConfig(initial_history_in_client_content=True)

        # Add system instruction if provided
        if system_prompt:
            config_dict["system_instruction"] = system_prompt

        # Add tools if provided
        if tools:
            config_dict["tools"] = self._format_tools_for_live_api(tools)

        if "voice" in self.audio_config:
            config_dict.setdefault("speech_config", {}).setdefault("voice_config", {}).setdefault(
                "prebuilt_voice_config", {}
            )["voice_name"] = self.audio_config["voice"]

        return config_dict

    def _format_tools_for_live_api(self, tool_specs: list[ToolSpec]) -> list[genai_types.Tool]:
        """Format tool specs for Gemini Live API."""
        if not tool_specs:
            return []

        return [
            genai_types.Tool(
                function_declarations=[
                    genai_types.FunctionDeclaration(
                        description=tool_spec["description"],
                        name=tool_spec["name"],
                        parameters_json_schema=tool_spec["inputSchema"]["json"],
                    )
                    for tool_spec in tool_specs
                ],
            ),
        ]
