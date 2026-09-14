"""Amazon Bedrock Nova Sonic provider for real-time streaming conversations.

Implements the BidiModel interface for Amazon's Nova Sonic, handling the
complex event sequencing and audio processing required by Nova Sonic's
InvokeModelWithBidirectionalStream protocol.

Nova Sonic specifics:

- Hierarchical event sequences: connectionStart → promptStart → content streaming
- Base64-encoded audio format with hex encoding
- Tool execution with content containers and identifier tracking
- 8-minute connection limits with proper cleanup sequences
- Interruption detection through stopReason events

Note, BedrockNovaSonicModel is only supported for Python 3.12+
"""

import sys
from typing import TYPE_CHECKING

if not TYPE_CHECKING and sys.version_info < (3, 12):
    raise ImportError("BedrockNovaSonicModel is only supported for Python 3.12+")

import asyncio
import base64
import json
import logging
import uuid
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Any, Literal, TypedDict, cast

import boto3
from aws_sdk_bedrock_runtime.client import AsyncBedrockRuntimeClient, InvokeModelWithBidirectionalStreamOperationInput
from aws_sdk_bedrock_runtime.config import AsyncBedrockRuntimeConfig, HTTPAuthSchemeResolver, SigV4AuthScheme
from aws_sdk_bedrock_runtime.models import (
    BidirectionalInputPayloadPart,
    InvokeModelWithBidirectionalStreamInputChunk,
    ModelTimeoutException,
    ValidationException,
)
from boto3.session import Session
from smithy_aws_core.identity.static import StaticCredentialsResolver
from smithy_core.aio.eventstream import DuplexEventStream
from smithy_core.shapes import ShapeID
from smithy_http.aio.crt import AWSCRTHTTPClient, AWSCRTHTTPResponse
from typing_extensions import Unpack, override

from ....models._validation import validate_config_keys, validate_region
from ....types._events import ToolResultEvent, ToolUseStreamEvent
from ....types.content import Messages
from ....types.tools import ToolResult, ToolSpec, ToolUse
from .._async import stop_all
from ..types.events import (
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiConnectionStartEvent,
    BidiInputEvent,
    BidiInterruptionEvent,
    BidiOutputEvent,
    BidiResponseCompleteEvent,
    BidiResponseStartEvent,
    BidiTextInputEvent,
    BidiTranscriptCompleteEvent,
    BidiTranscriptStreamEvent,
    BidiUsageEvent,
)
from .configs import (
    AudioConfig,
    AudioStreamConfig,
    BidiConnectionConfig,
    BidiModelConfig,
    _validate_audio_config,
    _validate_model_config,
)
from .model import AudioCapable, BidiModel, BidiModelTimeoutError

logger = logging.getLogger(__name__)

# Nova Sonic model identifiers
NOVA_SONIC_V1_MODEL_ID = "amazon.nova-sonic-v1:0"
NOVA_SONIC_V2_MODEL_ID = "amazon.nova-2-sonic-v1:0"

NOVA_TEXT_CONFIG = {"mediaType": "text/plain"}
NOVA_TOOL_CONFIG = {"mediaType": "application/json"}

_MAX_HISTORY_MESSAGE_BYTES = 50 * 1024  # 50KB per message
_MAX_HISTORY_TOTAL_BYTES = 200 * 1024  # 200KB total history

_STRANDS_USER_AGENT_EXTRA = "strands-agents"

# TODO: Remove the CRT lifecycle workaround when both upstream issues are fixed:
# https://github.com/aws/aws-sdk-python/issues/13
# https://github.com/awslabs/aws-crt-python/issues/762
_AWS_ERROR_HTTP_STREAM_HAS_COMPLETED = 2080


def _is_http_stream_completed_error(error: BaseException) -> bool:
    """Return whether a CRT write observed an already-completed HTTP stream."""
    if getattr(error, "code", None) == _AWS_ERROR_HTTP_STREAM_HAS_COMPLETED:
        return True
    return isinstance(error, RuntimeError) and "AWS_ERROR_HTTP_STREAM_HAS_COMPLETED" in str(error)


class _BedrockAWSCRTHTTPClient(AWSCRTHTTPClient):
    """Observe CRT request writers so their terminal results are always consumed."""

    async def _await_response(self, stream: Any) -> AWSCRTHTTPResponse:
        writer_task = getattr(stream, "_writer", None)
        if isinstance(writer_task, asyncio.Task):
            writer_task.add_done_callback(self._observe_request_writer)
        response = await super()._await_response(stream)
        return _BedrockAWSCRTHTTPResponse(status=response.status, fields=response.fields, stream=stream)

    def _observe_request_writer(self, task: asyncio.Task[Any]) -> None:
        """Consume a CRT request-writer result and report unexpected failures."""
        if task.cancelled():
            return

        error = task.exception()
        if error is None:
            return
        if _is_http_stream_completed_error(error):
            logger.debug("error=<%s> | request writer stopped after HTTP/2 stream completion", error)
            return

        task.get_loop().call_exception_handler(
            {
                "message": "bedrock HTTP/2 request writer failed",
                "exception": error,
                "task": task,
            }
        )


class _BedrockAWSCRTHTTPResponse(AWSCRTHTTPResponse):
    """Keep CRT response reads alive until the stream resolves them."""

    async def chunks(self) -> AsyncGenerator[bytes, None]:
        while True:
            read_task = asyncio.create_task(self._stream.get_next_response_chunk())
            try:
                await asyncio.wait({read_task})
            except asyncio.CancelledError:
                read_task.add_done_callback(self._observe_cancelled_read)
                raise

            chunk = read_task.result()
            if not chunk:
                return
            yield chunk

    def _observe_cancelled_read(self, task: asyncio.Task[bytes]) -> None:
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            task.get_loop().call_exception_handler(
                {
                    "message": "bedrock HTTP/2 response reader failed after cancellation",
                    "exception": error,
                    "task": task,
                }
            )


@dataclass
class _ResponseState:
    """Track transcript state for one Nova event stream.

    Attributes:
        role: Role of the current content block.
        generation_stage: Generation stage of the current text block.
        transcript: Accumulated user transcript or final assistant transcript.
    """

    role: str | None = None
    generation_stage: str | None = None
    transcript: str = ""

    def append_transcript(self, delta: str) -> str:
        """Append a transcript block while preserving word boundaries."""
        if self.transcript and delta and not self.transcript[-1].isspace() and not delta[0].isspace():
            delta = f" {delta}"
        self.transcript += delta
        return delta

    def reset(self) -> None:
        """Reset the response state."""
        self.role = None
        self.generation_stage = None
        self.transcript = ""


class BedrockNovaSonicAudioStreamConfig(TypedDict):
    """Nova Sonic stream options. Audio uses mono PCM.

    Attributes:
        sample_rate: Sample rate in Hz.
    """

    sample_rate: Literal[8000, 16000, 24000]


class BedrockNovaSonicAudioConfig(TypedDict, total=False):
    """Nova Sonic input and output audio options.

    Omitted streams use a sample rate of 16000 Hz.

    Attributes:
        input: Input stream options.
        output: Output stream options.
    """

    input: BedrockNovaSonicAudioStreamConfig
    output: BedrockNovaSonicAudioStreamConfig


class BedrockNovaSonicModel(BidiModel, AudioCapable):
    """Amazon Bedrock Nova Sonic implementation for bidirectional streaming.

    Combines model configuration and connection state in a single class.
    Manages Nova Sonic's complex event sequencing, audio format conversion, and
    tool execution patterns while providing the standard BidiModel interface.

    Note, BedrockNovaSonicModel is only supported for Python 3.12+.

    Attributes:
        _stream: open bedrock stream to nova sonic.
    """

    _stream: DuplexEventStream

    def __init__(
        self,
        *,
        boto_session: Session | None = None,
        region: str | None = None,
        audio: BedrockNovaSonicAudioConfig | None = None,
        voice: str = "matthew",
        **model_config: Unpack[BidiModelConfig],
    ) -> None:
        """Initialize Nova Sonic bidirectional model.

        Args:
            boto_session: Boto3 session used to resolve credentials and region.
            region: AWS region. Cannot be combined with ``boto_session``.
            audio: Audio configuration.
            voice: Output voice identifier. Defaults to ``matthew``.
            **model_config: Model configuration.

        Raises:
            ValueError: If audio options or the resolved region are invalid, or both ``boto_session`` and
                ``region`` are provided.
        """
        if boto_session is not None and region is not None:
            raise ValueError("Cannot specify both 'boto_session' and 'region'")

        _validate_model_config(model_config)
        self._config = BidiModelConfig(**model_config)
        self._config.setdefault("model_id", NOVA_SONIC_V2_MODEL_ID)
        self._config["params"] = dict(self._config.get("params") or {})

        # Nova caps a connection at ~8 min; reconnect at 7 min, leaving headroom below the cap.
        # It also reports cumulative usage totals.
        self._config["connection"] = BidiConnectionConfig(
            **{"restart_after_s": 420, **self._config.get("connection", {})}
        )
        self.usage_is_cumulative = True

        self._resolve_audio_config(audio)
        self._voice = voice

        self._session = boto_session or boto3.Session()
        resolved_region = region if region is not None else self._session.region_name or "us-east-1"
        self.region = validate_region(resolved_region)

        # Track API-provided identifiers
        self._connection_id: str | None = None
        self._audio_content_name: str | None = None
        self._current_completion_id: str | None = None

        # Ensure certain events are sent in sequence when required
        self._send_lock = asyncio.Lock()

        logger.debug("model_id=<%s> | nova sonic model initialized", self._config["model_id"])

    @override
    def update_config(self, **model_config: Unpack[BidiModelConfig]) -> None:  # type: ignore[override]
        """Update the model configuration with the provided arguments.

        Args:
            **model_config: Configuration overrides.
        """
        _validate_model_config(model_config)
        self._config.update(model_config)

    @override
    def get_config(self) -> BidiModelConfig:
        """Return the model configuration by reference."""
        return self._config

    @override
    def get_audio_config(self) -> AudioConfig:
        """Get the resolved audio configuration."""
        return self._audio_config

    def _resolve_audio_config(self, config: BedrockNovaSonicAudioConfig | None) -> None:
        """Resolve and validate input and output audio settings."""
        config = config or {}
        validate_config_keys(config, BedrockNovaSonicAudioConfig)

        input_config = config.get("input", {"sample_rate": 16000})
        output_config = config.get("output", {"sample_rate": 16000})
        for stream in (input_config, output_config):
            validate_config_keys(stream, BedrockNovaSonicAudioStreamConfig)
            sample_rate = stream["sample_rate"]
            if sample_rate not in (8000, 16000, 24000):
                raise ValueError(f"Unsupported sample rate: {sample_rate}. Expected 8000, 16000, or 24000.")

        self._audio_config = AudioConfig(
            input=AudioStreamConfig(sample_rate=input_config["sample_rate"], channels=1, format="pcm"),
            output=AudioStreamConfig(sample_rate=output_config["sample_rate"], channels=1, format="pcm"),
        )
        _validate_audio_config(self._audio_config)

    async def start(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **kwargs: Any,
    ) -> None:
        """Establish bidirectional connection to Nova Sonic.

        Args:
            system_prompt: System instructions for the model.
            tools: List of tools available to the model.
            messages: Conversation history to initialize with.
            **kwargs: Additional configuration options.

        Raises:
            RuntimeError: If user calls start again without first stopping.
        """
        if self._connection_id:
            raise RuntimeError("model already started | call stop before starting again")

        logger.debug("nova connection starting")

        self._connection_id = str(uuid.uuid4())

        # Get credentials from boto3 session (full credential chain)
        credentials = self._session.get_credentials()

        if not credentials:
            raise ValueError(
                "no AWS credentials found. configure credentials via environment variables, "
                "credential files, IAM roles, or SSO."
            )

        # Use static resolver with credentials configured as properties
        resolver = StaticCredentialsResolver()

        config = await AsyncBedrockRuntimeConfig.resolve(
            endpoint_uri=f"https://bedrock-runtime.{self.region}.amazonaws.com",
            region=self.region,
            aws_credentials_identity_resolver=resolver,
            auth_scheme_resolver=HTTPAuthSchemeResolver(),
            auth_schemes={ShapeID("aws.auth#sigv4"): SigV4AuthScheme(service="bedrock")},
            # Configure static credentials as properties
            aws_access_key_id=credentials.access_key,
            aws_secret_access_key=credentials.secret_key,
            aws_session_token=credentials.token,
            transport=_BedrockAWSCRTHTTPClient(),
            user_agent_extra=_STRANDS_USER_AGENT_EXTRA,
        )

        self._client = AsyncBedrockRuntimeClient(config=config)
        logger.debug("region=<%s> | nova sonic client initialized", self.region)

        self._stream = await self._client.invoke_model_with_bidirectional_stream(
            InvokeModelWithBidirectionalStreamOperationInput(model_id=self._config["model_id"])
        )
        logger.debug("region=<%s> | nova sonic bidirectional stream established", self.region)

        init_events = self._build_initialization_events(system_prompt, tools, messages)
        logger.debug("event_count=<%d> | sending nova sonic initialization events", len(init_events))
        await self._send_nova_events(init_events)

        logger.info("connection_id=<%s> | nova sonic connection established", self._connection_id)

    def _build_initialization_events(
        self, system_prompt: str | None, tools: list[ToolSpec] | None, messages: Messages | None
    ) -> list[str]:
        """Build the sequence of initialization events."""
        tools = tools or []
        events = [
            self._get_connection_start_event(),
            self._get_prompt_start_event(tools),
            *self._get_system_prompt_events(system_prompt),
        ]

        # Add conversation history if provided
        if messages:
            events.extend(self._get_message_history_events(messages))
            logger.debug("message_count=<%d> | conversation history added to initialization", len(messages))

        return events

    def _log_event_type(self, nova_event: dict[str, Any]) -> None:
        """Log specific Nova Sonic event types for debugging."""
        # Log the full event structure for detailed debugging
        event_keys = list(nova_event.keys())
        logger.debug("event_keys=<%s> | nova sonic event received", event_keys)

        if "usageEvent" in nova_event:
            usage = nova_event["usageEvent"]
            logger.debug(
                "input_tokens=<%s>, output_tokens=<%s>, usage_details=<%s> | nova usage event",
                usage.get("totalInputTokens", 0),
                usage.get("totalOutputTokens", 0),
                json.dumps(usage, indent=2),
            )
        elif "textOutput" in nova_event:
            text_content = nova_event["textOutput"].get("content", "")
            logger.debug(
                "text_length=<%d>, text_preview=<%s>, text_output_details=<%s> | nova text output",
                len(text_content),
                text_content[:100],
                json.dumps(nova_event["textOutput"], indent=2)[:500],
            )
        elif "toolUse" in nova_event:
            tool_use = nova_event["toolUse"]
            logger.debug(
                "tool_name=<%s>, tool_use_id=<%s>, tool_use_details=<%s> | nova tool use received",
                tool_use["toolName"],
                tool_use["toolUseId"],
                json.dumps(tool_use, indent=2)[:500],
            )
        elif "audioOutput" in nova_event:
            audio_content = nova_event["audioOutput"]["content"]
            audio_bytes = base64.b64decode(audio_content)
            logger.debug("audio_bytes=<%d> | nova audio output received", len(audio_bytes))
        elif "completionStart" in nova_event:
            completion_id = nova_event["completionStart"].get("completionId", "unknown")
            logger.debug("completion_id=<%s> | nova completion started", completion_id)
        elif "completionEnd" in nova_event:
            completion_data = nova_event["completionEnd"]
            logger.debug(
                "completion_id=<%s>, stop_reason=<%s> | nova completion ended",
                completion_data.get("completionId", "unknown"),
                completion_data.get("stopReason", "unknown"),
            )
        elif "stopReason" in nova_event:
            logger.debug("stop_reason=<%s> | nova stop reason event", nova_event["stopReason"])
        else:
            # Log any other event types
            audio_metadata = self._get_audio_metadata_for_logging({"event": nova_event})
            if audio_metadata:
                logger.debug("audio_byte_count=<%d> | nova sonic event with audio", audio_metadata["audio_byte_count"])
            else:
                logger.debug("event_payload=<%s> | nova sonic event details", json.dumps(nova_event, indent=2)[:500])

    async def receive(self) -> AsyncGenerator[BidiOutputEvent, None]:
        """Receive Nova Sonic events and convert to provider-agnostic format.

        Raises:
            RuntimeError: If start has not been called.
        """
        if not self._connection_id:
            raise RuntimeError("model not started | call start before receiving")

        logger.debug("nova event stream starting")
        yield BidiConnectionStartEvent(connection_id=self._connection_id, model=self._config["model_id"])

        _, output = await self._stream.await_output()
        response_state = _ResponseState()
        while True:
            try:
                event_data = await output.receive()

            except ValidationException as error:
                if "InternalErrorCode=531" in error.message:
                    # nova also times out if user is silent for 175 seconds
                    raise BidiModelTimeoutError(error.message) from error
                raise

            except ModelTimeoutException as error:
                raise BidiModelTimeoutError(error.message) from error

            # Per the smithy EventReceiver contract, receive() returns None only at
            # end-of-stream (e.g. the connection closed during reconnect). A closed receiver
            # returns None without suspending, so continuing here busy-loops and starves the
            # event loop; end the generator so the reader exits cleanly and the swap proceeds.
            if event_data is None:
                logger.debug("event stream closed by service | ending nova receive loop")
                break

            # Decode and parse the event
            raw_bytes = event_data.value.bytes_.decode("utf-8")
            logger.debug("raw_event_size=<%d> | received nova sonic event", len(raw_bytes))

            nova_event = json.loads(raw_bytes)["event"]
            self._log_event_type(nova_event)

            for model_event in self._convert_nova_event(nova_event, response_state):
                event_type = (
                    model_event.get("type", "unknown") if isinstance(model_event, dict) else type(model_event).__name__
                )
                logger.debug("converted_event_type=<%s> | yielding converted event", event_type)
                yield model_event

    async def send(self, content: BidiInputEvent | ToolResultEvent) -> None:
        """Unified send method for all content types. Sends the given content to Nova Sonic.

        Dispatches to appropriate internal handler based on content type.

        Args:
            content: Input event.

        Raises:
            ValueError: If content type not supported (e.g., image content).
        """
        if not self._connection_id:
            raise RuntimeError("model not started | call start before sending")

        if isinstance(content, BidiTextInputEvent):
            text_preview = content.text[:100] if len(content.text) > 100 else content.text
            logger.debug("text_length=<%d>, text_preview=<%s> | sending text content", len(content.text), text_preview)
            await self._send_text_content(content.text)
        elif isinstance(content, BidiAudioInputEvent):
            audio_size = len(base64.b64decode(content.audio)) if content.audio else 0
            logger.debug("audio_bytes=<%d>, format=<%s> | sending audio content", audio_size, content.format)
            await self._send_audio_content(content)
        elif isinstance(content, ToolResultEvent):
            tool_result = content.get("tool_result")
            if tool_result:
                logger.debug(
                    "tool_use_id=<%s>, content_blocks=<%d> | sending tool result",
                    tool_result.get("toolUseId", "unknown"),
                    len(tool_result.get("content", [])),
                )
                await self._send_tool_result(tool_result)
        else:
            logger.error("content_type=<%s> | unsupported content type", type(content))
            raise ValueError(f"content_type={type(content)} | content not supported")

    async def _start_audio_connection(self) -> None:
        """Internal: Start audio input connection (call once before sending audio chunks)."""
        logger.debug("nova audio connection starting")
        self._audio_content_name = str(uuid.uuid4())

        # Build audio input configuration from config
        audio_input_config = {
            "mediaType": "audio/lpcm",
            "sampleRateHertz": self._audio_config["input"]["sample_rate"],
            "sampleSizeBits": 16,
            "channelCount": self._audio_config["input"]["channels"],
            "audioType": "SPEECH",
            "encoding": "base64",
        }

        audio_content_start = json.dumps(
            {
                "event": {
                    "contentStart": {
                        "promptName": self._connection_id,
                        "contentName": self._audio_content_name,
                        "type": "AUDIO",
                        "interactive": True,
                        "role": "USER",
                        "audioInputConfiguration": audio_input_config,
                    }
                }
            }
        )

        await self._send_nova_events([audio_content_start])

    async def _send_audio_content(self, audio_input: BidiAudioInputEvent) -> None:
        """Internal: Send audio using Nova Sonic protocol-specific format."""
        # Start audio connection if not already active
        if not self._audio_content_name:
            await self._start_audio_connection()

        # Audio is already base64 encoded in the event
        # Send audio input event
        audio_event = json.dumps(
            {
                "event": {
                    "audioInput": {
                        "promptName": self._connection_id,
                        "contentName": self._audio_content_name,
                        "content": audio_input.audio,
                    }
                }
            }
        )

        await self._send_nova_events([audio_event])

    async def _end_audio_input(self) -> None:
        """Internal: End current audio input connection to trigger Nova Sonic processing."""
        if not self._audio_content_name:
            return

        logger.debug("nova audio connection ending")

        audio_content_end = json.dumps(
            {"event": {"contentEnd": {"promptName": self._connection_id, "contentName": self._audio_content_name}}}
        )

        await self._send_nova_events([audio_content_end])
        self._audio_content_name = None

    async def _send_text_content(self, text: str) -> None:
        """Internal: Send text content using Nova Sonic format."""
        content_name = str(uuid.uuid4())
        events = [
            self._get_text_content_start_event(content_name),
            self._get_text_input_event(content_name, text),
            self._get_content_end_event(content_name),
        ]
        await self._send_nova_events(events)

    async def _send_tool_result(self, tool_result: ToolResult) -> None:
        """Internal: Send tool result using Nova Sonic toolResult format."""
        tool_use_id = tool_result["toolUseId"]

        logger.debug("tool_use_id=<%s> | sending nova tool result", tool_use_id)

        # Validate content types and preserve structure
        content = tool_result.get("content", [])

        # Validate all content types are supported
        for block in content:
            if "text" not in block and "json" not in block:
                # Unsupported content type - raise error
                raise ValueError(
                    f"tool_use_id=<{tool_use_id}>, content_types=<{list(block.keys())}> | "
                    f"Content type not supported by Nova Sonic"
                )

        # Optimize for single content item - unwrap the array
        if len(content) == 1:
            result_data = cast(dict[str, Any], content[0])
        else:
            # Multiple items - send as array
            result_data = {"content": content}

        content_name = str(uuid.uuid4())
        events = [
            self._get_tool_content_start_event(content_name, tool_use_id),
            self._get_tool_result_event(content_name, result_data),
            self._get_content_end_event(content_name),
        ]
        await self._send_nova_events(events)

    async def stop(self) -> None:
        """Close Nova Sonic connection with proper cleanup sequence."""
        logger.debug("nova connection cleanup starting")

        async def stop_events() -> None:
            if not self._connection_id or not hasattr(self, "_stream"):
                return

            await self._end_audio_input()
            cleanup_events = [self._get_prompt_end_event(), self._get_connection_end_event()]
            await self._send_nova_events(cleanup_events)

        async def stop_stream() -> None:
            if not hasattr(self, "_stream"):
                return

            try:
                await self._stream.close()
            finally:
                del self._stream

        async def stop_client() -> None:
            if not hasattr(self, "_client"):
                return

            try:
                await self._client.close()
            finally:
                del self._client

        async def stop_connection() -> None:
            self._connection_id = None

        await stop_all(stop_events, stop_stream, stop_client, stop_connection)

        logger.debug("nova connection closed")

    async def restart(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **restart_kwargs: Any,
    ) -> None:
        """Restart by closing the connection and starting a new one, replaying messages.

        Args:
            system_prompt: System instructions for the new connection.
            tools: Tool specifications for the new connection.
            messages: Conversation history to replay into the new connection.
            **restart_kwargs: Reserved for provider-specific restart options.
        """
        logger.debug("nova restart starting")
        await self.stop()
        await self.start(system_prompt, tools, messages, **restart_kwargs)
        logger.debug("connection_id=<%s> | nova restart complete", self._connection_id)

    def _convert_nova_event(
        self,
        nova_event: dict[str, Any],
        response_state: _ResponseState,
    ) -> list[BidiOutputEvent]:
        """Convert Nova Sonic events to TypedEvent format."""
        # Handle completion start - track completionId
        if "completionStart" in nova_event:
            completion_data = nova_event["completionStart"]
            self._current_completion_id = completion_data.get("completionId")
            logger.debug("completion_id=<%s> | nova completion started", self._current_completion_id)
            return []

        # completionEnd brackets the whole prompt/session, not a turn (its completionId is
        # constant across turns). Per-turn boundaries come from contentEnd stopReason below,
        # so only clear completion tracking here.
        if "completionEnd" in nova_event:
            self._current_completion_id = None
            response_state.reset()
            return []

        # Handle audio output
        if "audioOutput" in nova_event:
            # Audio is already base64 string from Nova Sonic
            audio_content = nova_event["audioOutput"]["content"]
            return [
                BidiAudioStreamEvent(
                    audio=audio_content,
                    **self._audio_config["output"],
                )
            ]

        # Handle text output (transcripts)
        elif "textOutput" in nova_event:
            text_output = nova_event["textOutput"]
            text_content = text_output["content"]
            role = text_output["role"].strip().lower()
            # Check for Nova Sonic interruption pattern
            if '{ "interrupted" : true }' in text_content:
                logger.debug("nova interruption detected in text output")
                response_state.reset()
                return [BidiInterruptionEvent(reason="user_speech")]

            if role == "user":
                return [BidiTranscriptStreamEvent(delta=response_state.append_transcript(text_content), role="user")]

            # Accumulate FINAL text for the completed assistant transcript.
            if response_state.generation_stage == "FINAL":
                response_state.append_transcript(text_content)
                return []

            # Separately, stream speculative assistant text for low-latency updates.
            return [BidiTranscriptStreamEvent(delta=text_content, role="assistant")]

        # Handle tool use
        if "toolUse" in nova_event:
            tool_use = nova_event["toolUse"]
            tool_use_event: ToolUse = {
                "toolUseId": tool_use["toolUseId"],
                "name": tool_use["toolName"],
                "input": json.loads(tool_use["content"]),
            }
            return [
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
            ]

        # Handle interruption
        if nova_event.get("stopReason") == "INTERRUPTED":
            logger.debug("nova interruption detected via stop reason")
            response_state.reset()
            return [BidiInterruptionEvent(reason="user_speech")]

        # Handle usage events - convert to multimodal usage format
        if "usageEvent" in nova_event:
            usage_data = nova_event["usageEvent"]
            total_input = usage_data.get("totalInputTokens", 0)
            total_output = usage_data.get("totalOutputTokens", 0)

            return [
                BidiUsageEvent(
                    input_tokens=total_input,
                    output_tokens=total_output,
                    total_tokens=usage_data.get("totalTokens", total_input + total_output),
                )
            ]

        # Handle content start events (emit response start)
        if "contentStart" in nova_event:
            content_data = nova_event["contentStart"]
            role = content_data["role"].strip().lower()
            if content_data["type"] == "TEXT":
                response_state.generation_stage = json.loads(content_data["additionalModelFields"])["generationStage"]

            response_start = BidiResponseStartEvent(
                response_id=self._current_completion_id or str(uuid.uuid4())  # Fallback to UUID if missing
            )
            previous_role = response_state.role
            response_state.role = role
            if previous_role == "user" and role != "user":
                transcript_complete = BidiTranscriptCompleteEvent(response_state.transcript, "user")
                response_state.transcript = ""
                return [transcript_complete, response_start]

            return [response_start]

        if "contentEnd" in nova_event:
            content_end = nova_event["contentEnd"]
            stop_reason = content_end.get("stopReason")
            # Nova ends a turn after its FINAL assistant text block (which follows the audio).
            # Both that text block and the preceding audio block carry END_TURN, so gate on
            # the FINAL text to emit exactly one per-turn complete, after that text is in
            # history. INTERRUPTED (barge-in) ends the turn regardless of block.
            is_final_text = content_end.get("type") == "TEXT" and response_state.generation_stage == "FINAL"
            response_state.generation_stage = None
            if stop_reason == "INTERRUPTED" or (stop_reason == "END_TURN" and is_final_text):
                response_complete = BidiResponseCompleteEvent(
                    response_id=self._current_completion_id or str(uuid.uuid4()),
                    stop_reason="interrupted" if stop_reason == "INTERRUPTED" else "complete",
                )
                if stop_reason != "INTERRUPTED" and response_state.transcript:
                    transcript_complete = BidiTranscriptCompleteEvent(response_state.transcript, "assistant")
                    response_state.reset()
                    return [transcript_complete, response_complete]

                response_state.reset()
                return [response_complete]

        # Ignore all other events
        return []

    def _get_connection_start_event(self) -> str:
        """Generate Nova Sonic connection start event."""
        session_start_event: dict[str, Any] = {"event": {"sessionStart": {**(self._config.get("params") or {})}}}

        return json.dumps(session_start_event)

    def _get_prompt_start_event(self, tools: list[ToolSpec]) -> str:
        """Generate Nova Sonic prompt start event with tool configuration."""
        audio_output_config = {
            "mediaType": "audio/lpcm",
            "sampleRateHertz": self._audio_config["output"]["sample_rate"],
            "sampleSizeBits": 16,
            "channelCount": self._audio_config["output"]["channels"],
            "voiceId": self._voice,
            "encoding": "base64",
            "audioType": "SPEECH",
        }

        prompt_start_event: dict[str, Any] = {
            "event": {
                "promptStart": {
                    "promptName": self._connection_id,
                    "textOutputConfiguration": NOVA_TEXT_CONFIG,
                    "audioOutputConfiguration": audio_output_config,
                }
            }
        }

        if tools:
            tool_config = self._build_tool_configuration(tools)
            prompt_start_event["event"]["promptStart"]["toolUseOutputConfiguration"] = NOVA_TOOL_CONFIG
            prompt_start_event["event"]["promptStart"]["toolConfiguration"] = {"tools": tool_config}

        return json.dumps(prompt_start_event)

    def _build_tool_configuration(self, tools: list[ToolSpec]) -> list[dict[str, Any]]:
        """Build tool configuration from tool specs."""
        tool_config: list[dict[str, Any]] = []
        for tool in tools:
            input_schema = (
                {"json": json.dumps(tool["inputSchema"]["json"])}
                if "json" in tool["inputSchema"]
                else {"json": json.dumps(tool["inputSchema"])}
            )

            tool_config.append(
                {"toolSpec": {"name": tool["name"], "description": tool["description"], "inputSchema": input_schema}}
            )
        return tool_config

    def _get_system_prompt_events(self, system_prompt: str | None) -> list[str]:
        """Generate system prompt events."""
        content_name = str(uuid.uuid4())
        return [
            self._get_text_content_start_event(content_name, "SYSTEM", interactive=False),
            self._get_text_input_event(content_name, system_prompt or ""),
            self._get_content_end_event(content_name),
        ]

    def _get_message_history_events(self, messages: Messages) -> list[str]:
        """Generate conversation history events from agent messages.

        Converts agent message history to Nova Sonic format following the
        contentStart/textInput/contentEnd pattern for each message.

        History messages are sent as non-interactive (interactive=False) so Nova Sonic
        treats them as prior context rather than new inputs requiring a response.

        Individual messages are truncated to 50KB and total history is capped
        at 200KB. When the limit is reached, the oldest messages are dropped
        to prioritize recent conversation context.

        Args:
            messages: List of conversation messages with role and content.

        Returns:
            List of JSON event strings for Nova Sonic.
        """
        max_message_bytes = _MAX_HISTORY_MESSAGE_BYTES
        max_total_bytes = _MAX_HISTORY_TOTAL_BYTES

        # First pass: extract and truncate text from each message, walking backwards
        # to prioritize recent messages when the total size limit is hit
        prepared: list[tuple[str, str]] = []  # (role, text)
        total_bytes = 0

        for message in reversed(messages):
            role = message["role"].upper()
            content_blocks = message.get("content", [])

            text_parts = []
            for block in content_blocks:
                if "text" in block:
                    text_parts.append(block["text"])

            if not text_parts:
                continue

            combined_text = "\n".join(text_parts)

            # Truncate individual message
            encoded = combined_text.encode("utf-8")
            if len(encoded) > max_message_bytes:
                encoded = encoded[:max_message_bytes]
                combined_text = encoded.decode("utf-8", errors="ignore")
                encoded = combined_text.encode("utf-8")

            msg_bytes = len(encoded)

            if total_bytes + msg_bytes > max_total_bytes:
                logger.debug(
                    "total_bytes=<%d>, msg_bytes=<%d>, max_total_bytes=<%d> | dropping older messages to fit limit",
                    total_bytes,
                    msg_bytes,
                    max_total_bytes,
                )
                break

            total_bytes += msg_bytes
            prepared.append((role, combined_text))

        # Reverse back to chronological order
        prepared.reverse()

        # Ensure the first message is from the user role — drop leading assistant messages
        while prepared and prepared[0][0] != "USER":
            dropped_role, dropped_text = prepared.pop(0)
            logger.debug(
                "role=<%s>, text_preview=<%s> | dropping leading non-user message from history",
                dropped_role,
                dropped_text[:100],
            )

        logger.debug("prepared_count=<%d>, total_bytes=<%d> | final history after trimming", len(prepared), total_bytes)

        # Second pass: build events
        events: list[str] = []
        for role, text in prepared:
            content_name = str(uuid.uuid4())
            events.extend(
                [
                    self._get_text_content_start_event(content_name, role, interactive=False),
                    self._get_text_input_event(content_name, text),
                    self._get_content_end_event(content_name),
                ]
            )

        return events

    def _get_text_content_start_event(self, content_name: str, role: str = "USER", interactive: bool = True) -> str:
        """Generate text content start event.

        Args:
            content_name: Unique identifier for this content block.
            role: Message role (USER, ASSISTANT, SYSTEM).
            interactive: Whether this is a live input (True) or history context (False).
        """
        return json.dumps(
            {
                "event": {
                    "contentStart": {
                        "promptName": self._connection_id,
                        "contentName": content_name,
                        "type": "TEXT",
                        "role": role,
                        "interactive": interactive,
                        "textInputConfiguration": NOVA_TEXT_CONFIG,
                    }
                }
            }
        )

    def _get_tool_content_start_event(self, content_name: str, tool_use_id: str) -> str:
        """Generate tool content start event."""
        return json.dumps(
            {
                "event": {
                    "contentStart": {
                        "promptName": self._connection_id,
                        "contentName": content_name,
                        "interactive": False,
                        "type": "TOOL",
                        "role": "TOOL",
                        "toolResultInputConfiguration": {
                            "toolUseId": tool_use_id,
                            "type": "TEXT",
                            "textInputConfiguration": NOVA_TEXT_CONFIG,
                        },
                    }
                }
            }
        )

    def _get_text_input_event(self, content_name: str, text: str) -> str:
        """Generate text input event."""
        return json.dumps(
            {"event": {"textInput": {"promptName": self._connection_id, "contentName": content_name, "content": text}}}
        )

    def _get_tool_result_event(self, content_name: str, result: dict[str, Any]) -> str:
        """Generate tool result event."""
        return json.dumps(
            {
                "event": {
                    "toolResult": {
                        "promptName": self._connection_id,
                        "contentName": content_name,
                        "content": json.dumps(result),
                    }
                }
            }
        )

    def _get_content_end_event(self, content_name: str) -> str:
        """Generate content end event."""
        return json.dumps({"event": {"contentEnd": {"promptName": self._connection_id, "contentName": content_name}}})

    def _get_prompt_end_event(self) -> str:
        """Generate prompt end event."""
        return json.dumps({"event": {"promptEnd": {"promptName": self._connection_id}}})

    def _get_connection_end_event(self) -> str:
        """Generate connection end event."""
        return json.dumps({"event": {"connectionEnd": {}}})

    def _get_audio_metadata_for_logging(self, event_dict: dict[str, Any]) -> dict[str, Any]:
        """Extract audio metadata from event dict for logging.

        Instead of logging large base64-encoded audio data, this extracts metadata
        like byte count to verify audio presence without bloating logs.

        Args:
            event_dict: The event dictionary to process.

        Returns:
            A dict with audio metadata (byte_count) if audio is present, empty dict otherwise.
        """
        metadata: dict[str, Any] = {}

        if "event" in event_dict:
            event_data = event_dict["event"]

            # Handle contentStart events with audio
            if "contentStart" in event_data and "content" in event_data["contentStart"]:
                content = event_data["contentStart"]["content"]
                if "audio" in content and "bytes" in content["audio"]:
                    metadata["audio_byte_count"] = len(content["audio"]["bytes"])

            # Handle content events with audio
            if "content" in event_data and "content" in event_data["content"]:
                content = event_data["content"]["content"]
                if "audio" in content and "bytes" in content["audio"]:
                    metadata["audio_byte_count"] = len(content["audio"]["bytes"])

        return metadata

    async def _send_nova_events(self, events: list[str]) -> None:
        """Send event JSON string to Nova Sonic stream.

        A lock is used to send events in sequence when required (e.g., tool result start, content, and end).

        Args:
            events: Jsonified events.
        """
        async with self._send_lock:
            for event in events:
                bytes_data = event.encode("utf-8")
                chunk = InvokeModelWithBidirectionalStreamInputChunk(
                    value=BidirectionalInputPayloadPart(bytes_=bytes_data)
                )
                await self._stream.input_stream.send(chunk)
