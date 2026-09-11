"""Integration tests for agent cancellation with Amazon Bedrock.

These tests verify that cancellation works correctly with the Bedrock model provider.
They require valid AWS credentials and may incur API costs.

To run these tests:
    hatch run test-integ tests_integ/test_cancellation.py
"""

import asyncio
import os
import threading

import pytest

from strands import Agent, tool
from strands.hooks import AfterModelCallEvent, BeforeModelCallEvent
from strands.models import BedrockModel

# Skip all tests if no AWS credentials are available
pytestmark = [
    pytest.mark.skipif(not os.getenv("AWS_REGION"), reason="AWS credentials not available"),
    pytest.mark.asyncio,
]


async def test_cancel_with_bedrock():
    """Test agent.cancel() with Amazon Bedrock model.

    Verifies that cancellation works correctly with a real Bedrock
    model by cancelling before the model call starts.
    """

    agent = Agent(model=BedrockModel(model_id="anthropic.claude-3-haiku-20240307-v1:0"))

    # Cancel deterministically before the model call
    async def cancel_before_model(event: BeforeModelCallEvent):
        agent.cancel()

    agent.add_hook(cancel_before_model, BeforeModelCallEvent)

    result = await agent.invoke_async(
        "Write a detailed 1000-word essay about the history of space exploration, "
        "including major milestones, key figures, and technological breakthroughs."
    )

    assert result.stop_reason == "cancelled"
    assert result.message["role"] == "assistant"
    assert result.message["content"] == [{"text": "Cancelled by user"}]


async def test_cancel_during_streaming_bedrock():
    """Test agent.cancel() during streaming with Bedrock.

    Verifies that cancellation works correctly when using the
    streaming API with a real Bedrock model.
    """

    agent = Agent(model=BedrockModel(model_id="anthropic.claude-3-haiku-20240307-v1:0"))

    events = []
    async for event in agent.stream_async(
        "Write a detailed story about a space adventure. Make it at least 500 words long."
    ):
        events.append(event)
        # Cancel after receiving the first model delta event
        if "data" in event:
            agent.cancel()
        if event.get("result"):
            break

    # Find the result event
    result_event = next((e for e in events if e.get("result")), None)
    assert result_event is not None
    assert result_event["result"].stop_reason == "cancelled"


async def test_cancel_with_tools_bedrock():
    """Test agent.cancel() during tool execution with Bedrock.

    Verifies that cancellation works correctly when the agent
    is executing tools with a real Bedrock model.
    """

    @tool
    async def slow_calculation(x: int, y: int) -> int:
        """Perform a slow calculation that takes time.

        Args:
            x: First number
            y: Second number

        Returns:
            The sum of x and y
        """
        await asyncio.sleep(2)
        return x + y

    @tool
    async def another_calculation(a: int, b: int) -> int:
        """Another slow calculation.

        Args:
            a: First number
            b: Second number

        Returns:
            The product of a and b
        """
        await asyncio.sleep(2)
        return a * b

    agent = Agent(
        model=BedrockModel(model_id="anthropic.claude-3-haiku-20240307-v1:0"),
        tools=[slow_calculation, another_calculation],
    )

    # Cancel deterministically after model returns tool_use
    async def cancel_after_model(event: AfterModelCallEvent):
        if event.stop_response and event.stop_response.stop_reason == "tool_use":
            agent.cancel()

    agent.add_hook(cancel_after_model, AfterModelCallEvent)

    result = await agent.invoke_async(
        "Please use the slow_calculation tool to add 5 and 10, then use another_calculation to multiply 3 and 7."
    )

    assert result.stop_reason == "cancelled"


async def test_cancel_from_thread_bedrock():
    """Test agent.cancel() from a different thread with Bedrock.

    Simulates a real-world scenario where cancellation is triggered
    from a different thread (e.g., a web request handler) while the agent
    is executing.
    """

    agent = Agent(model=BedrockModel(model_id="anthropic.claude-3-haiku-20240307-v1:0"))

    # Cancel deterministically from a different thread before the model call
    def cancel_before_model(event: BeforeModelCallEvent):
        thread = threading.Thread(target=agent.cancel)
        thread.start()
        thread.join()

    agent.add_hook(cancel_before_model, BeforeModelCallEvent)

    result = await agent.invoke_async(
        "Write a comprehensive guide about machine learning, "
        "covering supervised learning, unsupervised learning, and deep learning. "
        "Make it at least 800 words."
    )

    assert result.stop_reason == "cancelled"


async def test_cancel_with_external_signal_bedrock():
    """Test an external cancel_signal during streaming with Bedrock.

    Verifies that a caller-owned event injected into stream_async cancels
    the invocation and aborts the in-flight Bedrock response.
    """

    agent = Agent(model=BedrockModel(model_id="anthropic.claude-3-haiku-20240307-v1:0"))
    cancel_signal = threading.Event()

    events = []
    async for event in agent.stream_async(
        "Write a detailed story about a space adventure. Make it at least 500 words long.",
        cancel_signal=cancel_signal,
    ):
        events.append(event)
        # Cancel after receiving the first model delta event
        if "data" in event:
            cancel_signal.set()
        if event.get("result"):
            break

    result_event = next((e for e in events if e.get("result")), None)
    assert result_event is not None
    assert result_event["result"].stop_reason == "cancelled"
    # The caller's event is never cleared by the agent.
    assert cancel_signal.is_set()
