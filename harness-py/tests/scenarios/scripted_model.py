"""A scripted ``Model`` that drives the real agent loop offline with a fixed sequence of replies."""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from typing import Any

from strands.models import Model
from strands.types.content import Messages
from strands.types.streaming import StreamEvent


@dataclass
class Reply:
    """One model reply. ``summary=True`` marks the reply to a compaction summary request."""

    text: str | None = None
    tool_uses: Sequence[tuple[str, dict[str, Any]]] = ()
    reasoning: str | None = None
    summary: bool = False


Step = str | Sequence[tuple[str, dict[str, Any]]] | Reply | Callable[[Messages], Any]
"""A text reply, a list of ``(tool name, input)`` uses, a ``Reply``, or a callable building one from the request."""


def _tokens(*parts: Any) -> int:
    return len(json.dumps(parts, default=str)) // 4


class ScriptedModel(Model):
    """Replies with ``steps`` in order, one per request, and fails on a request the script does not expect.

    Usage mimics a provider prefix cache: ``inputTokens`` is the whole request, the part shared with the
    previous request is also reported as a cache read and the rest as a cache write.
    """

    def __init__(self, steps: Sequence[Step], *, model_id: str = "scripted"):
        self._steps = list(steps)
        self._config = {"model_id": model_id, "context_window_limit": 200_000}
        self._summarizing = False
        self._previous_request = ""
        self._tool_use_count = 0

    def update_config(self, **model_config: Any) -> None:
        self._config.update(model_config)

    def get_config(self) -> dict[str, Any]:
        return self._config

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        raise NotImplementedError("ScriptedModel does not script structured output")
        yield

    async def count_tokens(self, messages, tool_specs=None, system_prompt=None, system_prompt_content=None) -> int:
        return _tokens(tool_specs, system_prompt, messages)

    async def summarize(self, messages, **kwargs):
        self._summarizing = True
        try:
            return await super().summarize(messages, **kwargs)
        finally:
            self._summarizing = False

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs) -> AsyncIterator[StreamEvent]:
        reply = self._next_reply(messages)
        unoffered = {name for name, _input in reply.tool_uses} - {spec["name"] for spec in tool_specs or ()}
        if unoffered:
            raise AssertionError(f"{self._name}: the script uses {sorted(unoffered)}, which the request does not offer")
        request = json.dumps([tool_specs, system_prompt, messages], default=str)
        shared = len(os.path.commonprefix([request, self._previous_request]))
        self._previous_request = request

        yield {"messageStart": {"role": "assistant"}}
        if reply.reasoning is not None:
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"reasoningContent": {"text": reply.reasoning}}}}
            yield {"contentBlockDelta": {"delta": {"reasoningContent": {"signature": "scripted-signature"}}}}
            yield {"contentBlockStop": {}}
        if reply.text is not None:
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": reply.text}}}
            yield {"contentBlockStop": {}}
        for name, tool_input in reply.tool_uses:
            self._tool_use_count += 1
            tool_use_id = f"{self._config['model_id']}-{self._tool_use_count}"
            yield {"contentBlockStart": {"start": {"toolUse": {"name": name, "toolUseId": tool_use_id}}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(tool_input)}}}}
            yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "tool_use" if reply.tool_uses else "end_turn"}}
        input_tokens = len(request) // 4
        output_tokens = _tokens(reply.text, reply.reasoning, reply.tool_uses)
        yield {
            "metadata": {
                "usage": {
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "totalTokens": input_tokens + output_tokens,
                    "cacheReadInputTokens": shared // 4,
                    "cacheWriteInputTokens": input_tokens - shared // 4,
                },
                "metrics": {"latencyMs": 0},
            }
        }

    def assert_exhausted(self) -> None:
        assert not self._steps, f"{self._name}: {len(self._steps)} scripted step(s) were never requested"

    @property
    def _name(self) -> str:
        return f"ScriptedModel {self._config['model_id']!r}"

    def _next_reply(self, messages: Messages) -> Reply:
        kind = "summary request" if self._summarizing else "request"
        if not self._steps:
            raise AssertionError(f"{self._name}: unexpected {kind} after the script ended")
        step = self._steps.pop(0)
        if callable(step):
            step = step(messages)
        reply = (
            step if isinstance(step, Reply) else Reply(text=step) if isinstance(step, str) else Reply(tool_uses=step)
        )
        if reply.summary != self._summarizing:
            raise AssertionError(f"{self._name}: got a {kind} but the next scripted step is {step!r}")
        return reply
