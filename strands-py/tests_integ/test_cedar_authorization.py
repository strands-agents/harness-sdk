"""Integration tests for Cedar authorization handler with a real model."""

from strands import Agent, tool
from strands.vended_interventions.cedar import CedarAuthorization
from tests_integ.conftest import retry_on_flaky


@tool
def get_weather(city: str) -> str:
    """Get the current weather for a city."""
    return f"The weather in {city} is sunny and 72°F."


@tool
def delete_account(account_id: str) -> str:
    """Delete a user account permanently."""
    return f"Account {account_id} deleted."


@tool
def send_email(to: str, subject: str) -> str:
    """Send an email to a recipient."""
    return f"Email sent to {to} with subject: {subject}"


class TestCedarPermitDeny:
    """Verify Cedar allows/denies tool calls with a real model."""

    @retry_on_flaky("LLM responses are non-deterministic")
    def test_permitted_tool_executes(self):
        cedar = CedarAuthorization(
            policies='permit(principal, action == Action::"get_weather", resource);',
        )
        agent = Agent(tools=[get_weather, delete_account], interventions=[cedar])
        result = agent("What's the weather in Seattle?")

        assert result.stop_reason == "end_turn"
        assert "Seattle" in str(result.message)

    @retry_on_flaky("LLM responses are non-deterministic")
    def test_denied_tool_not_executed(self):
        cedar = CedarAuthorization(
            policies='permit(principal, action == Action::"get_weather", resource);',
        )
        agent = Agent(tools=[get_weather, delete_account], interventions=[cedar])
        result = agent("Delete account abc-123")

        assert result.stop_reason == "end_turn"
        # The model should have received a denial message and not executed delete_account
        assert "Account abc-123 deleted" not in str(result.message)


class TestCedarRateLimiting:
    """Verify Cedar rate limits work with a real model."""

    @retry_on_flaky("LLM responses are non-deterministic")
    def test_rate_limit_blocks_after_threshold(self):
        cedar = CedarAuthorization(
            policies="""
            permit(principal, action == Action::"send_email", resource)
            when { context.session.call_count <= 2 };
            permit(principal, action == Action::"get_weather", resource);
            """,
        )
        agent = Agent(tools=[send_email, get_weather], interventions=[cedar])
        result = agent("Send 5 emails to alice@example.com about 'hello'. Send each one individually.")

        # The model should have been blocked after the rate limit
        assert result.stop_reason == "end_turn"


class TestCedarPrincipalResolver:
    """Verify principal resolution from invocation_state with a real model."""

    @retry_on_flaky("LLM responses are non-deterministic")
    def test_authorized_user_can_act(self):
        cedar = CedarAuthorization(
            policies='permit(principal == User::"alice", action, resource);',
            principal_resolver=lambda state: {"type": "User", "id": state["user_id"]} if state.get("user_id") else None,
        )
        agent = Agent(tools=[get_weather], interventions=[cedar])
        result = agent("What's the weather in NYC?", invocation_state={"user_id": "alice"})

        assert result.stop_reason == "end_turn"
        assert "NYC" in str(result.message) or "New York" in str(result.message)

    @retry_on_flaky("LLM responses are non-deterministic")
    def test_missing_identity_blocks_all_tools(self):
        cedar = CedarAuthorization(
            policies="permit(principal, action, resource);",
            principal_resolver=lambda state: {"type": "User", "id": state["user_id"]} if state.get("user_id") else None,
        )
        agent = Agent(tools=[get_weather], interventions=[cedar])
        result = agent("What's the weather in London?", invocation_state={})

        # Tool should have been blocked due to missing identity
        assert result.stop_reason == "end_turn"
        assert "sunny" not in str(result.message).lower()


class TestCedarContextEnricher:
    """Verify context enricher with a real model."""

    @retry_on_flaky("LLM responses are non-deterministic")
    def test_environment_restriction(self):
        cedar = CedarAuthorization(
            policies="""
            permit(principal, action, resource)
            when { context.session.environment != "production" };
            """,
            context_enricher=lambda ctx: {"environment": ctx["invocation_state"].get("env", "development")},
        )
        agent = Agent(tools=[delete_account], interventions=[cedar])

        # Should be blocked in production
        result = agent("Delete account xyz-999", invocation_state={"env": "production"})
        assert "Account xyz-999 deleted" not in str(result.message)
