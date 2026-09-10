"""Qwen Realtime API provider for Strands bidirectional streaming."""

import asyncio
import json
import logging
import os
import time
import uuid
from collections.abc import AsyncGenerator
from typing import Any, cast
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import websockets
from websockets import ClientConnection

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
from .model import AudioCapable, BidiModel, BidiModelTimeoutError

logger = logging.getLogger(__name__)

QWEN_REALTIME_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
QWEN_MAX_TIMEOUT_S = 7200
QWEN_RESTART_AFTER_S = 6600
DEFAULT_MODEL = "qwen3.5-omni-flash-realtime"
DEFAULT_INPUT_SAMPLE_RATE = 16000
DEFAULT_OUTPUT_SAMPLE_RATE = 24000
DEFAULT_VOICE = "Tina"

_DEFAULT_TURN_DETECTION = {
    "type": "server_vad",
    "threshold": 0.5,
    "silence_duration_ms": 800,
}


class QwenRealtimeModel(BidiModel, AudioCapable):
    """Qwen Realtime implementation for bidirectional streaming over WebSocket."""

    _websocket: ClientConnection
    _start_time: int

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL,
        provider_config: dict[str, Any] | None = None,
        client_config: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        """Initialize a Qwen Realtime model.

        Args:
            model_id: Qwen Realtime model identifier.
            provider_config: Model, audio, inference, and connection configuration.
            client_config: Authentication, endpoint, region, workspace, and timeout configuration.
            **kwargs: Reserved for future parameters.

        Raises:
            ValueError: If authentication, timeout, or VAD configuration is invalid.
        """
        self.model_id = model_id
        self.usage_is_cumulative = False
        self._client_config = self._resolve_client_config(client_config or {})
        self.config = self._resolve_provider_config(provider_config or {})

        self.api_key = cast(str, self._client_config["api_key"])
        self.timeout_s = cast(int, self._client_config["timeout_s"])
        self.url = self._resolve_url(self._client_config)
        if self.timeout_s > QWEN_MAX_TIMEOUT_S:
            raise ValueError(
                f"timeout_s=<{self.timeout_s}>, max_timeout_s=<{QWEN_MAX_TIMEOUT_S}> | timeout exceeds max limit"
            )

        default_connection: BidiConnectionConfig = {"restart_after_s": QWEN_RESTART_AFTER_S}
        self.connection_config = cast(
            BidiConnectionConfig, {**default_connection, **(provider_config or {}).get("connection", {})}
        )
        self._connection_id: str | None = None
        self._function_call_buffer: dict[str, dict[str, str]] = {}
        self._audio_sent_in_turn = False

        logger.debug("model=<%s> | qwen realtime model initialized", model_id)

    def _resolve_client_config(self, config: dict[str, Any]) -> dict[str, Any]:
        """Resolve authentication and connection defaults."""
        resolved = config.copy()
        resolved.setdefault("api_key", os.getenv("DASHSCOPE_API_KEY"))
        resolved.setdefault("timeout_s", QWEN_MAX_TIMEOUT_S)
        resolved.setdefault("region", "cn-beijing")
        if not resolved.get("api_key"):
            raise ValueError(
                "DashScope API key is required. Provide via client_config={'api_key': '...'} "
                "or set DASHSCOPE_API_KEY environment variable."
            )
        return resolved

    def _resolve_provider_config(self, config: dict[str, Any]) -> dict[str, Any]:
        """Merge provider configuration with Qwen defaults."""
        default_audio: AudioConfig = {
            "input_rate": cast(AudioSampleRate, DEFAULT_INPUT_SAMPLE_RATE),
            "output_rate": cast(AudioSampleRate, DEFAULT_OUTPUT_SAMPLE_RATE),
            "channels": 1,
            "format": "pcm",
            "voice": DEFAULT_VOICE,
        }
        inference_overrides = config.get("inference", {})
        turn_detection_override = inference_overrides.get("turn_detection", _DEFAULT_TURN_DETECTION)
        if turn_detection_override is None:
            raise ValueError("turn_detection cannot be disabled because manual audio commit is not supported")
        if not isinstance(turn_detection_override, dict):
            raise ValueError("turn_detection must be a configuration object")

        turn_detection = {**_DEFAULT_TURN_DETECTION, **turn_detection_override}
        inference = {
            "modalities": ["text", "audio"],
            "input_audio_transcription": {"model": "qwen3-asr-flash-realtime"},
            **inference_overrides,
            "turn_detection": turn_detection,
        }
        if turn_detection.get("type") not in {"server_vad", "semantic_vad"}:
            raise ValueError("turn_detection.type must be 'server_vad' or 'semantic_vad'")

        return {
            "audio": {**default_audio, **config.get("audio", {})},
            "inference": inference,
        }

    def _resolve_url(self, config: dict[str, Any]) -> str:
        """Resolve the WebSocket URL and append the model query parameter."""
        base_url = config.get("url")
        if not base_url and config.get("workspace_id"):
            base_url = f"wss://{config['workspace_id']}.{config['region']}.maas.aliyuncs.com/api-ws/v1/realtime"
        parts = urlsplit(base_url or QWEN_REALTIME_URL)
        query = dict(parse_qsl(parts.query, keep_blank_values=True))
        query["model"] = self.model_id
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))

    @property
    def audio_config(self) -> AudioConfig:
        """Get the resolved audio configuration."""
        return cast(AudioConfig, self.config["audio"])

    async def start(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **kwargs: Any,
    ) -> None:
        """Establish a Qwen Realtime WebSocket connection.

        Args:
            system_prompt: System instructions for the session.
            tools: Tools available to the model.
            messages: Conversation history to replay.
            **kwargs: Reserved for provider-specific options.

        Raises:
            RuntimeError: If the model is already started.
            ValueError: If search and function calling are both enabled.
        """
        if self._connection_id:
            raise RuntimeError("model already started | call stop before starting again")

        session_config = self._build_session_config(system_prompt, tools)
        self._connection_id = str(uuid.uuid4())
        self._start_time = int(time.time())
        self._function_call_buffer = {}
        self._audio_sent_in_turn = False

        try:
            self._websocket = await websockets.connect(
                self.url,
                additional_headers=[("Authorization", f"Bearer {self.api_key}")],
            )
        except Exception:
            self._connection_id = None
            raise

        logger.debug("connection_id=<%s> | qwen websocket connected", self._connection_id)
        await self._send_event({"type": "session.update", "session": session_config})
        if messages:
            await self._add_conversation_history(messages)

    def _build_session_config(self, system_prompt: str | None, tools: list[ToolSpec] | None) -> dict[str, Any]:
        """Build the Qwen session.update payload."""
        inference = self.config["inference"].copy()
        if inference.get("enable_search") and tools:
            raise ValueError("enable_search and tools cannot be enabled at the same time")

        audio = self.config["audio"]
        session: dict[str, Any] = {
            "model": self.model_id,
            "modalities": inference.pop("modalities"),
            "voice": audio["voice"],
            "audio": {
                "input": {
                    "format": {
                        "type": audio["format"],
                        "sample_rate": audio["input_rate"],
                    }
                },
                "output": {
                    "format": {
                        "type": audio["format"],
                        "sample_rate": audio["output_rate"],
                    }
                },
            },
            **inference,
        }
        if system_prompt:
            session["instructions"] = system_prompt
        if tools:
            session["tools"] = self._convert_tools(tools)
        return session

    def _convert_tools(self, tools: list[ToolSpec]) -> list[dict[str, Any]]:
        """Convert Strands tool specifications to Qwen function tools."""
        converted = []
        for tool in tools:
            input_schema = tool["inputSchema"]
            schema = input_schema.get("json", input_schema)
            if isinstance(schema, str):
                schema = json.loads(schema)
            converted.append(
                {
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": tool["description"],
                        "parameters": schema,
                    },
                }
            )
        return converted

    async def _add_conversation_history(self, messages: Messages) -> None:
        """Replay text, function calls, and function results into a new session."""
        for message in messages:
            role = message["role"]
            text_content = []
            for block in message.get("content", []):
                if "text" in block:
                    content_type = "input_text" if role == "user" else "output_text"
                    text_content.append({"type": content_type, "text": block["text"]})
                elif "toolUse" in block:
                    await self._send_history_tool_use(block["toolUse"])
                elif "toolResult" in block:
                    await self._send_history_tool_result(block["toolResult"])

            if text_content:
                await self._send_event(
                    {
                        "type": "conversation.item.create",
                        "item": {"type": "message", "role": role, "content": text_content},
                    }
                )
        logger.debug("message_count=<%d> | conversation history added to qwen session", len(messages))

    async def _send_history_tool_use(self, tool_use: ToolUse) -> None:
        """Replay one historical tool call."""
        await self._send_event(
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "function_call",
                    "call_id": tool_use["toolUseId"],
                    "name": tool_use["name"],
                    "arguments": json.dumps(tool_use["input"]),
                },
            }
        )

    async def _send_history_tool_result(self, tool_result: ToolResult) -> None:
        """Replay one historical tool result."""
        await self._send_event(
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "function_call_output",
                    "call_id": tool_result["toolUseId"],
                    "output": self._serialize_tool_result(tool_result),
                },
            }
        )

    async def receive(self) -> AsyncGenerator[BidiOutputEvent, None]:
        """Receive Qwen events and convert them to Strands events.

        Yields:
            Normalized bidirectional output events.

        Raises:
            RuntimeError: If the model has not been started.
            BidiModelTimeoutError: When the configured connection timeout is reached.
        """
        if not self._connection_id:
            raise RuntimeError("model not started | call start before receiving")

        yield BidiConnectionStartEvent(connection_id=self._connection_id, model=self.model_id)
        websocket = self._websocket
        start_time = self._start_time

        while True:
            if time.time() - start_time >= self.timeout_s:
                raise BidiModelTimeoutError(f"timeout_s=<{self.timeout_s}>")
            try:
                message = await asyncio.wait_for(websocket.recv(), timeout=10)
            except asyncio.TimeoutError:
                continue

            qwen_event = json.loads(message)
            for event in self._convert_qwen_event(qwen_event) or []:
                yield event

    def _create_text_event(
        self,
        text: str,
        role: Role,
        *,
        is_final: bool,
        current_transcript: str | None = None,
    ) -> BidiTranscriptStreamEvent:
        """Create a normalized transcript event."""
        return BidiTranscriptStreamEvent(
            delta={"text": text},
            text=text,
            role=role,
            is_final=is_final,
            current_transcript=current_transcript,
        )

    def _convert_qwen_event(self, event: dict[str, Any]) -> list[BidiOutputEvent] | None:
        """Convert a Qwen server event to Strands events."""
        event_type = event.get("type")
        if event_type == "response.created":
            response_id = event.get("response", {}).get("id", str(uuid.uuid4()))
            return [BidiResponseStartEvent(response_id=response_id)]

        if event_type == "response.audio.delta":
            return [
                BidiAudioStreamEvent(
                    audio=event.get("delta", ""),
                    format=self.audio_config["format"],
                    sample_rate=self.audio_config["output_rate"],
                    channels=self.audio_config["channels"],
                )
            ]

        if event_type in {"response.text.delta", "response.audio_transcript.delta"}:
            return [self._create_text_event(event.get("delta", ""), "assistant", is_final=False)]

        if event_type == "response.text.done":
            text = event.get("text", "")
            return [self._create_text_event(text, "assistant", is_final=True, current_transcript=text)]

        if event_type == "response.audio_transcript.done":
            transcript = event.get("transcript", "")
            return [self._create_text_event(transcript, "assistant", is_final=True, current_transcript=transcript)]

        if event_type == "conversation.item.input_audio_transcription.delta":
            preview = event.get("text", "") + event.get("stash", "")
            return (
                [self._create_text_event(preview, "user", is_final=False, current_transcript=preview)]
                if preview
                else None
            )

        if event_type == "conversation.item.input_audio_transcription.completed":
            transcript = event.get("transcript", "")
            return (
                [self._create_text_event(transcript, "user", is_final=True, current_transcript=transcript)]
                if transcript
                else None
            )

        if event_type == "conversation.item.input_audio_transcription.failed":
            logger.warning("error=<%s> | qwen input audio transcription failed", event.get("error", {}))
            return None

        if event_type == "input_audio_buffer.speech_started":
            return [BidiInterruptionEvent(reason="user_speech")]

        if event_type == "input_audio_buffer.committed":
            self._audio_sent_in_turn = False
            return None

        if event_type == "response.output_item.added":
            self._track_function_call(event.get("item", {}))
            return None

        if event_type == "response.function_call_arguments.delta":
            self._append_function_arguments(event)
            return None

        if event_type == "response.function_call_arguments.done":
            tool_event = self._complete_function_call(event)
            return [tool_event] if tool_event else None

        if event_type == "response.done":
            return self._convert_response_done(event.get("response", {}))

        if event_type == "error":
            logger.error("error=<%s> | qwen realtime error", event.get("error", {}))
            return None

        logger.debug("event_type=<%s> | unhandled qwen event", event_type)
        return None

    def _track_function_call(self, item: dict[str, Any]) -> None:
        """Store function call metadata from an output item."""
        if item.get("type") != "function_call" or not item.get("call_id"):
            return
        call_id = cast(str, item["call_id"])
        self._function_call_buffer[call_id] = {
            "name": item.get("name", ""),
            "arguments": item.get("arguments", ""),
        }

    def _append_function_arguments(self, event: dict[str, Any]) -> None:
        """Append one function call argument delta."""
        call_id = event.get("call_id")
        if not call_id:
            return
        buffer = self._function_call_buffer.setdefault(call_id, {"name": event.get("name", ""), "arguments": ""})
        buffer["arguments"] += event.get("delta", "")

    def _complete_function_call(self, event: dict[str, Any]) -> ToolUseStreamEvent | None:
        """Create a tool use event from completed function arguments."""
        call_id = event.get("call_id")
        if not call_id:
            return None
        buffered = self._function_call_buffer.pop(call_id, {"name": "", "arguments": ""})
        name = event.get("name") or buffered["name"]
        arguments = event.get("arguments") or buffered["arguments"]
        try:
            parsed_arguments = json.loads(arguments) if arguments else {}
        except json.JSONDecodeError as error:
            logger.warning("call_id=<%s>, error=<%s> | error parsing qwen function arguments", call_id, error)
            return None

        tool_use: ToolUse = {"toolUseId": call_id, "name": name, "input": parsed_arguments}
        return ToolUseStreamEvent(
            delta={
                "toolUse": {
                    "toolUseId": call_id,
                    "name": name,
                    "input": json.dumps(parsed_arguments),
                }
            },
            current_tool_use=dict(tool_use),
        )

    def _convert_response_done(self, response: dict[str, Any]) -> list[BidiOutputEvent]:
        """Convert response completion and usage information."""
        status = response.get("status", "completed")
        stop_reasons = {
            "completed": "complete",
            "cancelled": "interrupted",
            "failed": "error",
            "incomplete": "interrupted",
        }
        events: list[BidiOutputEvent] = [
            BidiResponseCompleteEvent(
                response_id=response.get("id", "unknown"),
                stop_reason=cast(StopReason, stop_reasons.get(status, "complete")),
            )
        ]
        usage = response.get("usage")
        if usage:
            events.append(self._convert_usage(usage))
        return events

    def _convert_usage(self, usage: dict[str, Any]) -> BidiUsageEvent:
        """Convert Qwen token usage and modality details."""
        input_details = usage.get("input_tokens_details", {})
        output_details = usage.get("output_tokens_details", {})
        modality_details = []
        for modality in ("text", "audio", "image"):
            input_tokens = input_details.get(f"{modality}_tokens", 0)
            output_tokens = output_details.get(f"{modality}_tokens", 0)
            if input_tokens or output_tokens:
                modality_details.append(
                    {
                        "modality": modality,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                    }
                )
        return BidiUsageEvent(
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            total_tokens=usage.get("total_tokens", 0),
            modality_details=cast(list[ModalityUsage], modality_details) if modality_details else None,
        )

    async def send(self, content: BidiInputEvent | ToolResultEvent) -> None:
        """Send text, audio, image, or tool result content to Qwen.

        Args:
            content: Typed input or tool result event.

        Raises:
            RuntimeError: If the model has not been started.
            ValueError: If content is unsupported or image ordering is invalid.
        """
        if not self._connection_id:
            raise RuntimeError("model not started | call start before sending")
        if isinstance(content, BidiTextInputEvent):
            await self._send_text(content.text)
        elif isinstance(content, BidiAudioInputEvent):
            self._audio_sent_in_turn = True
            await self._send_event({"type": "input_audio_buffer.append", "audio": content.audio})
        elif isinstance(content, BidiImageInputEvent):
            if not self._audio_sent_in_turn:
                raise ValueError("audio input must be sent before image input in the current turn")
            await self._send_event({"type": "input_image_buffer.append", "image": content.image})
        elif isinstance(content, ToolResultEvent):
            tool_result = content.get("tool_result")
            if tool_result:
                await self._send_tool_result(tool_result)
        else:
            raise ValueError(f"content_type={type(content)} | content not supported")

    async def _send_text(self, text: str) -> None:
        """Send user text and request a response."""
        await self._send_event(
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                },
            }
        )
        await self._send_event({"type": "response.create"})

    def _serialize_tool_result(self, tool_result: ToolResult) -> str:
        """Validate and serialize a tool result."""
        for block in tool_result.get("content", []):
            if "text" not in block and "json" not in block:
                raise ValueError(
                    f"tool_use_id=<{tool_result.get('toolUseId')}>, content_types=<{list(block.keys())}> | "
                    "content type not supported by Qwen Realtime API"
                )
        return json.dumps(tool_result.get("content", []))

    async def _send_tool_result(self, tool_result: ToolResult) -> None:
        """Return a tool result and request the final response."""
        await self._send_history_tool_result(tool_result)
        await self._send_event({"type": "response.create"})

    async def stop(self) -> None:
        """Finish the Qwen session and close the WebSocket."""
        if not self._connection_id:
            return

        async def finish_session() -> None:
            await self._send_event({"type": "session.finish"})

        async def close_websocket() -> None:
            await self._websocket.close()

        async def clear_connection() -> None:
            self._connection_id = None

        await stop_all(finish_session, close_websocket, clear_connection)
        logger.debug("qwen realtime connection closed")

    async def restart(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **restart_kwargs: Any,
    ) -> None:
        """Reconnect and replay supported conversation history.

        Args:
            system_prompt: System instructions for the new session.
            tools: Tools available to the model.
            messages: Text and tool history to replay. Media is not replayed.
            **restart_kwargs: Reserved for provider-specific restart options.
        """
        await self.stop()
        await self.start(system_prompt, tools, messages, **restart_kwargs)

    async def _send_event(self, event: dict[str, Any]) -> None:
        """Send a client event with a unique event identifier."""
        payload = event.copy()
        payload.setdefault("event_id", f"event_{uuid.uuid4().hex}")
        await self._websocket.send(json.dumps(payload))
        logger.debug("event_type=<%s> | qwen event sent", payload.get("type"))
