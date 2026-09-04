"""OpenAI Realtime API provider for Strands bidirectional streaming.

Provides real-time audio and text communication through OpenAI's Realtime API
with WebSocket connections, voice activity detection, and function calling.
"""

import asyncio
import copy
import json
import logging
import os
import time
import uuid
from collections.abc import AsyncGenerator
from typing import Any, cast

import websockets
from typing_extensions import Unpack
from websockets import ClientConnection

from ....models._validation import validate_config_keys
from ....types._events import ToolResultEvent, ToolUseStreamEvent
from ....types.content import Messages
from ....types.tools import ToolResult, ToolSpec, ToolUse
from .._async import stop_all
from ..types.events import (
    AudioSampleRate,
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
    Role,
    StopReason,
)
from ..types.model import AudioConfig, BidiConnectionConfig
from .model import AudioCapable, BidiModel, BidiModelConfig, BidiModelTimeoutError

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
DEFAULT_MODEL = "gpt-realtime"
DEFAULT_SAMPLE_RATE = 24000

DEFAULT_SESSION_CONFIG = {
    "type": "realtime",
    "instructions": "You are a helpful assistant. Please speak in English and keep your responses clear and concise.",
    "output_modalities": ["audio"],
    "audio": {
        "input": {
            "format": {"type": "audio/pcm", "rate": DEFAULT_SAMPLE_RATE},
            "transcription": {"model": "gpt-4o-transcribe"},
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 500,
            },
        },
        "output": {"format": {"type": "audio/pcm", "rate": DEFAULT_SAMPLE_RATE}, "voice": "alloy"},
    },
}

# Sent as a system message after a restart. Replay restores the conversation text but not the
# live audio state, so the fresh session can drift language or re-introduce itself; this steers it
# to continue seamlessly.
_RESTART_INSTRUCTION = (
    "The connection was re-established mid-conversation. Continue seamlessly from the prior "
    "context: do not greet or re-introduce yourself, and keep replying in the language already in use."
)


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
        api_key: str | None = None,
        organization: str | None = None,
        project: str | None = None,
        timeout_s: int = OPENAI_MAX_TIMEOUT_S,
        audio: AudioConfig | None = None,
        **model_config: Unpack[BidiModelConfig],
    ) -> None:
        """Initialize OpenAI Realtime bidirectional model.

        Args:
            api_key: OpenAI API key. Defaults to ``OPENAI_API_KEY``.
            organization: OpenAI organization. Defaults to ``OPENAI_ORGANIZATION``.
            project: OpenAI project. Defaults to ``OPENAI_PROJECT``.
            timeout_s: Maximum connection duration in seconds.
            audio: Audio configuration.
            **model_config: Model configuration.

        Raises:
            ValueError: If the API key is missing or ``timeout_s`` exceeds the maximum.
        """
        validate_config_keys(model_config, BidiModelConfig)
        self.config = BidiModelConfig(**model_config)
        self.model_id = self.config.setdefault("model_id", DEFAULT_MODEL)

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
        self.connection_config = BidiConnectionConfig(
            **{
                "restart_after_s": timeout_s - OPENAI_PROACTIVE_RECONNECT_MARGIN_S,
                **self.config.get("connection", {}),
            }
        )

        self._audio_config = AudioConfig(
            **{
                "input_rate": cast(AudioSampleRate, DEFAULT_SAMPLE_RATE),
                "output_rate": cast(AudioSampleRate, DEFAULT_SAMPLE_RATE),
                "channels": 1,
                "format": "pcm",
                "voice": "alloy",
                **(audio or {}),
            }
        )
        self.config["params"] = dict(self.config.get("params") or {})
        self.config["connection"] = self.connection_config

        # Connection state (initialized in start())
        self._connection_id: str | None = None

        self._function_call_buffer: dict[str, Any] = {}

        logger.debug("model=<%s> | openai realtime model initialized", self.model_id)

    @property
    def audio_config(self) -> AudioConfig:
        """Get the resolved audio configuration."""
        return self._audio_config

    def _merge_audio_config(self, config: dict[str, Any], overrides: dict[str, Any]) -> None:
        """Merge audio overrides while preserving nested defaults."""
        for key, value in overrides.items():
            if isinstance(config.get(key), dict) and isinstance(value, dict):
                self._merge_audio_config(config[key], value)
            else:
                config[key] = value

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

        # Establish WebSocket connection
        url = f"{OPENAI_REALTIME_URL}?model={self.model_id}"

        headers = [("Authorization", f"Bearer {self.api_key}")]
        if self.organization:
            headers.append(("OpenAI-Organization", self.organization))
        if self.project:
            headers.append(("OpenAI-Project", self.project))

        self._websocket = await websockets.connect(url, additional_headers=headers)
        logger.debug("connection_id=<%s> | websocket connected successfully", self._connection_id)

        # Configure session
        session_config = self._build_session_config(system_prompt, tools)
        await self._send_event({"type": "session.update", "session": session_config})

        # Add conversation history if provided
        if messages:
            await self._add_conversation_history(messages)

    def _create_text_event(self, text: str, role: str, is_final: bool = True) -> BidiTranscriptStreamEvent:
        """Create standardized transcript event.

        Args:
            text: The transcript text
            role: The raw provider role (normalized by the event constructor)
            is_final: Whether this is the final transcript
        """
        return BidiTranscriptStreamEvent(
            delta={"text": text},
            text=text,
            role=cast(Role, role),
            is_final=is_final,
            current_transcript=text if is_final else None,
        )

    def _create_voice_activity_event(self, activity_type: str) -> BidiInterruptionEvent | None:
        """Create standardized interruption event for voice activity."""
        # Only speech_started triggers interruption
        if activity_type == "speech_started":
            return BidiInterruptionEvent(reason="user_speech")
        # Other voice activity events are logged but don't create events
        return None

    def _build_session_config(self, system_prompt: str | None, tools: list[ToolSpec] | None) -> dict[str, Any]:
        """Build session configuration for OpenAI Realtime API."""
        config: dict[str, Any] = copy.deepcopy(DEFAULT_SESSION_CONFIG)
        params = copy.deepcopy(self.config.get("params") or {})
        audio_params = params.pop("audio", {})
        config.update(params)
        self._merge_audio_config(config["audio"], audio_params)

        if system_prompt:
            config["instructions"] = system_prompt

        if tools:
            config["tools"] = self._convert_tools_to_openai_format(tools)

        audio_config = self.audio_config

        if "voice" in audio_config:
            config.setdefault("audio", {}).setdefault("output", {})["voice"] = audio_config["voice"]

        if "input_rate" in audio_config:
            config.setdefault("audio", {}).setdefault("input", {}).setdefault("format", {})["rate"] = audio_config[
                "input_rate"
            ]

        if "output_rate" in audio_config:
            config.setdefault("audio", {}).setdefault("output", {}).setdefault("format", {})["rate"] = audio_config[
                "output_rate"
            ]

        return config

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

        yield BidiConnectionStartEvent(connection_id=self._connection_id, model=self.model_id)

        # Bind this reader to the connection it started on. After a reconnect swaps self._websocket,
        # a still-draining superseded reader keeps reading its own (now-closed) socket rather than
        # stealing messages from the connection that replaced it.
        websocket = self._websocket
        start_time = self._start_time

        while True:
            duration = time.time() - start_time
            if duration >= self.timeout_s:
                raise BidiModelTimeoutError(f"timeout_s=<{self.timeout_s}>")

            try:
                message = await asyncio.wait_for(websocket.recv(), timeout=10)
            except asyncio.TimeoutError:
                continue

            openai_event = json.loads(message)

            for event in self._convert_openai_event(openai_event) or []:
                yield event

    def _convert_openai_event(self, openai_event: dict[str, Any]) -> list[BidiOutputEvent] | None:
        """Convert OpenAI events to Strands TypedEvent format."""
        event_type = openai_event.get("type")

        # Turn start - response begins
        if event_type == "response.created":
            response = openai_event.get("response", {})
            response_id = response.get("id", str(uuid.uuid4()))
            return [BidiResponseStartEvent(response_id=response_id)]

        # Audio output
        elif event_type == "response.output_audio.delta":
            # Audio is already base64 string from OpenAI
            # Use the resolved output sample rate from our merged configuration
            sample_rate = self.audio_config["output_rate"]

            # Channels from config is guaranteed to be 1 or 2
            channels = self.audio_config["channels"]
            return [
                BidiAudioStreamEvent(
                    audio=openai_event["delta"],
                    format="pcm",
                    sample_rate=sample_rate,
                    channels=channels,
                )
            ]

        # Assistant text output events - combine multiple similar events
        elif event_type in ["response.output_text.delta", "response.output_audio_transcript.delta"]:
            role = openai_event.get("role", "assistant")
            return [self._create_text_event(openai_event["delta"], role, is_final=False)]

        elif event_type in ["response.output_audio_transcript.done"]:
            role = openai_event.get("role", "assistant")
            return [self._create_text_event(openai_event["transcript"], role)]

        elif event_type in ["response.output_text.done"]:
            role = openai_event.get("role", "assistant")
            return [self._create_text_event(openai_event["text"], role)]

        # User transcription events - combine multiple similar events
        elif event_type in [
            "conversation.item.input_audio_transcription.delta",
            "conversation.item.input_audio_transcription.completed",
        ]:
            text_key = "delta" if "delta" in event_type else "transcript"
            text = openai_event.get(text_key, "")
            role = openai_event.get("role", "user")
            is_final = "completed" in event_type
            return [self._create_text_event(text, role, is_final=is_final)] if text.strip() else None

        elif event_type == "conversation.item.input_audio_transcription.segment":
            segment_data = openai_event.get("segment", {})
            text = segment_data.get("text", "")
            role = segment_data.get("role", "user")
            return [self._create_text_event(text, role)] if text.strip() else None

        elif event_type == "conversation.item.input_audio_transcription.failed":
            error_info = openai_event.get("error", {})
            logger.warning("error=<%s> | openai transcription failed", error_info.get("message", "unknown error"))
            return None

        # Function call processing
        elif event_type == "response.function_call_arguments.delta":
            call_id = openai_event.get("call_id")
            delta = openai_event.get("delta", "")
            if call_id:
                if call_id not in self._function_call_buffer:
                    self._function_call_buffer[call_id] = {"call_id": call_id, "name": "", "arguments": delta}
                else:
                    self._function_call_buffer[call_id]["arguments"] += delta
            return None

        elif event_type == "response.function_call_arguments.done":
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
                except (json.JSONDecodeError, KeyError) as e:
                    logger.warning("call_id=<%s>, error=<%s> | error parsing function arguments", call_id, e)
                    del self._function_call_buffer[call_id]
            return None

        # Voice activity detection - speech_started triggers interruption
        elif event_type == "input_audio_buffer.speech_started":
            # This is the primary interruption signal - handle it first
            return [BidiInterruptionEvent(reason="user_speech")]

        # Response cancelled - handle interruption
        elif event_type == "response.cancelled":
            response = openai_event.get("response", {})
            response_id = response.get("id", "unknown")
            logger.debug("response_id=<%s> | openai response cancelled", response_id)
            return [BidiResponseCompleteEvent(response_id=response_id, stop_reason="interrupted")]

        # Turn complete and usage - response finished
        elif event_type == "response.done":
            response = openai_event.get("response", {})
            response_id = response.get("id", "unknown")
            status = response.get("status", "completed")
            usage = response.get("usage")

            # Map OpenAI status to our stop_reason
            stop_reason_map = {
                "completed": "complete",
                "cancelled": "interrupted",
                "failed": "error",
                "incomplete": "interrupted",
            }

            # Build list of events to return
            events: list[Any] = []

            # Always add response complete event
            events.append(
                BidiResponseCompleteEvent(
                    response_id=response_id,
                    stop_reason=cast(StopReason, stop_reason_map.get(status, "complete")),
                ),
            )

            # Add usage event if available
            if usage:
                input_details = usage.get("input_token_details", {})
                output_details = usage.get("output_token_details", {})

                # Build modality details
                modality_details = []

                # Text modality
                text_input = input_details.get("text_tokens", 0)
                text_output = output_details.get("text_tokens", 0)
                if text_input > 0 or text_output > 0:
                    modality_details.append(
                        {"modality": "text", "input_tokens": text_input, "output_tokens": text_output}
                    )

                # Audio modality
                audio_input = input_details.get("audio_tokens", 0)
                audio_output = output_details.get("audio_tokens", 0)
                if audio_input > 0 or audio_output > 0:
                    modality_details.append(
                        {"modality": "audio", "input_tokens": audio_input, "output_tokens": audio_output}
                    )

                # Image modality
                image_input = input_details.get("image_tokens", 0)
                if image_input > 0:
                    modality_details.append({"modality": "image", "input_tokens": image_input, "output_tokens": 0})

                # Cached tokens
                cached_tokens = input_details.get("cached_tokens", 0)

                # Add usage event
                events.append(
                    BidiUsageEvent(
                        input_tokens=usage.get("input_tokens", 0),
                        output_tokens=usage.get("output_tokens", 0),
                        total_tokens=usage.get("total_tokens", 0),
                        modality_details=cast(list[ModalityUsage], modality_details) if modality_details else None,
                        cache_read_input_tokens=cached_tokens if cached_tokens > 0 else None,
                    )
                )

            # Return list of events
            return events

        # Lifecycle events (log only) - combine multiple similar events
        elif event_type in ["conversation.item.retrieve", "conversation.item.added"]:
            item = openai_event.get("item", {})
            action = "retrieved" if "retrieve" in event_type else "added"
            logger.debug("action=<%s>, item_id=<%s> | openai conversation item event", action, item.get("id"))
            return None

        elif event_type == "conversation.item.done":
            logger.debug("item_id=<%s> | openai conversation item done", openai_event.get("item", {}).get("id"))
            return None

        # Response output events - combine similar events
        elif event_type in [
            "response.output_item.added",
            "response.output_item.done",
            "response.content_part.added",
            "response.content_part.done",
        ]:
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

        # Session/buffer events - combine simple log-only events
        elif event_type in [
            "input_audio_buffer.committed",
            "input_audio_buffer.cleared",
            "session.created",
            "session.updated",
        ]:
            logger.debug("event_type=<%s> | openai event received", event_type)
            return None

        elif event_type == "error":
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

        else:
            logger.debug("event_type=<%s> | unhandled openai event type", event_type)
            return None

    async def send(
        self,
        content: BidiInputEvent | ToolResultEvent,
    ) -> None:
        """Unified send method for all content types. Sends the given content to OpenAI.

        Dispatches to appropriate internal handler based on content type.

        Args:
            content: Typed event (BidiTextInputEvent, BidiAudioInputEvent, BidiImageInputEvent, or ToolResultEvent).

        Raises:
            ValueError: If content type not supported.
        """
        if not self._connection_id:
            raise RuntimeError("model not started | call start before sending")

        # Note: TypedEvent inherits from dict, so isinstance checks for TypedEvent must come first
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
        """Internal: Send audio content to OpenAI for processing."""
        # Audio is already base64 encoded in the event
        await self._send_event({"type": "input_audio_buffer.append", "audio": audio_input.audio})

    async def _send_image_content(self, image_input: BidiImageInputEvent) -> None:
        """Internal: Send image content to OpenAI for processing.

        Sends the image as an ``input_image`` content block on a user message via
        ``conversation.item.create``. Image data is encoded as a ``data:`` URL using
        the event's MIME type and base64 payload, matching the format documented for
        OpenAI's Realtime API image input on ``gpt-realtime`` models.
        """
        data_url = f"data:{image_input.mime_type};base64,{image_input.image}"
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
        await self._send_event({"type": "response.create"})

    async def _send_tool_result(self, tool_result: ToolResult) -> None:
        """Internal: Send tool result back to OpenAI."""
        tool_use_id = tool_result.get("toolUseId")

        logger.debug("tool_use_id=<%s> | sending openai tool result", tool_use_id)

        # Validate content types and serialize, preserving structure
        result_output = ""
        if "content" in tool_result:
            # First validate all content types are supported
            for block in tool_result["content"]:
                if "text" not in block and "json" not in block:
                    # Unsupported content type - raise error
                    raise ValueError(
                        f"tool_use_id=<{tool_use_id}>, content_types=<{list(block.keys())}> | "
                        f"Content type not supported by OpenAI Realtime API"
                    )

            # Preserve structure by JSON-dumping the entire content array
            result_output = json.dumps(tool_result["content"])

        item_data = {"type": "function_call_output", "call_id": tool_use_id, "output": result_output}
        await self._send_event({"type": "conversation.item.create", "item": item_data})
        await self._send_event({"type": "response.create"})

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
