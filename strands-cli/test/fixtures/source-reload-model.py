"""Deterministic model for exercising the real Python source worker and tool loop."""

import json
from collections.abc import AsyncIterator

from strands.models import Model
from strands.types.streaming import StreamEvent


class SourceReloadModel(Model):
    def update_config(self, **config):
        pass

    def get_config(self):
        return {"model_id": "source-reload-test", "context_window_limit": 1000}

    def structured_output(self, *args, **kwargs):
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs) -> AsyncIterator[StreamEvent]:
        prompt = next(
            block["text"]
            for message in reversed(messages)
            if message["role"] == "user"
            for block in message["content"]
            if "text" in block and block["text"].lstrip().startswith("{")
        )
        request = json.loads(prompt)
        completed = any("toolResult" in block for block in messages[-1]["content"])
        yield {"messageStart": {"role": "assistant"}}
        if completed:
            yield {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Turn complete."}}}
        else:
            yield {
                "contentBlockStart": {
                    "contentBlockIndex": 0,
                    "start": {"toolUse": {"toolUseId": f"call-{len(messages)}", "name": request["tool"]}},
                }
            }
            yield {
                "contentBlockDelta": {
                    "contentBlockIndex": 0,
                    "delta": {"toolUse": {"input": json.dumps(request.get("input", {}))}},
                }
            }
        yield {"contentBlockStop": {"contentBlockIndex": 0}}
        yield {"messageStop": {"stopReason": "end_turn" if completed else "tool_use"}}
        yield {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}}}
