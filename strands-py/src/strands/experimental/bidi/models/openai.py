"""OpenAI Realtime API provider for Strands bidirectional streaming.

Provides real-time audio and text communication through OpenAI's Realtime API
with WebSocket connections, voice activity detection, and function calling.
"""

import asyncio
import base64
import copy
import json
import logging
import os
import time
import uuid
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Any, cast

import websockets
from typing_extensions import Unpack, override
from websockets import ClientConnection

from ....types._events import ToolUseStreamEvent
from ....types.content import Messages, TextBlock
from ....types.media import ImageBlock
from ....types.tools import ToolResultBlock, ToolSpec, ToolUse
from .._async import stop_all
from ..types.content import BidiContentBlock, BidiContentDelta
from ..types.events import (
    BidiAudioDeltaEvent,
    BidiAudioStartEvent,
    BidiAudioStopEvent,
    BidiBargeInEvent,
    BidiConnectionStartEvent,
    BidiOutputEvent,
    BidiResponseStartEvent,
    BidiResponseStopEvent,
    BidiTranscriptDeltaEvent,
    BidiTranscriptStartEvent,
    BidiTranscriptStopEvent,
    BidiUsageEvent,
    ModalityUsage,
    Role,
    StopReason,
)
from ..types.media import AudioDelta
from .configs import (
    AudioConfig,
    AudioStreamConfig,
    ConnectionConfig,
    ModelConfig,
    ModelUpdateConfig,
    _merge_config,
    _validate_audio_config,
    _validate_model_config,
)
from .model import AudioCapable, BidiModel, ConnectionTimeoutError

logger = logging.getLogger(__name__)

# Test idle_timeout_ms

# OpenAI Realtime API configuration
OPENAI_MAX_TIMEOUT_S = 3000  # 50 minutes
"""Max timeout before closing connection.

OpenAI documents a 60 minute limit on realtime sessions
([docs](https://platform.openai.com/docs/guides/realtime-conversations#session-lifecycle-events)). However, OpenAI does
not emit any warnings when approaching the limit. As a workaround, we configure a max timeout client side to gracefully
handle the connection closure. We set the max to 50 minutes to provide enough buffer before hitting the real limit.
"""
# Proactive reconnect fires this many seconds below the reader's reactive timeout, leaving room for
# the turn-boundary alignment wait so a mid-turn swap stays graceful instead of being preempted by
# the reactive timeout firing at the same instant.
OPENAI_PROACTIVE_RECONNECT_MARGIN_S = 300
OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime"
DEFAULT_SAMPLE_RATE = 24000

DEFAULT_SESSION_CONFIG = {
    "type": "realtime",
    "instructions": "You are a helpful assistant. Please speak in English and keep your responses clear and concise.",
    "output_modalities": ["audio"],
    "audio": {
        "input": {
            "format": {"type": "audio/pcm", "rate": DEFAULT_SAMPLE_RATE},
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 500,
            },
        },
        "output": {"format": {"type": "audio/pcm", "rate": DEFAULT_SAMPLE_RATE}},
    },
}

# Sent as a system message after a restart. Replay restores the conversation text but not the
# live audio state, so the fresh session can drift language or re-introduce itself; this steers it
# to continue seamlessly.
_RESTART_INSTRUCTION = (
    "The connection was re-established mid-conversation. Continue seamlessly from the prior "
    "context: do not greet or re-introduce yourself, and keep replying in the language already in use."
)


@dataclass
class _SessionState:
    """Connection-local transcript identities and response creation state."""

    started_transcripts: set[str] = field(default_factory=set)
    assistant_parts: dict[str, tuple[str, int]] = field(default_factory=dict)
    audio_responses: set[str | None] = field(default_factory=set)
    active_responses: set[str] = field(default_factory=set)
    pending_tools: set[str] = field(default_factory=set)
    response_pending: bool = False
    response_requested: bool = False
    transcription_enabled: bool = True
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def start_audio(self, response_id: str | None) -> list[BidiOutputEvent]:
        """Open an audio stream before its first chunk."""
        if response_id in self.audio_responses:
            return []
        self.audio_responses.add(response_id)
        return [BidiAudioStartEvent()]

    def stop_audio(self, response_id: str | None) -> list[BidiOutputEvent]:
        """Close an open audio stream once."""
        if response_id not in self.audio_responses:
            return []
        self.audio_responses.remove(response_id)
        return [BidiAudioStopEvent()]

    def start_transcript(self, role: Role, content_id: str) -> list[BidiOutputEvent]:
        """Open a transcript once, when speech or its first text arrives."""
        if content_id in self.started_transcripts:
            return []
        self.started_transcripts.add(content_id)
        return [BidiTranscriptStartEvent(role, content_id=content_id)]

    def transcript_events(self, event: BidiTranscriptDeltaEvent | BidiTranscriptStopEvent) -> list[BidiOutputEvent]:
        """Ensure the transcript starts before emitting its delta or stop."""
        events = [*self.start_transcript(event.role, event.content_id), event]
        if isinstance(event, BidiTranscriptStopEvent):
            self.started_transcripts.remove(event.content_id)
        return events


class OpenAIRealtimeModel(BidiModel, AudioCapable):
    """OpenAI Realtime API implementation for bidirectional streaming.

    Combines model configuration and connection state in a single class.
    Manages WebSocket connection to OpenAI's Realtime API with automatic VAD,
    function calling, and event conversion to Strands format.
    """

    _websocket: ClientConnection
    _start_time: int

    def __init__(
        self,
        *,
        transcription_model_id: str | None,
        api_key: str | None = None,
        organization: str | None = None,
        project: str | None = None,
        timeout_s: int = OPENAI_MAX_TIMEOUT_S,
        voice: str = "alloy",
        **model_config: Unpack[ModelConfig],
    ) -> None:
        """Initialize OpenAI Realtime bidirectional model.

        Args:
            transcription_model_id: Input transcription model identifier. Pass ``None`` to disable user transcription.
            api_key: OpenAI API key. Defaults to ``OPENAI_API_KEY``.
            organization: OpenAI organization. Defaults to ``OPENAI_ORGANIZATION``.
            project: OpenAI project. Defaults to ``OPENAI_PROJECT``.
            timeout_s: Maximum connection duration in seconds.
            voice: Output voice identifier. Defaults to ``alloy``.
            **model_config: Model configuration.

        Raises:
            ValueError: If any of the following conditions apply:

                - Required model configuration fields are missing.
                - ``model_id`` is not a non-empty string.
                - The API key is missing.
                - ``timeout_s`` exceeds the maximum.
                - The configured audio formats are unsupported.
        """
        _validate_model_config(model_config)
        self._config = ModelConfig(**model_config)
        self._config["params"] = dict(self._config.get("params") or {})

        # OpenAI reports per-response token usage on response.done, not cumulative session totals.
        self.usage_is_cumulative = False

        self.api_key = api_key if api_key is not None else os.getenv("OPENAI_API_KEY")
        if not self.api_key:
            raise ValueError(
                "OpenAI API key is required. Provide via api_key or set OPENAI_API_KEY environment variable."
            )

        self.organization = organization if organization is not None else os.getenv("OPENAI_ORGANIZATION")
        self.project = project if project is not None else os.getenv("OPENAI_PROJECT")
        self.timeout_s = timeout_s
        if timeout_s > OPENAI_MAX_TIMEOUT_S:
            raise ValueError(
                f"timeout_s=<{timeout_s}>, max_timeout_s=<{OPENAI_MAX_TIMEOUT_S}> | timeout exceeds max limit"
            )

        # OpenAI emits no approaching-limit warning, so reconnect proactively a margin below the
        # reader's reactive timeout: the swap can then align to a turn boundary before the reactive
        # path fires. Deriving from timeout_s keeps that headroom when a caller lowers it.
        self._config["connection"] = ConnectionConfig(
            **{
                "restart_after_s": timeout_s - OPENAI_PROACTIVE_RECONNECT_MARGIN_S,
                **self._config.get("connection", {}),
            }
        )

        self._transcription_model_id = transcription_model_id
        self._voice = voice
        self._resolve_audio_config(self._config.get("params"))

        # Connection state (initialized in start())
        self._connection_id: str | None = None

        self._function_call_buffer: dict[str, Any] = {}
        self._session_state = _SessionState()

        logger.debug("model=<%s> | openai realtime model initialized", self._config["model_id"])

    @override
    def update_config(self, **model_config: Unpack[ModelUpdateConfig]) -> None:  # type: ignore[override]
        """Update the model configuration with the provided arguments.

        Args:
            **model_config: Configuration overrides.

        Raises:
            ValueError: If any of the following conditions apply:

                - The resulting configuration is missing required fields.
                - ``model_id`` is not a non-empty string.
                - The configured audio formats are unsupported.
        """
        _validate_model_config(self._config | model_config)
        if "params" in model_config:
            self._resolve_audio_config(model_config["params"])
        self._config.update(model_config)

    @override
    def get_config(self) -> ModelConfig:
        """Return the model configuration by reference."""
        return self._config

    @override
    def get_audio_config(self) -> AudioConfig:
        """Get the resolved audio configuration."""
        return self._audio_config

    def _resolve_audio_config(self, params: dict[str, Any] | None) -> None:
        """Resolve audio settings and validate native format overrides."""
        audio = (params or {}).get("audio", {})
        for direction in ("input", "output"):
            stream = audio.get(direction, {})
            audio_format = stream.get("format", {})

            format_type = audio_format.get("type", "audio/pcm")
            if format_type != "audio/pcm":
                raise ValueError(f"Unsupported audio format: {format_type}. Expected audio/pcm.")

            sample_rate = audio_format.get("rate", DEFAULT_SAMPLE_RATE)
            if sample_rate != DEFAULT_SAMPLE_RATE:
                raise ValueError(f"Unsupported sample rate: {sample_rate}. Expected {DEFAULT_SAMPLE_RATE}.")

        self._audio_config = AudioConfig(
            input=AudioStreamConfig(sample_rate=DEFAULT_SAMPLE_RATE, channels=1, format="pcm"),
            output=AudioStreamConfig(sample_rate=DEFAULT_SAMPLE_RATE, channels=1, format="pcm"),
        )
        _validate_audio_config(self._audio_config)

    async def start(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **kwargs: Any,
    ) -> None:
        """Establish bidirectional connection to OpenAI Realtime API.

        Args:
            system_prompt: System instructions for the model.
            tools: List of tools available to the model.
            messages: Conversation history to initialize with.
            **kwargs: Additional configuration options.
        """
        if self._connection_id:
            raise RuntimeError("model already started | call stop before starting again")

        logger.debug("openai realtime connection starting")

        # Initialize connection state
        self._connection_id = str(uuid.uuid4())
        self._start_time = int(time.time())

        self._function_call_buffer = {}
        self._session_state = _SessionState()

        # Establish WebSocket connection
        url = f"{OPENAI_REALTIME_URL}?model={self._config['model_id']}"

        headers = [("Authorization", f"Bearer {self.api_key}")]
        if self.organization:
            headers.append(("OpenAI-Organization", self.organization))
        if self.project:
            headers.append(("OpenAI-Project", self.project))

        self._websocket = await websockets.connect(url, additional_headers=headers)
        logger.debug("connection_id=<%s> | websocket connected successfully", self._connection_id)

        # Configure session
        session_config = self._build_session_config(system_prompt, tools)
        self._session_state.transcription_enabled = session_config["audio"]["input"].get("transcription") is not None
        await self._send_event({"type": "session.update", "session": session_config})

        # Add conversation history if provided
        if messages:
            await self._add_conversation_history(messages)

    def _build_session_config(self, system_prompt: str | None, tools: list[ToolSpec] | None) -> dict[str, Any]:
        """Build session configuration for OpenAI Realtime API.

        Model params recursively override defaults and directly supplied options.
        """
        config: dict[str, Any] = copy.deepcopy(DEFAULT_SESSION_CONFIG)

        if system_prompt:
            config["instructions"] = system_prompt

        if tools:
            config["tools"] = self._convert_tools_to_openai_format(tools)

        config["audio"]["input"]["transcription"] = (
            {"model": self._transcription_model_id} if self._transcription_model_id is not None else None
        )
        config["audio"]["output"]["voice"] = self._voice

        return _merge_config(config, self._config.get("params") or {})

    def _convert_tools_to_openai_format(self, tools: list[ToolSpec]) -> list[dict]:
        """Convert Strands tool specifications to OpenAI Realtime API format."""
        openai_tools = []

        for tool in tools:
            input_schema = tool["inputSchema"]
            if "json" in input_schema:
                schema = (
                    json.loads(input_schema["json"]) if isinstance(input_schema["json"], str) else input_schema["json"]
                )
            else:
                schema = input_schema

            # OpenAI Realtime API expects flat structure, not nested under "function"
            openai_tool = {
                "type": "function",
                "name": tool["name"],
                "description": tool["description"],
                "parameters": schema,
            }
            openai_tools.append(openai_tool)

        return openai_tools

    async def _add_conversation_history(self, messages: Messages) -> None:
        """Add conversation history to the session.

        Converts agent message history to OpenAI Realtime API format using
        conversation.item.create events for each message.

        Note: OpenAI Realtime API has a 32-character limit on call_id, so we truncate
        UUIDs consistently to ensure tool calls and their results match.

        Args:
            messages: List of conversation messages with role and content.
        """
        # Track tool call IDs to ensure consistency between calls and results
        call_id_map: dict[str, str] = {}

        # First pass: collect all tool call IDs
        for message in messages:
            for block in message.get("content", []):
                if "toolUse" in block:
                    tool_use = block["toolUse"]
                    original_id = tool_use["toolUseId"]
                    call_id = original_id[:32]
                    call_id_map[original_id] = call_id

        # Second pass: send messages
        for message in messages:
            role = message["role"]
            content_blocks = message.get("content", [])

            # Build content array for OpenAI format
            openai_content = []

            for block in content_blocks:
                if "text" in block:
                    # Text content - use appropriate type based on role
                    # User messages use "input_text", assistant messages use "output_text"
                    if role == "user":
                        openai_content.append({"type": "input_text", "text": block["text"]})
                    else:  # assistant
                        openai_content.append({"type": "output_text", "text": block["text"]})
                elif "toolUse" in block:
                    # Tool use - create as function_call item
                    tool_use = block["toolUse"]
                    original_id = tool_use["toolUseId"]
                    # Use pre-mapped call_id
                    call_id = call_id_map[original_id]

                    tool_item = {
                        "type": "conversation.item.create",
                        "item": {
                            "type": "function_call",
                            "call_id": call_id,
                            "name": tool_use["name"],
                            "arguments": json.dumps(tool_use["input"]),
                        },
                    }
                    await self._send_event(tool_item)
                    continue  # Tool use is sent separately, not in message content
                elif "toolResult" in block:
                    # Tool result - create as function_call_output item
                    tool_result = block["toolResult"]
                    original_id = tool_result["toolUseId"]

                    # Validate content types and serialize, preserving structure
                    result_output = ""
                    if "content" in tool_result:
                        # First validate all content types are supported
                        for result_block in tool_result["content"]:
                            if "text" not in result_block and "json" not in result_block:
                                # Unsupported content type - raise error
                                raise ValueError(
                                    f"tool_use_id=<{original_id}>, content_types=<{list(result_block.keys())}> | "
                                    f"Content type not supported by OpenAI Realtime API"
                                )

                        # Preserve structure by JSON-dumping the entire content array
                        result_output = json.dumps(tool_result["content"])

                    # Use mapped call_id if available, otherwise skip orphaned result
                    if original_id not in call_id_map:
                        continue  # Skip this tool result since we don't have the call

                    call_id = call_id_map[original_id]

                    result_item = {
                        "type": "conversation.item.create",
                        "item": {
                            "type": "function_call_output",
                            "call_id": call_id,
                            "output": result_output,
                        },
                    }
                    await self._send_event(result_item)
                    continue  # Tool result is sent separately, not in message content

            # Only create message item if there's text content
            if openai_content:
                conversation_item = {
                    "type": "conversation.item.create",
                    "item": {"type": "message", "role": role, "content": openai_content},
                }
                await self._send_event(conversation_item)

        logger.debug("message_count=<%d> | conversation history added to openai session", len(messages))

    async def receive(self) -> AsyncGenerator[BidiOutputEvent, None]:
        """Receive OpenAI events and convert to Strands TypedEvent format."""
        if not self._connection_id:
            raise RuntimeError("model not started | call start before receiving")

        yield BidiConnectionStartEvent(connection_id=self._connection_id, model=self._config["model_id"])

        # Bind this reader to the connection it started on. After a reconnect swaps self._websocket,
        # a still-draining superseded reader keeps reading its own (now-closed) socket rather than
        # stealing messages from the connection that replaced it.
        websocket = self._websocket
        start_time = self._start_time
        state = self._session_state

        while True:
            duration = time.time() - start_time
            if duration >= self.timeout_s:
                raise ConnectionTimeoutError(f"timeout_s=<{self.timeout_s}>")

            try:
                message = await asyncio.wait_for(websocket.recv(), timeout=10)
            except asyncio.TimeoutError:
                continue

            openai_event = json.loads(message)
            event_type = openai_event.get("type")
            if event_type == "response.created":
                response_id = openai_event["response"]["id"]
                if response_id in state.active_responses:
                    continue
                state.active_responses.add(response_id)
                state.response_requested = False
            elif event_type == "response.done":
                response_id = openai_event["response"]["id"]
                if response_id not in state.active_responses:
                    continue
                state.active_responses.remove(response_id)

            if event_type == "error" and openai_event.get("error", {}).get("code") == (
                "conversation_already_has_active_response"
            ):
                state.response_requested = False
                state.response_pending = True
                continue

            for event in self._convert_openai_event(openai_event, state) or []:
                if isinstance(event, ToolUseStreamEvent):
                    state.pending_tools.add(event["current_tool_use"]["toolUseId"])
                yield event
            if state is self._session_state and event_type == "response.done":
                await self._flush_response_request(state)

    def _convert_openai_event(
        self, openai_event: dict[str, Any], state: _SessionState | None = None
    ) -> list[BidiOutputEvent] | None:
        """Convert OpenAI events to Strands TypedEvent format."""
        event_type = openai_event.get("type")
        state = state if state is not None else self._session_state

        if event_type == "input_audio_buffer.speech_started":
            events: list[BidiOutputEvent] = [BidiBargeInEvent(reason="user_speech")]
            if state.transcription_enabled:
                events.extend(state.start_transcript("user", openai_event["item_id"]))
            return events

        input_id = None
        if event_type == "input_audio_buffer.committed" and state.transcription_enabled:
            input_id = openai_event.get("item_id")
        elif event_type == "conversation.item.added" and openai_event.get("item", {}).get("role") == "user":
            item = openai_event["item"]
            is_audio = any(content.get("type") == "input_audio" for content in item.get("content", []))
            if state.transcription_enabled and is_audio:
                input_id = item["id"]
        if input_id is not None:
            return state.start_transcript("user", input_id) or None

        if event_type == "response.created":
            response = openai_event.get("response", {})
            response_id = response.get("id", str(uuid.uuid4()))
            return [BidiResponseStartEvent(response_id=response_id)]

        if event_type == "response.content_part.added" and openai_event.get("part", {}).get("type") == "audio":
            return state.start_audio(openai_event.get("response_id")) or None

        if event_type == "response.output_audio.delta":
            return [
                *state.start_audio(openai_event.get("response_id")),
                BidiAudioDeltaEvent(
                    audio=openai_event["delta"],
                    **self._audio_config["output"],
                ),
            ]

        if event_type == "response.output_audio.done":
            return state.stop_audio(openai_event.get("response_id")) or None

        if event_type in ("response.output_text.delta", "response.output_audio_transcript.delta"):
            text = openai_event.get("delta", "")
            if not text:
                return None
            response_id = openai_event["response_id"]
            part_id = (openai_event["item_id"], openai_event["content_index"])
            previous_part = state.assistant_parts.get(response_id)
            if previous_part is not None and previous_part != part_id:
                text = "\n\n" + text
            state.assistant_parts[response_id] = part_id
            return state.transcript_events(BidiTranscriptDeltaEvent(text, "assistant", content_id=response_id))

        if event_type in ("response.output_text.done", "response.output_audio_transcript.done"):
            # Response completion closes the combined assistant transcript.
            return None

        if event_type in (
            "conversation.item.input_audio_transcription.delta",
            "conversation.item.input_audio_transcription.segment",
        ):
            if event_type == "conversation.item.input_audio_transcription.segment":
                segment = openai_event.get("segment", {})
                text = segment.get("text", "")
                role = cast(Role, segment.get("role", "user"))
            else:
                text = openai_event.get("delta", "")
                role = "user"
            if not text:
                return None
            return state.transcript_events(BidiTranscriptDeltaEvent(text, role, content_id=openai_event["item_id"]))

        if event_type == "conversation.item.input_audio_transcription.completed":
            return state.transcript_events(
                BidiTranscriptStopEvent(openai_event["transcript"], "user", content_id=openai_event["item_id"])
            )

        if event_type == "conversation.item.input_audio_transcription.failed":
            error_info = openai_event.get("error", {})
            raise RuntimeError(error_info.get("message", "Transcription failed."))

        if event_type == "response.function_call_arguments.delta":
            call_id = openai_event.get("call_id")
            delta = openai_event.get("delta", "")
            if call_id:
                if call_id not in self._function_call_buffer:
                    self._function_call_buffer[call_id] = {"call_id": call_id, "name": "", "arguments": delta}
                else:
                    self._function_call_buffer[call_id]["arguments"] += delta
            return None

        if event_type == "response.function_call_arguments.done":
            call_id = openai_event.get("call_id")
            if call_id and call_id in self._function_call_buffer:
                function_call = self._function_call_buffer[call_id]
                try:
                    tool_use: ToolUse = {
                        "toolUseId": call_id,
                        "name": function_call["name"],
                        "input": json.loads(function_call["arguments"]) if function_call["arguments"] else {},
                    }
                    del self._function_call_buffer[call_id]
                    # Return ToolUseStreamEvent for consistency with standard agent
                    return [
                        ToolUseStreamEvent(
                            delta={
                                "toolUse": {
                                    "toolUseId": tool_use["toolUseId"],
                                    "name": tool_use["name"],
                                    "input": json.dumps(tool_use["input"]),
                                }
                            },
                            current_tool_use=dict(tool_use),
                        )
                    ]
                except (json.JSONDecodeError, KeyError) as error:
                    logger.warning("call_id=<%s>, error=<%s> | error parsing function arguments", call_id, error)
                    del self._function_call_buffer[call_id]
            return None

        if event_type == "response.done":
            return self._complete_response(openai_event.get("response", {}), state)

        if event_type in ("conversation.item.retrieve", "conversation.item.added"):
            item = openai_event.get("item", {})
            action = "retrieved" if "retrieve" in event_type else "added"
            logger.debug("action=<%s>, item_id=<%s> | openai conversation item event", action, item.get("id"))
            return None

        if event_type == "conversation.item.done":
            logger.debug("item_id=<%s> | openai conversation item done", openai_event.get("item", {}).get("id"))
            return None

        if event_type in (
            "response.output_item.added",
            "response.output_item.done",
            "response.content_part.added",
            "response.content_part.done",
        ):
            item_data = openai_event.get("item") or openai_event.get("part")
            logger.debug(
                "event_type=<%s>, item_id=<%s> | openai output event",
                event_type,
                item_data.get("id") if item_data else "unknown",
            )

            # Track function call names from response.output_item.added
            if event_type == "response.output_item.added":
                item = openai_event.get("item", {})
                if item.get("type") == "function_call":
                    call_id = item.get("call_id")
                    function_name = item.get("name")
                    if call_id and function_name:
                        if call_id not in self._function_call_buffer:
                            self._function_call_buffer[call_id] = {
                                "call_id": call_id,
                                "name": function_name,
                                "arguments": "",
                            }
                        else:
                            self._function_call_buffer[call_id]["name"] = function_name
            return None

        if event_type in (
            "input_audio_buffer.committed",
            "input_audio_buffer.cleared",
            "session.created",
            "session.updated",
        ):
            logger.debug("event_type=<%s> | openai event received", event_type)
            return None

        if event_type == "error":
            error_data = openai_event.get("error", {})
            error_code = error_data.get("code", "")

            # Suppress expected errors that don't affect session state
            if error_code == "response_cancel_not_active":
                # This happens when trying to cancel a response that's not active
                # It's safe to ignore as the session remains functional
                logger.debug("openai response cancel attempted when no response active")
                return None

            # Log other errors
            logger.error("error=<%s> | openai realtime error", error_data)
            return None

        logger.debug("event_type=<%s> | unhandled openai event type", event_type)
        return None

    def _complete_response(self, response: dict[str, Any], state: _SessionState) -> list[BidiOutputEvent]:
        """Close audio and the combined assistant transcript before stopping the response."""
        response_id = response.get("id", "unknown")
        output = response.get("output", [])
        events = state.stop_audio(response.get("id"))
        transcript_parts = [
            part.get("transcript", part.get("text", ""))
            for item in output
            if item.get("type") == "message" and item.get("role") == "assistant"
            for part in item.get("content", [])
            if part.get("type") in ("output_audio", "output_text")
        ]
        if transcript_parts or response_id in state.assistant_parts:
            events.extend(
                state.transcript_events(
                    BidiTranscriptStopEvent("\n\n".join(transcript_parts), "assistant", content_id=response_id)
                )
            )
        state.assistant_parts.pop(response_id, None)

        has_tool_use = any(item.get("type") == "function_call" for item in output)
        stop_reasons: dict[str, StopReason] = {
            "completed": "tool_use" if has_tool_use else "end_turn",
            "cancelled": "barge_in",
            "failed": "error",
            "incomplete": "barge_in",
        }
        stop_reason = stop_reasons.get(response.get("status", "completed"), "end_turn")
        events.append(BidiResponseStopEvent(response_id=response_id, stop_reason=stop_reason))

        if usage := response.get("usage"):
            events.append(self._convert_usage_metadata(usage))
        return events

    def _convert_usage_metadata(self, usage: dict[str, Any]) -> BidiUsageEvent:
        """Convert response token counts and modality details into a usage event."""
        input_details = usage.get("input_token_details", {})
        output_details = usage.get("output_token_details", {})
        modality_details: list[dict[str, Any]] = []
        for modality in ("text", "audio"):
            input_tokens = input_details.get(f"{modality}_tokens", 0)
            output_tokens = output_details.get(f"{modality}_tokens", 0)
            if input_tokens > 0 or output_tokens > 0:
                modality_details.append(
                    {"modality": modality, "input_tokens": input_tokens, "output_tokens": output_tokens}
                )

        image_tokens = input_details.get("image_tokens", 0)
        if image_tokens > 0:
            modality_details.append({"modality": "image", "input_tokens": image_tokens, "output_tokens": 0})

        cached_tokens = input_details.get("cached_tokens", 0)
        return BidiUsageEvent(
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            total_tokens=usage.get("total_tokens", 0),
            modality_details=cast(list[ModalityUsage], modality_details) if modality_details else None,
            cache_read_input_tokens=cached_tokens if cached_tokens > 0 else None,
        )

    async def send(
        self,
        content: BidiContentBlock | BidiContentDelta | ToolResultBlock,
    ) -> None:
        """Unified send method for all content types. Sends the given content to OpenAI.

        Dispatches to appropriate internal handler based on content type.

        Args:
            content: A TextBlock, AudioDelta, ImageBlock, or ToolResultBlock.

        Raises:
            ValueError: If content type not supported.
        """
        if not self._connection_id:
            raise RuntimeError("model not started | call start before sending")

        if isinstance(content, TextBlock):
            await self._send_text_content(content.text)
        elif isinstance(content, AudioDelta):
            await self._send_audio_content(content)
        elif isinstance(content, ImageBlock):
            await self._send_image_content(content)
        elif isinstance(content, ToolResultBlock):
            await self._send_tool_result(content)
        else:
            raise ValueError(f"content_type={type(content)} | content not supported")

    async def _send_audio_content(self, audio_input: AudioDelta) -> None:
        """Internal: Send audio content to OpenAI for processing."""
        audio_bytes = audio_input.source.get("bytes")
        if audio_bytes is None:
            raise ValueError("audio source must contain bytes for OpenAI Realtime")
        audio = base64.b64encode(audio_bytes).decode("utf-8")
        await self._send_event({"type": "input_audio_buffer.append", "audio": audio})

    async def _send_image_content(self, image_input: ImageBlock) -> None:
        """Internal: Send image content to OpenAI for processing.

        Image data is encoded as a ``data:`` URL using the image format and base64
        payload, matching OpenAI's Realtime API image input format.
        """
        image_bytes = image_input.source.get("bytes")
        if image_bytes is None:
            raise ValueError("image source must contain bytes for OpenAI Realtime")
        image = base64.b64encode(image_bytes).decode("utf-8")
        data_url = f"data:image/{image_input.format};base64,{image}"
        item_data = {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_image", "image_url": data_url}],
        }
        await self._send_event({"type": "conversation.item.create", "item": item_data})

    async def _send_text_content(self, text: str) -> None:
        """Internal: Send text content to OpenAI for processing."""
        item_data = {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}
        await self._send_event({"type": "conversation.item.create", "item": item_data})
        await self._request_response()

    async def _send_tool_result(self, tool_result: ToolResultBlock) -> None:
        """Internal: Send tool result back to OpenAI."""
        tool_use_id = tool_result.tool_use_id

        logger.debug("tool_use_id=<%s> | sending openai tool result", tool_use_id)

        # Validate content types and serialize, preserving structure
        for block in tool_result.content:
            if "text" not in block and "json" not in block:
                # Unsupported content type - raise error
                raise ValueError(
                    f"tool_use_id=<{tool_use_id}>, content_types=<{list(block.keys())}> | "
                    f"Content type not supported by OpenAI Realtime API"
                )

        # Preserve structure by JSON-dumping the entire content array
        result_output = json.dumps(tool_result.content)

        item_data = {"type": "function_call_output", "call_id": tool_use_id, "output": result_output}
        await self._send_event({"type": "conversation.item.create", "item": item_data})
        self._session_state.pending_tools.discard(tool_use_id)
        await self._request_response()

    async def _request_response(self) -> None:
        """Coalesce continuation requests while a native response or tool group is active."""
        state = self._session_state
        state.response_pending = True
        await self._flush_response_request(state)

    async def _flush_response_request(self, state: _SessionState) -> None:
        async with state.lock:
            if not state.response_pending or state.response_requested or state.active_responses or state.pending_tools:
                return
            state.response_pending = False
            state.response_requested = True
            try:
                await self._send_event({"type": "response.create"})
            except BaseException:
                state.response_requested = False
                state.response_pending = True
                raise

    async def stop(self) -> None:
        """Close session and cleanup resources."""
        logger.debug("openai realtime connection cleanup starting")

        async def stop_websocket() -> None:
            if not hasattr(self, "_websocket"):
                return

            await self._websocket.close()

        async def stop_connection() -> None:
            self._connection_id = None

        await stop_all(stop_websocket, stop_connection)

        logger.debug("openai realtime connection closed")

    async def restart(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **restart_kwargs: Any,
    ) -> None:
        """Restart by closing the connection and starting a new one, replaying history.

        OpenAI's Realtime API exposes no server-side resume handle, so a restart re-establishes
        the session and replays the accumulated conversation history to preserve context across the
        swap.

        Args:
            system_prompt: System instructions for the new connection.
            tools: Tool specifications for the new connection.
            messages: Conversation history to replay into the new connection.
            **restart_kwargs: Reserved for provider-specific restart options.
        """
        logger.debug("openai realtime restart starting")
        await self.stop()
        await self.start(system_prompt, tools, messages, **restart_kwargs)
        # Re-anchor the fresh session so it continues the conversation rather than drifting. This is
        # a best-effort nudge: if the send fails, the connection is still healthy, so log and move on
        # rather than let a failed nudge tear down the session.
        try:
            await self._send_event(
                {
                    "type": "conversation.item.create",
                    "item": {
                        "type": "message",
                        "role": "system",
                        "content": [{"type": "input_text", "text": _RESTART_INSTRUCTION}],
                    },
                }
            )
        except Exception as error:
            logger.warning("error=<%s> | failed to send restart re-anchor message | continuing", error)
        logger.debug("connection_id=<%s> | openai realtime restart complete", self._connection_id)

    async def _send_event(self, event: dict[str, Any]) -> None:
        """Send event to OpenAI via WebSocket."""
        message = json.dumps(event)
        await self._websocket.send(message)
        logger.debug("event_type=<%s> | openai event sent", event.get("type"))
