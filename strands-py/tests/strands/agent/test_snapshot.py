"""Tests for _snapshot.py — Snapshot dataclass and resolve_snapshot_fields."""

import json
import re
from typing import Any, get_args
from unittest.mock import MagicMock

import pytest

from strands import Agent
from strands.types._snapshot import (
    ALL_SNAPSHOT_FIELDS,
    SNAPSHOT_PRESETS,
    SNAPSHOT_SCHEMA_VERSION,
    VALID_SCOPES,
    Scope,
    Snapshot,
    resolve_snapshot_fields,
)
from strands.types.exceptions import SnapshotException

# Helpers

ISO_8601_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def _make_snapshot(**kwargs: object) -> Snapshot:
    defaults: dict[str, Any] = {
        "scope": "agent",
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "created_at": "2025-01-15T12:00:00.000000Z",
        "data": {},
        "app_data": {},
    }
    defaults.update(kwargs)
    return Snapshot(**defaults)


def _make_agent(**kwargs) -> Agent:
    """Create a minimal Agent with a mock model for testing."""
    mock_model = MagicMock()
    mock_model.get_config.return_value = {}
    return Agent(model=mock_model, callback_handler=None, **kwargs)


def test_snapshot_from_dict_bad_version_raises():
    d = {"schema_version": "99.0", "created_at": "2025-01-15T12:00:00Z", "data": {}, "app_data": {}}
    with pytest.raises(SnapshotException, match="Unsupported snapshot schema version"):
        Snapshot.from_dict(d)


def test_snapshot_to_dict_round_trip():
    s = _make_snapshot(data={"messages": []}, app_data={"x": 1})
    assert Snapshot.from_dict(s.to_dict()) == s


def test_resolve_snapshot_fields_invalid_include_raises():
    with pytest.raises(SnapshotException, match="Invalid snapshot field"):
        resolve_snapshot_fields(include=["not_a_field"])  # type: ignore[list-item]


def test_resolve_snapshot_fields_invalid_exclude_raises():
    with pytest.raises(SnapshotException, match="Invalid snapshot field"):
        resolve_snapshot_fields(preset="session", exclude=["not_a_field"])  # type: ignore[list-item]


def test_resolve_snapshot_fields_no_preset_no_include_raises():
    with pytest.raises(SnapshotException, match="No snapshot fields resolved"):
        resolve_snapshot_fields()


def test_resolve_snapshot_fields_session_preset():
    assert resolve_snapshot_fields(preset="session") == set(SNAPSHOT_PRESETS["session"])


def test_resolve_snapshot_fields_include_adds_to_preset():
    fields = resolve_snapshot_fields(preset="session", include=["system_prompt"])
    assert fields == set(SNAPSHOT_PRESETS["session"]) | {"system_prompt"}


def test_resolve_snapshot_fields_exclude_removes_from_preset():
    fields = resolve_snapshot_fields(preset="session", exclude=["messages"])
    assert "messages" not in fields


def test_resolve_snapshot_fields_all_excluded_raises():
    with pytest.raises(SnapshotException):
        resolve_snapshot_fields(exclude=list(ALL_SNAPSHOT_FIELDS))  # type: ignore[list-item]


_ORDERING_CASES = [
    # (preset, include, exclude)
    ("session", [], []),
    ("session", ["system_prompt"], []),
    ("session", [], ["messages"]),
    ("session", ["system_prompt"], ["messages", "state"]),
    (None, ["messages", "state"], []),
    (None, list(ALL_SNAPSHOT_FIELDS), []),
    (None, list(ALL_SNAPSHOT_FIELDS), ["system_prompt"]),
    ("session", ["system_prompt"], list(SNAPSHOT_PRESETS["session"])),  # exclude all preset → only system_prompt
]


@pytest.mark.parametrize("preset,include,exclude", _ORDERING_CASES)
def test_resolve_snapshot_fields_ordering(preset, include, exclude):
    expected = (set(SNAPSHOT_PRESETS[preset] if preset else []) | set(include)) - set(exclude)

    if not expected:
        with pytest.raises(SnapshotException):
            resolve_snapshot_fields(preset=preset, include=include or None, exclude=exclude or None)
    else:
        assert resolve_snapshot_fields(preset=preset, include=include or None, exclude=exclude or None) == expected


_STRUCTURAL_CASES = [
    ([], {}, None),
    ([{"role": "user", "content": [{"text": "hi"}]}], {"k": "v"}, "system prompt"),
    ([{"role": "user", "content": [{"text": "a"}]}, {"role": "user", "content": [{"text": "b"}]}], {}, None),
    ([], {"num": 42, "flag": True}, "another prompt"),
]


@pytest.mark.parametrize("messages,state_dict,system_prompt", _STRUCTURAL_CASES)
def test_snapshot_structural_invariants(messages, state_dict, system_prompt):
    agent = _make_agent(messages=messages, state=state_dict, system_prompt=system_prompt)
    snapshot = agent.take_snapshot(preset="session")

    assert snapshot.schema_version == "1.0"
    assert ISO_8601_UTC_RE.match(snapshot.created_at), f"created_at={snapshot.created_at!r} not ISO 8601 UTC"
    assert isinstance(snapshot.data, dict)
    assert isinstance(snapshot.app_data, dict)
    for field in ("messages", "state", "conversation_manager_state", "interrupt_state", "model_state"):
        assert field in snapshot.data
    assert "system_prompt" not in snapshot.data


_APP_DATA_CASES = [
    {"key": "value"},
    {"num": 42, "flag": True, "nothing": None},
    {"nested_str": "hello", "count": 0},
]


@pytest.mark.parametrize("app_data", _APP_DATA_CASES)
def test_app_data_stored_verbatim(app_data):
    agent = _make_agent()
    snapshot = agent.take_snapshot(preset="session", app_data=app_data)
    assert snapshot.app_data == app_data


_ROUND_TRIP_AGENT_CASES = [
    ([], {}),
    ([{"role": "user", "content": [{"text": "hi"}]}], {"k": "v"}),
    (
        [{"role": "user", "content": [{"text": "a"}]}, {"role": "user", "content": [{"text": "b"}]}],
        {"num": 1, "flag": None},
    ),
]


@pytest.mark.parametrize("messages,state_dict", _ROUND_TRIP_AGENT_CASES)
def test_agent_state_round_trip(messages, state_dict):
    agent = _make_agent(messages=messages, state=state_dict, system_prompt="original prompt")
    snapshot = agent.take_snapshot(preset="session")

    fresh_agent = _make_agent(system_prompt="original prompt")
    fresh_agent.load_snapshot(snapshot)

    assert fresh_agent.messages == messages
    assert fresh_agent.state.get() == state_dict
    assert fresh_agent.system_prompt == "original prompt"
    assert fresh_agent.conversation_manager.get_state() == agent.conversation_manager.get_state()
    assert fresh_agent._interrupt_state.to_dict() == agent._interrupt_state.to_dict()


def test_durable_tracking_id_survives_snapshot_round_trip():
    messages = [{"role": "user", "content": [{"text": "hi"}], "tracking_id": "durable-1"}]
    agent = _make_agent(messages=messages)
    snapshot = agent.take_snapshot(preset="session")

    fresh_agent = _make_agent()
    fresh_agent.load_snapshot(snapshot)

    assert fresh_agent.messages[0]["tracking_id"] == "durable-1"


@pytest.mark.parametrize("omitted_field", list(ALL_SNAPSHOT_FIELDS))
def test_missing_fields_leave_agent_unchanged(omitted_field):
    agent = _make_agent(
        messages=[{"role": "user", "content": [{"text": "original"}]}],
        state={"key": "original"},
        system_prompt="original prompt",
    )

    include_fields = [f for f in ALL_SNAPSHOT_FIELDS if f != omitted_field]
    snapshot = agent.take_snapshot(include=include_fields)
    # system_prompt field is stored under the key "system_prompt" in snapshot.data
    data_key = "system_prompt" if omitted_field == "system_prompt" else omitted_field
    assert data_key not in snapshot.data

    fresh_agent = _make_agent(
        messages=list(agent.messages),
        state=agent.state.get(),
        system_prompt="original prompt",
    )

    if omitted_field == "messages":
        before = list(fresh_agent.messages)
    elif omitted_field == "state":
        before = fresh_agent.state.get()
    elif omitted_field == "system_prompt":
        before = fresh_agent.system_prompt
    elif omitted_field == "conversation_manager_state":
        before = fresh_agent.conversation_manager.get_state()
    elif omitted_field == "interrupt_state":
        before = fresh_agent._interrupt_state.to_dict()
    elif omitted_field == "model_state":
        before = dict(fresh_agent._model_state)
    else:
        pytest.fail(f"Unhandled field in test: {omitted_field!r}. Update this test when adding new snapshot fields.")

    fresh_agent.load_snapshot(snapshot)

    if omitted_field == "messages":
        assert fresh_agent.messages == before
    elif omitted_field == "state":
        assert fresh_agent.state.get() == before
    elif omitted_field == "system_prompt":
        assert fresh_agent.system_prompt == before
    elif omitted_field == "conversation_manager_state":
        assert fresh_agent.conversation_manager.get_state() == before
    elif omitted_field == "interrupt_state":
        assert fresh_agent._interrupt_state.to_dict() == before
    elif omitted_field == "model_state":
        assert fresh_agent._model_state == before
    else:
        pytest.fail(f"Unhandled field in test: {omitted_field!r}. Update this test when adding new snapshot fields.")


def test_snapshot_no_system_prompt_clears_target_agent_prompt():
    """Snapshot from agent with no system_prompt (field included) clears prompt on restore."""
    source_agent = _make_agent()  # no system_prompt
    snapshot = source_agent.take_snapshot(include=["system_prompt"])

    assert "system_prompt" in snapshot.data
    assert snapshot.data["system_prompt"] is None

    target_agent = _make_agent(system_prompt="existing prompt")
    target_agent.load_snapshot(snapshot)

    assert target_agent.system_prompt is None


def test_snapshot_without_system_prompt_field_preserves_target_agent_prompt():
    """Snapshot taken without system_prompt field does not override target agent's prompt."""
    source_agent = _make_agent(system_prompt="source prompt")
    snapshot = source_agent.take_snapshot(include=["messages"])  # system_prompt field excluded

    assert "system_prompt" not in snapshot.data

    target_agent = _make_agent(system_prompt="target prompt")
    target_agent.load_snapshot(snapshot)

    assert target_agent.system_prompt == "target prompt"


def test_load_snapshot_messages_are_independent_copy():
    """Messages restored from a snapshot are a copy — mutating snapshot.data after load doesn't affect the agent."""
    agent = _make_agent(messages=[{"role": "user", "content": [{"text": "hello"}]}])
    snapshot = agent.take_snapshot(preset="session")

    fresh_agent = _make_agent()
    fresh_agent.load_snapshot(snapshot)

    snapshot.data["messages"].append({"role": "user", "content": [{"text": "injected"}]})
    assert len(fresh_agent.messages) == 1


def test_take_snapshot_messages_are_independent_copy():
    """Mutating agent messages after take_snapshot doesn't corrupt the snapshot."""
    msg = {"role": "user", "content": [{"text": "original"}]}
    agent = _make_agent(messages=[msg])
    snapshot = agent.take_snapshot(preset="session")

    agent.messages[0]["content"][0]["text"] = "mutated"
    assert snapshot.data["messages"][0]["content"][0]["text"] == "original"


def test_take_snapshot_app_data_is_independent_copy():
    """Mutating app_data after take_snapshot doesn't corrupt the snapshot."""
    app_data = {"key": "original"}
    agent = _make_agent()
    snapshot = agent.take_snapshot(preset="session", app_data=app_data)

    app_data["key"] = "mutated"
    assert snapshot.app_data["key"] == "original"


# Scope validation


def test_valid_scopes_constant_matches_scope_type():
    """VALID_SCOPES contains exactly the values from the Scope Literal type."""
    assert set(VALID_SCOPES) == set(get_args(Scope))


def test_snapshot_validate_accepts_valid_scopes():
    """validate() should not raise for each valid scope value."""
    for scope in VALID_SCOPES:
        snap = _make_snapshot(scope=scope)
        snap.validate()  # should not raise


def test_snapshot_validate_rejects_invalid_scope():
    """validate() should raise SnapshotException for an unrecognised scope."""
    snap = _make_snapshot(scope="invalid_scope")
    with pytest.raises(SnapshotException, match="Invalid snapshot scope"):
        snap.validate()


def test_snapshot_from_dict_rejects_invalid_scope():
    """from_dict() calls validate(), so an invalid scope should raise."""
    d = {
        "scope": "bad_scope",
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "created_at": "2025-01-15T12:00:00Z",
        "data": {},
        "app_data": {},
    }
    with pytest.raises(SnapshotException, match="Invalid snapshot scope"):
        Snapshot.from_dict(d)


def test_snapshot_from_dict_defaults_scope_to_agent():
    """from_dict() defaults scope to 'agent' when the key is missing."""
    d = {
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "created_at": "2025-01-15T12:00:00Z",
        "data": {},
        "app_data": {},
    }
    snap = Snapshot.from_dict(d)
    assert snap.scope == "agent"


def test_load_snapshot_rejects_invalid_scope():
    """Agent.load_snapshot() should reject a snapshot with an invalid scope."""
    agent = _make_agent()
    snap = _make_snapshot(scope="unknown")
    with pytest.raises(SnapshotException, match="Invalid snapshot scope"):
        agent.load_snapshot(snap)


def test_take_snapshot_always_produces_agent_scope():
    """take_snapshot() should always set scope to 'agent'."""
    agent = _make_agent()
    snapshot = agent.take_snapshot(preset="session")
    assert snapshot.scope == "agent"


# Individual field restore from a raw snapshot


def test_load_snapshot_restores_messages_only():
    """A snapshot containing only messages restores them on a fresh agent."""
    agent = _make_agent(messages=[{"role": "user", "content": [{"text": "existing"}]}])
    snap = _make_snapshot(data={"messages": [{"role": "user", "content": [{"text": "restored"}]}]})

    agent.load_snapshot(snap)

    assert len(agent.messages) == 1
    assert agent.messages[0]["content"][0]["text"] == "restored"


def test_load_snapshot_restores_state_only():
    """A snapshot containing only state restores it on a fresh agent."""
    agent = _make_agent(state={"old": "value"})
    snap = _make_snapshot(data={"state": {"new_key": "new_value"}})

    agent.load_snapshot(snap)

    assert agent.state.get() == {"new_key": "new_value"}


def test_load_snapshot_restores_system_prompt_only():
    """A snapshot containing only system_prompt restores it on a fresh agent."""
    agent = _make_agent(system_prompt="old prompt")
    snap = _make_snapshot(data={"system_prompt": "restored prompt"})

    agent.load_snapshot(snap)

    assert agent.system_prompt == "restored prompt"


def test_snapshot_json_string_round_trip():
    """Snapshot survives json.dumps / json.loads round-trip."""
    agent = _make_agent(
        messages=[{"role": "user", "content": [{"text": "hello"}]}],
        state={"k": "v"},
        system_prompt="test prompt",
    )
    snapshot = agent.take_snapshot(preset="session", include=["system_prompt"])

    json_str = json.dumps(snapshot.to_dict())
    restored = Snapshot.from_dict(json.loads(json_str))

    assert restored == snapshot


def test_snapshot_json_store_and_restore_into_new_agent():
    """Simulate persisting a snapshot as JSON and restoring into a new agent."""
    agent = _make_agent(
        messages=[{"role": "user", "content": [{"text": "test message"}]}],
        state={"key": "value"},
    )
    snapshot = agent.take_snapshot(preset="session")

    stored = json.dumps(snapshot.to_dict())
    retrieved = Snapshot.from_dict(json.loads(stored))

    new_agent = _make_agent()
    new_agent.load_snapshot(retrieved)

    assert new_agent.messages == [{"role": "user", "content": [{"text": "test message"}]}]
    assert new_agent.state.get() == {"key": "value"}


def test_snapshot_round_trip_with_tool_use_messages():
    """Snapshot preserves toolUse and toolResult content blocks through a round-trip."""
    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "tool-123", "name": "calculator", "input": {"op": "add"}}}],
    }
    tool_result_msg = {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": "tool-123", "status": "success", "content": [{"text": "6"}]}}],
    }
    agent = _make_agent(messages=[tool_use_msg, tool_result_msg])
    snapshot = agent.take_snapshot(include=["messages"])

    fresh_agent = _make_agent()
    fresh_agent.load_snapshot(snapshot)

    assert fresh_agent.messages == [tool_use_msg, tool_result_msg]


def test_take_snapshot_exclude_removes_field_from_data():
    """Excluding a field from take_snapshot omits it from snapshot.data while keeping others."""
    agent = _make_agent(
        messages=[{"role": "user", "content": [{"text": "hi"}]}],
        state={"k": "v"},
    )
    snapshot = agent.take_snapshot(preset="session", exclude=["messages"])

    assert "messages" not in snapshot.data
    assert "state" in snapshot.data
    assert "conversation_manager_state" in snapshot.data
    assert "interrupt_state" in snapshot.data


def test_take_snapshot_system_prompt_is_independent_copy():
    """Mutating agent system_prompt after take_snapshot doesn't corrupt the snapshot."""
    agent = _make_agent(system_prompt="original prompt")
    snapshot = agent.take_snapshot(include=["system_prompt"])

    original_content = snapshot.data["system_prompt"]
    agent.system_prompt = "mutated prompt"
    assert snapshot.data["system_prompt"] == original_content
    assert snapshot.data["system_prompt"] != agent._system_prompt_content


# model_state snapshot field


def test_model_state_is_valid_snapshot_field():
    """model_state is recognized as a valid SnapshotField."""
    assert "model_state" in ALL_SNAPSHOT_FIELDS


def test_model_state_in_session_preset():
    """model_state is included in the session preset."""
    assert "model_state" in SNAPSHOT_PRESETS["session"]


def test_take_snapshot_captures_model_state():
    """take_snapshot with include=['model_state'] captures the agent's _model_state."""
    agent = _make_agent()
    agent._model_state = {"response_id": "resp_abc123"}
    snapshot = agent.take_snapshot(include=["model_state"])

    assert snapshot.data["model_state"] == {"response_id": "resp_abc123"}


def test_take_snapshot_model_state_is_independent_copy():
    """Mutating agent._model_state after take_snapshot doesn't corrupt the snapshot."""
    agent = _make_agent()
    agent._model_state = {"response_id": "resp_abc123"}
    snapshot = agent.take_snapshot(include=["model_state"])

    agent._model_state["response_id"] = "resp_mutated"
    assert snapshot.data["model_state"]["response_id"] == "resp_abc123"


def test_load_snapshot_restores_model_state():
    """load_snapshot restores model_state onto the agent."""
    agent = _make_agent()
    agent._model_state = {"old": "state"}

    snap = _make_snapshot(data={"model_state": {"response_id": "resp_restored"}})
    agent.load_snapshot(snap)

    assert agent._model_state == {"response_id": "resp_restored"}


def test_load_snapshot_without_model_state_leaves_it_unchanged():
    """A snapshot without model_state in data does not alter agent._model_state."""
    agent = _make_agent()
    agent._model_state = {"response_id": "resp_keep"}

    snap = _make_snapshot(data={"messages": [{"role": "user", "content": [{"text": "hi"}]}]})
    agent.load_snapshot(snap)

    assert agent._model_state == {"response_id": "resp_keep"}


def test_load_snapshot_with_empty_model_state_clears_it():
    """A snapshot with model_state={} overwrites a non-empty _model_state."""
    agent = _make_agent()
    agent._model_state = {"response_id": "resp_existing"}

    snap = _make_snapshot(data={"model_state": {}})
    agent.load_snapshot(snap)

    assert agent._model_state == {}


def test_load_snapshot_model_state_is_independent_copy():
    """Mutating agent._model_state after load_snapshot doesn't corrupt the snapshot."""
    agent = _make_agent()
    snap = _make_snapshot(data={"model_state": {"response_id": "resp_original"}})
    agent.load_snapshot(snap)

    agent._model_state["response_id"] = "resp_mutated"
    assert snap.data["model_state"]["response_id"] == "resp_original"


def test_model_state_round_trip():
    """model_state survives take_snapshot -> load_snapshot round-trip."""
    agent = _make_agent()
    agent._model_state = {"response_id": "resp_xyz", "extra": 42}
    snapshot = agent.take_snapshot(include=["model_state"])

    fresh_agent = _make_agent()
    fresh_agent.load_snapshot(snapshot)

    assert fresh_agent._model_state == {"response_id": "resp_xyz", "extra": 42}
