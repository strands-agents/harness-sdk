"""Tests for CedarAuthorization intervention handler."""

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from strands.vended_interventions.cedar import CedarAuthorization

FIXTURES = Path(__file__).parent / "fixtures"


class _MockState:
    """Mock agent state matching JSONSerializableDict interface."""

    def __init__(self):
        self._data = {}

    def get(self, key=None):
        if key is None:
            return dict(self._data)
        return self._data.get(key)

    def set(self, key, value):
        self._data[key] = value


def _make_event(tool_name: str = "search", tool_input: dict | None = None, invocation_state: dict | None = None):
    """Create a mock BeforeToolCallEvent."""
    event = MagicMock()
    event.tool_use = {"toolUseId": "test-123", "name": tool_name, "input": tool_input or {}}
    event.invocation_state = invocation_state or {}
    event.selected_tool = None
    event.agent = MagicMock()
    event.agent.state = _MockState()
    return event


class TestBasicAuthorization:
    def test_permit_allows_tool_call(self):
        cedar = CedarAuthorization(policies='permit(principal, action == Action::"search", resource);')
        result = cedar.before_tool_call(_make_event("search"))
        assert result.type == "proceed"

    def test_no_matching_permit_denies(self):
        cedar = CedarAuthorization(policies='permit(principal, action == Action::"search", resource);')
        result = cedar.before_tool_call(_make_event("delete"))
        assert result.type == "deny"
        assert "Access denied by Cedar policy" in result.reason

    def test_permit_all_actions(self):
        cedar = CedarAuthorization(policies="permit(principal, action, resource);")
        result = cedar.before_tool_call(_make_event("anything"))
        assert result.type == "proceed"

    def test_forbid_overrides_permit(self):
        policies = """
        permit(principal, action, resource);
        forbid(principal, action == Action::"delete", resource);
        """
        cedar = CedarAuthorization(policies=policies)
        assert cedar.before_tool_call(_make_event("search")).type == "proceed"
        assert cedar.before_tool_call(_make_event("delete")).type == "deny"


class TestPrincipalResolution:
    def test_default_anonymous_principal(self):
        cedar = CedarAuthorization(policies="permit(principal, action, resource);")
        result = cedar.before_tool_call(_make_event("search"))
        assert result.type == "proceed"

    def test_static_principal(self):
        cedar = CedarAuthorization(
            policies='permit(principal == User::"alice", action, resource);',
            principal={"type": "User", "id": "alice"},
        )
        result = cedar.before_tool_call(_make_event("search"))
        assert result.type == "proceed"

    def test_static_principal_wrong_user_denied(self):
        cedar = CedarAuthorization(
            policies='permit(principal == User::"alice", action, resource);',
            principal={"type": "User", "id": "bob"},
        )
        result = cedar.before_tool_call(_make_event("search"))
        assert result.type == "deny"

    def test_principal_resolver(self):
        def resolver(state):
            user_id = state.get("user_id")
            return {"type": "User", "id": user_id} if user_id else None

        cedar = CedarAuthorization(
            policies='permit(principal == User::"alice", action, resource);',
            principal_resolver=resolver,
        )
        result = cedar.before_tool_call(_make_event("search", invocation_state={"user_id": "alice"}))
        assert result.type == "proceed"

    def test_principal_resolver_returns_none_denies(self):
        cedar = CedarAuthorization(
            policies="permit(principal, action, resource);",
            principal_resolver=lambda state: None,
        )
        result = cedar.before_tool_call(_make_event("search"))
        assert result.type == "deny"
        assert "No principal identity" in result.reason

    def test_principal_and_resolver_mutually_exclusive(self):
        with pytest.raises(ValueError, match="either.*principal.*or.*principal_resolver"):
            CedarAuthorization(
                policies="permit(principal, action, resource);",
                principal={"type": "User", "id": "alice"},
                principal_resolver=lambda s: {"type": "User", "id": "bob"},
            )

    def test_principal_id_with_quotes_denied(self):
        cedar = CedarAuthorization(
            policies="permit(principal, action, resource);",
            principal={"type": "User", "id": 'alice"injection'},
        )
        result = cedar.before_tool_call(_make_event("search"))
        assert result.type == "deny"
        assert "double quotes" in result.reason

    def test_tool_name_with_quotes_denied(self):
        cedar = CedarAuthorization(policies="permit(principal, action, resource);")
        result = cedar.before_tool_call(_make_event('tool"injection'))
        assert result.type == "deny"
        assert "Tool name" in result.reason


class TestRateLimiting:
    def test_call_count_increments(self):
        cedar = CedarAuthorization(
            policies="""
            permit(principal, action == Action::"send_email", resource)
            when { context.session.call_count < 3 };
            permit(principal, action == Action::"search", resource);
            """
        )
        event = _make_event("send_email")
        assert cedar.before_tool_call(event).type == "proceed"  # call_count=1
        assert cedar.before_tool_call(event).type == "proceed"  # call_count=2
        assert cedar.before_tool_call(event).type == "deny"  # call_count=3, 3 < 3 is false

    def test_call_count_per_tool(self):
        cedar = CedarAuthorization(
            policies="""
            permit(principal, action == Action::"send_email", resource)
            when { context.session.call_count < 2 };
            permit(principal, action == Action::"search", resource);
            """
        )
        assert cedar.before_tool_call(_make_event("send_email")).type == "proceed"
        assert cedar.before_tool_call(_make_event("search")).type == "proceed"
        assert cedar.before_tool_call(_make_event("send_email")).type == "deny"

    def test_reset_call_counts(self):
        cedar = CedarAuthorization(
            policies="""
            permit(principal, action == Action::"send_email", resource)
            when { context.session.call_count < 2 };
            """
        )
        assert cedar.before_tool_call(_make_event("send_email")).type == "proceed"
        assert cedar.before_tool_call(_make_event("send_email")).type == "deny"

        cedar.reset_call_counts()
        assert cedar.before_tool_call(_make_event("send_email")).type == "proceed"

    def test_reset_call_counts_clears_agent_state(self):
        cedar = CedarAuthorization(
            policies="""
            permit(principal, action == Action::"send_email", resource)
            when { context.session.call_count < 2 };
            """
        )
        event = _make_event("send_email")
        cedar.before_tool_call(event)
        assert event.agent.state.get("cedar-authorization") == {"send_email": 1}

        cedar.reset_call_counts(event.agent)
        assert event.agent.state.get("cedar-authorization") == {}

    def test_call_counts_persisted_to_agent_state(self):
        cedar = CedarAuthorization(
            policies="""
            permit(principal, action == Action::"send_email", resource)
            when { context.session.call_count < 5 };
            """
        )
        event = _make_event("send_email")
        cedar.before_tool_call(event)
        cedar.before_tool_call(event)
        assert event.agent.state.get("cedar-authorization") == {"send_email": 2}

    def test_call_counts_restored_from_agent_state(self):
        """A new handler instance restores counts from agent.state."""
        cedar1 = CedarAuthorization(
            policies="""
            permit(principal, action == Action::"send_email", resource)
            when { context.session.call_count < 3 };
            """
        )
        # Use a shared agent state across events
        agent_state = _MockState()
        event = _make_event("send_email")
        event.agent.state = agent_state
        cedar1.before_tool_call(event)
        cedar1.before_tool_call(event)
        # agent state has count=2

        # Create a new handler instance (simulating handler recreation)
        cedar2 = CedarAuthorization(
            policies="""
            permit(principal, action == Action::"send_email", resource)
            when { context.session.call_count < 3 };
            """
        )
        event2 = _make_event("send_email")
        event2.agent.state = agent_state  # same agent state
        # cedar2 should restore from agent state: count=2, next call = count=3
        assert cedar2.before_tool_call(event2).type == "deny"

    def test_denied_calls_dont_increment_count(self):
        cedar = CedarAuthorization(
            policies="""
            permit(principal, action == Action::"send_email", resource)
            when { context.session.call_count < 2 };
            """
        )
        assert cedar.before_tool_call(_make_event("send_email")).type == "proceed"  # count=1
        assert cedar.before_tool_call(_make_event("send_email")).type == "deny"  # count was 2, decremented back to 1
        assert cedar.before_tool_call(_make_event("send_email")).type == "deny"  # still count=2, decremented


class TestContextEnricher:
    def test_enricher_adds_session_fields(self):
        cedar = CedarAuthorization(
            policies="""
            permit(principal, action, resource)
            when { context.session.environment == "staging" };
            """,
            context_enricher=lambda ctx: {"environment": ctx["invocation_state"].get("environment", "unknown")},
        )
        result = cedar.before_tool_call(_make_event("search", invocation_state={"environment": "staging"}))
        assert result.type == "proceed"

        result = cedar.before_tool_call(_make_event("search", invocation_state={"environment": "production"}))
        assert result.type == "deny"

    def test_enricher_receives_tool_context(self):
        received = {}

        def enricher(ctx):
            received.update(ctx)
            return {}

        cedar = CedarAuthorization(
            policies="permit(principal, action, resource);",
            context_enricher=enricher,
        )
        cedar.before_tool_call(_make_event("search", tool_input={"q": "test"}, invocation_state={"user_id": "alice"}))

        assert received["tool_name"] == "search"
        assert received["tool_input"] == {"q": "test"}
        assert received["invocation_state"] == {"user_id": "alice"}


class TestInputContext:
    def test_tool_input_available_in_context(self):
        cedar = CedarAuthorization(
            policies="""
            permit(principal, action == Action::"query", resource)
            when { context.input.database == "analytics" };
            """
        )
        result = cedar.before_tool_call(_make_event("query", tool_input={"database": "analytics"}))
        assert result.type == "proceed"

        result = cedar.before_tool_call(_make_event("query", tool_input={"database": "production"}))
        assert result.type == "deny"


class TestFileLoading:
    def test_load_policies_from_file(self):
        cedar = CedarAuthorization(policies=str(FIXTURES / "test.cedar"))
        result = cedar.before_tool_call(_make_event("search"))
        assert result.type == "proceed"

    def test_load_entities_from_file(self):
        cedar = CedarAuthorization(
            policies='permit(principal == User::"alice", action, resource);',
            entities=str(FIXTURES / "entities.json"),
            principal={"type": "User", "id": "alice"},
        )
        result = cedar.before_tool_call(_make_event("search"))
        assert result.type == "proceed"

    def test_missing_policy_file_raises(self):
        with pytest.raises(FileNotFoundError, match="not found"):
            CedarAuthorization(policies="/nonexistent/path/policies.cedar")

    def test_missing_entities_file_raises(self):
        with pytest.raises(FileNotFoundError, match="not found"):
            CedarAuthorization(
                policies="permit(principal, action, resource);",
                entities="/nonexistent/entities.json",
            )

    def test_missing_schema_file_raises(self):
        with pytest.raises(FileNotFoundError, match="not found"):
            CedarAuthorization(
                policies="permit(principal, action, resource);",
                schema="/nonexistent/schema.cedarschema",
            )

    def test_all_three_loaded_from_files(self):
        """Load policies, entities, and schema all from fixture files."""
        cedar = CedarAuthorization(
            policies=str(FIXTURES / "test.cedar"),
            entities=str(FIXTURES / "entities.json"),
            schema=str(FIXTURES / "test.cedarschema"),
            principal={"type": "User", "id": "alice"},
        )
        # search is permitted in test.cedar and defined in test.cedarschema
        result = cedar.before_tool_call(_make_event("search", tool_input={"query": "hello"}))
        assert result.type == "proceed"

        # delete is not permitted in test.cedar
        result = cedar.before_tool_call(_make_event("delete"))
        assert result.type == "deny"

    def test_file_based_policies_with_role_context(self):
        """Load role-based policies from file, use context enricher for role."""
        cedar = CedarAuthorization(
            policies=str(FIXTURES / "role-based.cedar"),
            principal={"type": "User", "id": "bob"},
            context_enricher=lambda ctx: {"role": ctx["invocation_state"].get("role", "none")},
        )
        # admin role: all tools permitted
        result = cedar.before_tool_call(_make_event("delete", invocation_state={"role": "admin"}))
        assert result.type == "proceed"

        # analyst role: only search permitted
        result = cedar.before_tool_call(_make_event("search", invocation_state={"role": "analyst"}))
        assert result.type == "proceed"

        result = cedar.before_tool_call(_make_event("delete", invocation_state={"role": "analyst"}))
        assert result.type == "deny"

    def test_file_based_rate_limiting(self):
        """Load rate-limited policies from file."""
        cedar = CedarAuthorization(policies=str(FIXTURES / "rate-limited.cedar"))
        # send_email: call_count < 3
        assert cedar.before_tool_call(_make_event("send_email")).type == "proceed"
        assert cedar.before_tool_call(_make_event("send_email")).type == "proceed"
        assert cedar.before_tool_call(_make_event("send_email")).type == "deny"

        # search: always permitted
        assert cedar.before_tool_call(_make_event("search")).type == "proceed"

    def test_file_based_env_restriction(self):
        """Load env-restricted policies from file."""
        cedar = CedarAuthorization(
            policies=str(FIXTURES / "env-restricted.cedar"),
            context_enricher=lambda ctx: {"environment": ctx["invocation_state"].get("env", "dev")},
        )
        assert cedar.before_tool_call(_make_event("search", invocation_state={"env": "dev"})).type == "proceed"
        assert cedar.before_tool_call(_make_event("search", invocation_state={"env": "production"})).type == "deny"

    def test_reload_policies_from_file(self, tmp_path):
        """Write policies to a temp file, load, modify, reload."""
        policy_file = tmp_path / "dynamic.cedar"
        policy_file.write_text('permit(principal, action == Action::"search", resource);')

        cedar = CedarAuthorization(policies=str(policy_file))
        assert cedar.before_tool_call(_make_event("search")).type == "proceed"
        assert cedar.before_tool_call(_make_event("delete")).type == "deny"

        # Update the file and reload
        policy_file.write_text("""
            permit(principal, action == Action::"search", resource);
            permit(principal, action == Action::"delete", resource);
        """)
        cedar.reload()

        assert cedar.before_tool_call(_make_event("search")).type == "proceed"
        assert cedar.before_tool_call(_make_event("delete")).type == "proceed"

    def test_reload_entities_from_file(self, tmp_path):
        """Write entities to a temp file, load, modify, reload."""
        entities_file = tmp_path / "entities.json"
        entities_file.write_text('[{"uid": {"type": "User", "id": "alice"}, "attrs": {}, "parents": []}]')

        cedar = CedarAuthorization(
            policies='permit(principal == User::"alice", action, resource);',
            entities=str(entities_file),
            principal={"type": "User", "id": "alice"},
        )
        assert cedar.before_tool_call(_make_event("search")).type == "proceed"

    def test_reload_schema_from_file(self, tmp_path):
        """Write schema to a temp file, load, verify validation catches errors."""
        schema_file = tmp_path / "test.cedarschema"
        schema_file.write_text("""
            entity User;
            entity Resource;
            action "search" appliesTo {
              principal: [User],
              resource: [Resource],
              context: {
                input: {},
                session: {
                  hour_utc: Long,
                  call_count: Long
                }
              }
            };
        """)

        # Valid: policy references an action defined in schema
        cedar = CedarAuthorization(
            policies='permit(principal, action == Action::"search", resource);',
            schema=str(schema_file),
        )
        assert cedar.before_tool_call(_make_event("search")).type == "proceed"

        # Invalid: policy references action not in schema
        with pytest.raises(ValueError, match="validation failed"):
            CedarAuthorization(
                policies='permit(principal, action == Action::"unknown", resource);',
                schema=str(schema_file),
            )


class TestPolicyValidation:
    def test_invalid_policy_syntax_raises(self):
        with pytest.raises(ValueError, match="Invalid Cedar policy"):
            CedarAuthorization(policies="this is not valid cedar {{{")

    def test_valid_policy_passes(self):
        cedar = CedarAuthorization(policies="permit(principal, action, resource);")
        assert cedar is not None

    def test_schema_validation_from_file(self):
        cedar = CedarAuthorization(
            policies='permit(principal, action == Action::"search", resource);',
            schema=str(FIXTURES / "test.cedarschema"),
            principal={"type": "User", "id": "alice"},
        )
        result = cedar.before_tool_call(_make_event("search", tool_input={"query": "hello"}))
        assert result.type == "proceed"

    def test_schema_validation_catches_unknown_action(self):
        with pytest.raises(ValueError, match="validation failed"):
            CedarAuthorization(
                policies='permit(principal, action == Action::"nonexistent_tool", resource);',
                schema=str(FIXTURES / "test.cedarschema"),
            )


class TestEvaluationFailure:
    def test_policy_deny_message(self):
        cedar = CedarAuthorization(
            policies='permit(principal, action == Action::"search", resource);',
        )
        result = cedar.before_tool_call(_make_event("delete"))
        assert result.type == "deny"
        assert "Access denied by Cedar policy" in result.reason

    def test_engine_failure_produces_evaluation_failed(self):
        """NoDecision (engine error) produces 'evaluation failed', not 'access denied'."""
        from unittest.mock import patch

        cedar = CedarAuthorization(policies="permit(principal, action, resource);")

        # Mock cedarpy.is_authorized to return NoDecision with diagnostics
        mock_result = MagicMock()
        mock_result.decision = MagicMock()
        mock_result.decision.__eq__ = lambda self, other: True  # matches NoDecision check
        mock_result.allowed = False
        mock_result.diagnostics.errors = [MagicMock(error="failed to parse schema from request")]
        mock_result.diagnostics.reasons = []

        import cedarpy

        with patch.object(cedarpy, "is_authorized", return_value=mock_result):
            result = cedar.before_tool_call(_make_event("search"))

        assert result.type == "deny"
        assert "Cedar evaluation failed" in result.reason
        assert "failed to parse schema" in result.reason

    def test_exception_during_evaluation_returns_deny(self):
        """If cedarpy.is_authorized raises, return Deny with error details."""
        from unittest.mock import patch

        cedar = CedarAuthorization(policies="permit(principal, action, resource);")

        import cedarpy

        with patch.object(cedarpy, "is_authorized", side_effect=RuntimeError("wasm panic")):
            result = cedar.before_tool_call(_make_event("search"))

        assert result.type == "deny"
        assert "Cedar evaluation failed" in result.reason
        assert "wasm panic" in result.reason

    def test_exception_decrements_call_count(self):
        """Call count is rolled back when evaluation fails."""
        from unittest.mock import patch

        cedar = CedarAuthorization(
            policies="""
            permit(principal, action == Action::"send_email", resource)
            when { context.session.call_count < 3 };
            """
        )

        import cedarpy

        # First call succeeds normally
        assert cedar.before_tool_call(_make_event("send_email")).type == "proceed"

        # Second call raises — should decrement count back
        with patch.object(cedarpy, "is_authorized", side_effect=RuntimeError("crash")):
            result = cedar.before_tool_call(_make_event("send_email"))
            assert result.type == "deny"

        # Third call should still work (count was rolled back from 2 to 1, now becomes 2)
        assert cedar.before_tool_call(_make_event("send_email")).type == "proceed"


class TestOnError:
    def test_default_on_error_is_throw(self):
        cedar = CedarAuthorization(policies="permit(principal, action, resource);")
        assert cedar.on_error == "throw"

    def test_on_error_deny(self):
        cedar = CedarAuthorization(policies="permit(principal, action, resource);", on_error="deny")
        assert cedar.on_error == "deny"

    def test_on_error_proceed(self):
        cedar = CedarAuthorization(policies="permit(principal, action, resource);", on_error="proceed")
        assert cedar.on_error == "proceed"


class TestReload:
    def test_reload_from_file(self, tmp_path):
        policy_file = tmp_path / "policies.cedar"
        policy_file.write_text('permit(principal, action == Action::"search", resource);')

        cedar = CedarAuthorization(policies=str(policy_file))
        assert cedar.before_tool_call(_make_event("search")).type == "proceed"
        assert cedar.before_tool_call(_make_event("delete")).type == "deny"

        policy_file.write_text("permit(principal, action, resource);")
        cedar.reload()

        assert cedar.before_tool_call(_make_event("delete")).type == "proceed"


class TestEntities:
    def test_inline_entities(self):
        entities = [
            {"uid": {"type": "User", "id": "alice"}, "attrs": {}, "parents": []},
        ]
        cedar = CedarAuthorization(
            policies='permit(principal == User::"alice", action, resource);',
            entities=entities,
            principal={"type": "User", "id": "alice"},
        )
        result = cedar.before_tool_call(_make_event("search"))
        assert result.type == "proceed"

    def test_inline_json_string_entities(self):
        entities_json = '[{"uid": {"type": "User", "id": "alice"}, "attrs": {}, "parents": []}]'
        cedar = CedarAuthorization(
            policies='permit(principal == User::"alice", action, resource);',
            entities=entities_json,
            principal={"type": "User", "id": "alice"},
        )
        result = cedar.before_tool_call(_make_event("search"))
        assert result.type == "proceed"

    def test_invalid_entity_raises(self):
        with pytest.raises(ValueError, match="uid"):
            CedarAuthorization(
                policies="permit(principal, action, resource);",
                entities=[{"no_uid": True}],
            )

    def test_entity_with_missing_type_raises(self):
        with pytest.raises(ValueError, match="uid"):
            CedarAuthorization(
                policies="permit(principal, action, resource);",
                entities=[{"uid": {"type": "", "id": "test"}}],
            )
