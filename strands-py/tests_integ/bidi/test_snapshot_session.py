"""Integration tests for BidiAgent persistence through SnapshotSessionManager."""

import asyncio
from uuid import uuid4

import pytest

from strands import LocalAgent, tool
from strands.experimental.bidi.agent import BidiAgent
from strands.session import SnapshotSessionManager
from strands.storage import LocalFileStorage

from .test_bidirectional_agent import PROVIDER_CONFIGS, check_provider_available


@pytest.fixture
def weather_tool():
    @tool(name="weather_tool")
    def func(city_name: str) -> str:
        return f"city_name=<{city_name}> | sunny"

    return func


def _texts(agent: BidiAgent) -> list[str]:
    return [content["text"] for message in agent.messages for content in message["content"] if "text" in content]


@pytest.mark.asyncio
async def test_bidi_agent_direct_tool_call_with_snapshot_session(weather_tool, tmp_path):
    session_id = str(uuid4())
    storage = LocalFileStorage(tmp_path)
    manager = SnapshotSessionManager[LocalAgent](
        session_id, storage=storage, snapshot_trigger=lambda *, agent_data, **_: True
    )
    agent = BidiAgent(record_direct_tool_call=True, tools=[weather_tool], session_manager=manager)
    agent.state.set("city", "new york")
    agent.tool.weather_tool(city_name="new york")
    await agent.stop()

    restored_manager = SnapshotSessionManager[LocalAgent](session_id, storage=storage)
    restored_agent = BidiAgent(record_direct_tool_call=True, tools=[weather_tool], session_manager=restored_manager)

    tru_state = restored_agent.state.get()
    exp_state = {"city": "new york"}
    assert tru_state == exp_state
    tru_messages = restored_agent.messages
    exp_messages = agent.messages
    assert tru_messages == exp_messages

    restored_agent.tool.weather_tool(city_name="seattle")
    await restored_agent.stop()

    snapshot_ids = await manager.list_snapshot_ids(agent)
    assert len(snapshot_ids) == 1
    assert await restored_manager.restore_snapshot(restored_agent, snapshot_id=snapshot_ids[0]) is True
    assert restored_agent.messages == agent.messages
    assert await restored_manager.restore_snapshot(restored_agent) is True
    assert len(restored_agent.messages) == 8


@pytest.mark.asyncio
async def test_bidi_agent_conversation_restores_before_start_with_snapshot_session(tmp_path):
    provider_config = PROVIDER_CONFIGS["bedrock_nova_sonic"]
    is_available, skip_reason = check_provider_available("bedrock_nova_sonic")
    if not is_available:
        pytest.skip(skip_reason)

    session_id = str(uuid4())
    storage = LocalFileStorage(tmp_path)
    system_prompt = "You are a helpful assistant. Keep responses brief."

    agent = BidiAgent(
        model=provider_config["model_factory"](**provider_config["model_kwargs"]),
        system_prompt=system_prompt,
        session_manager=SnapshotSessionManager(session_id, storage=storage),
    )
    agent.state.set("turns", 1)
    await agent.start()
    await agent.send("Remember the code word is pineapple.")
    await asyncio.sleep(provider_config["silence_duration"])
    await agent.stop()

    assert "Remember the code word is pineapple." in _texts(agent)

    restored_agent = BidiAgent(
        model=provider_config["model_factory"](**provider_config["model_kwargs"]),
        session_manager=SnapshotSessionManager(session_id, storage=storage),
    )

    assert _texts(restored_agent) == _texts(agent)
    assert restored_agent.state.get("turns") == 1
    assert restored_agent.system_prompt == system_prompt

    await restored_agent.start()
    await restored_agent.stop()
