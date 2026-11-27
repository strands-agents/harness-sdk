from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any

from strands.models import Model


@dataclass(frozen=True)
class ToolUse:
    name: str
    input: dict[str, Any] = field(default_factory=dict)


Turn = str | ToolUse | BaseException


class ScriptedModel(Model):
    def __init__(
        self,
        turns: Sequence[Turn],
        *,
        model_id: str = "scripted-model",
        usage: dict[str, int] | None = None,
    ) -> None:
        if not turns:
            raise ValueError("a scripted model needs at least one turn")
        self.turns = list(turns)
        self.usage = usage or {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}
        self.config: dict[str, Any] = {"model_id": model_id}
        self.calls = 0

    def update_config(self, **model_config: Any) -> None:
        self.config.update(model_config)

    def get_config(self) -> dict[str, Any]:
        return self.config

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        raise NotImplementedError
        yield

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs) -> AsyncIterator[dict]:
        turn = self.turns[min(self.calls, len(self.turns) - 1)]
        self.calls += 1
        if isinstance(turn, BaseException):
            raise turn
        yield {"messageStart": {"role": "assistant"}}
        if isinstance(turn, ToolUse):
            tool_use_id = f"tool-{self.calls}"
            yield {"contentBlockStart": {"start": {"toolUse": {"toolUseId": tool_use_id, "name": turn.name}}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(turn.input)}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockDelta": {"delta": {"text": turn}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": dict(self.usage), "metrics": {"latencyMs": 1}}}
