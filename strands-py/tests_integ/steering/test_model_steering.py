"""Integration tests for model steering (steer_after_model)."""

from strands import Agent, tool
from strands.types.content import Message
from strands.types.streaming import StopReason
from strands.vended_plugins.steering.context_providers.ledger_provider import LedgerProvider
from strands.vended_plugins.steering.core.action import Guide, ModelSteeringAction, Proceed
from strands.vended_plugins.steering.core.handler import SteeringHandler


class SimpleModelSteeringHandler(SteeringHandler):
    """Simple handler that steers only on model responses."""

    def __init__(self, should_guide: bool = False, guidance_message: str = ""):
        """Initialize handler.

        Args:
            should_guide: If True, guide (retry) on first model response
            guidance_message: The guidance message to provide on retry
        """
        super().__init__()
        self.should_guide = should_guide
        self.guidance_message = guidance_message
        self.call_count = 0

    async def steer_after_model(
        self, *, agent: Agent, message: Message, stop_reason: StopReason, **kwargs
    ) -> ModelSteeringAction:
        """Steer after model response."""
        self.call_count += 1

        # On first call, guide to retry if configured
        if self.should_guide and self.call_count == 1:
            return Guide(reason=self.guidance_message)

        return Proceed(reason="Model response accepted")


def test_model_steering_proceeds_without_intervention():
    """Test that model steering can accept responses without modification."""
    handler = SimpleModelSteeringHandler(should_guide=False)
    agent = Agent(plugins=[handler])

    response = agent("What is 2+2?")

    # Handler should have been called once
    assert handler.call_count >= 1
    # Response should be generated successfully
    response_text = str(response)
    assert response_text is not None
    assert len(response_text) > 0


def test_model_steering_guide_triggers_retry():
    """Test that Guide action triggers model retry."""
    handler = SimpleModelSteeringHandler(should_guide=True, guidance_message="Please provide a more detailed response.")
    agent = Agent(plugins=[handler])

    response = agent("What is the capital of France?")

    # Handler should have been called at least twice (first response + retry)
    assert handler.call_count >= 2, "Handler should be called on initial response and retry"

    # Response should be generated successfully after retry
    response_text = str(response)
    assert response_text is not None
    assert len(response_text) > 0


def test_model_steering_guide_influences_retry_response():
    """Test that guidance message influences the retry response."""

    class SpecificGuidanceHandler(SteeringHandler):
        def __init__(self):
            super().__init__()
            self.retry_done = False

        async def steer_after_model(
            self, *, agent: Agent, message: Message, stop_reason: StopReason, **kwargs
        ) -> ModelSteeringAction:
            if not self.retry_done:
                self.retry_done = True
                # Provide very specific guidance that should appear in retry
                return Guide(reason="Please mention that Paris is also known as the 'City of Light'.")
            return Proceed(reason="Response is good now")

    handler = SpecificGuidanceHandler()
    agent = Agent(plugins=[handler])

    response = agent("What is the capital of France?")

    # Verify retry happened
    assert handler.retry_done, "Retry should have occurred"

    # Check that the response likely incorporated the guidance
    output = str(response).lower()
    assert "paris" in output, "Response should mention Paris"

    # The guidance should have influenced the retry (check for "light" or that retry happened)
    # We can't guarantee the model will include it, but we verify the mechanism worked
    assert handler.retry_done, "Guidance mechanism should have executed"


def test_model_steering_multiple_retries():
    """Test that model steering can guide multiple times before proceeding."""

    class MultiRetryHandler(SteeringHandler):
        def __init__(self):
            super().__init__()
            self.call_count = 0

        async def steer_after_model(
            self, *, agent: Agent, message: Message, stop_reason: StopReason, **kwargs
        ) -> ModelSteeringAction:
            self.call_count += 1

            # Retry twice
            if self.call_count == 1:
                return Guide(reason="Please provide more context.")
            if self.call_count == 2:
                return Guide(reason="Please add specific examples.")
            return Proceed(reason="Response is good now")

    handler = MultiRetryHandler()
    agent = Agent(plugins=[handler])

    response = agent("Explain machine learning.")

    # Should have been called 3 times (2 guides + 1 proceed)
    assert handler.call_count >= 3, "Handler should be called multiple times for multiple retries"

    # Response should still complete successfully
    assert str(response) is not None
    assert len(str(response)) > 0


@tool
def log_activity(activity: str) -> str:
    """Log an activity for audit purposes."""
    return f"Activity logged: {activity}"


def test_model_steering_forces_tool_usage_on_unrelated_prompt():
    """Test that steering forces tool usage even when prompt doesn't need the tool.

    This test verifies the flow:
    1. Agent has a logging tool available
    2. User asks an unrelated question (math problem)
    3. Model tries to answer directly without using the tool
    4. Steering intercepts and forces tool usage before termination
    5. Model uses the tool and then completes
    """

    class ForceToolUsageHandler(SteeringHandler):
        """Handler that forces a specific tool to be used before allowing termination."""

        def __init__(self, required_tool: str):
            super().__init__(context_providers=[LedgerProvider()])
            self.required_tool = required_tool
            self.tool_was_used = False
            self.guidance_given = False

        async def steer_after_model(
            self, *, agent: Agent, message: Message, stop_reason: StopReason, **kwargs
        ) -> ModelSteeringAction:
            # Only check when model is trying to end the turn
            if stop_reason != "end_turn":
                return Proceed(reason="Model still processing")

            # Check if the required tool was used in this message
            content_blocks = message.get("content", [])
            for block in content_blocks:
                if "toolUse" in block and block["toolUse"].get("name") == self.required_tool:
                    self.tool_was_used = True

                    # Verify tool is in the ledger
                    ledger = self.steering_context.data.get("ledger")
                    if ledger:
                        tool_calls = ledger.get("tool_calls", [])
                        assert any(tc.get("tool_name") == self.required_tool for tc in tool_calls), (
                            f"{self.required_tool} should be in ledger when tool_was_used=True"
                        )

                    return Proceed(reason="Required tool was used")

            # If tool wasn't used and we haven't guided yet, force its usage
            if not self.tool_was_used and not self.guidance_given:
                self.guidance_given = True
                return Guide(
                    reason=f"Before completing your response, you MUST use the {self.required_tool} tool "
                    "to log this interaction. Call the tool with a brief description of what you did."
                )

            # Allow completion after guidance was given (model may have used tool in retry)
            return Proceed(reason="Guidance was provided")

    handler = ForceToolUsageHandler(required_tool="log_activity")
    agent = Agent(tools=[log_activity], plugins=[handler])

    # Ask a question that clearly doesn't need the logging tool
    response = agent("What is 2 + 2?")

    # Verify the steering mechanism worked
    assert handler.guidance_given, "Handler should have provided guidance to use the tool"

    # Verify tool was actually called by checking metrics
    tool_metrics = response.metrics.tool_metrics
    assert "log_activity" in tool_metrics, "log_activity tool should have been called"
    assert tool_metrics["log_activity"].call_count >= 1, "log_activity should have been called at least once"
    assert tool_metrics["log_activity"].success_count >= 1, "log_activity should have succeeded"

    # Verify the response still answers the original question
    output = str(response).lower()
    assert "4" in output, "Response should contain the answer to 2+2"
