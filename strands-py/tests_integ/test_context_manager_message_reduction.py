"""Message-level context reduction against a real Bedrock model.

Regression tests for https://github.com/strands-agents/harness-sdk/issues/4685: repeated reduction
keeps a pinned message 0 verbatim, and every reduced history it sends is one Bedrock accepts. A small
``context_window_limit`` makes each model call run the reduction strategies.
"""

from collections.abc import Callable
from typing import Any

import pytest

import strands
from strands import Agent
from strands.context_manager import ContextManager, Offload
from strands.context_manager.types import ContextStrategy
from strands.models import BedrockModel
from strands.types.content import ContentBlock, Message

THINKING: dict[str, Any] = {"thinking": {"type": "enabled", "budget_tokens": 1024}}


@strands.tool
def calculator(a: int, b: int) -> str:
    """Add two numbers."""
    return str(a + b)


def _task() -> Message:
    return Message(
        role="user",
        content=[ContentBlock(text="You help with arithmetic. Always use the calculator tool.")],
        metadata={"custom": {"pinned": True}},
    )


@pytest.mark.timeout(300)
@pytest.mark.parametrize("additional_request_fields", [None, THINKING], ids=["no-thinking", "thinking"])
@pytest.mark.parametrize(
    "make_strategy",
    [
        lambda: Offload.drop("*").when(utilization=0.5),
        lambda: Offload.truncate("*").when(utilization=0.5),
        lambda: Offload.summarize("*").when(utilization=0.5, preserve_recent=2),
    ],
    ids=["drop", "truncate", "summarize"],
)
def test_repeated_reduction_keeps_message_zero_and_history_valid(
    make_strategy: Callable[[], ContextStrategy], additional_request_fields: dict[str, Any] | None
) -> None:
    model = BedrockModel(
        max_tokens=2048,
        context_window_limit=400,
        additional_request_fields=additional_request_fields,
    )
    agent = Agent(
        model=model,
        context_manager=ContextManager(strategies=[make_strategy()]),
        tools=[calculator],
        messages=[_task(), Message(role="assistant", content=[ContentBlock(text="Understood.")])],
        callback_handler=None,
    )

    for index in range(4):
        result = agent(f"Use the calculator to add {index} and {index + 10}.")
        assert result.stop_reason == "end_turn"

    first = agent.messages[0]
    assert (first["role"], first["content"]) == ("user", _task()["content"])
    assert len(agent.messages) < 10
