"""Unit tests for BidiAgent snapshot capture and restore."""

import copy
import unittest.mock

import pytest

from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.models import BidiModel
from strands.types._snapshot import BIDI_SNAPSHOT_PRESETS, SNAPSHOT_SCHEMA_VERSION, Snapshot
from strands.types.exceptions import SnapshotException

_MESSAGES = [
    {"role": "user", "content": [{"text": "hello"}]},
    {"role": "assistant", "content": [{"text": "hi"}]},
]
_STATE = {"user_id": "u-1", "count": 2}
_SYSTEM_PROMPT = [{"text": "You are helpful."}, {"cachePoint": {"type": "default"}}]


def _make_agent(**kwargs) -> BidiAgent:
    model = unittest.mock.AsyncMock(spec=BidiModel)
    model.get_connection_config.return_value = {}
    return BidiAgent(model=model, **kwargs)


def _make_snapshot(**data) -> Snapshot:
    return Snapshot(scope="agent", schema_version=SNAPSHOT_SCHEMA_VERSION, data=copy.deepcopy(data), app_data={})


def test_take_snapshot_session_preset():
    agent = _make_agent(messages=_MESSAGES, state=_STATE, system_prompt=_SYSTEM_PROMPT)

    tru_snapshot = agent.take_snapshot(preset="session")

    exp_snapshot = Snapshot(
        scope="agent",
        schema_version=SNAPSHOT_SCHEMA_VERSION,
        created_at=unittest.mock.ANY,
        data={"messages": _MESSAGES, "state": _STATE},
        app_data={},
    )
    assert tru_snapshot == exp_snapshot
    assert set(tru_snapshot.data) == set(BIDI_SNAPSHOT_PRESETS["session"])


def test_take_snapshot_include_system_prompt_preserves_content_blocks():
    agent = _make_agent(system_prompt=_SYSTEM_PROMPT)

    tru_data = agent.take_snapshot(include=["system_prompt"]).data

    exp_data = {"system_prompt": _SYSTEM_PROMPT}
    assert tru_data == exp_data


def test_take_snapshot_exclude_removes_field():
    agent = _make_agent(messages=_MESSAGES, state=_STATE)

    tru_data = agent.take_snapshot(preset="session", exclude=["messages"]).data

    exp_data = {"state": _STATE}
    assert tru_data == exp_data


@pytest.mark.parametrize("field", ["conversation_manager_state", "interrupt_state", "model_state"])
@pytest.mark.parametrize("option", ["include", "exclude"])
def test_take_snapshot_rejects_unsupported_field(field, option):
    agent = _make_agent()

    with pytest.raises(SnapshotException, match=f"Invalid snapshot field: '{field}'"):
        agent.take_snapshot(preset="session", **{option: [field]})


@pytest.mark.parametrize("options", [{}, {"preset": "session", "exclude": ["messages", "state"]}])
def test_take_snapshot_rejects_empty_field_set(options):
    agent = _make_agent()

    with pytest.raises(SnapshotException, match="No snapshot fields resolved"):
        agent.take_snapshot(**options)


def test_take_snapshot_app_data_stored_verbatim():
    agent = _make_agent()
    app_data = {"checkpoint": "before-tool", "nested": {"k": [1, 2]}}

    tru_app_data = agent.take_snapshot(preset="session", app_data=app_data).app_data

    assert tru_app_data == app_data
    assert tru_app_data is not app_data


def test_take_snapshot_returns_independent_copies():
    agent = _make_agent(messages=_MESSAGES, state=_STATE, system_prompt=_SYSTEM_PROMPT)

    snapshot = agent.take_snapshot(preset="session", include=["system_prompt"])
    snapshot.data["messages"].append({"role": "user", "content": [{"text": "extra"}]})
    snapshot.data["state"]["count"] = 99
    snapshot.data["system_prompt"].append({"text": "extra"})

    assert agent.messages == _MESSAGES
    assert agent.state.get() == _STATE
    assert agent.system_prompt_content == _SYSTEM_PROMPT


@pytest.mark.asyncio
async def test_take_snapshot_while_started():
    agent = _make_agent(messages=_MESSAGES)
    await agent.start()
    try:
        tru_data = agent.take_snapshot(preset="session").data
    finally:
        await agent.stop()

    exp_data = {"messages": _MESSAGES, "state": {}}
    assert tru_data == exp_data


def test_load_snapshot_round_trip_into_fresh_agent():
    source = _make_agent(messages=_MESSAGES, state=_STATE, system_prompt=_SYSTEM_PROMPT)
    target = _make_agent()

    target.load_snapshot(source.take_snapshot(preset="session", include=["system_prompt"]))

    assert target.messages == _MESSAGES
    assert target.state.get() == _STATE
    assert target.system_prompt_content == _SYSTEM_PROMPT


@pytest.mark.parametrize("omitted_field", ["messages", "state", "system_prompt"])
def test_load_snapshot_missing_field_leaves_agent_unchanged(omitted_field):
    data = {"messages": _MESSAGES, "state": _STATE, "system_prompt": _SYSTEM_PROMPT}
    del data[omitted_field]
    target = _make_agent(
        messages=[{"role": "user", "content": [{"text": "original"}]}],
        state={"original": True},
        system_prompt="original prompt",
    )
    exp_messages = list(target.messages)
    exp_state = target.state.get()
    exp_system_prompt = target.system_prompt_content

    target.load_snapshot(_make_snapshot(**data))

    tru_values = {
        "messages": target.messages,
        "state": target.state.get(),
        "system_prompt": target.system_prompt_content,
    }
    exp_values = {
        "messages": _MESSAGES,
        "state": _STATE,
        "system_prompt": _SYSTEM_PROMPT,
    }
    exp_values[omitted_field] = {
        "messages": exp_messages,
        "state": exp_state,
        "system_prompt": exp_system_prompt,
    }[omitted_field]
    assert tru_values == exp_values


def test_load_snapshot_ignores_agent_only_fields():
    target = _make_agent()

    target.load_snapshot(
        _make_snapshot(
            messages=_MESSAGES,
            conversation_manager_state={"removed_message_count": 3},
            interrupt_state={"activated": False},
            model_state={"response_id": "r-1"},
        )
    )

    assert target.messages == _MESSAGES


def test_load_snapshot_restores_independent_copies():
    target = _make_agent()
    snapshot = _make_snapshot(messages=_MESSAGES, system_prompt=_SYSTEM_PROMPT)

    target.load_snapshot(snapshot)
    snapshot.data["messages"].append({"role": "user", "content": [{"text": "extra"}]})
    snapshot.data["system_prompt"].append({"text": "extra"})

    assert target.messages == _MESSAGES
    assert target.system_prompt_content == _SYSTEM_PROMPT


def test_load_snapshot_rejects_unsupported_schema_version():
    target = _make_agent()
    snapshot = Snapshot(scope="agent", schema_version="0.9", data={"messages": _MESSAGES}, app_data={})

    with pytest.raises(SnapshotException, match="Unsupported snapshot schema version"):
        target.load_snapshot(snapshot)


def test_load_snapshot_rejects_multi_agent_scope():
    target = _make_agent(state={"original": True})
    snapshot = Snapshot(
        scope="multiAgent",
        schema_version=SNAPSHOT_SCHEMA_VERSION,
        data={"state": {"node": "n-1"}},
        app_data={},
    )

    with pytest.raises(SnapshotException, match="Expected snapshot scope 'agent'"):
        target.load_snapshot(snapshot)
    assert target.state.get() == {"original": True}


@pytest.mark.asyncio
async def test_load_snapshot_rejects_active_connection():
    agent = _make_agent()
    snapshot = _make_snapshot(messages=_MESSAGES)

    await agent.start()
    try:
        with pytest.raises(RuntimeError, match="agent started"):
            agent.load_snapshot(snapshot)
        assert agent.messages == []
    finally:
        await agent.stop()

    agent.load_snapshot(snapshot)
    assert agent.messages == _MESSAGES


@pytest.mark.asyncio
async def test_load_snapshot_history_is_sent_on_next_start():
    agent = _make_agent()
    agent.load_snapshot(_make_snapshot(messages=_MESSAGES, system_prompt=_SYSTEM_PROMPT))

    await agent.start()
    try:
        tru_call = agent.model.start.call_args
    finally:
        await agent.stop()

    assert tru_call.kwargs["messages"] == _MESSAGES
    assert tru_call.kwargs["system_prompt"] == "You are helpful."
