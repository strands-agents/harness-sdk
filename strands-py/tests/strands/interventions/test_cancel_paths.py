"""Tests for cancellation paths in agent and event loop triggered by interventions."""

from strands import Agent, InterventionHandler
from strands.hooks.events import BeforeModelCallEvent
from strands.interventions import Deny, Proceed
from tests.fixtures.mocked_model_provider import MockedModelProvider


class DenyInvocation(InterventionHandler):
    name = "deny-invocation"

    def before_invocation(self, event):
        return Deny(reason="invocation blocked")


class DenyModelCall(InterventionHandler):
    name = "deny-model"

    def before_model_call(self, event):
        return Deny(reason="model call blocked")


class DenyModelThenRetry(InterventionHandler):
    """Denies the first model call, then proceeds on retry."""

    name = "deny-then-retry"

    def __init__(self):
        self.call_count = 0

    def before_model_call(self, event):
        self.call_count += 1
        if self.call_count == 1:
            return Deny(reason="blocked first time")
        return Proceed()


class TestBeforeInvocationCancel:
    def test_deny_returns_cancel_message(self):
        model = MockedModelProvider(agent_responses=[])
        agent = Agent(model=model, interventions=[DenyInvocation()])

        result = agent("hello")

        assert result.stop_reason == "end_turn"
        assert any("DENIED: invocation blocked" in block.get("text", "") for block in result.message.get("content", []))

    def test_deny_does_not_call_model(self):
        model = MockedModelProvider(agent_responses=[])
        agent = Agent(model=model, interventions=[DenyInvocation()])

        agent("hello")

        assert model.index == 0

    def test_cancel_with_string_uses_custom_text(self):
        class CustomCancel(InterventionHandler):
            name = "custom-cancel"

            def before_invocation(self, event):
                return Deny(reason="custom denial reason")

        model = MockedModelProvider(agent_responses=[])
        agent = Agent(model=model, interventions=[CustomCancel()])

        result = agent("hello")

        assert "DENIED: custom denial reason" in result.message["content"][0]["text"]


class TestBeforeModelCallCancel:
    def test_deny_returns_end_turn(self):
        model = MockedModelProvider(agent_responses=[{"role": "assistant", "content": [{"text": "should not reach"}]}])
        agent = Agent(model=model, interventions=[DenyModelCall()])

        result = agent("hello")

        assert result.stop_reason == "end_turn"
        assert "DENIED: model call blocked" in result.message["content"][0]["text"]

    def test_deny_does_not_invoke_model(self):
        model = MockedModelProvider(agent_responses=[{"role": "assistant", "content": [{"text": "should not reach"}]}])
        agent = Agent(model=model, interventions=[DenyModelCall()])

        agent("hello")

        assert model.index == 0

    def test_cancel_with_retry_re_enters_loop(self):
        """When AfterModelCallEvent.retry=True on a cancelled call, the model loop retries."""

        class RetryOnCancel(InterventionHandler):
            name = "retry-on-cancel"

            def __init__(self):
                self.cancel_count = 0

            def before_model_call(self, event):
                self.cancel_count += 1
                if self.cancel_count <= 1:
                    return Deny(reason="retry me")
                return Proceed()

        class ForceRetry(InterventionHandler):
            name = "force-retry"

            def after_model_call(self, event):
                if event.stop_response and "DENIED: retry me" in event.stop_response.message.get("content", [{}])[
                    0
                ].get("text", ""):
                    event.retry = True
                return Proceed()

        model = MockedModelProvider(
            agent_responses=[{"role": "assistant", "content": [{"text": "success after retry"}]}]
        )
        agent = Agent(model=model, interventions=[RetryOnCancel(), ForceRetry()])

        result = agent("hello")

        assert result.stop_reason == "end_turn"
        assert "success after retry" in result.message["content"][0]["text"]

    def test_plain_hook_cancel_uses_default_text(self):
        """A plain hook (not intervention) can set event.cancel = True for default message."""

        model = MockedModelProvider(agent_responses=[{"role": "assistant", "content": [{"text": "should not reach"}]}])
        agent = Agent(model=model)

        agent.hooks.add_callback(BeforeModelCallEvent, lambda event: setattr(event, "cancel", True))

        result = agent("hello")

        assert result.stop_reason == "end_turn"
        assert "model call denied by hook" in result.message["content"][0]["text"]
