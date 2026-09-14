"""Bedrock provider using the native InvokeModel APIs.

Use in place of :class:`~strands.models.bedrock.BedrockModel` when the target model does not
support Converse (Custom Model Import, etc.). Request format auto-detects from the model id:
``anthropic.*``/``*claude*`` use the Anthropic Messages API, everything else uses the OpenAI
Chat Completions API. Ids belonging to a foundation-model family with its own native InvokeModel
body shape (``amazon.*``, ``meta.*``, ``mistral.*``, ``cohere.*``, ``ai21.*``) are rejected rather
than guessed — reach for :class:`~strands.models.bedrock.BedrockModel`, which serves them over
Converse. Override the detection with ``model_family``.
"""

import asyncio
import base64
import json
import logging
import threading
import time
from collections.abc import AsyncGenerator, Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, TypeVar, cast

import boto3
from botocore.config import Config as BotocoreConfig
from botocore.exceptions import ClientError
from pydantic import BaseModel
from typing_extensions import Unpack, override

from .._exception_notes import add_exception_note
from ..event_loop import streaming
from ..tools import convert_pydantic_to_tool_spec
from ..types.content import Messages, SystemContentBlock
from ..types.event_loop import Usage
from ..types.streaming import ReasoningContentBlockDelta, StreamEvent
from ..types.tools import ToolChoice, ToolSpec
from ._defaults import resolve_config_metadata
from ._validation import validate_config_keys
from .bedrock import BedrockModel, _next_stream_event, _poll_cancel_signal, _suppress_task_exception
from .model import BaseModelConfig, Model

logger = logging.getLogger(__name__)

ModelFamily = Literal["anthropic", "openai"]
T = TypeVar("T", bound=BaseModel)

_DEFAULT_MAX_TOKENS = 4096

# Foundation-model families whose InvokeModel body is neither Anthropic Messages nor OpenAI Chat
# Completions shaped. BedrockModel already serves them over Converse.
_NATIVE_SCHEMA_MODEL_PREFIXES = ("amazon.", "meta.", "mistral.", "cohere.", "ai21.")

_BLOCK_STOP: StreamEvent = {"contentBlockStop": {}}
_TEXT_START: StreamEvent = {"contentBlockStart": {"start": {}}}


class _CancellationSignal(Protocol):
    def is_set(self) -> bool: ...


class _WorkerCancelSignal:
    """Combine caller cancellation with private generator-ownership cancellation."""

    def __init__(self, external: threading.Event | None) -> None:
        self._external = external
        self._internal = threading.Event()

    def is_set(self) -> bool:
        return self._internal.is_set() or (self._external is not None and self._external.is_set())

    def set(self) -> None:
        self._internal.set()


def _text_delta(t: str) -> StreamEvent:
    return {"contentBlockDelta": {"delta": {"text": t}}}


def _tool_use_start(tool_use_id: str, name: str) -> StreamEvent:
    return {"contentBlockStart": {"start": {"toolUse": {"toolUseId": tool_use_id, "name": name}}}}


def _tool_use_delta(partial_json: str) -> StreamEvent:
    return {"contentBlockDelta": {"delta": {"toolUse": {"input": partial_json}}}}


def _reasoning_delta(**reasoning_content: str | bytes) -> StreamEvent:
    reasoning = cast(ReasoningContentBlockDelta, reasoning_content)
    return {"contentBlockDelta": {"delta": {"reasoningContent": reasoning}}}


def _unsupported_block(block: Mapping[str, Any]) -> TypeError:
    """Build the error for a content block this provider cannot put on the wire."""
    return TypeError(f"content_type=<{next(iter(block), None)}> | unsupported type")


def _tool_result_text(block: Mapping[str, Any]) -> str:
    """Return supported tool-result text, rejecting blocks this provider cannot put on the wire."""
    if "text" not in block:
        raise _unsupported_block(block)
    return cast(str, block["text"])


def _latency_ms(start_time: float) -> int:
    return int((time.perf_counter() - start_time) * 1000)


def _metadata(
    in_tok: int,
    out_tok: int,
    latency_ms: int,
    total: int | None = None,
    cache_read: int = 0,
    cache_write: int = 0,
) -> StreamEvent:
    usage: Usage = {
        "inputTokens": in_tok,
        "outputTokens": out_tok,
        "totalTokens": in_tok + out_tok if total is None else total,
    }
    if cache_read:
        usage["cacheReadInputTokens"] = cache_read
    if cache_write:
        usage["cacheWriteInputTokens"] = cache_write
    return {"metadata": {"usage": usage, "metrics": {"latencyMs": latency_ms}}}


@dataclass
class _OpenAIToolCall:
    """The pieces of one openai tool-call index seen so far, held until its block can open."""

    tool_use_id: str | None = None
    name: str | None = None
    arguments: list[str] = field(default_factory=list)


class _OpenAIBlockWriter:
    """Emit Strands content blocks from openai-dialect stream deltas, one open block at a time.

    Tool-call fragments are buffered by index until the end of the stream. The consumer keys its
    in-progress tool use off the most recent ``contentBlockStart``, so interleaved parallel calls
    cannot be emitted safely until every fragment can be grouped with its own block.
    """

    def __init__(self, callback: Callable[..., None]) -> None:
        self._callback = callback
        self._active: str | None = None
        self._pending: dict[int, _OpenAIToolCall] = {}

    def write_text(self, text: str) -> None:
        """Append text to the open text block, opening one if the active block is not text."""
        if self._active != "text":
            self._close_active()
            self._callback(_TEXT_START)
            self._active = "text"
        self._callback(_text_delta(text))

    def write_tool_call(self, tool_call: Mapping[str, Any]) -> None:
        """Fold one streamed ``tool_calls`` entry into the block for its index."""
        index = tool_call.get("index", 0)
        function = tool_call.get("function") or {}
        buffered = self._pending.setdefault(index, _OpenAIToolCall())
        buffered.tool_use_id = tool_call.get("id") or buffered.tool_use_id
        buffered.name = function.get("name") or buffered.name
        if arguments := function.get("arguments"):
            buffered.arguments.append(arguments)

    def close(self) -> None:
        """Close the open block and report any tool call whose name never arrived."""
        self._flush_tool_calls()
        self._close_active()

    def _close_active(self) -> None:
        if self._active is not None:
            self._callback(_BLOCK_STOP)
            self._active = None

    def _flush_tool_calls(self) -> None:
        if not self._pending:
            return

        self._close_active()
        for index in sorted(self._pending):
            buffered = self._pending[index]
            if not buffered.name:
                logger.warning("tool_call_index=<%s> | dropping a tool call that never carried a name", index)
                continue
            self._callback(_tool_use_start(buffered.tool_use_id or f"call_{index}", buffered.name))
            for arguments in buffered.arguments:
                self._callback(_tool_use_delta(arguments))
            self._callback(_BLOCK_STOP)
        self._pending.clear()


class BedrockInvokeModel(BedrockModel):
    """AWS Bedrock model provider using ``InvokeModel`` / ``InvokeModelWithResponseStream``.

    Subclasses :class:`~strands.models.bedrock.BedrockModel`, matching the shape of other
    provider-family subclasses (e.g. ``SageMakerAIModel(OpenAIModel)``), while replacing request
    formatting, streaming, and response translation to talk to the native InvokeModel APIs.
    """

    class BedrockInvokeConfig(BaseModelConfig, total=False):
        """Configuration options for ``BedrockInvokeModel``.

        Attributes:
            model_id: Bedrock model id or ARN to invoke.
            model_family: Wire dialect to emit, overriding id-based detection. This selects the request
                shape this provider sends, not a capability, so set it only when the target model
                genuinely speaks that format.
            max_tokens: Cap on generated tokens, sent on both request families. Defaults to 4096 when
                unset or ``None``, since the Anthropic Messages API requires the field.
            streaming: Whether to call ``InvokeModelWithResponseStream``. Defaults to True.
            temperature: Sampling temperature. Omitted from the request when unset.
            top_p: Nucleus sampling cutoff. Omitted from the request when unset.
            top_k: Top-k sampling cutoff, applied on the anthropic family only. OpenAI Chat Completions
                has no equivalent parameter, so a value set here has no effect on an openai-family
                request.
            stop_sequences: Sequences that end generation, sent as ``stop_sequences`` on the anthropic
                family and ``stop`` on the openai family.
            params: Extra wire fields, splatted onto the formatted request last, so it both reaches
                fields this config does not model (``thinking``, ``anthropic_beta``, ...) and overrides
                computed fields except the OpenAI ``stream``/``stream_options`` transport invariants.
        """

        model_id: str
        model_family: ModelFamily | None
        max_tokens: int | None
        streaming: bool | None
        temperature: float | None
        top_p: float | None
        top_k: int | None
        stop_sequences: list[str] | None
        params: dict[str, Any] | None

    # ``BedrockModel.__init__`` is deliberately not called: it would create a second bedrock-runtime
    # client and install a ``BedrockConfig``, which rejects this provider's own config keys.
    def __init__(
        self,
        *,
        boto_session: boto3.Session | None = None,
        boto_client_config: BotocoreConfig | None = None,
        region_name: str | None = None,
        endpoint_url: str | None = None,
        **model_config: Unpack[BedrockInvokeConfig],
    ):
        """Initialize the provider. ``boto_session`` and ``region_name`` are mutually exclusive."""
        self.client, resolved_region = self._create_bedrock_runtime_client(
            boto_session=boto_session,
            boto_client_config=boto_client_config,
            region_name=region_name,
            endpoint_url=endpoint_url,
        )

        validate_config_keys(model_config, self.BedrockInvokeConfig)

        config: BedrockInvokeModel.BedrockInvokeConfig = {
            "model_id": self._get_default_model_with_warning(resolved_region, model_config),
            "streaming": model_config.get("streaming", True),
        }
        config.update({k: v for k, v in model_config.items() if k != "model_id"})  # type: ignore[typeddict-item]
        self.config: BedrockInvokeModel.BedrockInvokeConfig = config  # type: ignore[assignment]

        logger.debug("config=<%s> | initializing", self.config)
        logger.debug("region=<%s> | bedrock client created", self.client.meta.region_name)

    @override
    def update_config(self, **model_config: Unpack[BedrockInvokeConfig]) -> None:  # type: ignore[override]
        """Update the model configuration."""
        validate_config_keys(model_config, self.BedrockInvokeConfig)
        self.config.update(model_config)

    @override
    def get_config(self) -> BedrockInvokeConfig:  # type: ignore[override]
        """Return the current configuration, with model metadata resolved from the built-in lookup tables."""
        return resolve_config_metadata(self.config, self.config.get("model_id", ""))

    def _get_model_family(self) -> ModelFamily:
        """Detect the request/response format from the configured model id.

        Raises:
            ValueError: If the id belongs to a foundation-model family whose native InvokeModel body
                shape this provider does not send, and no ``model_family`` override is configured.
        """
        if family := self.config.get("model_family"):
            return family

        model_id = self.config["model_id"].lower()
        if "anthropic" in model_id or "claude" in model_id:
            return "anthropic"
        if model_id.startswith(_NATIVE_SCHEMA_MODEL_PREFIXES):
            raise ValueError(
                f"model_id=<{self.config['model_id']}> | this model family takes its own native "
                "InvokeModel body shape, which BedrockInvokeModel does not send. Use BedrockModel, "
                "which supports these models through the Converse API, or set the model_family config "
                'key ("anthropic" or "openai") to force a dialect for a model that speaks it.'
            )
        return "openai"

    # ----- request formatting

    @staticmethod
    def _media_type(image_format: str) -> str:
        return image_format if image_format.startswith("image/") else f"image/{image_format}"

    @staticmethod
    def _system_text(blocks: list[SystemContentBlock] | None) -> str:
        return " ".join(b.get("text", "") for b in (blocks or []) if "text" in b)

    def _max_tokens(self) -> int:
        """Return the configured generation cap, falling back to the default when unset or ``None``."""
        max_tokens = self.config.get("max_tokens")
        return _DEFAULT_MAX_TOKENS if max_tokens is None else max_tokens

    def _apply_sampling_params(self, request: dict[str, Any], stop_key: str, include_top_k: bool = False) -> None:
        """Copy configured temperature/top_p/(top_k)/stop_sequences onto ``request`` when set."""
        config = cast(dict[str, Any], self.config)
        keys = ("temperature", "top_p", "top_k") if include_top_k else ("temperature", "top_p")
        for key in keys:
            if config.get(key) is not None:
                request[key] = config[key]
        if config.get("stop_sequences"):
            request[stop_key] = config["stop_sequences"]

    @staticmethod
    def _to_tool_choice(tool_choice: ToolChoice | None, family: ModelFamily) -> Any:
        """Translate Strands ``ToolChoice`` to the family-specific tool_choice shape."""
        if not tool_choice:
            return None
        c = cast(dict[str, Any], tool_choice)
        if family == "anthropic":
            if "tool" in c:
                return {"type": "tool", "name": c["tool"]["name"]}
            return {"type": "any"} if "any" in c else {"type": "auto"} if "auto" in c else None
        if "tool" in c:
            return {"type": "function", "function": {"name": c["tool"]["name"]}}
        return "required" if "any" in c else "auto" if "auto" in c else None

    def _format_anthropic_request(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None,
        system_prompt_content: list[SystemContentBlock] | None,
        tool_choice: ToolChoice | None,
    ) -> dict[str, Any]:
        """Build an Anthropic Messages request body.

        Raises:
            TypeError: If a message contains a content block type this provider cannot format.
        """
        request: dict[str, Any] = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": self._max_tokens(),
            "messages": [],
        }
        if system := self._system_text(system_prompt_content):
            request["system"] = system

        for msg in messages:
            content: list[dict[str, Any]] = []
            for block in msg["content"]:
                if "text" in block:
                    content.append({"type": "text", "text": block["text"]})
                elif "image" in block:
                    img = block["image"]
                    source = {
                        "type": "base64",
                        "media_type": self._media_type(img["format"]),
                        "data": base64.b64encode(img["source"]["bytes"]).decode("utf-8"),
                    }
                    content.append({"type": "image", "source": source})
                elif "toolUse" in block:
                    tu = block["toolUse"]
                    content.append(
                        {"type": "tool_use", "id": tu["toolUseId"], "name": tu["name"], "input": tu["input"]}
                    )
                elif "toolResult" in block:
                    tr = block["toolResult"]
                    rc: list[dict[str, Any]] = [{"type": "text", "text": _tool_result_text(rb)} for rb in tr["content"]]
                    entry: dict[str, Any] = {"type": "tool_result", "tool_use_id": tr["toolUseId"], "content": rc}
                    if tr.get("status") == "error":
                        entry["is_error"] = True
                    content.append(entry)
                elif "reasoningContent" in block:
                    reasoning = block["reasoningContent"]
                    if "reasoningText" in reasoning:
                        reasoning_text = reasoning["reasoningText"]
                        entry = {"type": "thinking", "thinking": reasoning_text.get("text", "")}
                        if reasoning_text.get("signature"):
                            entry["signature"] = reasoning_text["signature"]
                        content.append(entry)
                    elif "redactedContent" in reasoning:
                        data = base64.b64encode(reasoning["redactedContent"]).decode("utf-8")
                        content.append({"type": "redacted_thinking", "data": data})
                    else:
                        raise _unsupported_block(block)
                else:
                    raise _unsupported_block(block)
            if content:
                request["messages"].append({"role": msg["role"], "content": content})

        if tool_specs:
            request["tools"] = [
                {"name": s["name"], "description": s["description"], "input_schema": s["inputSchema"]["json"]}
                for s in tool_specs
            ]
        if (tc := self._to_tool_choice(tool_choice, "anthropic")) is not None:
            request["tool_choice"] = tc

        self._apply_sampling_params(request, "stop_sequences", include_top_k=True)
        request.update(self.config.get("params") or {})
        return request

    def _format_openai_request(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None,
        system_prompt_content: list[SystemContentBlock] | None,
        tool_choice: ToolChoice | None,
    ) -> dict[str, Any]:
        """Build an OpenAI Chat Completions request body.

        Raises:
            TypeError: If a message contains a content block type this provider cannot format. There is no
                image support on this path; images are formattable only when the target model understands
                Anthropic Messages format, in which case set ``model_family="anthropic"``.
        """
        request: dict[str, Any] = {
            "model": self.config["model_id"],
            "messages": [],
            "max_tokens": self._max_tokens(),
            "stream": self.config.get("streaming", True),
        }
        if request["stream"]:
            # Standard OpenAI streaming omits the usage chunk unless it is asked for, which would leave
            # the turn reporting no tokens and no latency at all.
            request["stream_options"] = {"include_usage": True}
        if system := self._system_text(system_prompt_content):
            request["messages"].append({"role": "system", "content": system})

        for msg in messages:
            text_parts: list[str] = []
            tool_calls: list[dict[str, Any]] = []
            tool_results: list[dict[str, Any]] = []
            for block in msg["content"]:
                if "text" in block:
                    text_parts.append(block["text"])
                elif "toolUse" in block:
                    tu = block["toolUse"]
                    fn = {"name": tu["name"], "arguments": json.dumps(tu["input"])}
                    tool_calls.append({"id": tu["toolUseId"], "type": "function", "function": fn})
                elif "toolResult" in block:
                    tr = block["toolResult"]
                    chunks = [_tool_result_text(result_content) for result_content in tr["content"]]
                    tool_results.append({"role": "tool", "tool_call_id": tr["toolUseId"], "content": "".join(chunks)})
                else:
                    raise _unsupported_block(block)
            if tool_calls or text_parts:
                entry: dict[str, Any] = {"role": msg["role"]}
                if text_parts:
                    entry["content"] = "".join(text_parts)
                if tool_calls:
                    entry["tool_calls"] = tool_calls
                    entry.setdefault("content", None)
                request["messages"].append(entry)
            request["messages"].extend(tool_results)

        if tool_specs:
            request["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": s["name"],
                        "description": s["description"],
                        "parameters": s["inputSchema"]["json"],
                    },
                }
                for s in tool_specs
            ]
            if (tc := self._to_tool_choice(tool_choice, "openai")) is not None:
                request["tool_choice"] = tc

        self._apply_sampling_params(request, "stop")
        request.update(self.config.get("params") or {})
        request["stream"] = self.config.get("streaming", True)
        if request["stream"]:
            request.setdefault("stream_options", {"include_usage": True})
        else:
            request.pop("stream_options", None)
        return request

    def _format_invoke_request(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None,
        system_prompt_content: list[SystemContentBlock] | None,
        tool_choice: ToolChoice | None,
    ) -> dict[str, Any]:
        if self._get_model_family() == "anthropic":
            return self._format_anthropic_request(messages, tool_specs, system_prompt_content, tool_choice)
        return self._format_openai_request(messages, tool_specs, system_prompt_content, tool_choice)

    # ----- response translation

    _ANTHROPIC_STOP = {
        "tool_use": "tool_use",
        "max_tokens": "max_tokens",
        "stop_sequence": "stop_sequence",
        "refusal": "content_filtered",
    }
    _OPENAI_STOP = {
        "tool_calls": "tool_use",
        "length": "max_tokens",
        "stop": "end_turn",
        "content_filter": "content_filtered",
    }

    @classmethod
    def _map_anthropic_stop(cls, reason: str | None) -> str:
        return cls._ANTHROPIC_STOP.get(reason or "", "end_turn")

    @classmethod
    def _map_openai_stop(cls, reason: str | None) -> str:
        return cls._OPENAI_STOP.get(reason or "", "end_turn")

    def _emit_anthropic_chunks(
        self,
        body: Any,
        callback: Callable[..., None],
        start_time: float,
        cancel_signal: _CancellationSignal | None = None,
    ) -> None:
        """Translate an Anthropic Messages stream into Strands ``StreamEvent``s."""
        callback({"messageStart": {"role": "assistant"}})
        stop_reason: str | None = None
        in_toks = out_toks = 0
        cache_read = cache_write = 0
        active: str | None = None

        for event in body:
            if cancel_signal is not None and cancel_signal.is_set():
                # Closing from this thread only: botocore's teardown is not safe against a read in
                # flight, and this thread is the one reading.
                body.close()
                return
            chunk = json.loads(event["chunk"]["bytes"])
            t = chunk.get("type")
            logger.debug("anthropic_chunk_type=<%s>", t)
            if t == "message_start":
                u = (chunk.get("message") or {}).get("usage") or {}
                in_toks = u.get("input_tokens", in_toks)
                out_toks = u.get("output_tokens", out_toks)
                cache_read = u.get("cache_read_input_tokens", cache_read)
                cache_write = u.get("cache_creation_input_tokens", cache_write)
            elif t == "content_block_start":
                cb = chunk.get("content_block") or {}
                if cb.get("type") == "tool_use":
                    active = "tool_use"
                    callback(_tool_use_start(cb["id"], cb["name"]))
                else:
                    active = cb.get("type")
                    callback(_TEXT_START)
                    if cb.get("type") == "redacted_thinking" and "data" in cb:
                        callback(_reasoning_delta(redactedContent=base64.b64decode(cb["data"])))
            elif t == "content_block_delta":
                d = chunk.get("delta") or {}
                if "text" in d:
                    callback(_text_delta(d["text"]))
                elif d.get("type") == "thinking_delta" and "thinking" in d:
                    callback(_reasoning_delta(text=d["thinking"]))
                elif d.get("type") == "signature_delta" and "signature" in d:
                    callback(_reasoning_delta(signature=d["signature"]))
                elif d.get("type") == "input_json_delta" and "partial_json" in d:
                    callback(_tool_use_delta(d["partial_json"]))
            elif t == "content_block_stop":
                if active is not None:
                    callback(_BLOCK_STOP)
                    active = None
            elif t == "message_delta":
                d = chunk.get("delta") or {}
                if "stop_reason" in d:
                    stop_reason = d["stop_reason"]
                u = chunk.get("usage") or {}
                if "output_tokens" in u:
                    out_toks = u["output_tokens"]
                cache_read = u.get("cache_read_input_tokens", cache_read)
                cache_write = u.get("cache_creation_input_tokens", cache_write)
            # message_stop carries no payload of interest.

        if active is not None:
            callback(_BLOCK_STOP)
        callback({"messageStop": {"stopReason": self._map_anthropic_stop(stop_reason)}})
        callback(_metadata(in_toks, out_toks, _latency_ms(start_time), cache_read=cache_read, cache_write=cache_write))

    def _emit_openai_chunks(
        self,
        body: Any,
        callback: Callable[..., None],
        start_time: float,
        cancel_signal: _CancellationSignal | None = None,
    ) -> None:
        """Translate an OpenAI Chat Completions stream into Strands ``StreamEvent``s.

        Content blocks are delimited by :class:`_OpenAIBlockWriter`. The metadata event is emitted even
        when no usage chunk arrives, so an endpoint that ignores ``stream_options`` reports zeroes rather
        than leaving the turn with no cost or latency at all.
        """
        callback({"messageStart": {"role": "assistant"}})
        writer = _OpenAIBlockWriter(callback)
        stop_reason: str | None = None
        usage: dict[str, Any] = {}

        for event in body:
            if cancel_signal is not None and cancel_signal.is_set():
                # Closing from this thread only: botocore's teardown is not safe against a read in
                # flight, and this thread is the one reading.
                body.close()
                return
            chunk = json.loads(event["chunk"]["bytes"])
            if choices := chunk.get("choices"):
                delta = choices[0].get("delta") or {}
                if delta.get("content"):
                    writer.write_text(delta["content"])
                for tool_call in delta.get("tool_calls") or []:
                    writer.write_tool_call(tool_call)
                if finish := choices[0].get("finish_reason"):
                    stop_reason = finish
            if chunk.get("usage"):
                usage = chunk["usage"]

        writer.close()
        callback({"messageStop": {"stopReason": self._map_openai_stop(stop_reason)}})
        inp = usage.get("prompt_tokens", 0)
        out = usage.get("completion_tokens", 0)
        callback(_metadata(inp, out, _latency_ms(start_time), usage.get("total_tokens", inp + out)))

    def _emit_anthropic_non_streaming(
        self, body: dict[str, Any], callback: Callable[..., None], start_time: float
    ) -> None:
        """Translate a non-streaming Anthropic Messages response into events."""
        callback({"messageStart": {"role": "assistant"}})
        for block in body.get("content") or []:
            bt = block.get("type")
            if bt == "text":
                callback(_TEXT_START)
                callback(_text_delta(block.get("text", "")))
                callback(_BLOCK_STOP)
            elif bt == "tool_use":
                callback(_tool_use_start(block["id"], block["name"]))
                callback(_tool_use_delta(json.dumps(block.get("input", {}))))
                callback(_BLOCK_STOP)
            elif bt == "thinking":
                callback(_TEXT_START)
                if "thinking" in block:
                    callback(_reasoning_delta(text=block["thinking"]))
                if block.get("signature"):
                    callback(_reasoning_delta(signature=block["signature"]))
                callback(_BLOCK_STOP)
            elif bt == "redacted_thinking":
                callback(_TEXT_START)
                callback(_reasoning_delta(redactedContent=base64.b64decode(block["data"])))
                callback(_BLOCK_STOP)
        callback({"messageStop": {"stopReason": self._map_anthropic_stop(body.get("stop_reason"))}})
        if u := body.get("usage"):
            callback(
                _metadata(
                    u.get("input_tokens", 0),
                    u.get("output_tokens", 0),
                    _latency_ms(start_time),
                    cache_read=u.get("cache_read_input_tokens", 0),
                    cache_write=u.get("cache_creation_input_tokens", 0),
                )
            )

    def _emit_openai_non_streaming(
        self, body: dict[str, Any], callback: Callable[..., None], start_time: float
    ) -> None:
        """Translate a non-streaming OpenAI Chat Completions response into events."""
        callback({"messageStart": {"role": "assistant"}})
        choices = body.get("choices") or []
        finish: str | None = None
        if choices:
            choice = choices[0]
            msg = choice.get("message") or {}
            finish = choice.get("finish_reason")
            if content := msg.get("content"):
                callback(_TEXT_START)
                callback(_text_delta(content))
                callback(_BLOCK_STOP)
            for idx, tc in enumerate(msg.get("tool_calls") or []):
                fn = tc.get("function") or {}
                callback(_tool_use_start(tc.get("id") or f"call_{idx}", fn.get("name", "")))
                callback(_tool_use_delta(fn.get("arguments", "")))
                callback(_BLOCK_STOP)
        callback({"messageStop": {"stopReason": self._map_openai_stop(finish)}})
        if u := body.get("usage"):
            inp = u.get("prompt_tokens", 0)
            out = u.get("completion_tokens", 0)
            callback(_metadata(inp, out, _latency_ms(start_time), u.get("total_tokens", inp + out)))

    # ----- public API

    @override
    def format_request(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
        tool_choice: ToolChoice | None = None,
        dynamic_trailing_blocks: int = 0,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Reject Converse-shaped request formatting, which this provider never sends.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt_content: Structured system prompt content blocks.
            tool_choice: Selection strategy for tool invocation.
            dynamic_trailing_blocks: How many trailing blocks of the last user message are rebuilt on every
                call, so the cache point goes ahead of them.
            **kwargs: Additional keyword arguments for future extensibility.

        Raises:
            NotImplementedError: Always.
        """
        raise NotImplementedError(
            "BedrockInvokeModel sends Anthropic Messages / OpenAI Chat Completions requests, not Bedrock Converse "
            "requests; format_request() is not supported — use BedrockModel for Converse-shaped access."
        )

    @override
    def convert_non_streaming_to_streaming(self, response: dict[str, Any], **kwargs: Any) -> Iterable[StreamEvent]:
        """Reject Converse-shaped response translation, which this provider never receives.

        Args:
            response: The non-streaming response from the model.
            **kwargs: Additional keyword arguments for future extensibility.

        Raises:
            NotImplementedError: Always.
        """
        raise NotImplementedError(
            "BedrockInvokeModel receives Anthropic Messages / OpenAI Chat Completions responses, not Bedrock Converse "
            "responses; convert_non_streaming_to_streaming() is not supported — use BedrockModel for Converse-shaped "
            "access."
        )

    @override
    async def count_tokens(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
    ) -> int:
        """Estimate token count with the local heuristic.

        Bedrock's native CountTokens API only accepts Converse-shaped input, so it cannot count the
        InvokeModel request bodies this provider sends. This bypasses ``BedrockModel.count_tokens``
        and always uses the base heuristic.

        Args:
            messages: List of message objects to count tokens for.
            tool_specs: List of tool specifications to include in the count.
            system_prompt: Plain string system prompt. Ignored if system_prompt_content is provided.
            system_prompt_content: Structured system prompt content blocks.

        Returns:
            Estimated input token count.
        """
        return await Model.count_tokens(self, messages, tool_specs, system_prompt, system_prompt_content)

    @override
    async def stream(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        *,
        tool_choice: ToolChoice | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
        cancel_signal: threading.Event | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream a turn through Bedrock InvokeModel.

        Args:
            messages: List of message objects to be processed by the model.
            tool_specs: List of tool specifications to make available to the model.
            system_prompt: System prompt to provide context to the model.
            tool_choice: Selection strategy for tool invocation.
            system_prompt_content: Structured system prompt content blocks.
            cancel_signal: Event that aborts an in-flight streaming request. The caller stops receiving
                events as soon as it is set, and the response is closed at the next chunk boundary. A
                non-streaming request (``streaming=False``) is not abortable.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Model events.

        Raises:
            ContextWindowOverflowException: If the input exceeds the model's context window.
            ModelThrottledException: If the model service is throttling requests.
            ValueError: If the model id belongs to a foundation-model family whose native InvokeModel
                body shape this provider does not send, and no ``model_family`` override is configured.
        """

        def callback(event: StreamEvent | None = None) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, event)

        loop = asyncio.get_event_loop()
        queue: asyncio.Queue[StreamEvent | None] = asyncio.Queue()
        worker_cancel_signal = _WorkerCancelSignal(cancel_signal)

        if system_prompt and system_prompt_content is None:
            system_prompt_content = [{"text": system_prompt}]

        thread = asyncio.to_thread(
            self._stream, callback, messages, tool_specs, system_prompt_content, tool_choice, worker_cancel_signal
        )
        task = asyncio.create_task(thread)
        cancel_poll = asyncio.ensure_future(_poll_cancel_signal(cancel_signal)) if cancel_signal else None

        try:
            while True:
                event = await _next_stream_event(queue, cancel_poll)
                if event is None:
                    break
                yield event

            if cancel_poll is not None and cancel_poll.done():
                # The worker thread owns the event stream and closes it at its next chunk boundary.
                # Detaching it rather than awaiting keeps a stalled read from delaying the caller.
                worker_cancel_signal.set()
                task.add_done_callback(_suppress_task_exception)
                return

            await task
        except BaseException:
            # Don't block cancellation on the in-flight blocking boto3 call; consume its exception later instead.
            worker_cancel_signal.set()
            task.add_done_callback(_suppress_task_exception)
            raise
        finally:
            if cancel_poll is not None:
                cancel_poll.cancel()

    def _stream(  # type: ignore[override]
        self,
        callback: Callable[..., None],
        messages: Messages,
        tool_specs: list[ToolSpec] | None,
        system_prompt_content: list[SystemContentBlock] | None,
        tool_choice: ToolChoice | None,
        cancel_signal: _CancellationSignal | None = None,
    ) -> None:
        """Run the InvokeModel call on a worker thread and stream events."""
        try:
            family = self._get_model_family()
            request = self._format_invoke_request(messages, tool_specs, system_prompt_content, tool_choice)
            logger.debug("family=<%s> request=<%s>", family, request)

            common_kwargs = {
                "modelId": self.config["model_id"],
                "body": json.dumps(request),
                "contentType": "application/json",
                "accept": "application/json",
            }

            start_time = time.perf_counter()
            if self.config.get("streaming", True):
                response = self.client.invoke_model_with_response_stream(**common_kwargs)
                stream_emit = self._emit_anthropic_chunks if family == "anthropic" else self._emit_openai_chunks
                stream_emit(response["body"], callback, start_time, cancel_signal)
            else:
                response = self.client.invoke_model(**common_kwargs)
                body = json.loads(response["body"].read())
                logger.debug("response_body=<%s>", body)
                non_stream_emit = (
                    self._emit_anthropic_non_streaming if family == "anthropic" else self._emit_openai_non_streaming
                )
                non_stream_emit(body, callback, start_time)

        except ClientError as error:
            self._add_model_family_note(error)
            self._raise_translated_client_error(error)
        finally:
            callback()
            logger.debug("finished streaming response from model")

    def _add_model_family_note(self, error: ClientError) -> None:
        """Note which dialect the request body used, a common cause of a rejected InvokeModel call.

        An Anthropic model reached through a provisioned-throughput or inference-profile ARN carries no
        ``anthropic``/``claude`` substring, so detection settles on ``openai`` and Bedrock rejects the body
        without saying why.
        """
        explicit = self.config.get("model_family")
        source = "explicitly set via model_family=" if explicit else "auto-detected from the model id"
        add_exception_note(error, f"└ Request body family: {explicit or self._get_model_family()} ({source})")
        add_exception_note(error, '└ Override it with model_family="anthropic" or model_family="openai"')

    @override
    async def structured_output(
        self,
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[dict[str, T | Any], None]:
        """Constrain the model to a Pydantic ``BaseModel`` via a forced tool call."""
        tool_spec = convert_pydantic_to_tool_spec(output_model)
        response = self.stream(
            messages=prompt,
            tool_specs=[tool_spec],
            system_prompt=system_prompt,
            tool_choice=cast(ToolChoice, {"any": {}}),
            **kwargs,
        )

        last: dict[str, Any] | None = None
        async for event in streaming.process_stream(response):
            last = event
            yield event

        if last is None or "stop" not in last:
            raise ValueError("Stream ended without a stop event.")
        stop_reason, message, _, _ = last["stop"]
        if stop_reason != "tool_use":
            raise ValueError(f'Model returned stop_reason: {stop_reason} instead of "tool_use".')
        for block in message["content"]:
            if block.get("toolUse") and block["toolUse"]["name"] == tool_spec["name"]:
                yield {"output": output_model(**block["toolUse"]["input"])}
                return
        raise ValueError(f"No tool use found for {tool_spec['name']}")
