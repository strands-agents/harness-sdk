"""Integration tests for CedarAuthorization using the full Agent loop.

These tests use MockedModelProvider to drive the agent through real tool calls,
verifying that Cedar policies are enforced end-to-end within the agent lifecycle.
"""

from pathlib import Path

import strands
from strands import Agent
from strands.vended_interventions.cedar import CedarAuthorization
from tests.fixtures.mocked_model_provider import MockedModelProvider

FIXTURES = Path(__file__).parent / "fixtures"


def _tool_use_response(tool_name: str, tool_use_id: str, input: dict):
    return {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": tool_use_id, "name": tool_name, "input": input}}],
    }


def _text_response(text: str):
    return {"role": "assistant", "content": [{"text": text}]}


class TestPermitDeny:
    """Basic permit/deny through the full agent loop."""

    def test_permitted_tool_executes(self):
        executed = []

        @strands.tool
        def search(query: str) -> str:
            """Search for information."""
            executed.append(query)
            return f"Results for: {query}"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("search", "t1", {"query": "test"}),
                _text_response("Done"),
            ]
        )

        cedar = CedarAuthorization(policies='permit(principal, action == Action::"search", resource);')
        agent = Agent(model=model, tools=[search], interventions=[cedar])
        result = agent("Search for test")

        assert result.stop_reason == "end_turn"
        assert executed == ["test"]

    def test_denied_tool_does_not_execute(self):
        executed = []

        @strands.tool
        def delete_record(record_id: str) -> str:
            """Delete a record."""
            executed.append(record_id)
            return "deleted"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("delete_record", "t1", {"record_id": "42"}),
                _text_response("I couldn't delete that."),
            ]
        )

        cedar = CedarAuthorization(policies='permit(principal, action == Action::"search", resource);')
        agent = Agent(model=model, tools=[delete_record], interventions=[cedar])
        result = agent("Delete record 42")

        assert result.stop_reason == "end_turn"
        assert executed == []

    def test_forbid_overrides_permit(self):
        executed = []

        @strands.tool
        def delete(id: str) -> str:
            """Delete something."""
            executed.append(id)
            return "deleted"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("delete", "t1", {"id": "1"}),
                _text_response("Blocked."),
            ]
        )

        cedar = CedarAuthorization(
            policies="""
            permit(principal, action, resource);
            forbid(principal, action == Action::"delete", resource);
            """
        )
        agent = Agent(model=model, tools=[delete], interventions=[cedar])
        agent("Delete it")

        assert executed == []


class TestRoleBasedAccess:
    """Role-based access control through the agent loop."""

    POLICIES = str(FIXTURES / "role-based.cedar")

    def test_admin_can_delete(self):
        executed = []

        @strands.tool
        def delete_record() -> str:
            """Delete a record."""
            executed.append(True)
            return "deleted"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("delete_record", "t1", {}),
                _text_response("Deleted."),
            ]
        )

        cedar = CedarAuthorization(
            policies=self.POLICIES,
            principal={"type": "User", "id": "alice"},
            context_enricher=lambda ctx: {"role": ctx["invocation_state"].get("role", "none")},
        )
        agent = Agent(model=model, tools=[delete_record], interventions=[cedar])
        agent("Delete", invocation_state={"role": "admin"})

        assert executed == [True]

    def test_analyst_cannot_delete(self):
        executed = []

        @strands.tool
        def delete_record() -> str:
            """Delete a record."""
            executed.append(True)
            return "deleted"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("delete_record", "t1", {}),
                _text_response("Denied."),
            ]
        )

        cedar = CedarAuthorization(
            policies=self.POLICIES,
            principal={"type": "User", "id": "bob"},
            context_enricher=lambda ctx: {"role": ctx["invocation_state"].get("role", "none")},
        )
        agent = Agent(model=model, tools=[delete_record], interventions=[cedar])
        agent("Delete", invocation_state={"role": "analyst"})

        assert executed == []

    def test_analyst_can_search(self):
        executed = []

        @strands.tool
        def search() -> str:
            """Search."""
            executed.append(True)
            return "found"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("search", "t1", {}),
                _text_response("Found it."),
            ]
        )

        cedar = CedarAuthorization(
            policies=self.POLICIES,
            principal={"type": "User", "id": "bob"},
            context_enricher=lambda ctx: {"role": ctx["invocation_state"].get("role", "none")},
        )
        agent = Agent(model=model, tools=[search], interventions=[cedar])
        agent("Search", invocation_state={"role": "analyst"})

        assert executed == [True]


class TestRateLimiting:
    """Rate limiting enforced through multiple tool calls in one agent invocation."""

    def test_rate_limit_enforced_mid_conversation(self):
        call_count = []

        @strands.tool
        def send_email() -> str:
            """Send an email."""
            call_count.append(1)
            return "sent"

        # Model tries to call send_email 4 times
        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("send_email", "t1", {}),
                _tool_use_response("send_email", "t2", {}),
                _tool_use_response("send_email", "t3", {}),
                _tool_use_response("send_email", "t4", {}),
                _text_response("Done sending."),
            ]
        )

        cedar = CedarAuthorization(policies=str(FIXTURES / "rate-limited.cedar"))
        agent = Agent(model=model, tools=[send_email], interventions=[cedar])
        agent("Send 4 emails")

        # Policy: call_count < 3, so calls 1 and 2 succeed, 3+ denied
        assert len(call_count) == 2


class TestEnvironmentRestrictions:
    """Environment-based deny using the env-restricted.cedar fixture."""

    def test_allowed_in_development(self):
        executed = []

        @strands.tool
        def search() -> str:
            """Search."""
            executed.append(True)
            return "results"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("search", "t1", {}),
                _text_response("Done."),
            ]
        )

        cedar = CedarAuthorization(
            policies=str(FIXTURES / "env-restricted.cedar"),
            context_enricher=lambda ctx: {"environment": ctx["invocation_state"].get("environment", "unknown")},
        )
        agent = Agent(model=model, tools=[search], interventions=[cedar])
        agent("Search", invocation_state={"environment": "development"})

        assert executed == [True]

    def test_denied_in_production(self):
        executed = []

        @strands.tool
        def search() -> str:
            """Search."""
            executed.append(True)
            return "results"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("search", "t1", {}),
                _text_response("Blocked."),
            ]
        )

        cedar = CedarAuthorization(
            policies=str(FIXTURES / "env-restricted.cedar"),
            context_enricher=lambda ctx: {"environment": ctx["invocation_state"].get("environment", "unknown")},
        )
        agent = Agent(model=model, tools=[search], interventions=[cedar])
        agent("Search", invocation_state={"environment": "production"})

        assert executed == []


class TestPrincipalResolution:
    """Dynamic principal resolution from invocation_state through the agent loop."""

    def test_principal_resolver_with_invocation_state(self):
        executed = []

        @strands.tool
        def search() -> str:
            """Search."""
            executed.append(True)
            return "found"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("search", "t1", {}),
                _text_response("Done."),
            ]
        )

        cedar = CedarAuthorization(
            policies='permit(principal == User::"alice", action, resource);',
            principal_resolver=lambda state: {"type": "User", "id": state["user_id"]} if state.get("user_id") else None,
        )
        agent = Agent(model=model, tools=[search], interventions=[cedar])
        agent("Search", invocation_state={"user_id": "alice"})

        assert executed == [True]

    def test_missing_identity_blocks_tool(self):
        executed = []

        @strands.tool
        def search() -> str:
            """Search."""
            executed.append(True)
            return "found"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("search", "t1", {}),
                _text_response("No identity."),
            ]
        )

        cedar = CedarAuthorization(
            policies="permit(principal, action, resource);",
            principal_resolver=lambda state: {"type": "User", "id": state["user_id"]} if state.get("user_id") else None,
        )
        agent = Agent(model=model, tools=[search], interventions=[cedar])
        agent("Search", invocation_state={})

        assert executed == []


class TestContextInput:
    """Tool arguments available in context.input for policy decisions."""

    def test_argument_gating(self):
        executed = []

        @strands.tool
        def delete(record_id: str) -> str:
            """Delete a record."""
            executed.append(record_id)
            return "deleted"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("delete", "t1", {"record_id": "99"}),
                _text_response("Denied."),
            ]
        )

        # Only allow deleting record 42
        cedar = CedarAuthorization(
            policies='permit(principal, action == Action::"delete", resource) when { context.input.record_id == "42" };'
        )
        agent = Agent(model=model, tools=[delete], interventions=[cedar])
        agent("Delete 99")

        assert executed == []

    def test_argument_gating_allowed(self):
        executed = []

        @strands.tool
        def delete(record_id: str) -> str:
            """Delete a record."""
            executed.append(record_id)
            return "deleted"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("delete", "t1", {"record_id": "42"}),
                _text_response("Deleted."),
            ]
        )

        cedar = CedarAuthorization(
            policies='permit(principal, action == Action::"delete", resource) when { context.input.record_id == "42" };'
        )
        agent = Agent(model=model, tools=[delete], interventions=[cedar])
        agent("Delete 42")

        assert executed == ["42"]


class TestContextEnricher:
    """Context enricher forwarding invocation_state fields into Cedar policy evaluation."""

    def test_enricher_field_used_in_policy(self):
        executed = []

        @strands.tool
        def search() -> str:
            """Search."""
            executed.append(True)
            return "ok"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("search", "t1", {}),
                _text_response("Done."),
            ]
        )

        cedar = CedarAuthorization(
            policies='permit(principal, action, resource) when { context.session.department == "engineering" };',
            context_enricher=lambda ctx: {"department": ctx["invocation_state"].get("department", "unknown")},
        )
        agent = Agent(model=model, tools=[search], interventions=[cedar])
        agent("Search", invocation_state={"department": "engineering"})

        assert executed == [True]

    def test_enricher_mismatch_denies(self):
        executed = []

        @strands.tool
        def search() -> str:
            """Search."""
            executed.append(True)
            return "ok"

        model = MockedModelProvider(
            agent_responses=[
                _tool_use_response("search", "t1", {}),
                _text_response("Denied."),
            ]
        )

        cedar = CedarAuthorization(
            policies='permit(principal, action, resource) when { context.session.department == "engineering" };',
            context_enricher=lambda ctx: {"department": ctx["invocation_state"].get("department", "unknown")},
        )
        agent = Agent(model=model, tools=[search], interventions=[cedar])
        agent("Search", invocation_state={"department": "marketing"})

        assert executed == []
