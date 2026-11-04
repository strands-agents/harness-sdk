"""End-to-end check: Anthropic on-demand compaction through ``BedrockModel`` over InvokeModel, without ``anthropic``.

Runs a Strands ``Agent`` on a preserved-thinking Claude model on Bedrock with strict thinking binding, forces summary
passes through the context manager, and checks on the wire (botocore events) and in ``agent.messages`` that:

- ``anthropic`` is never imported (it is blocked before ``strands`` loads);
- every request goes through InvokeModel, never Converse;
- each pass is a native compaction request, and its block is stored at ``messages[1]`` as Anthropic provider data;
- every later request starts at the compaction block, replays signed thinking, and succeeds with no drop_block retry;
- the model keeps thinking after compaction and finishes the task with the right answer.

It makes paid Bedrock requests with the default AWS credentials:

    hatch run python -m tests_integ._bedrock_native_compaction

``STRANDS_INTEG_BEDROCK_REGION``, ``STRANDS_INTEG_MAIN_MODEL_ID`` and ``STRANDS_INTEG_SUMMARIZER_MODEL_ID`` override
the region and models (default us-west-2, Sonnet 5.5 and Haiku 5.5 inference profiles).
"""

from __future__ import annotations

import sys

sys.modules["anthropic"] = None  # type: ignore[assignment]  # any import of anthropic now raises ImportError

import asyncio  # noqa: E402
import dataclasses  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
import os  # noqa: E402
from dataclasses import dataclass, field  # noqa: E402
from typing import Any  # noqa: E402

import strands  # noqa: E402
from strands import Agent  # noqa: E402
from strands.experimental.context_manager import ContextManager, ContextState, Offload  # noqa: E402
from strands.models import ModelCapabilities, ModelInfo  # noqa: E402
from strands.models.bedrock import BedrockModel  # noqa: E402
from strands.types.content import Messages  # noqa: E402

REGION = os.environ.get("STRANDS_INTEG_BEDROCK_REGION", "us-west-2")
MAIN_MODEL_ID = os.environ.get("STRANDS_INTEG_MAIN_MODEL_ID", "us.anthropic.claude-sonnet-5-5")
SUMMARIZER_MODEL_ID = os.environ.get("STRANDS_INTEG_SUMMARIZER_MODEL_ID", "us.anthropic.claude-haiku-5-5")

BINDING_BETA = "thinking-binding-controls-2026-08-01"
# Binding failures error instead of hiding behind an account default.
STRICT_THINKING = {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "error"}}
CODEWORD = "PELICAN"
STEPS = 7
EXPECTED_SUM = sum(n * 7 for n in range(1, STEPS + 1))
TASK = (
    f"Read steps 1 to {STEPS} in order with read_step, one call per turn. Every read_step call must pass codeword "
    f'"{CODEWORD}". When all steps are read, reply with exactly: DONE <sum of the values>.'
)
INSTRUCTIONS = (
    "Summarize the conversation so far for the assistant that continues it. Restate the original task from the "
    "first user message word for word, including the codeword. List every step already read with its value. "
    "Do not call tools; respond with the summary text only."
)
PASS_BEFORE_CALLS = [4, 7]
DROP_BLOCK_WARNING = "history edit invalidated replayed thinking blocks, retrying with drop_block"


@dataclass
class Request:
    """One Bedrock runtime call, without bodies."""

    operation: str
    model_id: str
    compaction: bool = False
    first_block_type: str | None = None
    sent_thinking: int = 0
    error: str | None = None


@dataclass
class Report:
    """What the wire and the agent saw."""

    requests: list[Request] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    codewords: list[str] = field(default_factory=list)
    passes: int = 0


def _record_requests(model: BedrockModel, report: Report) -> None:
    """Record every bedrock-runtime call the model's client makes, from botocore events."""

    def before_call(model: Any, params: dict[str, Any], **_: Any) -> None:
        request = Request(operation=model.name, model_id=str(params.get("url_path", "")))
        body = params.get("body")
        if model.name.startswith("InvokeModel") and isinstance(body, (bytes, str)):
            payload = json.loads(body)
            messages = payload.get("messages") or [{}]
            first = (messages[0].get("content") or [{}])[0]
            request.compaction = "compaction" in payload
            request.first_block_type = first.get("type")
            request.sent_thinking = sum(
                1 for message in messages for block in message.get("content", []) if block.get("type") == "thinking"
            )
        report.requests.append(request)

    def after_call_error(**_: Any) -> None:
        report.requests[-1].error = "error"

    events = model.client.meta.events
    events.register("before-call.bedrock-runtime.*", before_call)
    events.register("after-call-error.bedrock-runtime.*", after_call_error)


class _WarningCapture(logging.Handler):
    def __init__(self, warnings: list[str]) -> None:
        super().__init__(level=logging.WARNING)
        self._warnings = warnings

    def emit(self, record: logging.LogRecord) -> None:
        self._warnings.append(record.getMessage())


class _PlannedSummaryPasses:
    """Runs the summarize strategy, at full utilization, before the planned model calls only."""

    name = "e2e:planned-summary-passes"

    def __init__(self, summarizer: BedrockModel, report: Report) -> None:
        self._summarize = Offload.summarize("*", {"model": summarizer, "system_prompt": INSTRUCTIONS}).when(
            utilization=0, preserve_recent=3
        )
        self._report = report
        self._calls = 0

    async def apply(self, context: ContextState) -> bool:
        self._calls += 1
        if self._calls not in PASS_BEFORE_CALLS:
            return False
        acted = await self._summarize.apply(dataclasses.replace(context, utilization=1.0))
        self._report.passes += acted
        return acted


def _model(model_id: str) -> BedrockModel:
    return BedrockModel(
        model_id=model_id,
        region_name=REGION,
        max_tokens=8192,
        additional_request_fields={"thinking": STRICT_THINKING, "anthropic_beta": [BINDING_BETA]},
        model_info=ModelInfo(capabilities=ModelCapabilities(server_side_summary=True)),
    )


def _signed_thinking_turns(messages: Messages, start: int) -> int:
    def signed(message: Any) -> bool:
        return any(block.get("reasoningContent", {}).get("reasoningText", {}).get("signature") for block in message)

    return sum(1 for message in messages[start:] if message["role"] == "assistant" and signed(message["content"]))


async def run() -> tuple[Report, Agent, str]:
    """Run the task once."""
    report = Report()

    @strands.tool
    def read_step(n: int, codeword: str) -> str:
        """Read the value of one step.

        Args:
            n: The step number.
            codeword: The task's codeword.
        """
        report.codewords.append(codeword)
        # A modular inverse makes every turn reason, so kept thinking is in the history at every pass.
        return f"step {n}: the value is the x in 1..52 with (11 * x) mod 53 == {(n * 7 * 11) % 53}"

    main, summarizer = _model(MAIN_MODEL_ID), _model(SUMMARIZER_MODEL_ID)
    _record_requests(main, report)
    _record_requests(summarizer, report)
    capture = _WarningCapture(report.warnings)
    logging.getLogger("strands").addHandler(capture)
    try:
        agent = Agent(
            model=main,
            system_prompt="You are a careful assistant that follows the task exactly.",
            tools=[read_step],
            callback_handler=None,
            context_manager=ContextManager(strategies=[_PlannedSummaryPasses(summarizer, report)], stash=False),
        )
        result = await agent.invoke_async(TASK)
    finally:
        logging.getLogger("strands").removeHandler(capture)
    return report, agent, str(result)


def check(report: Report, agent: Agent, final_text: str) -> list[str]:
    """Return the failed checks, empty when the run passed."""
    failures: list[str] = []
    compactions = [request for request in report.requests if request.compaction]
    turns = [request for request in report.requests if not request.compaction]
    last_compaction = max((i for i, r in enumerate(report.requests) if r.compaction), default=-1)
    after = [request for request in report.requests[last_compaction + 1 :] if not request.compaction]
    stored = agent.messages[1]["content"][0] if len(agent.messages) > 1 else {}
    provider = stored.get("metadata", {}).get("providerData", {}).get("provider")

    def expect(ok: bool, message: str) -> None:
        if not ok:
            failures.append(message)

    expect("anthropic" not in sys.modules or sys.modules["anthropic"] is None, "anthropic was imported")
    expect(all(r.operation.startswith("InvokeModel") for r in report.requests), "a request went through Converse")
    expect(all(r.error is None for r in report.requests), "a Bedrock request failed")
    expect(report.passes == len(PASS_BEFORE_CALLS), f"passes={report.passes}, expected {len(PASS_BEFORE_CALLS)}")
    expect(len(compactions) == report.passes, f"compaction requests={len(compactions)}, passes={report.passes}")
    expect(provider == "anthropic", f"messages[1] holds no stored compaction block: {stored}")
    expect(bool(after), "no turn ran after the last compaction")
    expect(all(r.first_block_type == "compaction" for r in after), "a turn after compaction did not start at it")
    expect(any(r.sent_thinking for r in after), "no turn after compaction replayed signed thinking")
    expect(not [w for w in report.warnings if DROP_BLOCK_WARNING in w], "thinking was dropped (drop_block retry)")
    expect(_signed_thinking_turns(agent.messages, 2) >= 1, "the model never thought after compaction")
    expect(all(codeword == CODEWORD for codeword in report.codewords), f"codewords={report.codewords}")
    expect(f"DONE {EXPECTED_SUM}" in final_text, f"final answer {final_text!r}, expected DONE {EXPECTED_SUM}")
    print(f"requests: {len(turns)} turns, {len(compactions)} compactions, {len(after)} turns after the last pass")
    print(f"thinking replayed per turn after the last pass: {[r.sent_thinking for r in after]}")
    print(f"warnings: {report.warnings or 'none'}")
    print(f"final: {final_text.strip()!r}")
    return failures


def main() -> int:
    """Run the task and print the result."""
    report, agent, final_text = asyncio.run(run())
    failures = check(report, agent, final_text)
    for failure in failures:
        print(f"FAIL: {failure}")
    print("PASS" if not failures else f"{len(failures)} check(s) failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
