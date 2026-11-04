"""Live harness for summarization on preserved-thinking Claude models over first-party Anthropic.

Runs one bounded multi-turn tool task and forces a fixed number of summary passes, with test-local
instrumentation only: every HTTP status, every compaction block returned and replayed, every
``input_transformations`` entry, and every SDK warning. Nothing logs keys or full conversations.

Shared by ``test_context_manager_native_compaction.py`` and by a manual run of this module, which runs the
task once and prints a count-only report. It makes paid first-party Anthropic requests:

    ANTHROPIC_API_KEY=... hatch run python -m tests_integ._native_compaction [native|base]

``STRANDS_INTEG_MAIN_MODEL_ID`` and ``STRANDS_INTEG_SUMMARIZER_MODEL_ID`` override the models (default Sonnet 5.5
and Haiku 5.5; set both to the same id for same-model compaction). ``STRANDS_INTEG_PIN_INDEX`` pins that message
before the first pass.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import os
import sys
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal, cast

import anthropic
import httpx

import strands
from strands import Agent
from strands.experimental.context_manager import ContextManager, ContextState, Offload
from strands.models import ModelCapabilities, ModelInfo
from strands.models.anthropic import AnthropicModel
from strands.types.content import ContentBlock, Message, Messages

# Verified on platform.claude.com compaction-on-demand (supported models), 2026-11-02.
SONNET_5_5 = "claude-sonnet-5-5"
HAIKU_5_5 = "claude-haiku-5-5"

CODEWORD = "PELICAN"
STEPS = 7
TASK = " ".join(
    [
        f"Read steps 1 to {STEPS} in order with read_step, one call per turn.",
        f'Every read_step call must pass codeword "{CODEWORD}".',
        "When all steps are read, reply with exactly: DONE <sum of the values>.",
    ]
)
EXPECTED_SUM = sum((index + 1) * 7 for index in range(STEPS))
INSTRUCTIONS = " ".join(
    [
        "Summarize the conversation so far for the assistant that continues it.",
        "Restate the original task from the first user message word for word, including the codeword.",
        "List every step already read with its value. Do not call tools; respond with the summary text only.",
    ]
)
PASSES = [4, 7]

# Binding failures error instead of hiding behind an account default.
STRICT_THINKING: dict[str, Any] = {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "error"}}
BASE_THINKING: dict[str, Any] = {"type": "adaptive"}
_BINDING_BETA = "thinking-binding-controls-2026-08-01"
_DROP_BLOCK_WARNING = "history edit invalidated replayed thinking blocks, retrying with drop_block"

ExchangeKind = Literal["compaction", "conversation", "summarizer"]


@dataclass
class HarnessOptions:
    """One run of the task.

    Attributes:
        api_key: First-party Anthropic API key.
        main_model_id: Model that runs the task.
        summarizer_model_id: Model the summarize strategy calls.
        server_side_summary: ``True`` opts both models into native compaction; ``None`` leaves the capability
            unset (base control).
        thinking: Thinking config of both models; the base control may leave ``block_binding`` to the account.
        pass_before_calls: Model calls (1-based) that a summary pass precedes.
        pin_before_first_pass: Index of a message to pin before the first pass, so the summary joins a pinned
            message.
        max_tokens: Output token limit of both models.
    """

    api_key: str
    main_model_id: str
    summarizer_model_id: str
    server_side_summary: Literal[True] | None
    thinking: dict[str, Any]
    pass_before_calls: list[int]
    pin_before_first_pass: int | None = None
    max_tokens: int = 8192


@dataclass
class Exchange:
    """One HTTP exchange with the Messages API, without bodies.

    Attributes:
        kind: Which call the request was: native compaction, a main-model turn, or a client-side summary.
        model: Model id the request named.
        status: HTTP status of the response.
        returned: Compaction blocks the response returned, as returned.
        sent_compaction: Compaction blocks the request carried, as sent.
        sent_thinking: Signatures of the thinking blocks the request carried.
        returned_thinking: Signatures of the thinking blocks the response returned.
        input_transformations: ``input_transformations`` entries seen in the response; ``None`` when the field
            never appeared.
    """

    kind: ExchangeKind
    model: str
    status: int
    returned: list[dict[str, Any]] = field(default_factory=list)
    sent_compaction: list[dict[str, Any]] = field(default_factory=list)
    sent_thinking: list[str] = field(default_factory=list)
    returned_thinking: list[str] = field(default_factory=list)
    input_transformations: list[Any] | None = None
    _raw: bytearray = field(default_factory=bytearray, repr=False)
    _event_stream: bool = field(default=False, repr=False)


@dataclass
class HarnessReport:
    """What the wire and the agent saw in one run."""

    exchanges: list[Exchange]
    warnings: list[str]
    drop_block_warnings: list[str]
    codewords_after_pass: list[list[str]]
    passes: int
    final_text: str
    total_tokens: int
    message_zero_after: Message
    # Role and block types of messages[1], each marked with the provider of its provider data.
    message_one_after: str

    def of_kind(self, kind: ExchangeKind) -> list[Exchange]:
        """The exchanges of one kind, in request order."""
        return [exchange for exchange in self.exchanges if exchange.kind == kind]


class _TeeStream(httpx.AsyncByteStream):
    """Passes a response body through unchanged while keeping a copy of its bytes."""

    def __init__(self, inner: httpx.AsyncByteStream, sink: bytearray) -> None:
        self._inner = inner
        self._sink = sink

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self._inner:
            self._sink.extend(chunk)
            yield chunk

    async def aclose(self) -> None:
        await self._inner.aclose()


class _RecordingTransport(httpx.AsyncBaseTransport):
    """Records every Messages API exchange both models' clients make."""

    def __init__(self, exchanges: list[Exchange]) -> None:
        self._inner = httpx.AsyncHTTPTransport()
        self._exchanges = exchanges

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if not request.url.path.endswith("/v1/messages"):
            return await self._inner.handle_async_request(request)
        body: dict[str, Any] = json.loads(request.content or b"{}")
        # An uncompressed body, so the copy reads as sent.
        request.headers["accept-encoding"] = "identity"
        response = await self._inner.handle_async_request(request)
        exchange = Exchange(
            kind=_kind_of(body),
            model=str(body.get("model")),
            status=response.status_code,
            sent_compaction=_blocks_of_type(body.get("messages"), "compaction"),
            sent_thinking=[str(block.get("signature")) for block in _blocks_of_type(body.get("messages"), "thinking")],
            _event_stream=response.headers.get("content-type", "").startswith("text/event-stream"),
        )
        self._exchanges.append(exchange)
        assert isinstance(response.stream, httpx.AsyncByteStream)
        return httpx.Response(
            status_code=response.status_code,
            headers=response.headers,
            stream=_TeeStream(response.stream, exchange._raw),
            extensions=response.extensions,
            request=request,
        )

    async def aclose(self) -> None:
        await self._inner.aclose()


class _WarningCapture(logging.Handler):
    """Collects the SDK's warnings and errors."""

    def __init__(self, warnings: list[str]) -> None:
        super().__init__(level=logging.WARNING)
        self._warnings = warnings

    def emit(self, record: logging.LogRecord) -> None:
        self._warnings.append(record.getMessage())


class _PlannedSummaryPasses:
    """Runs the summarize strategy, at full utilization, before the planned model calls only."""

    name = "test:planned-summary-passes"

    def __init__(self, options: HarnessOptions, summarizer: AnthropicModel, codewords: list[list[str]]) -> None:
        self._options = options
        self._summarize = Offload.summarize("*", {"model": summarizer, "system_prompt": INSTRUCTIONS}).when(
            utilization=0, preserve_recent=3
        )
        self._codewords = codewords
        self._calls = 0
        self.passes = 0

    async def apply(self, context: ContextState) -> bool:
        self._calls += 1
        if self._calls not in self._options.pass_before_calls:
            return False
        if self.passes == 0 and self._options.pin_before_first_pass is not None:
            _pin(context.messages, self._options.pin_before_first_pass)
        acted = await self._summarize.apply(dataclasses.replace(context, utilization=1.0))
        if acted:
            self.passes += 1
            self._codewords.append([])
        return acted


def _model(options: HarnessOptions, model_id: str, http_client: httpx.AsyncClient) -> AnthropicModel:
    capabilities = ModelCapabilities(server_side_summary=options.server_side_summary)
    return AnthropicModel(
        client_args={
            "api_key": options.api_key,
            "max_retries": 0,
            "http_client": http_client,
            "default_headers": {"anthropic-beta": _BINDING_BETA},
        },
        model_id=model_id,
        max_tokens=options.max_tokens,
        params={"thinking": options.thinking},
        model_info=ModelInfo(capabilities=capabilities),
    )


async def run_compaction_task(options: HarnessOptions) -> HarnessReport:
    """Run the task once and return what the wire and the agent saw."""
    exchanges: list[Exchange] = []
    warnings: list[str] = []
    codewords: list[list[str]] = [[]]

    @strands.tool
    def read_step(n: int, codeword: str) -> str:
        """Read the value of one step.

        Args:
            n: The step number.
            codeword: The task's codeword.
        """
        codewords[-1].append(codeword)
        # A modular inverse makes every turn reason, so kept thinking is in the history at every pass.
        residue = (n * 7 * 11) % 53
        return f"step {n}: the value is the x in 1..52 with (11 * x) mod 53 == {residue}"

    capture = _WarningCapture(warnings)
    sdk_logger = logging.getLogger("strands")
    sdk_logger.addHandler(capture)
    http_client = anthropic.DefaultAsyncHttpxClient(transport=_RecordingTransport(exchanges))
    try:
        summarizer = _model(options, options.summarizer_model_id, http_client)
        planned = _PlannedSummaryPasses(options, summarizer, codewords)
        agent = Agent(
            model=_model(options, options.main_model_id, http_client),
            system_prompt="You are a careful assistant that follows the task exactly.",
            tools=[read_step],
            callback_handler=None,
            context_manager=ContextManager(strategies=[planned], stash=False),
        )
        result = await agent.invoke_async(TASK)
    finally:
        sdk_logger.removeHandler(capture)
        await http_client.aclose()

    for exchange in exchanges:
        _read_response(exchange)
    return HarnessReport(
        exchanges=exchanges,
        warnings=warnings,
        drop_block_warnings=[warning for warning in warnings if _DROP_BLOCK_WARNING in warning],
        codewords_after_pass=codewords[1:],
        passes=planned.passes,
        final_text=str(result),
        total_tokens=result.metrics.accumulated_usage["totalTokens"],
        message_zero_after=agent.messages[0],
        message_one_after=_describe_message(agent.messages[1] if len(agent.messages) > 1 else None),
    )


def describe_report(report: HarnessReport) -> str:
    """One-line summary of a report, with counts only."""

    def transformations(kind: ExchangeKind) -> str:
        return ",".join(
            "-" if exchange.input_transformations is None else str(len(exchange.input_transformations))
            for exchange in report.of_kind(kind)
        )

    return json.dumps(
        {
            "passes": report.passes,
            "requests": {kind: len(report.of_kind(kind)) for kind in ("compaction", "conversation", "summarizer")},
            "statuses": [exchange.status for exchange in report.exchanges],
            "dropBlockWarnings": len(report.drop_block_warnings),
            "inputTransformations": {
                "compaction": transformations("compaction"),
                "conversation": transformations("conversation"),
            },
            "codewordsAfterPass": report.codewords_after_pass,
            "finalText": report.final_text[:80],
            "totalTokens": report.total_tokens,
            "messageZeroAfter": _describe_message(report.message_zero_after),
            "messageOneAfter": report.message_one_after,
            "compactionBlocks": {
                "returned": sum(len(exchange.returned) for exchange in report.of_kind("compaction")),
                "replayedPerRequest": [len(exchange.sent_compaction) for exchange in report.of_kind("conversation")],
            },
        }
    )


def _kind_of(body: dict[str, Any]) -> ExchangeKind:
    if "compaction" in body:
        return "compaction"
    # The client-side summary sends no tools; every main-model turn sends read_step.
    return "conversation" if body.get("tools") else "summarizer"


def _describe_message(message: Message | None) -> str:
    if message is None:
        return "none"
    return f"{message['role']}:{','.join(_describe_block(block) for block in message['content'])}"


def _describe_block(block: ContentBlock) -> str:
    kind = next((key for key in block if key != "metadata"), "empty")
    metadata: dict[str, Any] = cast(dict[str, Any], block).get("metadata") or {}
    server_side = metadata.get("serverSideSummary")
    return f"{kind}+{server_side['provider']}" if server_side else kind


def _pin(messages: Messages, index: int) -> None:
    message = messages[index]
    metadata = message.get("metadata", {})
    message["metadata"] = {**metadata, "custom": {**metadata.get("custom", {}), "pinned": True}}


def _read_response(exchange: Exchange) -> None:
    """Fill in what the response returned, from its copied body."""
    text = exchange._raw.decode("utf-8", errors="replace")
    if not exchange._event_stream:
        _read_message(exchange, json.loads(text) if text.strip() else {})
        return
    signatures: dict[int, str] = {}
    for line in text.split("\n"):
        if not line.startswith("data: "):
            continue
        event = json.loads(line[len("data: ") :])
        _add_transformations(exchange, event)
        block = event.get("content_block") or {}
        if event.get("type") == "content_block_start" and block.get("type") == "compaction":
            exchange.returned.append(block)
        delta = event.get("delta") or {}
        if delta.get("type") == "signature_delta":
            signatures[int(event["index"])] = str(delta["signature"])
    exchange.returned_thinking = list(signatures.values())


def _read_message(exchange: Exchange, message: dict[str, Any]) -> None:
    """Fill in what a non-streamed response returned."""
    _add_transformations(exchange, message)
    content = message.get("content") or []
    exchange.returned = [block for block in content if block.get("type") == "compaction"]
    exchange.returned_thinking = [str(block.get("signature")) for block in content if block.get("type") == "thinking"]


def _add_transformations(exchange: Exchange, value: Any) -> None:
    found = _find_key(value, "input_transformations")
    if found is not None:
        exchange.input_transformations = [*(exchange.input_transformations or []), *found]


def _blocks_of_type(messages: Any, block_type: str) -> list[dict[str, Any]]:
    if not isinstance(messages, list):
        return []
    return [
        block
        for message in messages
        if isinstance(message.get("content"), list)
        for block in message["content"]
        if block.get("type") == block_type
    ]


def _find_key(value: Any, key: str) -> list[Any] | None:
    """The value of ``key`` anywhere in ``value``, ``[]`` when it is null, or ``None`` when it is absent."""
    if isinstance(value, dict):
        if key in value:
            return value[key] or []
        inner_values: list[Any] = list(value.values())
    elif isinstance(value, list):
        inner_values = value
    else:
        return None
    return next((found for inner in inner_values if (found := _find_key(inner, key)) is not None), None)


def _options_from_environment(api_key: str, native: bool) -> HarnessOptions:
    pin_index = os.environ.get("STRANDS_INTEG_PIN_INDEX")
    return HarnessOptions(
        api_key=api_key,
        main_model_id=os.environ.get("STRANDS_INTEG_MAIN_MODEL_ID", SONNET_5_5),
        summarizer_model_id=os.environ.get("STRANDS_INTEG_SUMMARIZER_MODEL_ID", HAIKU_5_5),
        server_side_summary=True if native else None,
        thinking=STRICT_THINKING if native else BASE_THINKING,
        pass_before_calls=PASSES,
        pin_before_first_pass=int(pin_index) if pin_index else None,
    )


def main() -> None:
    """Run the task once in the mode named by the first argument and print a count-only report."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise SystemExit("ANTHROPIC_API_KEY is not set")
    native = (sys.argv[1] if len(sys.argv) > 1 else "native") == "native"
    report = asyncio.run(run_compaction_task(_options_from_environment(api_key, native)))
    print(describe_report(report))


if __name__ == "__main__":
    main()
