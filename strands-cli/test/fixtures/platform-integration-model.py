"""Deterministic model for exported Python agent lifecycle tests."""

import json
from collections.abc import AsyncIterator

from strands.models import Model
from strands.types.streaming import StreamEvent


class PlatformIntegrationModel(Model):
    def update_config(self, **config):
        pass

    def get_config(self):
        return {"model_id": "platform-integration", "context_window_limit": 10_000}

    def structured_output(self, *args, **kwargs):
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs) -> AsyncIterator[StreamEvent]:
        latest = messages[-1]["content"]
        tool_result = next((block["toolResult"] for block in latest if "toolResult" in block), None)
        if tool_result is not None:
            async for event in response(f"MCP_RESULT={json.dumps(tool_result)}"):
                yield event
            return

        prompt = "".join(block.get("text", "") for block in latest)
        if "invoke the MCP probe" in prompt:
            tool = next(spec for spec in tool_specs or [] if spec["name"].endswith("probe"))
            yield {"messageStart": {"role": "assistant"}}
            yield {
                "contentBlockStart": {
                    "contentBlockIndex": 0,
                    "start": {"toolUse": {"toolUseId": "platform-probe", "name": tool["name"]}},
                }
            }
            yield {
                "contentBlockDelta": {
                    "contentBlockIndex": 0,
                    "delta": {"toolUse": {"input": "{}"}},
                }
            }
            yield {"contentBlockStop": {"contentBlockIndex": 0}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            yield metadata()
            return

        serialized_prompt = json.dumps(system_prompt, default=str)
        history = "|".join(
            "".join(block.get("text", "") for block in message["content"])
            for message in messages
            if message["role"] == "user"
        )
        text = " ".join(
            [
                f"LOCAL_SKILL={str('local-platform-skill' in serialized_prompt).lower()}",
                f"REMOTE_SKILL={str('remote-platform-skill' in serialized_prompt).lower()}",
                f"HISTORY={history}",
            ]
        )
        async for event in response(text):
            yield event


model = PlatformIntegrationModel()


async def response(text: str) -> AsyncIterator[StreamEvent]:
    yield {"messageStart": {"role": "assistant"}}
    yield {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}}
    yield {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": text}}}
    yield {"contentBlockStop": {"contentBlockIndex": 0}}
    yield {"messageStop": {"stopReason": "end_turn"}}
    yield metadata()


def metadata() -> StreamEvent:
    return {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}}}
