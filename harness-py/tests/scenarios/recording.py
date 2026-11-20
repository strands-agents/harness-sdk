"""Records every model request an agent makes and checks the invariants every scenario must keep."""

from __future__ import annotations

import copy
import json
import logging
import weakref
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from strands import Agent
from strands.hooks import AfterInvocationEvent
from strands.models import Model
from strands.types.content import Messages

_LOGGER_NAMES = ("strands", "strands_harness")


@dataclass
class ModelCall:
    """One ``Model.stream`` call: the request as the provider received it, then what the stream reported."""

    model: Model = field(repr=False)
    model_id: str
    system_prompt: str | None
    system_prompt_content: list[Any] | None
    tool_specs: list[Any] | None
    messages: Messages
    # Trailing blocks of the last message that the SDK re-renders on every call (injected reminders).
    dynamic_trailing_blocks: int
    # A summary or memory-extraction request rather than a request of the agent loop.
    auxiliary: bool = False
    # The call raised, then the SDK sent the identical request again and that attempt did not raise.
    retried: bool = False
    usage: dict[str, int] = field(default_factory=dict)
    stop_reason: str | None = None
    error: str | None = None


class Recording:
    """The model calls of a run in order, the call count at the end of each turn, and WARNING+ log records."""

    def __init__(self) -> None:
        self.calls: list[ModelCall] = []
        self.logs: list[logging.LogRecord] = []
        self.turn_ends: list[int] = []
        self._summarizing = False

    @property
    def loop_calls(self) -> list[ModelCall]:
        """The agent loop's requests: every call except the auxiliary ones and the attempts the SDK retried."""
        return [call for call in self.calls if not (call.auxiliary or call.retried)]

    def attach(self, model: Model) -> None:
        """Record ``model`` too. Wraps ``stream`` on the instance, so its class stays the real one."""
        stream = model.stream
        summarize = model.summarize

        async def recorded_summarize(*args, **kwargs):
            self._summarizing = True
            try:
                return await summarize(*args, **kwargs)
            finally:
                self._summarizing = False

        async def recorded_stream(messages, tool_specs=None, system_prompt=None, **kwargs):
            previous = next((earlier for earlier in reversed(self.calls) if earlier.model is model), None)
            call = ModelCall(
                model=model,
                model_id=model.get_config()["model_id"],
                system_prompt=system_prompt,
                system_prompt_content=copy.deepcopy(kwargs.get("system_prompt_content")),
                tool_specs=copy.deepcopy(tool_specs),
                messages=copy.deepcopy(messages),
                dynamic_trailing_blocks=kwargs.get("dynamic_trailing_blocks", 0),
                # The agent loop always sends tool specs; a memory-extraction request sends none.
                auxiliary=self._summarizing or tool_specs is None,
            )
            self.calls.append(call)
            # The SDK re-sends a throttled request as is, so a failed attempt followed by its twin was retried.
            if previous is not None and previous.error and _request(previous) == _request(call):
                previous.retried = True
            try:
                async for event in stream(messages, tool_specs, system_prompt, **kwargs):
                    if "messageStop" in event:
                        call.stop_reason = event["messageStop"]["stopReason"]
                    if "metadata" in event:
                        call.usage = dict(event["metadata"].get("usage", {}))
                    yield event
            except Exception as error:
                call.error = f"{type(error).__name__}: {error}"
                raise

        model.stream = recorded_stream  # type: ignore[method-assign]
        model.summarize = recorded_summarize  # type: ignore[method-assign]

    def dump(self, path: Path) -> None:
        """Write the recording as JSON, so a failed run can be read as a transcript."""
        calls = [{key: value for key, value in vars(call).items() if key != "model"} for call in self.calls]
        logs = [f"{log.levelname} {log.name}: {log.getMessage()}" for log in self.logs]
        path.write_text(json.dumps({"calls": calls, "turn_ends": self.turn_ends, "logs": logs}, indent=2, default=str))


def record(agent: Agent) -> Recording:
    """Start recording ``agent``: its model's requests, where each turn ends, and WARNING+ SDK/harness logs."""
    recording = Recording()
    recording.attach(agent.model)
    agent.add_hook(lambda _event: recording.turn_ends.append(len(recording.calls)), AfterInvocationEvent)
    handler = logging.Handler(logging.WARNING)
    handler.emit = recording.logs.append  # type: ignore[method-assign]
    for name in _LOGGER_NAMES:
        logger = logging.getLogger(name)
        logger.addHandler(handler)
        weakref.finalize(recording, logger.removeHandler, handler)
    return recording


def check_invariants(
    recording: Recording,
    agent: Agent,
    *,
    allowed_tool_errors: tuple[str, ...] = (),
    prefix_breaks: int = 0,
    auxiliary_calls: int = 0,
) -> None:
    """Raise one ``AssertionError`` listing every invariant the recorded run broke.

    Args:
        recording: The recording of the run.
        agent: The agent that ran, for its final conversation.
        allowed_tool_errors: Names of tools whose results may have error status.
        prefix_breaks: Exact number of agent-loop requests that rewrite earlier messages (one per compaction).
        auxiliary_calls: Exact number of auxiliary requests (compaction summaries, memory extractions).
    """
    violations = []
    loop_calls = recording.loop_calls
    if not loop_calls:
        violations.append("no agent-loop request was recorded, so nothing was checked")
    conversations = [("agent.messages", agent.messages)]
    conversations += [(f"call {recording.calls.index(call)}", call.messages) for call in loop_calls]

    failed_tools = set()
    for label, messages in conversations:
        violations += [f"tool pairing, {label}: {problem}" for problem in _pairing_problems(messages)]
        failed_tools |= _failed_tools(messages)
    for name in sorted(failed_tools - set(allowed_tool_errors)):
        violations.append(f"failed tool: {name} returned an error result")

    for index, call in enumerate(recording.calls):
        if call.error and not call.retried:
            violations.append(f"clean stops: call {index} raised {call.error}")
    for end in recording.turn_ends:
        last = next((call for call in reversed(recording.calls[:end]) if not (call.auxiliary or call.retried)), None)
        if last is not None and last.stop_reason != "end_turn":
            violations.append(
                f"clean stops: a turn ended on call {recording.calls.index(last)} with {last.stop_reason}"
            )

    for log in recording.logs:
        if log.levelno >= logging.ERROR:
            violations.append(f"error log: {log.name}: {log.getMessage()}")

    auxiliary = [index for index, call in enumerate(recording.calls) if call.auxiliary and not call.retried]
    if len(auxiliary) != auxiliary_calls:
        violations.append(
            f"auxiliary calls: expected {auxiliary_calls} auxiliary request(s) (summary, memory extraction), "
            f"calls {auxiliary} were"
        )

    breaks = []
    latest: dict[int, ModelCall] = {}
    for call in loop_calls:
        index = recording.calls.index(call)
        earlier = latest.get(id(call.model))
        latest[id(call.model)] = call
        if earlier is None:
            continue
        if (call.system_prompt, call.system_prompt_content) != (earlier.system_prompt, earlier.system_prompt_content):
            violations.append(f"stable prefix: call {index} changed the system prompt on model {call.model_id}")
        if call.tool_specs != earlier.tool_specs:
            violations.append(f"stable prefix: call {index} changed the tool specs on model {call.model_id}")
        if not _extends(earlier, call):
            breaks.append(index)
    if len(breaks) != prefix_breaks:
        violations.append(
            f"stable prefix: expected {prefix_breaks} call(s) that rewrite earlier messages "
            f"(a provider prompt-cache miss), calls {breaks} did"
        )

    if violations:
        raise AssertionError("\n".join(violations))


def _blocks(message: Any, key: str) -> list[Any]:
    return [block[key] for block in message["content"] if key in block]


def _pairing_problems(messages: Messages) -> list[str]:
    problems = []
    for index, message in enumerate(messages):
        uses = sorted(use["toolUseId"] for use in _blocks(message, "toolUse"))
        results = sorted(result["toolUseId"] for result in _blocks(message, "toolResult"))
        answers = _blocks(messages[index + 1], "toolResult") if index + 1 < len(messages) else []
        if uses and uses != sorted(answer["toolUseId"] for answer in answers):
            problems.append(f"message {index} uses {uses} but the next message does not answer exactly those")
        if results and not (index and _blocks(messages[index - 1], "toolUse")):
            problems.append(f"message {index} has results {results} without a toolUse before it")
    return problems


def _failed_tools(messages: Messages) -> set[str]:
    names = {use["toolUseId"]: use["name"] for message in messages for use in _blocks(message, "toolUse")}
    return {
        names.get(result["toolUseId"], "unknown")
        for message in messages
        for result in _blocks(message, "toolResult")
        if result.get("status") == "error"
    }


def _request(call: ModelCall) -> tuple[Any, ...]:
    prompt = (call.system_prompt, call.system_prompt_content)
    return call.model_id, prompt, call.tool_specs, call.messages, call.dynamic_trailing_blocks


def _stable_prefix(call: ModelCall) -> Messages:
    """The messages a provider can cache: all but the dynamic trailing blocks of the last one."""
    if not call.dynamic_trailing_blocks:
        return call.messages
    *before, last = call.messages
    return [*before, {**last, "content": last["content"][: -call.dynamic_trailing_blocks]}]


def _extends(earlier: ModelCall, later: ModelCall) -> bool:
    """Whether ``later`` starts with the stable prefix of ``earlier``, message for message."""
    prefix = _stable_prefix(earlier)
    return _stable_prefix(later)[: len(prefix)] == prefix
