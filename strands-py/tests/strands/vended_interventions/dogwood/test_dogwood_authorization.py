"""Tests for the DogwoodAuthorization intervention handler."""

import importlib
import logging
import sys
from unittest.mock import MagicMock, patch

import pytest
from dogwood import DogwoodError

from strands.vended_interventions.dogwood import DogwoodAuthorization

SEARCH_SPEC = {
    "name": "search",
    "description": "Search the web",
    "inputSchema": {"json": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
}
PAY_SPEC = {
    "name": "pay",
    "description": "Send a payment",
    "inputSchema": {
        "json": {
            "type": "object",
            "properties": {"amount": {"type": "number"}, "splits": {"type": "array", "items": {"type": "number"}}},
            "required": ["amount"],
        }
    },
}
PING_SPEC = {
    "name": "ping",
    "description": "Check liveness",
    "inputSchema": {"json": {"type": "object", "properties": {}}},
}
SPECS = [SEARCH_SPEC, PAY_SPEC, PING_SPEC]

PERMIT_SEARCH = 'permit(principal, action == Action::"search", resource);'
PERMIT_UNDER_TEN = (
    'permit(principal, action == Action::"pay", resource) when { context.input.amount.lessThan(decimal("10.0")) };'
)

PLAIN_SCHEMA = """
type SystemContext = { now: datetime };
type searchInput = { query: String };
entity Resource;
entity User;
action "search" appliesTo {
  principal: [User],
  resource: [Resource],
  context: { input: searchInput, system: SystemContext }
};
"""

# `session` is required, so only a handler with a `context_enricher` sends a conforming request.
SESSION_SCHEMA = """
type SystemContext = { now: datetime };
type searchInput = { query: String };
type SessionContext = { tenant: String };
entity Resource;
entity User;
action "search" appliesTo {
  principal: [User],
  resource: [Resource],
  context: { input: searchInput, session: SessionContext, system: SystemContext }
};
"""

# `ping` declares no context at all: neither `input` nor `session`, which the `context_enricher`
# check skips, and no `system`, so no timestamp is sent either.
CONTEXTLESS_SCHEMA = """
type SystemContext = { now: datetime };
type SessionContext = { tenant: String };
entity Resource;
entity User;
action "search" appliesTo {
  principal: [User],
  resource: [Resource],
  context: { session: SessionContext, system: SystemContext }
};
action "ping" appliesTo {
  principal: [User],
  resource: [Resource]
};
"""


def _before_event(tool_name="search", tool_input=None, invocation_state=None, tool_use_id="tool-1"):
    """A stand-in BeforeToolCallEvent carrying only the fields the handler reads."""
    event = MagicMock()
    event.tool_use = {"toolUseId": tool_use_id, "name": tool_name, "input": {} if tool_input is None else tool_input}
    event.invocation_state = invocation_state or {}
    return event


def _after_event(tool_name="search", tool_use_id="tool-1", status="success", exception=None, cancel_message=None):
    """A stand-in AfterToolCallEvent carrying only the fields the handler reads."""
    event = MagicMock()
    event.tool_use = {"toolUseId": tool_use_id, "name": tool_name, "input": {}}
    event.result = {"status": status}
    event.exception = exception
    event.cancel_message = cancel_message
    return event


class _RecordingAuthorizer:
    """Delegates to the real authorizer, keeping every event the handler sent it.

    The native ``is_authorized`` is read-only, so it cannot be patched on the instance.
    """

    def __init__(self, authorizer):
        self._authorizer = authorizer
        self.events = []

    def is_authorized(self, event):
        self.events.append(event)
        return self._authorizer.is_authorized(event)

    def __getattr__(self, name):
        return getattr(self._authorizer, name)


class _UnusableAuthorizer:
    """An authorizer whose every call raises, as one left in an unusable state does."""

    last_timestamp = None

    def is_authorized(self, event):
        raise DogwoodError("authorizer unusable")

    def reset(self):
        raise DogwoodError("authorizer unusable")


class _SilentAuthorizer:
    """An authorizer returning no decision at all, breaking the contract that every kind decides."""

    last_timestamp = None

    def is_authorized(self, event):
        return None


def _recording(handler):
    """Wrap a handler's authorizer so the events it sends can be asserted on."""
    recorder = _RecordingAuthorizer(handler._authorizer)
    handler._authorizer = recorder
    return recorder


def _kinds(recorder):
    return [event["kind"] for event in recorder.events]


def test_import_without_dogwood_installed_names_the_extra_to_install():
    package = "strands.vended_interventions.dogwood"
    # `None` in `sys.modules` is what makes `import dogwood` fail the way an absent install does.
    with patch.dict(sys.modules, {"dogwood": None}):
        del sys.modules[package]
        with pytest.raises(ImportError, match=r"strands-agents\[dogwood\]"):
            importlib.import_module(package)


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        (
            {"principal": {"type": "User", "id": "alice"}, "principal_resolver": lambda state: None, "tools": SPECS},
            "Provide either `principal` or `principal_resolver`, not both",
        ),
        ({}, "Provide either `action_schema` or `tools`"),
        ({"tools": SPECS, "entities": [{"type": "User", "id": "alice"}]}, "`entities` requires `action_schema`"),
        (
            {"action_schema": PLAIN_SCHEMA, "namespace": "Acme"},
            "`namespace` applies to a generated schema",
        ),
        ({"tools": SPECS, "namespace": "if"}, "must be `::`-separated Cedar identifiers"),
        ({"tools": SPECS, "namespace": "Ac-me"}, "must be `::`-separated Cedar identifiers"),
        ({"tools": SPECS, "namespace": "__cedarInternal"}, "must be `::`-separated Cedar identifiers"),
        ({"tools": SPECS, "principal": {"type": "Admin", "id": "root"}}, "`principal` must be of type"),
    ],
)
def test__init__rejects_invalid_configuration(kwargs, expected):
    with pytest.raises(ValueError, match=expected):
        DogwoodAuthorization(policies=PERMIT_SEARCH, **kwargs)


def test__init__rejects_a_policy_that_does_not_type_check():
    with pytest.raises(ValueError, match="Dogwood policy validation failed"):
        DogwoodAuthorization(policies='permit(principal, action == Action::"absent", resource);', tools=SPECS)


def test__init__rejects_a_context_enricher_without_a_session_group():
    with pytest.raises(ValueError, match="requires an `action_schema` declaring a `session` context group"):
        DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS, context_enricher=lambda call: {"tenant": "acme"})


def test__init__accepts_a_namespace_matching_the_generated_one():
    dogwood = DogwoodAuthorization(
        policies='permit(principal, action == Drupe::Action::"search", resource);', tools=SPECS, namespace="Drupe"
    )
    assert dogwood.before_tool_call(_before_event("search", {"query": "x"})).type == "proceed"


def test__init__loads_policies_and_schema_from_disk(tmp_path):
    policy_file = tmp_path / "policies.dw"
    policy_file.write_text(PERMIT_SEARCH, encoding="utf-8")
    schema_file = tmp_path / "actions.cedarschema"
    schema_file.write_text(PLAIN_SCHEMA, encoding="utf-8")

    dogwood = DogwoodAuthorization(policies=str(policy_file), action_schema=str(schema_file))

    assert dogwood.before_tool_call(_before_event("search", {"query": "x"})).type == "proceed"


@pytest.mark.parametrize("extension", [".dw", ".cedarschema"])
def test__init__reports_a_missing_source_file(tmp_path, extension):
    missing = str(tmp_path / f"absent{extension}")
    kwargs = {"policies": missing} if extension == ".dw" else {"policies": PERMIT_SEARCH, "action_schema": missing}
    with pytest.raises(FileNotFoundError, match="file not found"):
        DogwoodAuthorization(tools=SPECS, **kwargs)


def test_on_error_defaults_to_throw():
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    assert dogwood.on_error == "throw"
    assert DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS, on_error="deny").on_error == "deny"


def test_before_tool_call_permits_a_tool_the_policy_allows():
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    assert dogwood.before_tool_call(_before_event("search", {"query": "x"})).type == "proceed"


def test_before_tool_call_denies_a_tool_no_policy_allows():
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)

    tru_action = dogwood.before_tool_call(_before_event("pay", {"amount": 1.0}))

    assert tru_action.type == "deny"
    assert "Access denied by Dogwood policy" in tru_action.reason


def test_before_tool_call_denies_a_tool_the_schema_does_not_declare():
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)

    tru_action = dogwood.before_tool_call(_before_event("rm_rf", {}))

    assert tru_action.type == "deny"
    assert "is not declared by the Dogwood action schema" in tru_action.reason


def test_before_tool_call_lets_forbid_override_permit():
    policies = f'{PERMIT_SEARCH}\nforbid(principal, action == Action::"search", resource);'
    dogwood = DogwoodAuthorization(policies=policies, tools=SPECS)
    assert dogwood.before_tool_call(_before_event("search", {"query": "x"})).type == "deny"


def test_before_tool_call_qualifies_the_action_with_the_namespace():
    dogwood = DogwoodAuthorization(
        policies='permit(principal, action == Acme::Action::"search", resource);', tools=SPECS, namespace="Acme"
    )
    recorder = _recording(dogwood)

    assert dogwood.before_tool_call(_before_event("search", {"query": "x"})).type == "proceed"

    tru_event = {key: recorder.events[0][key] for key in ("action", "principal", "resource")}
    exp_event = {
        "action": "Acme::Action::search",
        "principal": {"type": "Acme::User", "id": "anonymous"},
        "resource": {"type": "Acme::Resource", "id": "agent"},
    }
    assert tru_event == exp_event


def test_before_tool_call_decides_a_no_argument_tool_with_its_input_absent():
    dogwood = DogwoodAuthorization(policies='permit(principal, action == Action::"ping", resource);', tools=SPECS)
    assert dogwood.before_tool_call(_before_event("ping", None)).type == "proceed"
    assert dogwood.before_tool_call(_before_event("ping", {}, tool_use_id="tool-2")).type == "proceed"


def test_before_tool_call_denies_an_argument_the_tool_does_not_declare():
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)

    tru_action = dogwood.before_tool_call(_before_event("search", {"query": "x", "undeclared": 1}))

    assert tru_action.type == "deny"
    # The denial names the mismatch so a model can correct the call when it retries.
    assert "Dogwood evaluation failed" in tru_action.reason
    assert "`undeclared`" in tru_action.reason


@pytest.mark.parametrize(
    ("amount", "exp_type"),
    [(2, "proceed"), (2.5, "proceed"), (9.9999, "proceed"), (50, "deny"), (10.5, "deny")],
)
def test_before_tool_call_compares_a_number_argument_as_a_decimal(amount, exp_type):
    dogwood = DogwoodAuthorization(policies=PERMIT_UNDER_TEN, tools=SPECS)
    assert dogwood.before_tool_call(_before_event("pay", {"amount": amount})).type == exp_type


def test_before_tool_call_compares_a_number_in_an_array_argument_as_a_decimal():
    # `splits` is optional, so Cedar only lets a policy read it behind a `has` guard.
    policies = (
        'permit(principal, action == Action::"pay", resource) '
        'when { context.input has splits && context.input.splits.contains(decimal("2.0")) };'
    )
    dogwood = DogwoodAuthorization(policies=policies, tools=SPECS)

    permitted = _before_event("pay", {"amount": 1, "splits": [2, 3]})
    assert dogwood.before_tool_call(permitted).type == "proceed"
    denied = _before_event("pay", {"amount": 1, "splits": [3]}, tool_use_id="tool-2")
    assert dogwood.before_tool_call(denied).type == "deny"


def test_before_tool_call_does_not_read_a_boolean_argument_as_a_decimal():
    dogwood = DogwoodAuthorization(policies=PERMIT_UNDER_TEN, tools=SPECS)

    tru_action = dogwood.before_tool_call(_before_event("pay", {"amount": True}))

    assert tru_action.type == "deny"
    assert "Dogwood evaluation failed" in tru_action.reason


def test_before_tool_call_denies_a_number_argument_too_large_for_a_decimal():
    dogwood = DogwoodAuthorization(policies=PERMIT_UNDER_TEN, tools=SPECS)

    tru_action = dogwood.before_tool_call(_before_event("pay", {"amount": 10**400}))

    assert tru_action.type == "deny"
    assert "Dogwood could not decide" in tru_action.reason


def test_before_tool_call_uses_the_anonymous_principal_by_default():
    dogwood = DogwoodAuthorization(policies='permit(principal == User::"anonymous", action, resource);', tools=SPECS)
    assert dogwood.before_tool_call(_before_event("search", {"query": "x"})).type == "proceed"


@pytest.mark.parametrize(("principal_id", "exp_type"), [("alice", "proceed"), ("bob", "deny")])
def test_before_tool_call_decides_against_a_static_principal(principal_id, exp_type):
    dogwood = DogwoodAuthorization(
        policies='permit(principal == User::"alice", action, resource);',
        tools=SPECS,
        principal={"type": "User", "id": principal_id},
    )
    assert dogwood.before_tool_call(_before_event("search", {"query": "x"})).type == exp_type


def test_before_tool_call_resolves_the_principal_from_invocation_state():
    def resolve(invocation_state):
        user_id = invocation_state.get("user_id")
        return {"type": "User", "id": user_id} if user_id else None

    dogwood = DogwoodAuthorization(
        policies='permit(principal == User::"alice", action, resource);', tools=SPECS, principal_resolver=resolve
    )

    permitted = _before_event("search", {"query": "x"}, invocation_state={"user_id": "alice"})
    assert dogwood.before_tool_call(permitted).type == "proceed"
    denied = _before_event("search", {"query": "x"}, invocation_state={"user_id": "bob"}, tool_use_id="tool-2")
    assert dogwood.before_tool_call(denied).type == "deny"


def test_before_tool_call_denies_when_the_resolver_returns_no_principal():
    dogwood = DogwoodAuthorization(
        policies=PERMIT_SEARCH, tools=SPECS, principal_resolver=lambda invocation_state: None
    )

    tru_action = dogwood.before_tool_call(_before_event("search", {"query": "x"}))

    assert tru_action.type == "deny"
    assert "No principal identity found in invocation state" in tru_action.reason


@pytest.mark.parametrize(
    "principal", [{"type": "Admin", "id": "root"}, {"type": "", "id": "root"}, {"type": "User", "id": ""}]
)
def test_before_tool_call_denies_a_principal_the_schema_does_not_declare(principal):
    dogwood = DogwoodAuthorization(
        policies=PERMIT_SEARCH, tools=SPECS, principal_resolver=lambda invocation_state: principal
    )
    assert dogwood.before_tool_call(_before_event("search", {"query": "x"})).type == "deny"


def test_before_tool_call_adds_the_enriched_fields_a_policy_reads():
    policies = 'permit(principal, action == Action::"search", resource) when { context.session.tenant == "acme" };'
    dogwood = DogwoodAuthorization(
        policies=policies,
        action_schema=SESSION_SCHEMA,
        context_enricher=lambda call: {"tenant": call["invocation_state"].get("tenant", "")},
    )

    permitted = _before_event("search", {"query": "x"}, invocation_state={"tenant": "acme"})
    assert dogwood.before_tool_call(permitted).type == "proceed"
    denied = _before_event("search", {"query": "x"}, invocation_state={"tenant": "other"}, tool_use_id="tool-2")
    assert dogwood.before_tool_call(denied).type == "deny"


def test_before_tool_call_passes_the_call_to_the_context_enricher():
    calls = []
    dogwood = DogwoodAuthorization(
        policies=PERMIT_SEARCH,
        action_schema=SESSION_SCHEMA,
        context_enricher=lambda call: calls.append(call) or {"tenant": "acme"},
    )

    dogwood.before_tool_call(_before_event("search", {"query": "x"}, invocation_state={"tenant": "acme"}))

    tru_call = calls
    exp_call = [{"tool_name": "search", "tool_input": {"query": "x"}, "invocation_state": {"tenant": "acme"}}]
    assert tru_call == exp_call


def test_before_tool_call_skips_the_enricher_for_an_action_without_a_session_group():
    calls = []
    dogwood = DogwoodAuthorization(
        policies='permit(principal, action == Action::"ping", resource);',
        action_schema=CONTEXTLESS_SCHEMA,
        context_enricher=lambda call: calls.append(call) or {"tenant": "acme"},
    )

    assert dogwood.before_tool_call(_before_event("ping", {})).type == "proceed"
    assert calls == []


def test_before_tool_call_proceeds_on_a_replayed_tool_use_id_without_deciding_again():
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    event = _before_event("search", {"query": "x"})
    assert dogwood.before_tool_call(event).type == "proceed"
    recorder = _recording(dogwood)

    assert dogwood.before_tool_call(event).type == "proceed"
    assert recorder.events == []


def test_before_tool_call_decides_again_when_a_tool_use_id_is_reused_for_another_tool():
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    assert dogwood.before_tool_call(_before_event("search", {"query": "x"})).type == "proceed"

    reused = _before_event("pay", {"amount": 1.0}, tool_use_id="tool-1")

    assert dogwood.before_tool_call(reused).type == "deny"


def test_after_tool_call_records_the_result_of_a_call_it_allowed():
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    recorder = _recording(dogwood)
    dogwood.before_tool_call(_before_event("search", {"query": "x"}))

    assert dogwood.after_tool_call(_after_event("search")).type == "proceed"

    assert _kinds(recorder) == ["request", "response"]
    tru_recorded = {key: recorder.events[1][key] for key in ("action", "principal", "logged")}
    exp_recorded = {
        "action": "Action::search",
        "principal": {"type": "User", "id": "anonymous"},
        "logged": {"input": {"query": "x"}},
    }
    assert tru_recorded == exp_recorded


@pytest.mark.parametrize(
    "event_kwargs", [{"status": "error"}, {"status": "success", "exception": RuntimeError("boom")}]
)
def test_after_tool_call_records_a_failed_call_as_an_error(event_kwargs):
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    recorder = _recording(dogwood)
    dogwood.before_tool_call(_before_event("search", {"query": "x"}))

    dogwood.after_tool_call(_after_event("search", **event_kwargs))

    assert _kinds(recorder) == ["request", "error"]


def test_after_tool_call_does_not_record_a_call_that_never_ran():
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    recorder = _recording(dogwood)
    dogwood.before_tool_call(_before_event("search", {"query": "x"}))

    assert dogwood.after_tool_call(_after_event("search", cancel_message="cancelled")).type == "proceed"

    assert _kinds(recorder) == ["request"]


@pytest.mark.parametrize("event_kwargs", [{"tool_use_id": "never-allowed"}, {"tool_name": "pay"}])
def test_after_tool_call_does_not_record_a_call_it_did_not_allow(event_kwargs):
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    recorder = _recording(dogwood)
    dogwood.before_tool_call(_before_event("search", {"query": "x"}))

    assert dogwood.after_tool_call(_after_event(**event_kwargs)).type == "proceed"

    assert _kinds(recorder) == ["request"]


def test_after_tool_call_records_a_call_only_once():
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    recorder = _recording(dogwood)
    dogwood.before_tool_call(_before_event("search", {"query": "x"}))

    dogwood.after_tool_call(_after_event("search"))
    dogwood.after_tool_call(_after_event("search"))

    assert _kinds(recorder) == ["request", "response"]


PERMIT_PING_AFTER_SEARCH = (
    PERMIT_SEARCH + 'permit(principal, action == Action::"ping", resource) '
    'when temporal { formerly within 1h Action::"search"::response{} };'
)


def test_after_tool_call_lets_a_later_call_satisfy_a_temporal_predicate():
    dogwood = DogwoodAuthorization(policies=PERMIT_PING_AFTER_SEARCH, tools=SPECS)

    assert dogwood.before_tool_call(_before_event("ping", {}, tool_use_id="p1")).type == "deny"
    assert dogwood.before_tool_call(_before_event("search", {"query": "x"}, tool_use_id="s1")).type == "proceed"
    # A request is not a response: the predicate waits for the call to come back.
    assert dogwood.before_tool_call(_before_event("ping", {}, tool_use_id="p2")).type == "deny"

    dogwood.after_tool_call(_after_event("search", tool_use_id="s1"))

    assert dogwood.before_tool_call(_before_event("ping", {}, tool_use_id="p3")).type == "proceed"


def test_after_tool_call_does_not_satisfy_a_response_predicate_with_a_failed_call():
    dogwood = DogwoodAuthorization(policies=PERMIT_PING_AFTER_SEARCH, tools=SPECS)
    dogwood.before_tool_call(_before_event("search", {"query": "x"}, tool_use_id="s1"))

    dogwood.after_tool_call(_after_event("search", tool_use_id="s1", status="error"))

    assert dogwood.before_tool_call(_before_event("ping", {}, tool_use_id="p1")).type == "deny"


def test_reset_denies_a_call_the_dropped_history_would_have_permitted():
    dogwood = DogwoodAuthorization(policies=PERMIT_PING_AFTER_SEARCH, tools=SPECS)
    dogwood.before_tool_call(_before_event("search", {"query": "x"}, tool_use_id="s1"))
    dogwood.after_tool_call(_after_event("search", tool_use_id="s1"))

    dogwood.reset()

    assert dogwood.before_tool_call(_before_event("ping", {}, tool_use_id="p1")).type == "deny"


def test_before_tool_call_denies_when_the_authorizer_returns_no_decision():
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    dogwood._authorizer = _SilentAuthorizer()

    tru_action = dogwood.before_tool_call(_before_event("search", {"query": "x"}))

    assert tru_action.type == "deny"
    assert "No Dogwood decision returned" in tru_action.reason


def test_after_tool_call_proceeds_when_the_result_cannot_be_recorded(caplog):
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    dogwood.before_tool_call(_before_event("search", {"query": "x"}))
    dogwood._authorizer = _UnusableAuthorizer()

    with caplog.at_level(logging.WARNING):
        assert dogwood.after_tool_call(_after_event("search")).type == "proceed"

    assert "could not record a tool result" in caplog.text


def test_reset_proceeds_when_the_history_cannot_be_dropped(caplog):
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    dogwood._authorizer = _UnusableAuthorizer()

    with caplog.at_level(logging.WARNING):
        dogwood.reset()

    assert "could not drop its temporal history" in caplog.text


def test_reset_drops_the_temporal_history():
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    dogwood.before_tool_call(_before_event("search", {"query": "x"}))
    assert dogwood._authorizer.decision_count == 1

    dogwood.reset()

    assert dogwood._authorizer.decision_count == 0
    assert dogwood._authorizer.last_timestamp is None


def test_reset_forgets_an_in_flight_call_so_its_result_is_not_recorded():
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, tools=SPECS)
    dogwood.before_tool_call(_before_event("search", {"query": "x"}))
    dogwood.reset()
    recorder = _recording(dogwood)

    assert dogwood.after_tool_call(_after_event("search")).type == "proceed"

    assert recorder.events == []


def test_before_tool_call_keeps_each_principal_pinned_to_its_own_decision():
    dogwood = DogwoodAuthorization(
        policies='permit(principal, action == Action::"search", resource);',
        tools=SPECS,
        principal_resolver=lambda invocation_state: {"type": "User", "id": invocation_state["user_id"]},
    )
    recorder = _recording(dogwood)
    dogwood.before_tool_call(_before_event("search", {"query": "x"}, invocation_state={"user_id": "alice"}))
    dogwood.after_tool_call(_after_event("search"))

    tru_principals = [event["principal"]["id"] for event in recorder.events]
    exp_principals = ["alice", "alice"]
    assert tru_principals == exp_principals


def test_before_tool_call_supplies_the_configured_entities_to_every_decision():
    entities = [{"type": "User", "id": "alice", "attrs": {}, "parents": []}]
    dogwood = DogwoodAuthorization(policies=PERMIT_SEARCH, action_schema=PLAIN_SCHEMA, entities=entities)
    recorder = _recording(dogwood)

    assert dogwood.before_tool_call(_before_event("search", {"query": "x"})).type == "proceed"

    assert recorder.events[0]["entities"] == entities
