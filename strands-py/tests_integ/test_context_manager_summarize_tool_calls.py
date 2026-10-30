"""Summarizing a tool-call history against real providers.

Regression tests for https://github.com/strands-agents/harness-sdk/issues/5291: summarizing a history that
holds a tool call takes a single summarizer request on every provider, and the summary reflects the call.
"""

import re
import unittest.mock

import pytest

from strands import Agent
from strands.experimental.context_manager import ContextState, Offload
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult, ToolUse
from tests_integ.models import providers

ORDER_ID = "ORD-48213"

PROVIDERS = [
    pytest.param(provider, id=provider.id, marks=provider.mark)
    for provider in [providers.openai_responses, providers.openai, providers.bedrock, providers.anthropic]
    if provider is not None
]


def _tool_call_history() -> Messages:
    tool_use = ToolUse(toolUseId="call_1", name="lookup_order", input={"orderId": ORDER_ID})
    tool_result = ToolResult(
        toolUseId="call_1",
        status="success",
        content=[{"text": "Shipped via FedEx, tracking FX-7731, arriving Thursday."}],
    )
    return [
        Message(role="user", content=[ContentBlock(text="Where is my order?")]),
        Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]),
        Message(role="user", content=[ContentBlock(toolResult=tool_result)]),
        Message(role="assistant", content=[ContentBlock(text="Your order shipped and arrives Thursday.")]),
        Message(role="user", content=[ContentBlock(text="Thanks. Can I change the delivery address?")]),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", PROVIDERS)
async def test_summarize_tool_call_history_in_single_request(provider: providers.ProviderInfo) -> None:
    model = provider.create_model()
    agent = Agent(model=model, messages=_tool_call_history(), callback_handler=None)
    strategy = Offload.summarize("*", {"model": model}).when(context_utilization="50%", preserve_recent=2)

    with unittest.mock.patch.object(model, "stream", wraps=model.stream) as stream:
        acted = await strategy.apply(ContextState(messages=agent.messages, agent=agent, utilization=1.0))

    assert acted is True
    assert stream.call_count == 1
    summaries = [
        block["text"]
        for message in agent.messages
        for block in message["content"]
        if block.get("text", "").startswith("[Summarized: 2 messages")
    ]
    assert len(summaries) == 1
    assert re.search(r"lookup_order|ORD-48213", summaries[0])
