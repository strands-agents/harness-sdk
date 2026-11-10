"""OpenAI Live model provider using the OpenAI Python client.

.. warning:: Experimental
    This module is experimental and may change in future versions.
"""

# Manual checks from strands-py/ in a dedicated virtualenv:
#   python -m pip install -e '.[bidi-openai-live,dev]'
#   python -m pytest tests/strands/bidi/models/openai/test_live.py -q
#   python -m ruff check src/strands/bidi/models/openai/live.py
#   python -m ruff format --check src/strands/bidi/models/openai/live.py
#   python -m mypy src/strands/bidi/models/openai/live.py --follow-imports=silent
#
# Integration test (requires OPENAI_API_KEY):
#   python -m pytest tests_integ/bidi/models/test_openai_live.py -q

import asyncio
import base64
import copy
import json
import logging
import mimetypes
import warnings
from collections.abc import AsyncGenerator, Iterator
from dataclasses import dataclass, field
from typing import Any, Literal, NoReturn, cast, final
from uuid import uuid4

from openai import AsyncOpenAI
from openai.resources.live.forks import AsyncForksConnection
from openai.resources.live.live import AsyncLiveConnection
from openai.types.live.custom_voice_param import CustomVoiceParam
from openai.types.live.error_event import ErrorEvent
from openai.types.live.fork_server_event import ForkServerEvent
from openai.types.live.fork_session_config_param import Audio, ForkSessionConfigParam
from openai.types.live.initial_item_param import InitialItemParam
from openai.types.live.input_transcript_delta_event import InputTranscriptDeltaEvent
from openai.types.live.output_audio_delta_event import OutputAudioDeltaEvent
from openai.types.live.output_transcript_delta_event import OutputTranscriptDeltaEvent
from openai.types.live.response_event import ResponseEvent
from openai.types.live.server_event import ServerEvent
from openai.types.live.session_closed_event import SessionClosedEvent
from openai.types.live.session_config_param import Delegation, SessionConfigParam
from openai.types.live.session_started_event import SessionStartedEvent
from openai.types.responses.response_input_item_param import ResponseInputItemParam
from openai.types.responses.response_input_message_content_list_param import ResponseInputContentParam
from typing_extensions import Unpack, override

from ....types.content import Messages, TextBlock
from ....types.exceptions import ModelThrottledException
from ....types.media import ImageBlock
from ....types.tools import ToolResultBlock, ToolSpec, ToolUse
from ..._async import stop_all
from ...types.content import BidiContentDelta, BidiMessage
from ...types.events import (
    BidiAudioDeltaEvent,
    BidiAudioStartEvent,
    BidiAudioStopEvent,
    BidiConnectionStartEvent,
    BidiConnectionStopEvent,
    BidiOutputEvent,
    BidiResponseStartEvent,
    BidiResponseStopEvent,
    BidiTextDeltaEvent,
    BidiTextStartEvent,
    BidiTextStopEvent,
    BidiToolUseBlocksEvent,
    BidiTranscriptDeltaEvent,
    BidiTranscriptStartEvent,
    BidiTranscriptStopEvent,
    BidiUsageEvent,
)
from ..configs import AudioConfig, ModelConfig, ModelUpdateConfig, _merge_config
from ..model import AudioCapable, BidiModel, ConnectionTimeoutError, Restartable
from .configs import OpenAILiveAudioConfig, OpenAILiveResponsesDelegationConfig

logger = logging.getLogger(__name__)


@dataclass
class _LiveSessionState:
    """Lifecycle and event state for one Live session.

    Attributes:
        connection_id: OpenAI session ID used for connection events and restart.
        send_gate: Allows sends after OpenAI acknowledges session startup.
        send_lock: Serializes message submissions and response requests.
        receive_task: Receiver task cancelled during shutdown.
        response_id: Active Strands response ID.
        audio_id: Active Strands audio content ID.
        delegations: Active delegated responses keyed by delegation ID.
        pending_tools: Tool call IDs awaiting results, retained across session forks.
        closed: Whether the session or connection has closed.
    """

    connection_id: str = ""
    send_gate: asyncio.Event = field(default_factory=asyncio.Event)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    receive_task: asyncio.Task[Any] | None = None
    response_id: str | None = None
    audio_id: str | None = None
    delegations: dict[str | None, "_DelegationState"] = field(default_factory=dict)
    pending_tools: set[str] = field(default_factory=set)
    closed: bool = False


@dataclass
class _DelegationState:
    """Text and tool state for one delegated response.

    Attributes:
        response_id: OpenAI response ID.
        texts: Strands content IDs keyed by OpenAI item ID and content index.
            Retained ``None`` values mark streams closed at a Strands response boundary.
        tools: Completed tool calls collected for emission as a group.
    """

    response_id: str
    texts: dict[tuple[str, int], str | None] = field(default_factory=dict)
    tools: list[ToolUse] = field(default_factory=list)


@final
class OpenAILiveModel(BidiModel, AudioCapable, Restartable):
    """Experimental OpenAI Live provider with Responses delegation.

    The Live model handles speech; the Responses model handles reasoning and tool use.
    The provider saves sessions with OpenAI and forks them on restart.

    Response boundaries do not mark completed spoken turns. Transcript blocks contain
    API fragments. Barge-in is unsupported, and token usage covers only the Responses model.
    """

    def __init__(
        self,
        *,
        delegation_config: OpenAILiveResponsesDelegationConfig,
        voice: str | CustomVoiceParam | None = None,
        audio_config: OpenAILiveAudioConfig | None = None,
        client_args: dict[str, Any] | None = None,
        **model_config: Unpack[ModelConfig],
    ) -> None:
        """Initialize the provider and client without opening a connection.

        Args:
            delegation_config: Responses model configuration.
            voice: Built-in voice name or custom voice ID object. Omission uses the API default.
            audio_config: Shared input and output audio configuration. Defaults to mono PCM16 at 24000 Hz.
            client_args: Keyword arguments for ``openai.AsyncOpenAI``.
            **model_config: Shared model configuration. ``model_id`` is required and ``params`` is ignored.
                Automatic restart is disabled by default.
        """
        warnings.warn("OpenAILiveModel is experimental and may change in future versions.", stacklevel=2)

        self._delegation_config = delegation_config
        self._voice = voice
        self._audio_config = audio_config or {"sample_rate": 24000}
        self._client_args = client_args or {}
        self._model_config: ModelConfig = {
            **model_config,
            "connection": {"auto_restart": False, **model_config.get("connection", {})},
        }

        self._client = AsyncOpenAI(**self._client_args)
        self._connection: AsyncLiveConnection | AsyncForksConnection | None = None
        self._state = _LiveSessionState()
        self._started = False

    @override
    def update_config(self, **model_config: Unpack[ModelUpdateConfig]) -> None:  # type: ignore[override]
        """Merge shared model configuration while stopped.

        Args:
            **model_config: Options to update. Omitted settings retain their values, including nested settings.
                ``params`` is ignored.

        Raises:
            RuntimeError: If the model is running.
        """
        if self._started:
            raise RuntimeError("Stop OpenAI Live before updating its configuration")

        self._model_config = cast(ModelConfig, _merge_config(self._model_config, model_config))

    @override
    def get_config(self) -> ModelConfig:
        """Return a copy of the shared model configuration."""
        return copy.deepcopy(self._model_config)

    @override
    def get_audio_config(self) -> AudioConfig:
        """Return the audio configuration for input and output."""
        sample_rate = self._audio_config["sample_rate"]
        return {
            "input": {"format": "pcm", "sample_rate": sample_rate, "channels": 1},
            "output": {"format": "pcm", "sample_rate": sample_rate, "channels": 1},
        }

    @override
    async def start(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **kwargs: Any,
    ) -> None:
        """Open a new Live session.

        ``receive()`` reports when the session is ready.
        Call ``stop()`` if startup fails or is cancelled.

        Args:
            system_prompt: Instructions for Live and, unless overridden, the Responses model.
            tools: Tool specifications for the Responses model.
            messages: Initial conversation history. Only text blocks are included.
            **kwargs: Unused.
        """
        session_config = self._to_openai_session_config(system_prompt, tools, messages)
        self._connection = await self._client.live.connect(max_retries=0).enter()
        await self._connection.session.start(session=session_config)

        self._state = _LiveSessionState()
        self._started = True

    @override
    async def restart(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **restart_kwargs: Any,
    ) -> None:
        """Close the current session and fork its saved conversation.

        ``receive()`` reports when the session is ready.
        Call ``stop()`` if startup fails or is cancelled.

        Args:
            system_prompt: Unused; the fork inherits instructions.
            tools: Unused; the fork inherits tools.
            messages: Unused; the fork inherits conversation history.
            **restart_kwargs: Unused.

        Raises:
            RuntimeError: If no session ID is available or cleanup fails.
        """
        if not self._state.connection_id:
            raise RuntimeError("OpenAI Live requires a session ID to restart")

        await self.stop()

        session_config = cast(ForkSessionConfigParam, {"audio": self._to_openai_session_audio()})
        self._connection = await self._client.live.forks.connect(
            session_id=self._state.connection_id, max_retries=0
        ).enter()
        await self._connection.session.start(session=session_config)

        self._state = _LiveSessionState(pending_tools=self._state.pending_tools.copy())
        self._started = True

    @override
    async def stop(self) -> None:
        """Cancel the receiver and close the session and connection.

        Waits for session finalization without a timeout. Repeated calls are safe.
        All cleanup steps are attempted even if one fails.

        Raises:
            RuntimeError: If any cleanup step fails.
        """
        self._started = False

        async def stop_receive() -> None:
            if self._state.receive_task is None:
                return

            self._state.receive_task.cancel()
            result = (await asyncio.gather(self._state.receive_task, return_exceptions=True))[0]
            if isinstance(result, Exception):
                raise result

        async def stop_session() -> None:
            if self._connection is None or not self._state.connection_id or self._state.closed:
                return

            await self._connection.session.close()
            while not self._state.closed:
                async for _event in self._receive():
                    pass

        async def stop_connection() -> None:
            if self._connection is None:
                return

            try:
                await self._connection.close()
            finally:
                self._connection = None
                self._state.closed = True

        await stop_all(stop_receive, stop_session, stop_connection)

    @override
    async def send(self, content: BidiMessage | BidiContentDelta) -> None:
        """Send audio, user content, or tool results.

        Waits for session readiness from ``receive()``. Cancel pending sends if receiving ends.

        Args:
            content: An audio delta or a message containing text, images, or tool results.

        Raises:
            ValueError: If content is unsupported, empty, or references an unknown tool call.
        """
        await self._state.send_gate.wait()

        if isinstance(content, BidiContentDelta):
            await self._send_delta(content)
        else:
            await self._send_blocks(content)

    @override
    async def receive(self) -> AsyncGenerator[BidiOutputEvent, None]:
        """Receive Strands events until cancelled or an error occurs.

        Run one receiver task concurrently with sends. ``stop()`` cancels this task.

        Raises:
            ConnectionTimeoutError: If the session expires.
            ConnectionError: If the session closes unexpectedly.
            ModelThrottledException: If OpenAI reports rate limiting.
            RuntimeError: If OpenAI reports another session or backend error.
            ValueError: If a backend response ID is unexpected or tool arguments contain invalid JSON.
        """
        self._state.receive_task = asyncio.current_task()
        try:
            while True:
                async for event in self._receive():
                    yield event
        finally:
            self._state.receive_task = None

    def _to_openai_session_config(
        self, system_prompt: str | None, tools: list[ToolSpec] | None, messages: Messages | None
    ) -> SessionConfigParam:
        session_config = {
            "model": self.model_id,
            "store": True,
            **({"instructions": system_prompt} if system_prompt is not None else {}),
            "audio": {
                **self._to_openai_session_audio(),
                **({"output": {"voice": self._voice}} if self._voice else {}),
            },
            "input": self._to_openai_session_input(messages),
            "delegation": self._to_openai_session_delegation(system_prompt, tools),
        }
        return cast(SessionConfigParam, session_config)

    def _to_openai_session_audio(self) -> Audio:
        audio = {
            "format": {
                "type": "audio/pcm",
                "rate": self._audio_config["sample_rate"],
            },
        }
        return cast(Audio, audio)

    def _to_openai_session_input(self, messages: Messages | None) -> list[InitialItemParam]:
        """Include only history text, joining each message's blocks with newlines."""
        items: list[InitialItemParam] = []
        for message in messages or []:
            text = "\n".join(block["text"] for block in message["content"] if "text" in block)
            if not text:
                continue
            if message["role"] == "assistant":
                items.append({"role": "assistant", "content": [{"type": "output_text", "text": text}]})
            else:
                items.append({"role": "user", "content": [{"type": "input_text", "text": text}]})
        return items

    def _to_openai_session_delegation(self, system_prompt: str | None, tools: list[ToolSpec] | None) -> Delegation:
        system_prompt = self._delegation_config.get("system_prompt", system_prompt)
        delegation = {
            "type": self._delegation_config["type"],
            "responses": {
                "model": self._delegation_config["model_id"],
                **({"instructions": system_prompt} if system_prompt is not None else {}),
                **{
                    key: value
                    for key, value in self._delegation_config.items()
                    if key in ("max_output_tokens", "reasoning", "text", "service_tier")
                },
                "tools": [
                    {
                        "type": "function",
                        "name": tool["name"],
                        "description": tool["description"],
                        "parameters": tool["inputSchema"]["json"],
                        "strict": False,
                    }
                    for tool in tools or []
                ],
            },
        }
        return cast(Delegation, delegation)

    async def _send_delta(self, content: BidiContentDelta) -> None:
        assert self._connection is not None

        if content.format != "pcm" or "bytes" not in content.source:
            raise ValueError("OpenAI Live audio must contain raw PCM16 bytes")

        audio = content.source["bytes"]
        await self._connection.session.input_audio.append(audio=base64.b64encode(audio).decode("ascii"))

    async def _send_blocks(self, content: BidiMessage) -> None:
        """Submit message items and request a response once all pending tool results have been submitted."""
        assert self._connection is not None

        async with self._state.send_lock:
            items = self._to_openai_response_items(content)
            for item in items:
                await self._connection.response.item.create(item=item)

            for block in content.content:
                if isinstance(block, ToolResultBlock):
                    self._state.pending_tools.remove(block.tool_use_id)

            if not self._state.pending_tools:
                await self._connection.response.create()

    def _to_openai_response_items(self, message: BidiMessage) -> list[ResponseInputItemParam]:
        if not message.content:
            raise ValueError("OpenAI Live messages must not be empty")

        items: list[ResponseInputItemParam] = []
        parts: list[ResponseInputContentParam] = []
        for block in message.content:
            if isinstance(block, TextBlock):
                parts.append({"type": "input_text", "text": block.text})
            elif isinstance(block, ImageBlock) and "bytes" in block.source:
                encoded = base64.b64encode(block.source["bytes"]).decode("ascii")
                parts.append(
                    {
                        "type": "input_image",
                        "image_url": f"data:image/{block.format};base64,{encoded}",
                        "detail": "auto",
                    }
                )
            elif isinstance(block, ToolResultBlock):
                items.append(self._to_openai_response_function_call_output(block))
            else:
                raise ValueError(
                    f"OpenAI Live only accepts text, images, and tool results; received {type(block).__name__}"
                )

        if parts:
            items.append({"type": "message", "role": "user", "content": parts})

        return items

    def _to_openai_response_function_call_output(self, block: ToolResultBlock) -> ResponseInputItemParam:
        if block.tool_use_id not in self._state.pending_tools:
            raise ValueError("Tool results must match pending OpenAI Live calls")

        output = [{"type": "input_text", "text": json.dumps({"status": block.status})}]
        for part in block.content:
            if "text" in part:
                output.append({"type": "input_text", "text": part["text"]})
            elif "json" in part:
                output.append({"type": "input_text", "text": json.dumps(part["json"])})
            elif "image" in part and "bytes" in part["image"]["source"]:
                image = part["image"]
                encoded = base64.b64encode(image["source"]["bytes"]).decode("ascii")
                output.append({"type": "input_image", "image_url": f"data:image/{image['format']};base64,{encoded}"})
            elif "document" in part and "bytes" in part["document"]["source"]:
                document = part["document"]
                filename = f"{document.get('name', 'document')}.{document['format']}"
                mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
                encoded = base64.b64encode(document["source"]["bytes"]).decode("ascii")
                output.append(
                    {
                        "type": "input_file",
                        "filename": filename,
                        "file_data": f"data:{mime_type};base64,{encoded}",
                    }
                )
            else:
                raise ValueError(
                    f"OpenAI Live only accepts text, JSON, images, and documents in tool results; received {list(part)}"
                )

        return cast(
            ResponseInputItemParam,
            {"type": "function_call_output", "call_id": block.tool_use_id, "output": output},
        )

    async def _receive(self) -> AsyncGenerator[BidiOutputEvent, None]:
        """Receive one OpenAI event and yield the corresponding Strands events."""
        assert self._connection is not None
        event = await self._connection.recv()

        if isinstance(event, ErrorEvent):
            code = event.error.code
            message = event.error.message
            if code == "rate_limit_exceeded":
                raise ModelThrottledException(message)
            raise RuntimeError(f"OpenAI Live {code}: {message}")

        for output_event in self._to_strands_events(event):
            yield output_event

    def _to_strands_events(self, event: ServerEvent | ForkServerEvent) -> Iterator[BidiOutputEvent]:
        if isinstance(event, SessionStartedEvent):
            yield from self._to_strands_connection_start_event(event)
        elif isinstance(event, SessionClosedEvent):
            yield from self._to_strands_connection_stop_event(event)
        elif isinstance(event, OutputAudioDeltaEvent):
            yield from self._to_strands_audio_delta_event(event)
        elif isinstance(event, (InputTranscriptDeltaEvent, OutputTranscriptDeltaEvent)):
            yield from self._to_strands_transcript_delta_event(event)
        elif isinstance(event, ResponseEvent):
            yield from self._to_strands_response_events(event)

    def _to_strands_connection_start_event(self, event: SessionStartedEvent) -> Iterator[BidiOutputEvent]:
        self._state.connection_id = event.session.id
        self._state.send_gate.set()

        yield BidiConnectionStartEvent(connection_id=self._state.connection_id, model=event.session.model)

    def _to_strands_connection_stop_event(self, event: SessionClosedEvent) -> Iterator[BidiOutputEvent]:
        self._state.closed = True
        logger.debug("seconds=<%s> | openai live final voice usage", event.usage.seconds)

        if event.reason == "expired":
            raise ConnectionTimeoutError("OpenAI Live session expired")

        if event.reason != "close_requested":
            raise ConnectionError(f"OpenAI Live session ended: {event.reason}")

        yield from self._to_strands_response_stop_event()
        yield BidiConnectionStopEvent(connection_id=self._state.connection_id, reason="user_request")

    def _to_strands_response_start_event(self) -> Iterator[BidiOutputEvent]:
        if self._state.response_id is None:
            self._state.response_id = str(uuid4())
            yield BidiResponseStartEvent(self._state.response_id)

    def _to_strands_response_stop_event(self) -> Iterator[BidiOutputEvent]:
        for delegation in self._state.delegations.values():
            for key, content_id in delegation.texts.items():
                if content_id is not None:
                    yield BidiTextStopEvent(content_id)
                    delegation.texts[key] = None

        if self._state.audio_id is not None:
            yield BidiAudioStopEvent(self._state.audio_id)
            self._state.audio_id = None

        if self._state.response_id is not None:
            yield BidiResponseStopEvent(self._state.response_id)
            self._state.response_id = None

    def _to_strands_audio_delta_event(self, event: OutputAudioDeltaEvent) -> Iterator[BidiOutputEvent]:
        yield from self._to_strands_response_start_event()

        if self._state.audio_id is None:
            self._state.audio_id = str(uuid4())
            yield BidiAudioStartEvent(self._state.audio_id)

        audio_config = self.get_audio_config()["output"]
        yield BidiAudioDeltaEvent(
            audio=event.delta,
            format=audio_config["format"],
            sample_rate=audio_config["sample_rate"],
            channels=audio_config["channels"],
            content_id=self._state.audio_id,
        )

    def _to_strands_transcript_delta_event(
        self, event: InputTranscriptDeltaEvent | OutputTranscriptDeltaEvent
    ) -> Iterator[BidiOutputEvent]:
        role: Literal["user", "assistant"] = "user" if isinstance(event, InputTranscriptDeltaEvent) else "assistant"
        content_id = str(uuid4())

        if role == "assistant":
            yield from self._to_strands_response_start_event()

        yield BidiTranscriptStartEvent(role=role, content_id=content_id)
        yield BidiTranscriptDeltaEvent(delta=event.delta, role=role, content_id=content_id)
        yield BidiTranscriptStopEvent(role=role, content_id=content_id)

    def _to_strands_response_events(self, event: ResponseEvent) -> Iterator[BidiOutputEvent]:
        """Translate delegated events, emitting tool calls together when the response completes.

        Each tool group starts a new synthetic Strands response.
        """
        response_event: dict[str, Any] = event.event
        event_type = response_event["type"]
        if event_type in {"response.failed", "response.incomplete", "error"}:
            self._to_strands_error(response_event)

        if event_type == "response.created":
            self._state.delegations[event.delegation_id] = _DelegationState(response_event["response"]["id"])
            return

        delegation = self._state.delegations.get(event.delegation_id)
        if delegation is None:
            return

        if event_type == "response.output_text.delta":
            yield from self._to_strands_text_delta_event(response_event, delegation)
        elif event_type == "response.output_text.done":
            yield from self._to_strands_text_stop_event(response_event, delegation)
        elif event_type == "response.output_item.done" and response_event["item"]["type"] == "function_call":
            delegation.tools.append(self._to_strands_tool_use(response_event["item"]))
        elif event_type == "response.completed":
            if response_event["response"]["id"] != delegation.response_id:
                raise ValueError("OpenAI Live completed an unexpected backend response")

            for content_id in delegation.texts.values():
                if content_id is not None:
                    yield BidiTextStopEvent(content_id)
            delegation.texts.clear()

            if delegation.tools:
                yield from self._to_strands_response_stop_event()
                yield from self._to_strands_response_start_event()
                yield BidiToolUseBlocksEvent(delegation.tools)

            usage = response_event["response"].get("usage")
            if usage:
                yield self._to_strands_usage_event(usage)

            del self._state.delegations[event.delegation_id]

    def _to_strands_error(self, event: dict[str, Any]) -> NoReturn:
        if event["type"] == "error":
            code = event.get("code", "backend_error")
            message = event.get("message", "Responses backend failed")
        else:
            response = event["response"]
            error = response.get("error") or response.get("incomplete_details") or {}
            code = error.get("code", event["type"])
            message = error.get("message", str(error))

        if code == "rate_limit_exceeded":
            raise ModelThrottledException(message)

        raise RuntimeError(f"OpenAI Live {code}: {message}")

    def _to_strands_text_delta_event(
        self, event: dict[str, Any], delegation: _DelegationState
    ) -> Iterator[BidiOutputEvent]:
        """Start a synthetic Strands response when a new backend text stream appears.

        Reopening a known stream preserves any active Strands response.
        """
        key = (event["item_id"], event["content_index"])
        if key not in delegation.texts:
            yield from self._to_strands_response_stop_event()

        content_id = delegation.texts.get(key)
        if content_id is None:
            yield from self._to_strands_response_start_event()
            content_id = str(uuid4())
            delegation.texts[key] = content_id
            yield BidiTextStartEvent(content_id)

        yield BidiTextDeltaEvent(
            delta=event["delta"] if "delta" in event else event["text"],
            content_id=content_id,
        )

    def _to_strands_text_stop_event(
        self, event: dict[str, Any], delegation: _DelegationState
    ) -> Iterator[BidiOutputEvent]:
        key = (event["item_id"], event["content_index"])
        if key not in delegation.texts:
            yield from self._to_strands_text_delta_event(event, delegation)

        content_id = delegation.texts.pop(key)
        if content_id is not None:
            yield BidiTextStopEvent(content_id)

    def _to_strands_tool_use(self, item: dict[str, Any]) -> ToolUse:
        self._state.pending_tools.add(item["call_id"])

        arguments = json.loads(item["arguments"])
        return {"toolUseId": item["call_id"], "name": item["name"], "input": arguments}

    def _to_strands_usage_event(self, usage: dict[str, Any]) -> BidiUsageEvent:
        return BidiUsageEvent(
            input_tokens=usage["input_tokens"],
            output_tokens=usage["output_tokens"],
            total_tokens=usage["total_tokens"],
            input_token_details={"cache_read": usage.get("input_tokens_details", {}).get("cached_tokens", 0)},
            output_token_details={"reasoning": usage.get("output_tokens_details", {}).get("reasoning_tokens", 0)},
        )
