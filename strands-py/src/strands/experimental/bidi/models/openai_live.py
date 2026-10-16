"""OpenAI GPT-Live provider for Strands bidirectional streaming.

GPT-Live is a full-duplex voice frontend that delegates reasoning and tool use to a Responses
backend. The protocol has no response, turn, or interruption events, so this provider derives
spoken bursts and transcript segments from audio activity and the session timeline. Delegated
function calls are surfaced as Strands tool groups, one per backend response.

This provider is experimental: its interface and behavior can change between minor releases.

Docs: https://developers.openai.com/api/docs/guides/live
"""

import array
import asyncio
import base64
import copy
import json
import logging
import math
import os
import re
import sys
import time
import uuid
from collections import OrderedDict, deque
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal, cast

import websockets
from typing_extensions import Unpack, override
from websockets import ClientConnection
from websockets.exceptions import ConnectionClosed, InvalidStatus

from strands.bidi._async import stop_all
from strands.bidi.models.configs import (
    AudioConfig,
    AudioStreamConfig,
    ConnectionConfig,
    ModelConfig,
    ModelUpdateConfig,
    _merge_config,
    _validate_audio_config,
    _validate_model_config,
)
from strands.bidi.models.model import AudioCapable, BidiModel, ConnectionTimeoutError
from strands.bidi.types.content import BidiContentDelta, BidiMessage
from strands.bidi.types.events import (
    BidiAudioDeltaEvent,
    BidiAudioStartEvent,
    BidiAudioStopEvent,
    BidiConnectionStartEvent,
    BidiOutputEvent,
    BidiResponseStartEvent,
    BidiResponseStopEvent,
    BidiToolUseBlocksEvent,
    BidiTranscriptDeltaEvent,
    BidiTranscriptStartEvent,
    BidiTranscriptStopEvent,
    BidiUsageEvent,
    TokenDetails,
)
from strands.bidi.types.media import AudioDelta
from strands.models._openai_errors import classify_openai_error
from strands.models._openai_responses_format import (
    encode_media_to_data_url,
    format_function_call_output,
    format_function_tool,
)
from strands.types.content import Message, Messages, TextBlock
from strands.types.exceptions import ContextWindowOverflowException, ModelThrottledException
from strands.types.media import ImageBlock
from strands.types.tools import ToolResultBlock, ToolResultContent, ToolSpec, ToolUse

logger = logging.getLogger(__name__)

OPENAI_LIVE_URL = "wss://api.openai.com/v1/live/sessions"
DEFAULT_SAMPLE_RATE = 24000
_SUPPORTED_SAMPLE_RATES = (16000, 24000)

# Proactive restart fires this many seconds before the server-reported expiry, covering the loop's
# warning lead and turn-boundary wait (10 s each), the close drain, and the next startup.
_RESTART_MARGIN_S = 60
_STARTUP_TIMEOUT_S = 15.0
# Bound on waiting for session.closed. Finalization takes ~9 s while a backend response still waits
# for a tool result, and longer for stored sessions while the recording is saved.
_CLOSE_TIMEOUT_S = 15.0
_STORED_CLOSE_TIMEOUT_S = 30.0
# The reader polls at this interval so segment timers fire without new server events.
_RECV_TICK_S = 0.2
_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

# Segmentation thresholds. GPT-Live provides no boundaries, so these are derived, not provider-native.
_ASSISTANT_IDLE_S = 0.7
# GPT-Live streams output audio continuously, silence included. Frames whose peak sample stays at or
# below this level (about -50 dBFS) are silence and do not count as assistant speech.
_SILENCE_PEAK = 100
# Captions trail audio, so a burst whose last activity was audio waits this much longer for its caption.
_TRANSCRIPT_GRACE_S = 0.15
_TIMELINE_GAP_MS = 1000
_USER_IDLE_S = 1.2
_USER_SEGMENT_MAX_CHARS = 4000

# Tool results that cannot be returned natively are spoken once the session is idle, or after this wait.
_LATE_RESULT_MAX_WAIT_S = 30.0
# Session appends are limited to 500 tokens.
_APPEND_MAX_CHARS = 1500

_HISTORY_MAX_MESSAGES = 127
_HISTORY_MAX_TOKENS = 7500
_CHARS_PER_TOKEN = 3.5
_HISTORY_TOOL_RESULT_MAX_CHARS = 1000

_MAX_TRACKED_COMMANDS = 256
_TOOL_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_RESTARTABLE_CLOSE_REASONS = frozenset({"expired", "connection_lost", "socket_closed"})
# A nested "error" ends its Responses stream like a failed response.
_FAILED_RESPONSE_EVENTS = frozenset({"response.failed", "response.incomplete", "error"})

_RESTART_INSTRUCTION = (
    "The connection was restored mid-conversation. Continue from the prior context: do not greet "
    "or re-introduce yourself, and keep the language in use."
)


class ConnectionClosedError(Exception):
    """GPT-Live closed the connection in a way that must not trigger an automatic restart.

    Raised from ``receive()`` when GPT-Live ends the session for a reason such as a safety filter, a
    remote hangup, or a close the agent did not request. Unlike ``ConnectionTimeoutError``, the agent
    loop does not restart the connection.

    Attributes:
        reason: Close reason reported by GPT-Live, such as ``"content"`` for a safety termination.
    """

    def __init__(self, reason: str) -> None:
        """Initialize error.

        Args:
            reason: Close reason reported by GPT-Live.
        """
        super().__init__(f"reason=<{reason}> | connection closed by provider")

        self.reason = reason


@dataclass
class _AssistantBurst:
    """One synthesized spoken response."""

    response_id: str
    last_activity: float
    last_was_audio: bool = False
    audio_content_id: str | None = None
    transcript_open: bool = False
    last_end_ms: int | None = None

    def deadline(self) -> float:
        """Wall-clock time at which the burst closes for inactivity."""
        grace = _TRANSCRIPT_GRACE_S if self.last_was_audio else 0.0
        return self.last_activity + _ASSISTANT_IDLE_S + grace

    def mark_activity(self, now: float, *, audio: bool) -> None:
        """Record assistant output."""
        self.last_activity = now
        self.last_was_audio = audio


@dataclass
class _UserSegment:
    """One synthesized user transcript segment."""

    content_id: str
    last_activity: float
    last_end_ms: int
    chars: int = 0


@dataclass
class _LateResult:
    """A completed tool result that is delivered as spoken commentary."""

    call_id: str
    content: str
    queued_at: float


@dataclass
class _ToolGroup:
    """Function calls collected from one backend response."""

    key: str
    delegation_id: str | None
    generation: int
    calls: list[ToolUse] = field(default_factory=list)
    error_outputs: list[dict[str, Any]] = field(default_factory=list)
    resolved: set[str] = field(default_factory=set)
    fallbacks: dict[str, _LateResult] = field(default_factory=dict)
    state: Literal["collecting", "awaiting_results", "continued", "failed"] = "collecting"

    @property
    def pending_ids(self) -> set[str]:
        """Emitted calls that have neither a submitted nor a late-delivered result."""
        return {call["toolUseId"] for call in self.calls} - self.resolved


@dataclass
class _Command:
    """A sent command tracked for error correlation."""

    kind: Literal["tool_result", "continue", "user_message", "commentary"]
    late_results: list[_LateResult] = field(default_factory=list)


@dataclass
class _Connection:
    """State bound to one GPT-Live session."""

    websocket: ClientConnection
    generation: int
    store: bool
    session_id: str = ""
    expires_at: float | None = None
    startup_events: deque[dict[str, Any]] = field(default_factory=deque)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    recv_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    closed: asyncio.Event = field(default_factory=asyncio.Event)
    closing: bool = False
    close_sent: bool = False
    close_reason: str | None = None
    fatal: Exception | None = None
    usage_seconds: float = 0.0
    burst: _AssistantBurst | None = None
    user: _UserSegment | None = None
    # Delegation ID (None when uncorrelated) -> its current backend response.
    delegation_groups: dict[str | None, str] = field(default_factory=dict)
    commands: OrderedDict[str, _Command] = field(default_factory=OrderedDict)
    user_input_pending: bool = False


class _LiveErrorDetails(RuntimeError):
    """Carrier for a GPT-Live error event, chained as the cause of the raised SDK exception."""

    def __init__(self, error: dict[str, Any]) -> None:
        super().__init__(error.get("message") or "GPT-Live error")
        self.code = error.get("code")


class OpenAILiveModel(BidiModel, AudioCapable):
    """OpenAI GPT-Live implementation for bidirectional streaming.

    The agent's system prompt configures the voice frontend. Task instructions and Strands tools are
    configured on the delegated Responses backend.
    """

    def __init__(
        self,
        *,
        backend_model_id: str,
        backend_instructions: str | None = None,
        api_key: str | None = None,
        organization: str | None = None,
        project: str | None = None,
        voice: str = "marin",
        **model_config: Unpack[ModelConfig],
    ) -> None:
        """Initialize the GPT-Live bidirectional model.

        Args:
            backend_model_id: Responses model that handles delegated work, such as ``gpt-6-luna``.
            backend_instructions: Instructions for the Responses backend: task procedures, tool use,
                and business rules. The agent's system prompt configures the voice frontend instead.
            api_key: OpenAI API key. Defaults to ``OPENAI_API_KEY``.
            organization: OpenAI organization. Defaults to ``OPENAI_ORGANIZATION``.
            project: OpenAI project. Defaults to ``OPENAI_PROJECT``.
            voice: Output voice. Fixed for the lifetime of each session.
            **model_config: Model configuration. ``model_id`` is the GPT-Live model, such as
                ``gpt-live-1``. ``params`` deep-merges into the session configuration, and
                ``params["delegation"]["responses"]`` configures the backend (reasoning, service tier,
                hosted ``web_search``).

        Raises:
            ValueError: If any of the following conditions apply:

                - Required model configuration fields are missing or ``model_id`` is empty.
                - ``backend_model_id`` is empty or the API key is missing.
                - ``params`` sets a provider-owned field, a delegation type, an unsupported hosted
                  tool, or an unsupported audio format.
        """
        _validate_model_config(model_config)
        if not isinstance(backend_model_id, str) or not backend_model_id:
            raise ValueError("backend_model_id must be a non-empty string")

        self.api_key = api_key if api_key is not None else os.getenv("OPENAI_API_KEY")
        if not self.api_key:
            raise ValueError(
                "OpenAI API key is required. Provide via api_key or set OPENAI_API_KEY environment variable."
            )
        self.organization = organization if organization is not None else os.getenv("OPENAI_ORGANIZATION")
        self.project = project if project is not None else os.getenv("OPENAI_PROJECT")

        params = dict(model_config.get("params") or {})
        _validate_params(params)
        self._resolve_audio_config(params)
        self._config = ModelConfig(**model_config)
        self._config["params"] = params
        self._config["connection"] = ConnectionConfig(**self._config.get("connection", {}))
        self._restart_deadline_overridden = "restart_after_s" in self._config["connection"]

        self._backend_model_id = backend_model_id
        self._backend_instructions = backend_instructions
        self._voice = voice

        self._connection_id: str | None = None
        self._connection: _Connection | None = None
        self._generation = 0
        self._usage_seconds_baseline = 0.0
        self._groups: dict[str, _ToolGroup] = {}
        self._call_groups: dict[str, str] = {}
        self._late_results: list[_LateResult] = []
        self._late_seen: set[str] = set()

        self._server_handlers: dict[str, Callable[[_Connection, dict[str, Any], float], Awaitable[list]]] = {
            "session.output_audio.delta": self._on_output_audio,
            "session.output_transcript.delta": self._on_output_transcript,
            "session.input_transcript.delta": self._on_input_transcript,
            "session.delegation.created": self._on_delegation_created,
            "session.usage.updated": self._on_usage_updated,
            "session.closed": self._on_session_closed,
            "response.event": self._on_response_event,
            "error": self._on_error,
        }
        self._backend_handlers: dict[str, Callable[[_Connection, dict[str, Any], str | None], Awaitable[list]]] = {
            "response.created": self._on_backend_created,
            "response.output_item.done": self._on_backend_output_item,
            "response.completed": self._on_backend_completed,
            **{event_type: self._on_backend_failed for event_type in _FAILED_RESPONSE_EVENTS},
        }

        logger.debug(
            "model=<%s>, backend_model=<%s> | openai gpt live model initialized",
            self._config["model_id"],
            backend_model_id,
        )

    @override
    def update_config(self, **model_config: Unpack[ModelUpdateConfig]) -> None:  # type: ignore[override]
        """Update the model configuration. Changes apply to the next connection.

        Args:
            **model_config: Configuration overrides.

        Raises:
            ValueError: If the resulting configuration is invalid.
        """
        _validate_model_config(self._config | model_config)
        if "params" in model_config:
            params = dict(model_config["params"] or {})
            _validate_params(params)
            self._resolve_audio_config(params)
            model_config["params"] = params
        if "connection" in model_config:
            self._restart_deadline_overridden = "restart_after_s" in model_config["connection"]
        self._config.update(model_config)

    @override
    def get_config(self) -> ModelConfig:
        """Return the model configuration by reference."""
        return self._config

    @override
    def get_audio_config(self) -> AudioConfig:
        """Get the resolved audio configuration."""
        return self._audio_config

    @property
    def usage_seconds(self) -> float:
        """Voice duration in seconds since ``start()``, including connections replaced by restarts.

        GPT-Live bills voice duration separately from the backend tokens reported in ``BidiUsageEvent``.
        """
        return self._usage_seconds_baseline + (self._connection.usage_seconds if self._connection else 0.0)

    def _resolve_audio_config(self, params: dict[str, Any]) -> None:
        """Resolve the single session audio format used for input and output."""
        audio_format = (params.get("audio") or {}).get("format") or {}
        format_type = audio_format.get("type", "audio/pcm")
        if format_type != "audio/pcm":
            raise ValueError(f"format=<{format_type}> | unsupported audio format, expected audio/pcm")
        sample_rate = audio_format.get("rate", DEFAULT_SAMPLE_RATE)
        if sample_rate not in _SUPPORTED_SAMPLE_RATES:
            raise ValueError(f"rate=<{sample_rate}> | unsupported sample rate, expected 16000 or 24000")

        stream = AudioStreamConfig(sample_rate=sample_rate, channels=1, format="pcm")
        self._audio_config = AudioConfig(input=stream, output=AudioStreamConfig(**stream))
        _validate_audio_config(self._audio_config)

    async def start(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **kwargs: Any,
    ) -> None:
        """Start a GPT-Live session and wait for ``session.started``.

        Args:
            system_prompt: Instructions for the voice frontend.
            tools: Strands tools exposed to the Responses backend.
            messages: Conversation history used to seed the session.
            **kwargs: Reserved for provider-specific options; currently unused.

        Raises:
            RuntimeError: If the model has already been started.
            ValueError: If a tool is invalid or the session rejects its configuration.
            ModelThrottledException: If the connection is rate limited.
            ConnectionTimeoutError: If the connection closes before the session starts.
            TimeoutError: If ``session.started`` does not arrive in time.
        """
        if self._connection_id:
            raise RuntimeError("model already started | call stop before starting again")

        self._groups.clear()
        self._call_groups.clear()
        self._late_results.clear()
        self._late_seen.clear()
        self._usage_seconds_baseline = 0.0
        await self._connect(system_prompt, tools, messages, restart=False)

    async def restart(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **restart_kwargs: Any,
    ) -> None:
        """Close the session and start a new one seeded with recent history.

        Tool calls from the previous session cannot be continued natively, so their results are
        delivered as spoken commentary on the new session.

        Args:
            system_prompt: Instructions for the voice frontend.
            tools: Strands tools exposed to the Responses backend.
            messages: Conversation history used to seed the new session.
            **restart_kwargs: Reserved for provider-specific restart options.
        """
        logger.debug("session_id=<%s> | openai gpt live restart starting", self._connection_id)
        await self.stop()
        await self._connect(system_prompt, tools, messages, restart=True)
        logger.debug("session_id=<%s> | openai gpt live restart complete", self._connection_id)

    async def _connect(
        self,
        system_prompt: str | None,
        tools: list[ToolSpec] | None,
        messages: Messages | None,
        *,
        restart: bool,
    ) -> None:
        """Open a socket, start the session, and make it the active connection."""
        session = self._build_session(system_prompt, tools, messages, restart=restart)
        websocket = await self._open_websocket()
        self._generation += 1
        connection = _Connection(websocket=websocket, generation=self._generation, store=bool(session.get("store")))

        try:
            await asyncio.wait_for(self._await_started(connection, session), timeout=_STARTUP_TIMEOUT_S)
        except asyncio.TimeoutError as error:
            await websocket.close()
            raise TimeoutError(f"startup_timeout_s=<{_STARTUP_TIMEOUT_S}> | session did not start") from error
        except BaseException:
            await websocket.close()
            raise

        self._connection = connection
        self._connection_id = connection.session_id
        self._apply_restart_deadline(connection)
        logger.debug(
            "session_id=<%s>, expires_at=<%s> | openai gpt live session started",
            connection.session_id,
            connection.expires_at,
        )

    def _build_session(
        self,
        system_prompt: str | None,
        tools: list[ToolSpec] | None,
        messages: Messages | None,
        *,
        restart: bool,
    ) -> dict[str, Any]:
        """Build the ``session.start`` configuration."""
        params = copy.deepcopy(self._config.get("params") or {})
        responses = (params.pop("delegation", None) or {}).get("responses") or {}
        hosted_tools = responses.pop("tools", None) or []

        session = _merge_config(
            {
                "audio": {
                    "format": {"type": "audio/pcm", "rate": self._audio_config["input"]["sample_rate"]},
                    "output": {"voice": self._voice},
                },
                "store": False,
            },
            params,
        )
        session["model"] = self._config["model_id"]
        if system_prompt:
            session["instructions"] = system_prompt
        history = _format_history(messages or [], restart=restart)
        if history:
            session["input"] = history

        backend: dict[str, Any] = {"model": self._backend_model_id, "parallel_tool_calls": True, **responses}
        if self._backend_instructions is not None:
            backend["instructions"] = self._backend_instructions
        backend["tools"] = [*hosted_tools, *(_format_tool(tool_spec) for tool_spec in tools or [])]
        session["delegation"] = {"type": "responses", "responses": backend}
        return cast(dict[str, Any], _drop_none(session))

    async def _open_websocket(self) -> ClientConnection:
        """Connect to the Live sessions endpoint, translating throttling."""
        headers = [("Authorization", f"Bearer {self.api_key}")]
        if self.organization:
            headers.append(("OpenAI-Organization", self.organization))
        if self.project:
            headers.append(("OpenAI-Project", self.project))

        try:
            return await websockets.connect(OPENAI_LIVE_URL, additional_headers=headers, max_size=_MAX_MESSAGE_BYTES)
        except InvalidStatus as error:
            if error.response.status_code == 429:
                raise ModelThrottledException(str(error)) from error
            raise

    async def _await_started(self, connection: _Connection, session: dict[str, Any]) -> None:
        """Send ``session.start`` and read until ``session.started``."""
        await self._send_command(connection, {"type": "session.start", "session": session})
        while True:
            try:
                raw = await connection.websocket.recv()
            except ConnectionClosed as error:
                raise ConnectionTimeoutError("session closed before session.started") from error

            event = _decode_event(raw)
            if event["type"] == "session.started":
                resource = event.get("session") or {}
                connection.session_id = resource.get("id") or str(uuid.uuid4())
                connection.expires_at = resource.get("expires_at")
                return
            if event["type"] == "error":
                error_data = event.get("error") or {}
                raise ValueError(
                    f"code=<{error_data.get('code')}>, param=<{error_data.get('param')}> | {error_data.get('message')}"
                ) from _LiveErrorDetails(error_data)
            connection.startup_events.append(event)

    def _apply_restart_deadline(self, connection: _Connection) -> None:
        """Restart proactively before the server-reported expiry unless the caller set a deadline."""
        if self._restart_deadline_overridden or connection.expires_at is None:
            return
        margin_s = _RESTART_MARGIN_S + (int(_STORED_CLOSE_TIMEOUT_S) if connection.store else 0)
        # A non-positive deadline disables the loop's timer, so near-expiry sessions restart after one second.
        restart_after_s = max(1, int(connection.expires_at - time.time()) - margin_s)
        self._config["connection"] = ConnectionConfig(
            **{**self._config.get("connection", {}), "restart_after_s": restart_after_s}
        )

    async def receive(self) -> AsyncGenerator[BidiOutputEvent, None]:
        """Receive GPT-Live events converted to Strands bidi events.

        Raises:
            RuntimeError: If the model has not been started.
            ConnectionTimeoutError: If the session expires or the connection is lost.
            ConnectionClosedError: If the provider ends the session for a non-restartable reason.
            ValueError: If the backend configuration is rejected or a frame is malformed.
        """
        connection = self._connection
        if connection is None or not self._connection_id:
            raise RuntimeError("model not started | call start before receiving")

        yield BidiConnectionStartEvent(connection_id=connection.session_id, model=self._config["model_id"])

        while True:
            for event in await self._read_events(connection):
                yield event
            if connection.close_reason is not None or connection.fatal is not None:
                await self._finish_reader(connection)
                return

    async def _read_events(self, connection: _Connection) -> list[BidiOutputEvent]:
        """Process one startup event or socket read, plus any segment timers that are due."""
        if connection.startup_events:
            return await self._handle(connection, connection.startup_events.popleft(), time.monotonic())

        now = time.monotonic()
        events = self._tick(connection, now)
        await self._flush_late_results(connection, now)

        try:
            async with connection.recv_lock:
                if connection.closed.is_set():
                    return events
                raw = await asyncio.wait_for(connection.websocket.recv(), timeout=_RECV_TICK_S)
        except asyncio.TimeoutError:
            return events
        except ConnectionClosed:
            connection.close_reason = connection.close_reason or "socket_closed"
            connection.closed.set()
            return [*events, *self._flush(connection)]

        return [*events, *(await self._handle(connection, _decode_event(raw), time.monotonic()))]

    async def _finish_reader(self, connection: _Connection) -> None:
        """End the reader, raising unless the session is closing at the agent's request."""
        if connection.fatal is not None:
            await self._request_close(connection)
            raise connection.fatal
        if connection.closing:
            return

        reason = connection.close_reason or "socket_closed"
        if reason == "socket_closed":
            logger.warning("session_id=<%s> | connection closed before session.closed", connection.session_id)
        if reason in _RESTARTABLE_CLOSE_REASONS:
            raise ConnectionTimeoutError(f"reason=<{reason}>")
        raise ConnectionClosedError(reason)

    async def _handle(self, connection: _Connection, event: dict[str, Any], now: float) -> list[BidiOutputEvent]:
        """Dispatch one server event."""
        event_type = event["type"]
        handler = self._server_handlers.get(event_type)
        if handler is not None:
            return cast(list[BidiOutputEvent], await handler(connection, event, now))
        logger.debug("event_type=<%s> | unhandled openai gpt live event", event_type)
        return []

    def _open_burst(self, connection: _Connection, now: float) -> list[BidiOutputEvent]:
        """Start a spoken burst if none is open."""
        if connection.burst is not None:
            return []
        connection.burst = _AssistantBurst(response_id=str(uuid.uuid4()), last_activity=now)
        return [BidiResponseStartEvent(response_id=connection.burst.response_id)]

    def _close_burst(self, connection: _Connection) -> list[BidiOutputEvent]:
        """Close the open burst's audio, transcript, and response, in that order."""
        burst = connection.burst
        if burst is None:
            return []
        connection.burst = None
        events: list[BidiOutputEvent] = []
        if burst.audio_content_id is not None:
            events.append(BidiAudioStopEvent(burst.audio_content_id))
        if burst.transcript_open:
            events.append(BidiTranscriptStopEvent("assistant", burst.response_id))
        events.append(BidiResponseStopEvent(burst.response_id))
        return events

    def _close_user(self, connection: _Connection) -> list[BidiOutputEvent]:
        """Close the open user transcript segment."""
        segment = connection.user
        if segment is None:
            return []
        connection.user = None
        return [BidiTranscriptStopEvent("user", segment.content_id)]

    def _flush(self, connection: _Connection) -> list[BidiOutputEvent]:
        """Close every open stream."""
        return [*self._close_burst(connection), *self._close_user(connection)]

    def _tick(self, connection: _Connection, now: float) -> list[BidiOutputEvent]:
        """Close segments that have been inactive long enough."""
        events: list[BidiOutputEvent] = []
        if connection.burst is not None and now >= connection.burst.deadline():
            events.extend(self._close_burst(connection))

        if connection.user is not None and now - connection.user.last_activity >= _USER_IDLE_S:
            events.extend(self._close_user(connection))
        return events

    async def _on_output_audio(
        self, connection: _Connection, event: dict[str, Any], now: float
    ) -> list[BidiOutputEvent]:
        """Stream assistant audio inside a burst. Silence opens no burst and does not extend one."""
        silent = _is_silent(event["delta"])
        if silent and connection.burst is None:
            return []
        events = self._open_burst(connection, now)
        burst = cast(_AssistantBurst, connection.burst)
        if burst.audio_content_id is None:
            burst.audio_content_id = str(uuid.uuid4())
            events.append(BidiAudioStartEvent(burst.audio_content_id))
        if not silent:
            burst.mark_activity(now, audio=True)

        events.append(
            BidiAudioDeltaEvent(
                audio=event["delta"],
                content_id=burst.audio_content_id,
                **self._audio_config["output"],
            )
        )
        return events

    async def _on_output_transcript(
        self, connection: _Connection, event: dict[str, Any], now: float
    ) -> list[BidiOutputEvent]:
        """Stream the assistant transcript, splitting bursts on timeline gaps."""
        start_ms, end_ms = event.get("start_ms", 0), event.get("end_ms", 0)
        events: list[BidiOutputEvent] = []
        burst = connection.burst
        if burst is not None and burst.last_end_ms is not None and start_ms - burst.last_end_ms > _TIMELINE_GAP_MS:
            events.extend(self._close_burst(connection))

        events.extend(self._open_burst(connection, now))
        burst = cast(_AssistantBurst, connection.burst)
        if not burst.transcript_open:
            burst.transcript_open = True
            events.append(BidiTranscriptStartEvent("assistant", burst.response_id))
        burst.last_end_ms = end_ms
        burst.mark_activity(now, audio=False)

        if event.get("delta"):
            events.append(BidiTranscriptDeltaEvent(event["delta"], "assistant", burst.response_id))
        return events

    async def _on_input_transcript(
        self, connection: _Connection, event: dict[str, Any], now: float
    ) -> list[BidiOutputEvent]:
        """Stream the user transcript, splitting segments on timeline gaps and size."""
        start_ms, end_ms = event.get("start_ms", 0), event.get("end_ms", 0)
        delta = event.get("delta", "")
        events: list[BidiOutputEvent] = []
        segment = connection.user
        if segment is not None and start_ms - segment.last_end_ms > _TIMELINE_GAP_MS:
            events.extend(self._close_user(connection))

        if connection.user is None:
            connection.user = _UserSegment(content_id=str(uuid.uuid4()), last_activity=now, last_end_ms=end_ms)
            events.append(BidiTranscriptStartEvent("user", connection.user.content_id))
        segment = connection.user
        segment.last_activity = now
        segment.last_end_ms = end_ms
        if delta:
            segment.chars += len(delta)
            events.append(BidiTranscriptDeltaEvent(delta, "user", segment.content_id))
        if segment.chars >= _USER_SEGMENT_MAX_CHARS:
            events.extend(self._close_user(connection))
        return events

    async def _on_delegation_created(
        self, connection: _Connection, event: dict[str, Any], now: float
    ) -> list[BidiOutputEvent]:
        """Log a delegation for latency tracing. Its backend response is tracked from response.created."""
        delegation = event.get("delegation") or {}
        logger.debug(
            "session_id=<%s>, delegation_id=<%s>, target=<%s>, offset_ms=<%s> | delegation received",
            connection.session_id,
            delegation.get("id"),
            delegation.get("target"),
            event.get("offset_ms"),
        )
        return []

    async def _on_usage_updated(
        self, connection: _Connection, event: dict[str, Any], now: float
    ) -> list[BidiOutputEvent]:
        """Track the connection's voice duration. Reported values are totals, never summed."""
        connection.usage_seconds = float((event.get("usage") or {}).get("seconds", connection.usage_seconds))
        return []

    async def _on_session_closed(
        self, connection: _Connection, event: dict[str, Any], now: float
    ) -> list[BidiOutputEvent]:
        """Record the close reason and final usage, then close every stream."""
        connection.close_reason = event.get("reason") or "close_requested"
        connection.usage_seconds = float((event.get("usage") or {}).get("seconds", connection.usage_seconds))
        connection.closed.set()
        logger.debug(
            "session_id=<%s>, reason=<%s>, usage_seconds=<%s> | openai gpt live session closed",
            connection.session_id,
            connection.close_reason,
            connection.usage_seconds,
        )
        return self._flush(connection)

    async def _on_error(self, connection: _Connection, event: dict[str, Any], now: float) -> list[BidiOutputEvent]:
        """Route an error to the session, a rejected command, or the voice output."""
        error = event.get("error") or {}
        code = error.get("code") or ""
        client_event_id = error.get("client_event_id") or event.get("client_event_id")
        command = connection.commands.pop(client_event_id, None) if client_event_id else None
        details = _LiveErrorDetails(error)

        if code == "responses_validation_failed":
            connection.fatal = ValueError(
                f"code=<{code}>, param=<{error.get('param')}> | backend configuration rejected: {details}"
            )
            connection.fatal.__cause__ = details
            return []

        if command is not None:
            self._on_command_rejected(command, code)
            return []

        kind = classify_openai_error(details)
        if kind is not None:
            exception_type = ModelThrottledException if kind == "throttling" else ContextWindowOverflowException
            connection.fatal = exception_type(str(details))
            connection.fatal.__cause__ = details
            return []

        logger.warning(
            "session_id=<%s>, code=<%s>, type=<%s>, param=<%s> | openai gpt live error",
            connection.session_id,
            code,
            error.get("type"),
            error.get("param"),
        )
        return []

    def _on_command_rejected(self, command: _Command, code: str) -> None:
        """Log a rejected command and deliver any tool outcome it carried as commentary."""
        logger.warning("kind=<%s>, code=<%s> | openai gpt live command rejected", command.kind, code)
        for late_result in command.late_results:
            self._queue_late_result(late_result)

    async def _on_response_event(
        self, connection: _Connection, event: dict[str, Any], now: float
    ) -> list[BidiOutputEvent]:
        """Dispatch a nested Responses backend event."""
        inner = event.get("event") or {}
        handler = self._backend_handlers.get(str(inner.get("type")))
        if handler is None:
            logger.debug("backend_event_type=<%s> | unhandled backend event", inner.get("type"))
            return []
        return cast(list[BidiOutputEvent], await handler(connection, inner, event.get("delegation_id")))

    def _resolve_group(
        self, connection: _Connection, delegation_id: str | None, response_id: str | None = None
    ) -> _ToolGroup | None:
        """Find the backend response a nested event belongs to."""
        key = response_id if response_id in self._groups else connection.delegation_groups.get(delegation_id)
        return self._groups.get(key) if key else None

    async def _on_backend_created(
        self, connection: _Connection, inner: dict[str, Any], delegation_id: str | None
    ) -> list[BidiOutputEvent]:
        """Track a new backend response."""
        response_id = (inner.get("response") or {}).get("id") or str(uuid.uuid4())
        self._groups[response_id] = _ToolGroup(
            key=response_id, delegation_id=delegation_id, generation=connection.generation
        )
        connection.delegation_groups[delegation_id] = response_id
        logger.debug("delegation_id=<%s>, response_id=<%s> | backend response created", delegation_id, response_id)
        return []

    async def _on_backend_output_item(
        self, connection: _Connection, inner: dict[str, Any], delegation_id: str | None
    ) -> list[BidiOutputEvent]:
        """Collect a completed function call. Argument deltas are never executed."""
        item = inner.get("item") or {}
        if item.get("type") != "function_call":
            logger.debug("item_type=<%s> | backend output item", item.get("type"))
            return []

        group = self._resolve_group(connection, delegation_id)
        if group is None:
            group = _ToolGroup(key=str(uuid.uuid4()), delegation_id=delegation_id, generation=connection.generation)
            self._groups[group.key] = group
            connection.delegation_groups[delegation_id] = group.key

        call_id = item["call_id"]
        self._call_groups[call_id] = group.key
        arguments = _parse_arguments(item.get("arguments"))
        if arguments is None:
            logger.warning("call_id=<%s>, tool_name=<%s> | malformed tool arguments", call_id, item.get("name"))
            group.error_outputs.append(
                {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": json.dumps({"error": "The tool arguments were not valid JSON. The tool did not run."}),
                }
            )
            return []

        group.calls.append(ToolUse(toolUseId=call_id, name=item["name"], input=arguments))
        return []

    async def _on_backend_completed(
        self, connection: _Connection, inner: dict[str, Any], delegation_id: str | None
    ) -> list[BidiOutputEvent]:
        """Emit the response's tool group, then its token usage."""
        response = inner.get("response") or {}
        events: list[BidiOutputEvent] = []
        group = self._resolve_group(connection, delegation_id, response.get("id"))
        if group is not None and group.state == "collecting":
            events.extend(await self._complete_group(connection, group))
        if usage := response.get("usage"):
            events.append(_convert_usage(usage))
        return events

    async def _complete_group(self, connection: _Connection, group: _ToolGroup) -> list[BidiOutputEvent]:
        """Hand Strands calls to the agent, or continue directly when only error outputs exist."""
        if group.calls:
            group.state = "awaiting_results"
            logger.debug("response_id=<%s>, tool_count=<%d> | tool group emitted", group.key, len(group.calls))
            return [BidiToolUseBlocksEvent(list(group.calls))]
        if group.error_outputs:
            group.state = "awaiting_results"
            await self._maybe_continue(connection, group)
            return []
        self._retire_group(group)
        return []

    async def _on_backend_failed(
        self, connection: _Connection, inner: dict[str, Any], delegation_id: str | None
    ) -> list[BidiOutputEvent]:
        """Stop continuation for a failed backend response. Results still running are delivered later."""
        response = inner.get("response") or {}
        group = self._resolve_group(connection, delegation_id, response.get("id"))
        logger.warning(
            "response_id=<%s>, status=<%s>, code=<%s> | backend response did not complete",
            response.get("id"),
            response.get("status") or inner.get("type"),
            (response.get("error") or {}).get("code") or inner.get("code"),
        )
        if group is not None:
            self._fail_group(connection, group)
        if connection.user_input_pending and not self._has_awaiting_group(connection):
            connection.user_input_pending = False
            await self._send_command(connection, {"type": "response.create"}, _Command("continue"))
        usage = response.get("usage")
        return [_convert_usage(usage)] if usage else []

    def _fail_group(self, connection: _Connection, group: _ToolGroup) -> None:
        """Mark a group failed; drop it when no emitted call is still running."""
        if group.state == "collecting" or not group.pending_ids:
            self._retire_group(group)
            return
        group.state = "failed"

    def _has_awaiting_group(self, connection: _Connection) -> bool:
        """Whether the current session has a backend response waiting for tool results."""
        return any(
            group.state == "awaiting_results" and group.generation == connection.generation
            for group in self._groups.values()
        )

    def _retire_group(self, group: _ToolGroup) -> None:
        """Forget a group whose calls need no further routing."""
        self._groups.pop(group.key, None)
        call_ids = [call["toolUseId"] for call in group.calls] + [item["call_id"] for item in group.error_outputs]
        for call_id in call_ids:
            self._call_groups.pop(call_id, None)

    async def send(self, content: BidiMessage | BidiContentDelta) -> None:
        """Send audio, tool results, or typed input.

        Tool results continue the backend response that requested them. Text and images are sent to
        the Responses backend as a user message.

        Args:
            content: A complete BidiMessage or an individual AudioDelta.

        Raises:
            RuntimeError: If the model is not started or the session is closing.
            ValueError: If the content is unsupported or a tool result references an unknown call.
        """
        connection = self._connection
        if connection is None or not self._connection_id:
            raise RuntimeError("model not started | call start before sending")
        if connection.closing:
            raise RuntimeError("session closing | cannot send")

        if isinstance(content, AudioDelta):
            await self._send_audio(connection, content)
        elif isinstance(content, BidiMessage) and content.content and isinstance(content.content[0], ToolResultBlock):
            await self._send_tool_results(connection, content)
        elif isinstance(content, BidiMessage):
            await self._send_user_message(connection, content)
        else:
            raise ValueError(f"content_type=<{type(content)}> | content not supported")

    async def _send_audio(self, connection: _Connection, audio_input: AudioDelta) -> None:
        """Append input audio. Audio appends have no acknowledgment."""
        audio_bytes = audio_input.source.get("bytes")
        if audio_bytes is None:
            raise ValueError("audio source must contain bytes for OpenAI GPT-Live")
        payload = {"type": "session.input_audio.append", "audio": base64.b64encode(audio_bytes).decode("utf-8")}
        async with connection.send_lock:
            await connection.websocket.send(json.dumps(payload))

    async def _send_user_message(self, connection: _Connection, message: BidiMessage) -> None:
        """Queue typed text and images for the backend, then run it unless tools are pending."""
        parts = [_format_user_block(block) for block in message.content]
        item = {"type": "message", "role": "user", "content": parts}
        await self._send_command(connection, {"type": "response.item.create", "item": item}, _Command("user_message"))
        if self._has_awaiting_group(connection):
            # The pending tool continuation runs the backend with this message included.
            connection.user_input_pending = True
            return
        await self._send_command(connection, {"type": "response.create"}, _Command("continue"))

    async def _send_tool_results(self, connection: _Connection, message: BidiMessage) -> None:
        """Return results natively, or as commentary when their backend response cannot continue."""
        results = [cast(ToolResultBlock, block) for block in message.content]
        routes = {result.tool_use_id: self._route_result(connection, result.tool_use_id) for result in results}
        unknown = [call_id for call_id, route in routes.items() if route == "unknown"]
        if unknown:
            raise ValueError(f"tool_use_ids=<{unknown}> | tool results reference unknown calls")

        touched: dict[str, _ToolGroup] = {}
        for result in results:
            route = routes[result.tool_use_id]
            group = self._groups[self._call_groups[result.tool_use_id]]
            late_result = self._late_result_for(group, result)
            group.resolved.add(result.tool_use_id)
            if route == "late":
                self._queue_late_result(late_result)
            else:
                await self._submit_result(connection, group, result, late_result)
                touched[group.key] = group
            if route == "late" and not group.pending_ids:
                self._retire_group(group)

        for group in touched.values():
            await self._maybe_continue(connection, group)

    def _route_result(self, connection: _Connection, call_id: str) -> Literal["native", "late", "unknown"]:
        """Decide how a tool result reaches the model."""
        group_key = self._call_groups.get(call_id)
        if group_key is None or group_key not in self._groups:
            return "unknown"
        group = self._groups[group_key]
        if group.generation != connection.generation or group.state == "failed":
            return "late"
        return "native"

    def _late_result_for(self, group: _ToolGroup, result: ToolResultBlock) -> _LateResult:
        """Render a result as commentary, used when it cannot be returned natively."""
        tool_name = next((call["name"] for call in group.calls if call["toolUseId"] == result.tool_use_id), "tool")
        text = _render_tool_result(result.content, result.status)
        content = _truncate(
            f"Result of {tool_name} (already completed; do not call it again): {text}", _APPEND_MAX_CHARS
        )
        return _LateResult(call_id=result.tool_use_id, content=content, queued_at=time.monotonic())

    async def _submit_result(
        self, connection: _Connection, group: _ToolGroup, result: ToolResultBlock, late_result: _LateResult
    ) -> None:
        """Send one function output for a pending call."""
        item = _format_tool_output(result)
        group.fallbacks[result.tool_use_id] = late_result
        await self._send_command(
            connection,
            {"type": "response.item.create", "item": item},
            _Command("tool_result", late_results=[late_result]),
        )

    async def _maybe_continue(self, connection: _Connection, group: _ToolGroup) -> None:
        """Send one continuation once every call in the group has an output."""
        if group.state != "awaiting_results" or group.pending_ids:
            return
        group.state = "continued"
        try:
            for item in group.error_outputs:
                await self._send_command(connection, {"type": "response.item.create", "item": item})
            await self._send_command(
                connection,
                {"type": "response.create"},
                _Command("continue", late_results=list(group.fallbacks.values())),
            )
        except BaseException:
            group.state = "awaiting_results"
            raise
        connection.user_input_pending = False
        logger.debug("response_id=<%s> | backend continuation sent", group.key)
        self._retire_group(group)

    def _queue_late_result(self, late_result: _LateResult) -> None:
        """Queue a tool outcome for spoken delivery, at most once per call."""
        if late_result.call_id in self._late_seen:
            return
        self._late_seen.add(late_result.call_id)
        self._late_results.append(late_result)

    async def _flush_late_results(self, connection: _Connection, now: float) -> None:
        """Deliver queued tool outcomes when the conversation is idle or the wait cap passes."""
        if not self._late_results or connection is not self._connection or connection.closing:
            return
        idle = connection.burst is None and connection.user is None
        ready = [result for result in self._late_results if idle or now - result.queued_at >= _LATE_RESULT_MAX_WAIT_S]
        for late_result in ready:
            self._late_results.remove(late_result)
            try:
                await self._send_command(
                    connection,
                    {"type": "session.commentary.append", "delegation_id": None, "content": late_result.content},
                    _Command("commentary"),
                )
            except Exception as error:
                logger.warning("call_id=<%s>, error=<%s> | failed to deliver tool result", late_result.call_id, error)

    async def _send_command(
        self, connection: _Connection, payload: dict[str, Any], command: _Command | None = None
    ) -> None:
        """Send a client command with an event ID, tracking it for error correlation."""
        event_id = uuid.uuid4().hex
        if command is not None:
            connection.commands[event_id] = command
            while len(connection.commands) > _MAX_TRACKED_COMMANDS:
                connection.commands.popitem(last=False)
        async with connection.send_lock:
            await connection.websocket.send(json.dumps({**payload, "event_id": event_id}))
        logger.debug("event_type=<%s> | openai gpt live command sent", payload["type"])

    async def stop(self) -> None:
        """Close the session gracefully and release the connection.

        Sends ``session.close`` and waits for ``session.closed`` so final usage is confirmed.
        """
        connection = self._connection
        if connection is None:
            return
        self._connection = None
        self._connection_id = None
        logger.debug("session_id=<%s> | openai gpt live connection cleanup starting", connection.session_id)

        async def close_session() -> None:
            await self._close_session(connection)

        async def close_websocket() -> None:
            await connection.websocket.close()

        await stop_all(close_session, close_websocket)
        self._usage_seconds_baseline += connection.usage_seconds
        logger.debug("session_id=<%s> | openai gpt live connection closed", connection.session_id)

    async def _close_session(self, connection: _Connection) -> None:
        """Request close and wait for finalization, bounded by the close timeout."""
        connection.closing = True
        if connection.closed.is_set():
            return
        timeout_s = _STORED_CLOSE_TIMEOUT_S if connection.store else _CLOSE_TIMEOUT_S
        try:
            await asyncio.wait_for(self._drain_until_closed(connection), timeout=timeout_s)
        except asyncio.TimeoutError:
            pass
        if connection.close_reason is None or connection.close_reason == "socket_closed":
            logger.warning("session_id=<%s> | session finalization unconfirmed", connection.session_id)

    async def _request_close(self, connection: _Connection) -> None:
        """Send ``session.close`` once, tolerating a socket that is already closed."""
        connection.closing = True
        if connection.close_sent or connection.closed.is_set():
            return
        connection.close_sent = True
        try:
            await self._send_command(connection, {"type": "session.close"})
        except ConnectionClosed:
            logger.debug("session_id=<%s> | socket closed before session.close", connection.session_id)

    async def _drain_until_closed(self, connection: _Connection) -> None:
        """Read until ``session.closed``. Events read here are not delivered to the agent."""
        await self._request_close(connection)
        while not connection.closed.is_set():
            async with connection.recv_lock:
                if connection.closed.is_set():
                    return
                try:
                    raw = await connection.websocket.recv()
                except ConnectionClosed:
                    connection.close_reason = connection.close_reason or "socket_closed"
                    connection.closed.set()
                    return
            try:
                await self._handle(connection, _decode_event(raw), time.monotonic())
            except ValueError as error:
                logger.debug("error=<%s> | ignoring malformed frame during close", error)


def _validate_params(params: dict[str, Any]) -> None:
    """Reject provider-owned fields and unsupported delegation settings in session params."""
    reserved = sorted({"model", "instructions", "input"} & params.keys())
    if reserved:
        raise ValueError(f"params=<{reserved}> | fields are set by the provider and cannot be overridden")

    delegation = params.get("delegation")
    if delegation is None:
        return
    if not isinstance(delegation, dict) or set(delegation) - {"responses"}:
        raise ValueError(
            "params.delegation only accepts responses settings; client delegation is not supported by this provider"
        )

    responses = delegation.get("responses") or {}
    reserved = sorted({"model", "instructions"} & responses.keys())
    if reserved:
        raise ValueError(
            f"params.delegation.responses=<{reserved}> | use backend_model_id and backend_instructions instead"
        )
    for tool in responses.get("tools") or []:
        if tool != {"type": "web_search"}:
            raise ValueError(
                f"tool_type=<{tool.get('type') if isinstance(tool, dict) else tool}> | only web_search hosted "
                "tools are supported; pass function tools to the agent"
            )


def _format_tool(tool_spec: ToolSpec) -> dict[str, Any]:
    """Validate a Strands tool and convert it to a Responses function tool."""
    name = tool_spec["name"]
    if not _TOOL_NAME_PATTERN.match(name):
        raise ValueError(f"tool_name=<{name}> | tool names must match {_TOOL_NAME_PATTERN.pattern}")

    input_schema = cast(dict[str, Any], tool_spec["inputSchema"])
    schema = input_schema.get("json", input_schema)
    if isinstance(schema, str):
        schema = json.loads(schema)
    if not isinstance(schema, dict) or schema.get("type", "object") != "object":
        raise ValueError(f"tool_name=<{name}> | tool input schema must be a JSON object schema")
    return format_function_tool(cast(ToolSpec, {**tool_spec, "inputSchema": {"json": schema}}))


def _format_tool_output(result: ToolResultBlock) -> dict[str, Any]:
    """Format a tool result. Live is not verified to accept array outputs, so media is replaced by text."""
    content = result.content
    if any("image" in part or "document" in part for part in content):
        logger.warning("tool_use_id=<%s> | media tool output sent as text", result.tool_use_id)
        content = [{"text": _render_tool_result(content, "success")}]
    return format_function_call_output({"toolUseId": result.tool_use_id, "status": result.status, "content": content})


def _format_user_block(block: object) -> dict[str, Any]:
    """Convert a typed input block to a Responses content part."""
    if isinstance(block, TextBlock):
        return {"type": "input_text", "text": block.text}
    if isinstance(block, ImageBlock):
        image_bytes = block.source.get("bytes")
        if image_bytes is None:
            raise ValueError("image source must contain bytes for OpenAI GPT-Live")
        return {"type": "input_image", "image_url": encode_media_to_data_url(image_bytes, block.format, "image")}
    raise ValueError(f"content_type=<{type(block)}> | content not supported by OpenAI GPT-Live")


def _decode_event(raw: str | bytes) -> dict[str, Any]:
    """Decode one server frame."""
    try:
        event = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("malformed openai gpt live frame") from error
    if not isinstance(event, dict) or not isinstance(event.get("type"), str):
        raise ValueError("openai gpt live frame has no event type")
    return event


def _is_silent(audio: str) -> bool:
    """Whether a base64 PCM16LE frame carries no audible signal."""
    data = base64.b64decode(audio)
    samples = array.array("h", data[: len(data) - len(data) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    return max(samples, default=0) <= _SILENCE_PEAK and min(samples, default=0) >= -_SILENCE_PEAK


def _drop_none(value: Any) -> Any:
    """Remove ``None`` entries recursively, so an explicit ``None`` in params omits the field."""
    if isinstance(value, dict):
        return {key: _drop_none(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_drop_none(item) for item in value]
    return value


def _parse_arguments(arguments: Any) -> dict[str, Any] | None:
    """Parse final function arguments, returning None when they are not a JSON object."""
    try:
        parsed = json.loads(arguments or "{}")
    except (TypeError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _convert_usage(usage: dict[str, Any]) -> BidiUsageEvent:
    """Convert backend token usage to an additive usage event."""
    cached = (usage.get("input_tokens_details") or {}).get("cached_tokens")
    reasoning = (usage.get("output_tokens_details") or {}).get("reasoning_tokens")
    return BidiUsageEvent(
        input_tokens=usage.get("input_tokens", 0),
        output_tokens=usage.get("output_tokens", 0),
        total_tokens=usage.get("total_tokens", 0),
        input_token_details=cast(TokenDetails, {"cache_read": cached}) if cached is not None else None,
        output_token_details=cast(TokenDetails, {"reasoning": reasoning}) if reasoning is not None else None,
    )


def _render_tool_result(content: list[ToolResultContent], status: str) -> str:
    """Render tool result content as plain text."""
    parts = []
    for part in content:
        if "text" in part:
            parts.append(part["text"])
        elif "json" in part:
            parts.append(json.dumps(part["json"], ensure_ascii=False))
        else:
            parts.append(f"[{next(iter(part), 'content')} omitted]")
    text = "\n".join(parts)
    return f"The tool failed: {text}" if status == "error" else text


def _truncate(text: str, max_chars: int) -> str:
    """Shorten text to a character budget, marking the cut."""
    return text if len(text) <= max_chars else text[: max_chars - 1].rstrip() + "…"


def _format_history(messages: Messages, *, restart: bool) -> list[dict[str, Any]]:
    """Convert recent history to GPT-Live startup input: one text part per message, newest first within budget."""
    tool_names = {
        block["toolUse"]["toolUseId"]: block["toolUse"]["name"]
        for message in messages
        for block in message.get("content", [])
        if "toolUse" in block
    }
    entries: list[tuple[str, str]] = []
    for message in messages:
        entry = _history_entry(message, tool_names)
        if entry is None:
            continue
        if entries and entries[-1][0] == entry[0]:
            entries[-1] = (entry[0], f"{entries[-1][1]}\n{entry[1]}")
        else:
            entries.append(entry)

    items = [_input_item(role, text) for role, text in _fit_history_budget(entries)]
    if restart:
        items.append(_input_item("developer", _RESTART_INSTRUCTION))
    return items


def _history_entry(message: Message, tool_names: dict[str, str]) -> tuple[str, str] | None:
    """Convert one message to a (role, text) history entry, or None when it should be skipped."""
    bidi = cast(dict[str, Any], message.get("metadata") or {}).get("custom", {}).get("bidi", {})
    if bidi.get("status") in ("pending", "incomplete") or bidi.get("kind") in ("reasoning", "tool_dispatch"):
        return None

    content = message.get("content", [])
    tool_results = [block["toolResult"] for block in content if "toolResult" in block]
    if tool_results:
        lines = [
            f"Backend result for {tool_names.get(result['toolUseId'], 'tool')}: "
            + _truncate(
                _render_tool_result(result["content"], result.get("status", "success")), _HISTORY_TOOL_RESULT_MAX_CHARS
            )
            for result in tool_results
        ]
        return "developer", "\n".join(lines)

    text = "\n".join(block["text"] for block in content if block.get("text")).strip()
    if not text:
        return None
    return message["role"], text


def _fit_history_budget(entries: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Keep the newest entries that fit the message and estimated token budgets."""
    selected: list[tuple[str, str]] = []
    remaining_tokens = _HISTORY_MAX_TOKENS
    for role, text in reversed(entries):
        tokens = math.ceil(len(text) / _CHARS_PER_TOKEN)
        if len(selected) >= _HISTORY_MAX_MESSAGES or tokens > remaining_tokens:
            break
        selected.append((role, text))
        remaining_tokens -= tokens

    dropped = len(entries) - len(selected)
    if dropped:
        logger.debug("dropped_count=<%d> | history trimmed to fit gpt live startup budget", dropped)
    return list(reversed(selected))


def _input_item(role: str, text: str) -> dict[str, Any]:
    """Build one GPT-Live startup message."""
    content_type = "output_text" if role == "assistant" else "input_text"
    return {"type": "message", "role": role, "content": [{"type": content_type, "text": text}]}
