import json
from collections.abc import AsyncGenerator, Iterable, Sequence
from typing import Any, TypedDict, TypeVar

from pydantic import BaseModel

from strands.models import Model
from strands.types.content import Message, Messages
from strands.types.event_loop import Metrics, StopReason, Usage
from strands.types.streaming import StreamEvent
from strands.types.tools import ToolSpec

T = TypeVar("T", bound=BaseModel)


class RedactionMessage(TypedDict):
    redactedUserContent: str
    redactedAssistantContent: str


class MockedModelProvider(Model):
    """A mock implementation of the Model interface for testing purposes.

    This class simulates a model provider by returning pre-defined agent responses
    in sequence. It implements the Model interface methods and provides functionality
    to stream mock responses as events.

    Optionally accepts parallel sequences of per-response ``Usage`` and ``Metrics``
    to drive accounting-dependent test paths.
    """

    def __init__(
        self,
        agent_responses: Sequence[Message | RedactionMessage],
        usages: Sequence[Usage] | None = None,
        metrics: Sequence[Metrics] | None = None,
    ):
        if usages is not None and len(usages) != len(agent_responses):
            raise ValueError(
                f"usages length ({len(usages)}) must match agent_responses length ({len(agent_responses)})"
            )
        if metrics is not None and len(metrics) != len(agent_responses):
            raise ValueError(
                f"metrics length ({len(metrics)}) must match agent_responses length ({len(agent_responses)})"
            )
        self.agent_responses = [*agent_responses]
        self.usages: list[Usage] | None = [*usages] if usages is not None else None
        self.metrics: list[Metrics] | None = [*metrics] if metrics is not None else None
        self.index = 0

    def format_chunk(self, event: Any) -> StreamEvent:
        return event

    def format_request(
        self, messages: Messages, tool_specs: list[ToolSpec] | None = None, system_prompt: str | None = None
    ) -> Any:
        return None

    def get_config(self) -> Any:
        pass

    def update_config(self, **model_config: Any) -> None:
        pass

    async def structured_output(
        self,
        output_model: type[T],
        prompt: Messages,
        system_prompt: str | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[Any, None]:
        pass

    async def stream(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        tool_choice: Any | None = None,
        *,
        system_prompt_content=None,
        **kwargs: Any,
    ) -> AsyncGenerator[Any, None]:
        usage = self.usages[self.index] if self.usages is not None else None
        metrics = self.metrics[self.index] if self.metrics is not None else None
        if metrics is None:
            events = self.map_agent_message_to_events(self.agent_responses[self.index], usage=usage)
        else:
            events = self.map_agent_message_to_events(self.agent_responses[self.index], usage=usage, metrics=metrics)
        for event in events:
            yield event

        self.index += 1

    def map_agent_message_to_events(
        self,
        agent_message: Message | RedactionMessage,
        usage: Usage | None = None,
        metrics: Metrics | None = None,
    ) -> Iterable[dict[str, Any]]:
        stop_reason: StopReason = "end_turn"
        yield {"messageStart": {"role": "assistant"}}
        if agent_message.get("redactedAssistantContent"):
            yield {"redactContent": {"redactUserContentMessage": agent_message["redactedUserContent"]}}
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": agent_message["redactedAssistantContent"]}}}
            yield {"contentBlockStop": {}}
            stop_reason = "guardrail_intervened"
        else:
            for content in agent_message["content"]:
                if "reasoningContent" in content:
                    yield {"contentBlockStart": {"start": {}}}
                    yield {"contentBlockDelta": {"delta": {"reasoningContent": content["reasoningContent"]}}}
                    yield {"contentBlockStop": {}}
                if "text" in content:
                    yield {"contentBlockStart": {"start": {}}}
                    yield {"contentBlockDelta": {"delta": {"text": content["text"]}}}
                    yield {"contentBlockStop": {}}
                if "toolUse" in content:
                    stop_reason = "tool_use"
                    yield {
                        "contentBlockStart": {
                            "start": {
                                "toolUse": {
                                    "name": content["toolUse"]["name"],
                                    "toolUseId": content["toolUse"]["toolUseId"],
                                }
                            }
                        }
                    }
                    yield {
                        "contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(content["toolUse"]["input"])}}}
                    }
                    yield {"contentBlockStop": {}}

        yield {"messageStop": {"stopReason": stop_reason}}
        if usage is not None:
            yield {"metadata": {"usage": usage, "metrics": metrics or {"latencyMs": 0}}}
