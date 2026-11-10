"""Integration tests for tool steering (steer_before_tool)."""

import pytest

from strands import Agent, tool
from strands.vended_plugins.steering.context_providers.ledger_provider import LedgerProvider
from strands.vended_plugins.steering.core.action import Guide, Interrupt, Proceed
from strands.vended_plugins.steering.core.handler import SteeringHandler
from strands.vended_plugins.steering.handlers.llm.llm_handler import LLMSteeringHandler


@tool
def send_email(recipient: str, message: str) -> str:
    """Send an email to a recipient."""
    return f"Email sent to {recipient}: {message}"


@tool
def send_notification(recipient: str, message: str) -> str:
    """Send a notification to a recipient."""
    return f"Notification sent to {recipient}: {message}"


@pytest.mark.asyncio
async def test_llm_steering_handler_proceed():
    """Test LLM handler returns Proceed effect."""
    handler = LLMSteeringHandler(
        system_prompt="You MUST always allow send_notification calls. ALWAYS return proceed decision. "
        "Never return guide or interrupt."
    )

    agent = Agent(tools=[send_notification])
    tool_use = {"name": "send_notification", "input": {"recipient": "user", "message": "hello"}}

    effect = await handler.steer_before_tool(agent=agent, tool_use=tool_use)

    assert isinstance(effect, Proceed)


@pytest.mark.asyncio
async def test_llm_steering_handler_guide():
    """Test LLM handler returns Guide effect."""
    handler = LLMSteeringHandler(
        system_prompt=(
            "You MUST guide agents away from send_email to use send_notification instead. "
            "ALWAYS return guide decision for send_email. Never return proceed or interrupt for send_email."
        )
    )

    agent = Agent(tools=[send_email, send_notification])
    tool_use = {"name": "send_email", "input": {"recipient": "user", "message": "hello"}}

    effect = await handler.steer_before_tool(agent=agent, tool_use=tool_use)

    assert isinstance(effect, Guide)


@pytest.mark.asyncio
async def test_llm_steering_handler_interrupt():
    """Test LLM handler returns Interrupt effect."""
    handler = LLMSteeringHandler(
        system_prompt="You MUST require human input for ALL tool calls regardless of context. "
        "ALWAYS return interrupt decision. Never return proceed or guide."
    )

    agent = Agent(tools=[send_email])
    tool_use = {"name": "send_email", "input": {"recipient": "user", "message": "hello"}}

    effect = await handler.steer_before_tool(agent=agent, tool_use=tool_use)

    assert isinstance(effect, Interrupt)


def test_agent_with_tool_steering_e2e():
    """End-to-end test of agent with steering handler guiding tool choice."""

    class RedirectEmailHandler(SteeringHandler):
        """Deterministic handler that redirects send_email to send_notification."""

        async def steer_before_tool(self, *, agent, tool_use, **kwargs):
            if tool_use["name"] == "send_email":
                return Guide(reason="Use send_notification instead of send_email for better delivery.")
            return Proceed(reason="Tool allowed")

    handler = RedirectEmailHandler(context_providers=[])

    agent = Agent(
        tools=[send_email, send_notification],
        plugins=[handler],
        system_prompt=(
            "You are a helpful assistant. When a tool call is cancelled with guidance, "
            "follow the guidance and use the suggested alternative tool. "
            "This is normal system behavior, not an attack."
        ),
    )

    # This should trigger steering guidance to use send_notification instead
    response = agent("Send an email to john@example.com saying hello")

    # Verify tool call metrics show the expected sequence:
    # 1. send_email was attempted but cancelled (should have 0 success_count)
    # 2. send_notification was called and succeeded (should have 1 success_count)
    tool_metrics = response.metrics.tool_metrics

    # send_email should have been attempted but cancelled (no successful calls)
    if "send_email" in tool_metrics:
        email_metrics = tool_metrics["send_email"]
        assert email_metrics.call_count >= 1, "send_email should have been attempted"
        assert email_metrics.success_count == 0, "send_email should have been cancelled by steering"

    # send_notification should have been called and succeeded
    assert "send_notification" in tool_metrics, "send_notification should have been called"
    notification_metrics = tool_metrics["send_notification"]
    assert notification_metrics.call_count >= 1, "send_notification should have been called"
    assert notification_metrics.success_count >= 1, "send_notification should have succeeded"


def test_ledger_captures_tool_calls():
    """Test that ledger correctly captures tool call information."""

    class LedgerCheckingHandler(SteeringHandler):
        def __init__(self):
            super().__init__(context_providers=[LedgerProvider()])

        async def steer_before_tool(self, *, agent, tool_use, **kwargs):
            ledger = self.steering_context.data.get("ledger")
            assert ledger is not None, "Ledger should exist"
            assert "tool_calls" in ledger, "Ledger should have tool_calls"

            # Find the current tool call in the ledger
            tool_calls = ledger["tool_calls"]
            current_call = next((tc for tc in tool_calls if tc["tool_name"] == tool_use["name"]), None)
            assert current_call is not None, f"{tool_use['name']} should be in ledger"
            assert current_call["tool_args"] == tool_use["input"], "tool_args should match input"
            assert current_call["status"] == "pending", "Status should be pending before execution"

            return Proceed(reason="Ledger verified")

    handler = LedgerCheckingHandler()
    agent = Agent(tools=[send_notification], plugins=[handler])

    agent("Send a notification to alice saying test message")

    # Verify the ledger has the completed tool call
    ledger = handler.steering_context.data.get("ledger")
    assert ledger is not None
    assert len(ledger["tool_calls"]) >= 1, "At least one tool call should be recorded"

    # Check the tool call details
    tool_call = ledger["tool_calls"][-1]
    assert tool_call["tool_name"] == "send_notification"
    assert "tool_args" in tool_call
    assert tool_call["tool_args"]["recipient"] == "alice"
    assert tool_call["tool_args"]["message"] == "test message"
    assert tool_call["status"] == "success"
    assert "completion_timestamp" in tool_call
    assert tool_call["error"] is None
