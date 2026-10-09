"""Tests for SnapshotSessionManager."""

import asyncio
import json
import logging
import tempfile
import uuid
from functools import partial
from unittest.mock import AsyncMock, Mock

import pytest

from strands import tool
from strands._context_manager.context_manager import ContextManager
from strands.agent import AgentResult
from strands.agent.agent import Agent
from strands.agent.conversation_manager.sliding_window_conversation_manager import SlidingWindowConversationManager
from strands.bidi.agent import BidiAgent
from strands.bidi.hooks import (
    BidiAfterConnectionRestartEvent,
    BidiAgentStopEvent,
    BidiBeforeConnectionRestartEvent,
    BidiResponseStopEvent,
)
from strands.bidi.models import BidiModel, ConnectionTimeoutError
from strands.hooks.events import (
    AfterMultiAgentInvocationEvent,
    AfterNodeCallEvent,
    BeforeMultiAgentInvocationEvent,
    MultiAgentInitializedEvent,
)
from strands.interrupt import Interrupt
from strands.multiagent import GraphBuilder, Swarm
from strands.multiagent.base import Status
from strands.session.snapshot_session_manager import (
    SnapshotSessionManager,
    _deserialize_snapshot,
    _multi_agent_latest_key,
    _new_snapshot_id,
    _serialize_snapshot,
    _session_prefix,
    _snapshot_key,
)
from strands.storage import LocalFileStorage
from strands.storage.in_memory_storage import InMemoryStorage
from strands.types._snapshot import Snapshot
from strands.types.content import ContentBlock
from strands.types.exceptions import ContextWindowOverflowException, SnapshotException
from tests.fixtures.mocked_model_provider import MockedModelProvider


@pytest.fixture
def temp_dir():
    """Create a temporary directory for testing."""
    with tempfile.TemporaryDirectory() as temp_dir:
        yield temp_dir


@pytest.fixture
def storage(temp_dir):
    """A file-backed unified storage."""
    return LocalFileStorage(temp_dir)


def _model(*texts):
    """Build a mock model that replies with the given texts in sequence."""
    return MockedModelProvider([{"role": "assistant", "content": [{"text": text}]} for text in texts])


def _on_disk_key(session_id: str, agent_id: str) -> str:
    """The full raw-storage key for a session's latest snapshot (namespace + relative key)."""
    return f"session/{_snapshot_key(session_id, agent_id, snapshot_id=None)}"


def _tool_result_text(agent, tool_use_id: str) -> str:
    """The text of the tool result for ``tool_use_id`` in an agent's history."""
    for message in agent.messages:
        for content in message["content"]:
            if content.get("toolResult", {}).get("toolUseId") == tool_use_id:
                return content["toolResult"]["content"][0]["text"]
    raise AssertionError(f"no tool result for {tool_use_id}")


def _texts(agent) -> list[str]:
    """Flatten an agent's message text content, for asserting which turns are present."""
    return [content["text"] for message in agent.messages for content in message["content"] if "text" in content]


def test_new_session_starts_empty(storage):
    """A brand-new session leaves a fresh agent's messages untouched."""
    manager = SnapshotSessionManager("s1", storage=storage)
    agent = Agent(model=_model("hi"), session_manager=manager, agent_id="a1")

    assert agent.messages == []


def test_empty_session_id_is_rejected(storage):
    """An empty session id is rejected; otherwise its prefix would broaden to all sessions."""
    with pytest.raises(ValueError, match="not a valid session identifier"):
        SnapshotSessionManager("", storage=storage)


@pytest.mark.parametrize("bad_id", [".", "..", "   "])
def test_relative_or_blank_session_id_is_rejected(storage, bad_id):
    """'.'/'..'/whitespace pass validate_identifier but collapse or explode the key — reject them."""
    with pytest.raises(ValueError, match="not a valid session identifier"):
        SnapshotSessionManager(bad_id, storage=storage)


def test_unknown_save_latest_on_is_rejected(storage):
    """A mistyped save_latest_on is rejected, rather than silently persisting nothing."""
    with pytest.raises(ValueError, match="save_latest_on must be one of"):
        SnapshotSessionManager("s1", storage=storage, save_latest_on="Invocation")  # type: ignore[arg-type]


@pytest.mark.parametrize("bad_strategy", ["Message", "invocation"])
def test_unknown_bidi_agent_save_latest_on_is_rejected(storage, bad_strategy):
    """The Bidi strategy has its own vocabulary; Agent-only values like "invocation" are rejected."""
    with pytest.raises(ValueError, match="bidi_agent_save_latest_on must be one of"):
        SnapshotSessionManager("s1", storage=storage, bidi_agent_save_latest_on=bad_strategy)


def test_graph_snapshot_is_persisted_after_run(storage):
    """Running a Graph with the manager writes its state to the multiAgent scope key."""
    builder = GraphBuilder()
    builder.add_node(Agent(model=_model("done"), agent_id="n1"), "n1")
    builder.set_graph_id("g1")
    builder.set_session_manager(SnapshotSessionManager("mm", storage=storage))
    graph = builder.build()

    asyncio.run(graph.invoke_async("go"))

    key = "session/mm/scopes/multiAgent/g1/snapshots/snapshot_latest.json"
    raw = asyncio.run(storage.read(key))
    assert raw is not None
    snapshot = _deserialize_snapshot(raw)
    assert snapshot.scope == "multiAgent"
    assert snapshot.data["orchestrator_id"] == "g1"
    assert snapshot.data["state"]["type"] == "graph"


def test_swarm_snapshot_is_persisted_after_run(storage):
    """Running a Swarm with the manager writes its state to the multiAgent scope key."""
    swarm = Swarm(
        nodes=[Agent(model=_model("done"), agent_id="n1")],
        session_manager=SnapshotSessionManager("mm", storage=storage),
        id="sw1",
    )

    asyncio.run(swarm.invoke_async("go"))

    key = "session/mm/scopes/multiAgent/sw1/snapshots/snapshot_latest.json"
    raw = asyncio.run(storage.read(key))
    assert raw is not None
    assert _deserialize_snapshot(raw).data["state"]["type"] == "swarm"


def test_interrupted_graph_restores_before_applying_response(storage, agenerator):
    """A fresh Graph applies an interrupt response after restoring the persisted interrupt state."""
    interrupt = Interrupt(id="approval", name="approval", reason="approval required")
    interrupted_agent = Agent(model=_model("unused"), agent_id="n1")
    interrupted_agent._interrupt_state.interrupts[interrupt.id] = interrupt
    interrupted_agent._interrupt_state.activate()
    interrupted_agent.stream_async = Mock(
        return_value=agenerator(
            [
                {
                    "result": AgentResult(
                        message={},
                        stop_reason="interrupt",
                        state={},
                        metrics=None,
                        interrupts=[interrupt],
                    )
                }
            ]
        )
    )

    def _graph(agent, manager):
        builder = GraphBuilder()
        builder.add_node(agent, "n1")
        builder.set_graph_id("g1")
        builder.set_session_manager(manager)
        return builder.build()

    first = _graph(interrupted_agent, SnapshotSessionManager("mm", storage=storage))
    interrupted_result = asyncio.run(first.invoke_async("go"))
    assert interrupted_result.status == Status.INTERRUPTED

    resumed_agent = Agent(model=_model("unused"), agent_id="n1")
    resumed_agent.stream_async = Mock(
        return_value=agenerator(
            [
                {
                    "result": AgentResult(
                        message={"role": "assistant", "content": [{"text": "done"}]},
                        stop_reason="end_turn",
                        state={},
                        metrics=None,
                    )
                }
            ]
        )
    )
    resumed = _graph(resumed_agent, SnapshotSessionManager("mm", storage=storage))
    responses = [{"interruptResponse": {"interruptId": interrupt.id, "response": "approved"}}]

    result = asyncio.run(resumed.invoke_async(responses))

    assert result.status == Status.COMPLETED
    resumed_agent.stream_async.assert_called_once_with(responses, invocation_state={})


def test_interrupted_swarm_restores_before_applying_response(storage, agenerator):
    """A fresh Swarm applies an interrupt response after restoring the persisted interrupt state."""
    interrupt = Interrupt(id="approval", name="approval", reason="approval required")
    interrupted_agent = Agent(model=_model("unused"), agent_id="n1")
    interrupted_agent._interrupt_state.interrupts[interrupt.id] = interrupt
    interrupted_agent._interrupt_state.activate()
    interrupted_agent.stream_async = Mock(
        return_value=agenerator(
            [
                {
                    "result": AgentResult(
                        message={},
                        stop_reason="interrupt",
                        state={},
                        metrics=None,
                        interrupts=[interrupt],
                    )
                }
            ]
        )
    )

    first = Swarm(
        nodes=[interrupted_agent],
        session_manager=SnapshotSessionManager("mm-swarm", storage=storage),
        id="sw1",
    )
    interrupted_result = asyncio.run(first.invoke_async("go"))
    assert interrupted_result.status == Status.INTERRUPTED

    resumed_agent = Agent(model=_model("unused"), agent_id="n1")
    resumed_agent.stream_async = Mock(
        return_value=agenerator(
            [
                {
                    "result": AgentResult(
                        message={"role": "assistant", "content": [{"text": "done"}]},
                        stop_reason="end_turn",
                        state={},
                        metrics=None,
                    )
                }
            ]
        )
    )
    resumed = Swarm(
        nodes=[resumed_agent],
        session_manager=SnapshotSessionManager("mm-swarm", storage=storage),
        id="sw1",
    )
    responses = [{"interruptResponse": {"interruptId": interrupt.id, "response": "approved"}}]

    result = asyncio.run(resumed.invoke_async(responses))

    assert result.status == Status.COMPLETED
    resumed_agent.stream_async.assert_called_once_with(responses, invocation_state={})


def test_load_snapshot_restores_mid_run_state(storage):
    """Loading a resumable (non-terminal) snapshot restores completed nodes and the frontier.

    Proves restore loads real state rather than only not crashing; the terminal-reset case is
    covered separately by ``test_completed_orchestrator_reinvokes_from_scratch``.
    """
    from strands.multiagent._snapshot import load_snapshot
    from strands.types._snapshot import SNAPSHOT_SCHEMA_VERSION, Snapshot

    def _graph():
        builder = GraphBuilder()
        builder.add_node(Agent(model=_model("done"), agent_id="n1"), "n1")
        builder.add_node(Agent(model=_model("done"), agent_id="n2"), "n2")
        builder.add_edge("n1", "n2")
        builder.set_entry_point("n1")
        builder.set_graph_id("g1")
        return builder.build()

    mid_run_state = {
        "type": "graph",
        "id": "g1",
        "status": "executing",
        "completed_nodes": ["n1"],
        "failed_nodes": [],
        "interrupted_nodes": [],
        "node_results": {},
        "next_nodes_to_execute": ["n2"],
        "current_task": "go",
        "execution_order": ["n1"],
        "accumulated_usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
        "accumulated_metrics": {"latencyMs": 5},
        "execution_count": 1,
        "execution_time": 5,
    }
    snapshot = Snapshot(
        scope="multiAgent",
        schema_version=SNAPSHOT_SCHEMA_VERSION,
        data={"orchestrator_id": "g1", "state": mid_run_state},
        app_data={},
    )

    graph = _graph()
    load_snapshot(graph, snapshot)

    assert {n.node_id for n in graph.state.completed_nodes} == {"n1"}
    assert graph.state.execution_count == 1
    assert graph.state.execution_time == 5


@pytest.mark.asyncio
async def test_multi_agent_restore_without_snapshot_runs_once():
    """A successful restore attempt with no snapshot is not repeated.

    Guards https://github.com/strands-agents/harness-sdk/issues/4396:
    restoration is complete after storage confirms that no checkpoint exists.
    """

    class CountingReadStorage(InMemoryStorage):
        def __init__(self):
            super().__init__()
            self.read_calls = 0

        async def read(self, key: str) -> bytes | None:
            self.read_calls += 1
            return await super().read(key)

    storage = CountingReadStorage()
    builder = GraphBuilder()
    builder.add_node(Agent(model=_model("first", "second"), agent_id="n1"), "n1")
    builder.set_entry_point("n1")
    builder.set_graph_id("g1")
    builder.set_session_manager(SnapshotSessionManager("mm", storage=storage))
    graph = builder.build()

    assert (await graph.invoke_async("first")).status == Status.COMPLETED
    assert (await graph.invoke_async("second")).status == Status.COMPLETED
    assert storage.read_calls == 1


@pytest.mark.asyncio
async def test_multi_agent_restore_retries_after_storage_failure():
    """A failed restore leaves the checkpoint intact and resumes only pending nodes.

    Guards https://github.com/strands-agents/harness-sdk/issues/4396:
    a transient restore failure must not suppress restoration on the next invocation.
    """
    from strands.hooks.events import BeforeNodeCallEvent
    from strands.types._snapshot import SNAPSHOT_SCHEMA_VERSION

    class FailOnceReadStorage(InMemoryStorage):
        def __init__(self):
            super().__init__()
            self.read_calls = 0

        async def read(self, key: str) -> bytes | None:
            self.read_calls += 1
            if self.read_calls == 1:
                raise RuntimeError("transient read failure")
            return await super().read(key)

    storage = FailOnceReadStorage()
    mid_run_state = {
        "type": "graph",
        "id": "g1",
        "status": "executing",
        "completed_nodes": ["n1"],
        "failed_nodes": [],
        "interrupted_nodes": [],
        "node_results": {},
        "next_nodes_to_execute": ["n2"],
        "current_task": "go",
        "execution_order": ["n1"],
        "accumulated_usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
        "accumulated_metrics": {"latencyMs": 5},
        "execution_count": 1,
        "execution_time": 5,
    }
    snapshot = Snapshot(
        scope="multiAgent",
        schema_version=SNAPSHOT_SCHEMA_VERSION,
        data={"orchestrator_id": "g1", "state": mid_run_state},
        app_data={},
    )
    storage_key = f"session/{_multi_agent_latest_key('mm', 'g1')}"
    snapshot_bytes = _serialize_snapshot(snapshot)
    await storage.write(storage_key, snapshot_bytes)

    manager = SnapshotSessionManager("mm", storage=storage)
    first_agent = Agent(model=_model("unexpected"), agent_id="n1")
    second_agent = Agent(model=_model("done"), agent_id="n2")
    builder = GraphBuilder()
    builder.add_node(first_agent, "n1")
    builder.add_node(second_agent, "n2")
    builder.add_edge("n1", "n2")
    builder.set_entry_point("n1")
    builder.set_graph_id("g1")
    builder.set_session_manager(manager)
    graph = builder.build()
    executed_nodes = []
    graph.add_hook(lambda event: executed_nodes.append(event.node_id), BeforeNodeCallEvent)

    with pytest.raises(RuntimeError, match="transient read failure"):
        await graph.invoke_async("go")

    assert await InMemoryStorage.read(storage, storage_key) == snapshot_bytes

    result = await graph.invoke_async("go")

    assert storage.read_calls == 2
    assert result.status == Status.COMPLETED
    assert executed_nodes == ["n2"]
    assert {node.node_id for node in graph.state.completed_nodes} == {"n1", "n2"}
    assert [node.node_id for node in graph.state.execution_order] == ["n1", "n2"]

    persisted = _deserialize_snapshot(await InMemoryStorage.read(storage, storage_key))
    assert set(persisted.data["state"]["completed_nodes"]) == {"n1", "n2"}
    assert persisted.data["state"]["next_nodes_to_execute"] == []

    await manager._on_before_multi_agent_invocation(BeforeMultiAgentInvocationEvent(source=graph))
    assert storage.read_calls == 2


def test_load_snapshot_rejects_orchestrator_id_mismatch(storage):
    """A snapshot is refused if loaded into an orchestrator with a different id."""
    from strands.multiagent._snapshot import load_snapshot, take_snapshot

    def _swarm(swarm_id):
        return Swarm(nodes=[Agent(model=_model("done"), agent_id="n1")], id=swarm_id)

    snapshot = take_snapshot(_swarm("sw1"))
    with pytest.raises(SnapshotException, match="orchestrator id mismatch"):
        load_snapshot(_swarm("other"), snapshot)


def test_load_snapshot_rejects_wrong_scope(storage):
    """An agent-scope snapshot is refused when loaded as a multi-agent one."""
    from strands.multiagent._snapshot import load_snapshot
    from strands.types._snapshot import SNAPSHOT_SCHEMA_VERSION, Snapshot

    agent_scoped = Snapshot(
        scope="agent",
        schema_version=SNAPSHOT_SCHEMA_VERSION,
        data={"orchestrator_id": "sw1", "state": {}},
        app_data={},
    )
    swarm = Swarm(nodes=[Agent(model=_model("done"), agent_id="n1")], id="sw1")
    with pytest.raises(SnapshotException, match="Expected snapshot scope 'multiAgent'"):
        load_snapshot(swarm, agent_scoped)


def test_completed_orchestrator_reinvokes_from_scratch(storage):
    """A completed run persists an empty resume frontier, so restoring it re-runs from the start.

    Guards the issue's completed-then-reinvoked case: a terminal snapshot must not leave the
    orchestrator mid-run on the next invocation.
    """
    from strands.multiagent._snapshot import load_snapshot, take_snapshot

    def _swarm():
        agent = Agent(model=_model("done"), agent_id="n1")
        return Swarm(nodes=[agent], id="sw1"), agent

    source, _ = _swarm()
    asyncio.run(source.invoke_async("go"))
    assert take_snapshot(source).data["state"]["next_nodes_to_execute"] == []

    restored, restored_agent = _swarm()
    load_snapshot(restored, take_snapshot(source))
    result = asyncio.run(restored.invoke_async("go again"))

    assert result.status == Status.COMPLETED
    assert restored.state.task == "go again"
    assert "User Request: go again" in "\n".join(_texts(restored_agent))


def test_invocation_strategy_does_not_register_node_hook(storage):
    """Under ``multi_agent_save_latest_on='invocation'`` the per-node save hook is not registered."""
    manager = SnapshotSessionManager("mm", storage=storage, multi_agent_save_latest_on="invocation")
    registered: list[type] = []
    orchestrator = Mock()
    orchestrator.add_hook = lambda callback, event_type: registered.append(event_type)

    manager._init_multi_agent(MultiAgentInitializedEvent(orchestrator))

    assert AfterNodeCallEvent not in registered
    assert BeforeMultiAgentInvocationEvent in registered
    assert AfterMultiAgentInvocationEvent in registered


def test_node_strategy_registers_node_hook(storage):
    """Under the default ``'node'`` strategy the per-node save hook is registered."""
    manager = SnapshotSessionManager("mm", storage=storage)
    registered: list[type] = []
    orchestrator = Mock()
    orchestrator.add_hook = lambda callback, event_type: registered.append(event_type)

    manager._init_multi_agent(MultiAgentInitializedEvent(orchestrator))

    assert AfterNodeCallEvent in registered


def test_multi_agent_requires_storage_in_constructor(storage):
    """An orchestrator has no agent to resolve storage from, so it must be given in the constructor."""
    with pytest.raises(RuntimeError, match="requires a storage backend for multi-agent"):
        Swarm(
            nodes=[Agent(model=_model("done"), agent_id="n1")],
            session_manager=SnapshotSessionManager("sw1"),
            id="sw1",
        )


def test_unknown_multi_agent_save_latest_on_is_rejected(storage):
    """A mistyped multi_agent_save_latest_on is rejected rather than silently registering no hooks."""
    with pytest.raises(ValueError, match="multi_agent_save_latest_on must be one of"):
        SnapshotSessionManager("s1", storage=storage, multi_agent_save_latest_on="Node")  # type: ignore[arg-type]


def test_child_agent_session_manager_still_blocked(storage):
    """Child agents inside a Graph still may not carry their own session manager."""
    builder = GraphBuilder()
    child = Agent(model=_model("hi"), agent_id="n1", session_manager=SnapshotSessionManager("child", storage=storage))
    with pytest.raises(ValueError, match="not supported for Graph"):
        builder.add_node(child, "n1")


def test_raising_snapshot_trigger_still_saves_latest(storage):
    """A snapshot_trigger that raises does not discard the completed turn's latest save."""

    def boom(*, agent_data, **kwargs):
        raise RuntimeError("trigger blew up")

    manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=boom)
    agent = Agent(model=_model("saved"), session_manager=manager, agent_id="a1")
    agent("go")  # trigger raises here, but the invocation-end latest save must still happen

    manager_2 = SnapshotSessionManager("s1", storage=storage)
    agent_2 = Agent(model=_model("x"), session_manager=manager_2, agent_id="a1")
    tru_texts = [content["text"] for message in agent_2.messages for content in message["content"] if "text" in content]
    assert "go" in tru_texts  # the turn survived despite the raising trigger


def test_raising_snapshot_trigger_still_saves_latest_under_trigger_strategy(storage):
    """Under ``save_latest_on="trigger"`` a raising trigger must not lose the turn entirely.

    The trigger is the only save under this strategy, so a failing trigger has to fall back to a
    latest save; otherwise the whole invocation is silently dropped with only a log line.
    """

    def boom(*, agent_data, **kwargs):
        raise RuntimeError("trigger blew up")

    manager = SnapshotSessionManager("s1", storage=storage, save_latest_on="trigger", snapshot_trigger=boom)
    agent = Agent(model=_model("saved"), session_manager=manager, agent_id="a1")
    agent("go")

    manager_2 = SnapshotSessionManager("s1", storage=storage, save_latest_on="trigger")
    agent_2 = Agent(model=_model("x"), session_manager=manager_2, agent_id="a1")
    tru_texts = [content["text"] for message in agent_2.messages for content in message["content"] if "text" in content]
    assert "go" in tru_texts


@pytest.mark.asyncio
async def test_empty_session_id_cannot_delete_other_sessions(temp_dir):
    """Guard against the destructive prefix broadening: an empty id must not reach delete_session."""
    storage = LocalFileStorage(temp_dir)
    # Populate an unrelated, real session.
    other = SnapshotSessionManager("real-session", storage=storage)
    Agent(model=_model("hi"), session_manager=other, agent_id="a1")("keep me")
    assert await storage.read(_on_disk_key("real-session", "a1")) is not None

    # Constructing with an empty id must fail rather than yield a manager whose delete_session
    # would list/delete the whole "session/" namespace (every session).
    with pytest.raises(ValueError, match="not a valid session identifier"):
        SnapshotSessionManager("", storage=storage)

    # The unrelated session is untouched.
    assert await storage.read(_on_disk_key("real-session", "a1")) is not None


def test_restore_across_instances(storage):
    """A fresh agent with the same session id rehydrates prior conversation."""
    manager = SnapshotSessionManager("s1", storage=storage)
    agent = Agent(model=_model("The answer is 42."), session_manager=manager, agent_id="a1")
    agent("What is the answer?")

    # Simulate process restart: new manager + new agent over the same storage.
    manager_2 = SnapshotSessionManager("s1", storage=storage)
    agent_2 = Agent(model=_model("Still 42."), session_manager=manager_2, agent_id="a1")

    tru_texts = [content["text"] for message in agent_2.messages for content in message["content"] if "text" in content]
    assert "What is the answer?" in tru_texts
    assert "The answer is 42." in tru_texts


def test_restore_warns_on_overwrite(storage, caplog):
    """Restoring over an agent that already had messages logs a warning."""
    manager = SnapshotSessionManager("s1", storage=storage)
    agent = Agent(model=_model("saved"), session_manager=manager, agent_id="a1")
    agent("first turn")

    manager_2 = SnapshotSessionManager("s1", storage=storage)
    Agent(
        model=_model("x"),
        session_manager=manager_2,
        agent_id="a1",
        messages=[{"role": "user", "content": [{"text": "pre-existing"}]}],
    )

    assert "overwritten by session restore" in caplog.text


def test_state_round_trips(storage):
    """Agent state persists and restores across instances."""
    manager = SnapshotSessionManager("s1", storage=storage)
    agent = Agent(model=_model("ok"), session_manager=manager, agent_id="a1")
    agent.state.set("favorite", "blue")
    agent("remember my favorite")

    manager_2 = SnapshotSessionManager("s1", storage=storage)
    agent_2 = Agent(model=_model("ok"), session_manager=manager_2, agent_id="a1")

    assert agent_2.state.get("favorite") == "blue"


def test_system_prompt_round_trips(storage):
    """The system prompt persists and restores (session preset opt-in)."""
    manager = SnapshotSessionManager("s1", storage=storage)
    agent = Agent(
        model=_model("ok"), session_manager=manager, agent_id="a1", system_prompt="You are a helpful assistant."
    )
    agent("hi")

    manager_2 = SnapshotSessionManager("s1", storage=storage)
    agent_2 = Agent(model=_model("ok"), session_manager=manager_2, agent_id="a1")

    assert agent_2.system_prompt == "You are a helpful assistant."


def test_bytes_content_round_trips(storage):
    """Image bytes in messages survive JSON serialization via base64 encoding."""
    manager = SnapshotSessionManager("s1", storage=storage)
    agent = Agent(model=_model("saw it"), session_manager=manager, agent_id="a1")
    image_block: ContentBlock = {"image": {"format": "png", "source": {"bytes": b"\x89PNG\r\n\x1a\n"}}}
    agent([image_block])

    manager_2 = SnapshotSessionManager("s1", storage=storage)
    agent_2 = Agent(model=_model("x"), session_manager=manager_2, agent_id="a1")

    tru_bytes = agent_2.messages[0]["content"][0]["image"]["source"]["bytes"]
    assert tru_bytes == b"\x89PNG\r\n\x1a\n"


@pytest.mark.asyncio
async def test_save_latest_on_message_writes_each_message(temp_dir):
    """The ``message`` strategy persists after every message added."""
    storage = LocalFileStorage(temp_dir)
    save_keys = []
    original = storage.write

    async def _spy(key, data, **kwargs):
        save_keys.append(key)
        await original(key, data, **kwargs)

    storage.write = _spy  # type: ignore[method-assign]

    manager = SnapshotSessionManager("s1", storage=storage, save_latest_on="message")
    agent = Agent(model=_model("reply"), session_manager=manager, agent_id="a1")
    save_keys.clear()
    await agent.invoke_async("hello")

    # Two messages added (user + assistant) each trigger a per-message save, plus one final
    # invocation-end save that captures post-conversation-management state.
    assert len(save_keys) == 3
    assert all(key.endswith("snapshot_latest.json") for key in save_keys)


@pytest.mark.asyncio
async def test_message_mode_persists_post_management_state(temp_dir):
    """``message`` mode restores the trimmed conversation, not the pre-management one.

    The Agent runs conversation management after the last MessageAddedEvent but before the
    AfterInvocationEvent, so per-message saves alone would persist untrimmed messages and a
    stale removed_message_count.
    """
    storage = LocalFileStorage(temp_dir)
    manager = SnapshotSessionManager("s1", storage=storage, save_latest_on="message")
    agent = Agent(
        model=_model("a1", "a2"),
        session_manager=manager,
        agent_id="a1",
        conversation_manager=SlidingWindowConversationManager(window_size=2),
    )
    agent("u1")
    agent("u2")

    # The live agent has been trimmed to the window and tracks the removed count.
    assert agent.conversation_manager.removed_message_count > 0
    live_texts = [content["text"] for message in agent.messages for content in message["content"] if "text" in content]

    manager_2 = SnapshotSessionManager("s1", storage=storage, save_latest_on="message")
    agent_2 = Agent(
        model=_model("x"),
        session_manager=manager_2,
        agent_id="a1",
        conversation_manager=SlidingWindowConversationManager(window_size=2),
    )
    restored_texts = [
        content["text"] for message in agent_2.messages for content in message["content"] if "text" in content
    ]

    assert restored_texts == live_texts
    assert agent_2.conversation_manager.removed_message_count == agent.conversation_manager.removed_message_count


@pytest.mark.asyncio
async def test_invocation_strategy_saves_once_not_per_message(temp_dir):
    """The default ``invocation`` strategy saves once at invocation end, not per message."""
    storage = LocalFileStorage(temp_dir)
    save_keys = []
    original = storage.write

    async def _spy(key, data, **kwargs):
        save_keys.append(key)
        await original(key, data, **kwargs)

    storage.write = _spy  # type: ignore[method-assign]

    # Default save_latest_on="invocation": MessageAddedEvent must not be registered.
    manager = SnapshotSessionManager("s1", storage=storage)
    agent = Agent(model=_model("reply"), session_manager=manager, agent_id="a1")
    save_keys.clear()
    await agent.invoke_async("hello")

    # One save at invocation end, despite two messages being added during the turn.
    assert len(save_keys) == 1
    assert save_keys[0].endswith("snapshot_latest.json")


def test_snapshot_trigger_creates_immutable(storage):
    """When the trigger fires, an immutable snapshot is appended."""
    manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=lambda *, agent_data, **_: True)
    agent = Agent(model=_model("turn one"), session_manager=manager, agent_id="a1")
    agent("go")

    ids = asyncio.run(manager.list_snapshot_ids(agent))
    assert len(ids) == 1


@pytest.mark.asyncio
async def test_save_snapshot_forces_immutable_checkpoint_without_a_trigger(storage):
    """save_snapshot(is_latest=False) appends an immutable checkpoint on demand and is restorable."""
    manager = SnapshotSessionManager("s1", storage=storage)  # no snapshot_trigger
    agent = Agent(model=_model("first", "second"), session_manager=manager, agent_id="a1")
    agent("turn 1")

    # No trigger fired, so nothing immutable exists yet.
    assert await manager.list_snapshot_ids(agent) == []

    checkpoint_id = await manager.save_snapshot(agent, is_latest=False)
    agent("turn 2")

    ids = await manager.list_snapshot_ids(agent)
    assert len(ids) == 1  # the manual checkpoint, not the second turn
    assert checkpoint_id == ids[0]  # the returned id addresses the snapshot just written

    # The returned id restores that checkpoint directly, with no list_snapshot_ids round trip.
    restored = SnapshotSessionManager("s1", storage=storage)
    agent_2 = Agent(model=_model("x"), session_manager=restored, agent_id="a1")
    assert await restored.restore_snapshot(agent_2, snapshot_id=checkpoint_id) is True
    tru_texts = [content["text"] for message in agent_2.messages for content in message["content"] if "text" in content]
    assert "turn 1" in tru_texts
    assert "turn 2" not in tru_texts


@pytest.mark.asyncio
async def test_save_snapshot_is_latest_overwrites_latest_only(storage):
    """save_snapshot(is_latest=True) overwrites snapshot_latest and appends no immutable snapshot."""
    manager = SnapshotSessionManager("s1", storage=storage, save_latest_on="trigger")
    agent = Agent(model=_model("only turn"), session_manager=manager, agent_id="a1")
    agent("go")

    assert await manager.save_snapshot(agent, is_latest=True) is None  # latest has no id

    assert await manager.list_snapshot_ids(agent) == []
    assert await storage.read(_on_disk_key("s1", "a1")) is not None


@pytest.mark.asyncio
async def test_triggered_turn_captures_and_writes_latest_once(temp_dir):
    """A triggered turn under ``invocation`` writes latest once (immutable + latest), not twice."""
    storage = LocalFileStorage(temp_dir)
    latest_writes = []
    original = storage.write

    async def _spy(key, data, **kwargs):
        if key.endswith("snapshot_latest.json"):
            latest_writes.append(key)
        await original(key, data, **kwargs)

    storage.write = _spy  # type: ignore[method-assign]

    # Default save_latest_on="invocation" with a trigger that always fires.
    manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=lambda *, agent_data, **_: True)
    agent = Agent(model=_model("reply"), session_manager=manager, agent_id="a1")
    latest_writes.clear()
    await agent.invoke_async("go")

    # The immutable+latest write subsumes the invocation save: one latest write, not two.
    assert len(latest_writes) == 1
    ids = await manager.list_snapshot_ids(agent)
    assert len(ids) == 1


def test_time_travel_restore(storage):
    """restore_snapshot rewinds an agent to an earlier immutable checkpoint."""
    manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=lambda *, agent_data, **_: True)
    agent = Agent(model=_model("first", "second"), session_manager=manager, agent_id="a1")
    agent("turn 1")
    agent("turn 2")

    ids = asyncio.run(manager.list_snapshot_ids(agent))
    assert len(ids) == 2

    restored = asyncio.run(manager.restore_snapshot(agent, snapshot_id=ids[0]))
    assert restored is True

    tru_texts = [content["text"] for message in agent.messages for content in message["content"] if "text" in content]
    assert "turn 1" in tru_texts
    assert "turn 2" not in tru_texts


@pytest.mark.asyncio
async def test_restore_snapshot_without_id_restores_latest(storage):
    """Omitting snapshot_id restores ``snapshot_latest``, undoing an in-memory time-travel rewind."""
    manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=lambda *, agent_data, **_: True)
    agent = Agent(model=_model("first", "second"), session_manager=manager, agent_id="a1")
    agent("turn 1")
    agent("turn 2")

    ids = await manager.list_snapshot_ids(agent)
    assert await manager.restore_snapshot(agent, snapshot_id=ids[0]) is True  # rewind to turn 1
    assert "turn 2" not in _texts(agent)

    # No id: back to latest, which still holds both turns.
    assert await manager.restore_snapshot(agent) is True
    tru_texts = _texts(agent)
    assert "turn 1" in tru_texts
    assert "turn 2" in tru_texts


@pytest.mark.asyncio
async def test_restore_snapshot_without_id_returns_false_for_new_session(storage):
    """Omitting snapshot_id on a session that has never been saved reports no snapshot."""
    manager = SnapshotSessionManager("never-saved", storage=storage)
    agent = Agent(model=_model("hi"), agent_id="a1")

    assert await manager.restore_snapshot(agent) is False


def _stateful_model(*texts):
    """Build a mock model that reports itself as stateful (server-managed history)."""
    model = _model(*texts)
    # Stateful models manage conversation history server-side; the constructor swaps in a
    # NullConversationManager for them, so both the saved and restored agents match.
    object.__setattr__(model, "_force_stateful", True)
    type(model).stateful = property(lambda self: getattr(self, "_force_stateful", False))
    return model


def test_stateful_model_discards_restored_messages(storage):
    """Restore keeps model_state but drops messages for a stateful model."""
    original = _stateful_model("hi")
    try:
        manager = SnapshotSessionManager("s1", storage=storage)
        agent = Agent(model=original, session_manager=manager, agent_id="a1")
        # Persist a snapshot that contains messages (a stateful model normally clears
        # local history mid-turn, so set them explicitly to exercise the discard branch).
        agent.messages = [{"role": "user", "content": [{"text": "hello"}]}]
        manager.sync_agent(agent)

        manager_2 = SnapshotSessionManager("s1", storage=storage)
        agent_2 = Agent(model=_stateful_model("x"), session_manager=manager_2, agent_id="a1")
        assert agent_2.messages == []
    finally:
        del type(original).stateful


def test_redaction_flush_persists_redacted_content(temp_dir):
    """A guardrail redaction is flushed to the latest snapshot immediately."""
    storage = LocalFileStorage(temp_dir)
    manager = SnapshotSessionManager("s1", storage=storage)
    redaction_model = MockedModelProvider(
        [{"redactedUserContent": "REDACTED", "redactedAssistantContent": "I can't help with that."}]
    )
    agent = Agent(model=redaction_model, session_manager=manager, agent_id="a1")
    agent("sensitive prompt")

    manager_2 = SnapshotSessionManager("s1", storage=storage)
    agent_2 = Agent(model=_model("x"), session_manager=manager_2, agent_id="a1")

    tru_texts = [content["text"] for message in agent_2.messages for content in message["content"] if "text" in content]
    assert "sensitive prompt" not in tru_texts
    assert "REDACTED" in tru_texts


@pytest.mark.asyncio
async def test_delete_session_removes_snapshots(storage):
    """delete_session clears persisted snapshots."""
    manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=lambda *, agent_data, **_: True)
    agent = Agent(model=_model("hi"), session_manager=manager, agent_id="a1")
    agent("go")

    # Seed a key under the session's namespace to confirm delete clears the whole subtree.
    assert await storage.read(_on_disk_key("s1", "a1")) is not None

    await manager.delete_session()

    assert await storage.read(_on_disk_key("s1", "a1")) is None
    assert await storage.list(f"session/{_session_prefix('s1')}") == []


def test_restore_by_id_missing_returns_false(storage):
    """Restoring a non-existent immutable snapshot returns False."""
    manager = SnapshotSessionManager("s1", storage=storage)
    agent = Agent(model=_model("hi"), session_manager=manager, agent_id="a1")

    assert asyncio.run(manager.restore_snapshot(agent, snapshot_id=_new_snapshot_id())) is False


def test_trigger_strategy_skips_latest_without_trigger(temp_dir):
    """Under ``trigger`` strategy with no trigger, nothing is persisted on invocation."""
    storage = LocalFileStorage(temp_dir)
    storage.write = AsyncMock()  # type: ignore[method-assign]

    manager = SnapshotSessionManager("s1", storage=storage, save_latest_on="trigger")
    agent = Agent(model=_model("hi"), session_manager=manager, agent_id="a1")
    storage.write.reset_mock()
    agent("go")

    storage.write.assert_not_called()


def test_no_warning_when_restoring_into_empty_agent(storage, caplog):
    """Restoring into a fresh agent with no messages does not log the overwrite warning."""
    manager = SnapshotSessionManager("s1", storage=storage)
    agent = Agent(model=_model("saved"), session_manager=manager, agent_id="a1")
    agent("first turn")

    # The second agent starts empty, so restore should populate it silently.
    manager_2 = SnapshotSessionManager("s1", storage=storage)
    agent_2 = Agent(model=_model("x"), session_manager=manager_2, agent_id="a1")

    assert len(agent_2.messages) > 0
    assert "overwritten by session restore" not in caplog.text


class _OverflowThenAnswerModel(MockedModelProvider):
    """A model that raises a context-overflow on its first stream, then answers normally.

    This drives the Agent's reactive overflow-recovery path (reduce_context), which in turn
    makes the direct ``session_manager.sync_agent`` call at the overflow catch site.
    """

    def __init__(self, *texts):
        super().__init__([{"role": "assistant", "content": [{"text": text}]} for text in texts])
        self._overflowed = False

    async def stream(self, *args, **kwargs):
        if not self._overflowed:
            self._overflowed = True
            raise ContextWindowOverflowException("Input is too long for requested model")
        async for event in super().stream(*args, **kwargs):
            yield event


def test_context_overflow_syncs_reduced_conversation(storage):
    """A context-window overflow persists the reduced conversation via the direct sync_agent call.

    On ContextWindowOverflowException the Agent calls ``session_manager.sync_agent(agent)``
    directly (outside the hook system) after trimming context. To prove this specific path —
    and not the invocation-end save — the manager runs under ``save_latest_on="trigger"`` with
    no trigger, so ``_on_after_invocation`` writes nothing and ``MessageAddedEvent`` is not
    registered. The only thing that can persist ``snapshot_latest`` is the overflow-time
    ``sync_agent``. Deleting the direct call at the overflow catch site would fail this test.
    """
    # window_size=2 forces the reactive trim to actually drop the seeded backlog.
    conversation_manager = SlidingWindowConversationManager(window_size=2)
    manager = SnapshotSessionManager("s1", storage=storage, save_latest_on="trigger")

    sync_calls = []
    original_sync = manager.sync_agent

    def _spy_sync(agent, **kwargs):
        sync_calls.append(len(agent.messages))
        return original_sync(agent, **kwargs)

    manager.sync_agent = _spy_sync  # type: ignore[method-assign]

    seeded = [
        {"role": "user", "content": [{"text": "one"}]},
        {"role": "assistant", "content": [{"text": "1"}]},
        {"role": "user", "content": [{"text": "two"}]},
        {"role": "assistant", "content": [{"text": "2"}]},
    ]
    agent = Agent(
        model=_OverflowThenAnswerModel("recovered."),
        session_manager=manager,
        agent_id="a1",
        conversation_manager=conversation_manager,
        messages=seeded,
    )
    agent("three")

    # The overflow catch site invoked sync_agent exactly once, on the trimmed conversation.
    assert len(sync_calls) == 1

    # A fresh instance restores only what the overflow-path sync persisted: the reduced
    # window, not the full seeded backlog (proving the reduced conversation was the thing saved).
    manager_2 = SnapshotSessionManager("s1", storage=storage, save_latest_on="trigger")
    agent_2 = Agent(
        model=_model("x"),
        session_manager=manager_2,
        agent_id="a1",
        conversation_manager=SlidingWindowConversationManager(window_size=2),
    )

    tru_texts = [content["text"] for message in agent_2.messages for content in message["content"] if "text" in content]
    assert "one" not in tru_texts  # the oldest seeded messages were trimmed before the sync
    assert tru_texts  # but the reduced conversation was persisted (not empty)


def test_redaction_flushes_even_under_trigger_strategy(temp_dir):
    """A guardrail redaction is flushed immediately even under the ``trigger`` strategy.

    This is a deliberate divergence from the TypeScript SDK. TS gates its redaction flush on an
    AfterModelCall hook that it does not register under ``saveLatestOn: 'trigger'``, so TS does not
    flush redactions under that strategy. Python has no redaction signal on AfterModelCallEvent;
    redaction arrives through the Agent's direct ``redact_latest_message`` call, which always
    persists so pre-redaction content never sits at rest. We assert the safer always-flush here.
    """
    storage = LocalFileStorage(temp_dir)
    manager = SnapshotSessionManager("s1", storage=storage, save_latest_on="trigger")
    redaction_model = MockedModelProvider(
        [{"redactedUserContent": "REDACTED", "redactedAssistantContent": "I can't help with that."}]
    )
    agent = Agent(model=redaction_model, session_manager=manager, agent_id="a1")
    agent("sensitive prompt")

    manager_2 = SnapshotSessionManager("s1", storage=storage, save_latest_on="trigger")
    agent_2 = Agent(model=_model("x"), session_manager=manager_2, agent_id="a1")

    tru_texts = [content["text"] for message in agent_2.messages for content in message["content"] if "text" in content]
    assert "sensitive prompt" not in tru_texts
    assert "REDACTED" in tru_texts


def test_snapshot_trigger_returning_false_appends_nothing(storage):
    """A present trigger that returns False creates no immutable snapshot and receives the agent."""
    seen_agents = []

    def trigger(*, agent_data, **kwargs):
        seen_agents.append(agent_data)
        return False

    manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=trigger)
    agent = Agent(model=_model("hi"), session_manager=manager, agent_id="a1")
    agent("go")

    assert asyncio.run(manager.list_snapshot_ids(agent)) == []
    # The trigger was invoked with the agent as the agent_data keyword argument.
    assert seen_agents and seen_agents[0] is agent


@pytest.mark.asyncio
async def test_list_snapshot_ids_pagination(storage):
    """limit and start_after page the immutable id list; invalid start_after raises."""
    manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=lambda *, agent_data, **_: True)
    agent = Agent(model=_model("a", "b", "c"), session_manager=manager, agent_id="a1")
    agent("one")
    agent("two")
    agent("three")

    all_ids = await manager.list_snapshot_ids(agent)
    assert len(all_ids) == 3
    assert all_ids == sorted(all_ids)

    # guards against a malformed key sorting ahead of valid ids and displacing them from a
    # limited page (#4198); "000-bad" sorts before every real UUIDv7 id
    history_prefix = "session/s1/scopes/agent/a1/snapshots/immutable_history/"
    await storage.write(f"{history_prefix}snapshot_000-bad.json", b"invalid")
    assert await manager.list_snapshot_ids(agent) == all_ids

    assert await manager.list_snapshot_ids(agent, limit=2) == all_ids[:2]
    assert await manager.list_snapshot_ids(agent, limit=0) == []
    assert await manager.list_snapshot_ids(agent, start_after=all_ids[0]) == all_ids[1:]

    with pytest.raises(ValueError, match="not a valid snapshot id"):
        await manager.list_snapshot_ids(agent, start_after="not-an-id")


@pytest.mark.asyncio
async def test_restore_snapshot_rejects_malformed_id(storage):
    """restore_snapshot with a malformed id raises rather than silently missing."""
    manager = SnapshotSessionManager("s1", storage=storage)
    agent = Agent(model=_model("hi"), session_manager=manager, agent_id="a1")

    with pytest.raises(ValueError, match="not a valid snapshot id"):
        await manager.restore_snapshot(agent, snapshot_id="../escape")


@pytest.mark.asyncio
async def test_delete_session_is_scoped_to_its_own_session(temp_dir):
    """delete_session removes only its session, leaving other sessions and keys intact."""
    storage = LocalFileStorage(temp_dir)

    manager_a = SnapshotSessionManager("sess-a", storage=storage)
    Agent(model=_model("a"), session_manager=manager_a, agent_id="a1")("hi")
    manager_b = SnapshotSessionManager("sess-b", storage=storage)
    Agent(model=_model("b"), session_manager=manager_b, agent_id="a1")("hi")
    # An unrelated key from another subsystem sharing the same storage.
    await storage.write("memory/note.json", b"keep me")

    await manager_a.delete_session()

    assert await storage.read(_on_disk_key("sess-a", "a1")) is None
    assert await storage.read(_on_disk_key("sess-b", "a1")) is not None
    assert await storage.read("memory/note.json") == b"keep me"


def test_stateful_model_restore_keeps_model_state(storage):
    """Restoring a stateful-model session drops messages but preserves model_state."""
    original = _stateful_model("hi")
    try:
        manager = SnapshotSessionManager("s1", storage=storage)
        agent = Agent(model=original, session_manager=manager, agent_id="a1")
        agent.messages = [{"role": "user", "content": [{"text": "hello"}]}]
        agent._model_state = {"response_id": "resp-123"}
        manager.sync_agent(agent)

        manager_2 = SnapshotSessionManager("s1", storage=storage)
        agent_2 = Agent(model=_stateful_model("x"), session_manager=manager_2, agent_id="a1")

        assert agent_2.messages == []  # messages dropped for the stateful model
        assert agent_2._model_state == {"response_id": "resp-123"}  # but model_state survives
    finally:
        del type(original).stateful


@pytest.mark.asyncio
async def test_raw_storage_is_namespaced_under_session(temp_dir):
    """Raw storage is auto-namespaced under 'session/', matching the TS key layout."""
    storage = LocalFileStorage(temp_dir)
    manager = SnapshotSessionManager("sid", storage=storage)
    Agent(model=_model("hi"), session_manager=manager, agent_id="a1")("go")

    keys = await storage.list("")
    assert keys == ["session/sid/scopes/agent/a1/snapshots/snapshot_latest.json"]


@pytest.mark.asyncio
async def test_prenamespaced_storage_is_not_double_prefixed(temp_dir):
    """A caller-namespaced view is used as-is; its 'session' prefix is not doubled."""
    storage = LocalFileStorage(temp_dir)
    scoped = storage.namespace("session")  # caller pre-namespaces under the same prefix
    manager = SnapshotSessionManager("sid", storage=scoped)
    Agent(model=_model("hi"), session_manager=manager, agent_id="a1")("go")

    # On raw storage the key is session/sid/... — a single "session/", not session/session/...
    keys = await storage.list("")
    assert keys == ["session/sid/scopes/agent/a1/snapshots/snapshot_latest.json"]


def test_snapshot_ids_are_monotonic_uuidv7(storage):
    """Immutable ids are UUIDv7 and sort in creation order even within one millisecond."""
    manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=lambda *, agent_data, **_: True)
    agent = Agent(model=_model(*[f"t{index}" for index in range(6)]), session_manager=manager, agent_id="a1")
    for index in range(6):
        agent(f"turn {index}")

    ids = asyncio.run(manager.list_snapshot_ids(agent))
    assert len(ids) == 6
    assert all(uuid.UUID(snapshot_id).version == 7 for snapshot_id in ids)
    # list_snapshot_ids sorts lexicographically; that must equal creation order.
    assert ids == sorted(ids)


@pytest.mark.asyncio
async def test_corrupt_snapshot_raises_typed_error_on_restore(temp_dir):
    """A corrupt/truncated stored snapshot surfaces a typed SnapshotException, not a raw decode error.

    Restore runs in the agent constructor, so a partially written or tampered blob would
    otherwise crash construction with a JSONDecodeError leaking out of the session manager.
    """
    storage = LocalFileStorage(temp_dir)
    await storage.write(f"session/{_snapshot_key('s1', 'a1', snapshot_id=None)}", b'{"scope": "agent", "data": {')

    with pytest.raises(SnapshotException, match="Failed to deserialize snapshot"):
        Agent(model=_model("hi"), session_manager=SnapshotSessionManager("s1", storage=storage), agent_id="a1")


@pytest.mark.parametrize(
    "blob",
    [
        b"{}",  # object missing required keys -> KeyError in Snapshot.from_dict
        b"42",  # non-object scalar -> would AttributeError on .get()
        b'"a string"',
        b"[]",
        b"null",
    ],
)
@pytest.mark.asyncio
async def test_wrong_shape_snapshot_raises_typed_error_on_restore(temp_dir, blob):
    """A valid-JSON but wrong-shape stored snapshot surfaces a typed SnapshotException.

    Valid JSON that is not a well-formed snapshot (missing keys, or a non-object scalar/array)
    must not leak a raw KeyError/AttributeError out of the agent constructor's restore path.
    """
    storage = LocalFileStorage(temp_dir)
    await storage.write(f"session/{_snapshot_key('s1', 'a1', snapshot_id=None)}", blob)

    with pytest.raises(SnapshotException):
        Agent(model=_model("hi"), session_manager=SnapshotSessionManager("s1", storage=storage), agent_id="a1")


# ---------------------------------------------------------------------------
# Stash integration
# ---------------------------------------------------------------------------


class TestSnapshotStashIntegration:
    """Tests for context-manager stash persistence through snapshots."""

    @pytest.mark.asyncio
    async def test_save_includes_inline_stash_for_ephemeral_storage(self, storage):
        """Agent with InMemoryStorage-backed stash → stash entries are inlined in the snapshot."""
        context_manager = ContextManager(stash={"storage": InMemoryStorage()})
        manager = SnapshotSessionManager("s1", storage=storage)
        agent = Agent(model=_model("hi"), session_manager=manager, context_manager=context_manager, agent_id="a1")
        agent("go")

        await context_manager.stash.load_snapshot({"ref-1": {"text": "stashed content"}})
        manager.sync_agent(agent)

        # Restore into a new agent and verify stash round-trips
        restored_context_manager = ContextManager(stash={"storage": InMemoryStorage()})
        manager2 = SnapshotSessionManager("s1", storage=storage)
        Agent(model=_model("x"), session_manager=manager2, context_manager=restored_context_manager, agent_id="a1")

        result = await restored_context_manager.stash.retrieve("ref-1")
        assert result == {"text": "stashed content"}

    @pytest.mark.asyncio
    async def test_save_writes_external_ref_for_durable_storage(self, temp_dir):
        """Agent with durable stash storage → snapshot carries an external reference, not inline data."""
        stash_storage = LocalFileStorage(f"{temp_dir}/stash")
        context_manager = ContextManager(stash={"storage": stash_storage})
        session_storage = LocalFileStorage(f"{temp_dir}/session")
        manager = SnapshotSessionManager("s1", storage=session_storage)
        agent = Agent(model=_model("hi"), session_manager=manager, context_manager=context_manager, agent_id="a1")
        agent("go")

        await context_manager.stash.load_snapshot({"ref-1": {"text": "durable"}})
        manager.sync_agent(agent)

        # Read the raw snapshot and verify it has an external ref
        key = _on_disk_key("s1", "a1")
        raw = await session_storage.read(key)
        snapshot_data = json.loads(raw)
        stash_data = snapshot_data["data"].get("stash")
        assert stash_data is not None
        assert stash_data["location"] == "external"
        assert stash_data["storage_type"] == "LocalFileStorage"

    @pytest.mark.asyncio
    async def test_save_omits_stash_when_no_context_manager(self, storage):
        """Agent without ContextManager → snapshot has no stash key."""
        manager = SnapshotSessionManager("s1", storage=storage)
        agent = Agent(model=_model("hi"), session_manager=manager, agent_id="a1")
        agent("go")

        key = _on_disk_key("s1", "a1")
        raw = await storage.read(key)
        snapshot_data = json.loads(raw)
        assert "stash" not in snapshot_data["data"]

    @pytest.mark.asyncio
    async def test_save_omits_stash_when_empty(self, storage):
        """Agent with stash but no stored entries → no stash key in snapshot."""
        context_manager = ContextManager(stash={"storage": InMemoryStorage()})
        manager = SnapshotSessionManager("s1", storage=storage)
        agent = Agent(model=_model("hi"), session_manager=manager, context_manager=context_manager, agent_id="a1")
        agent("go")

        await context_manager.stash.clear()
        manager.sync_agent(agent)

        key = _on_disk_key("s1", "a1")
        raw = await storage.read(key)
        snapshot_data = json.loads(raw)
        assert "stash" not in snapshot_data["data"]

    def test_restore_warns_on_storage_type_mismatch(self, storage, caplog):
        """Restoring an external-ref snapshot with a different storage type logs a warning."""
        snapshot = Snapshot(
            scope="agent",
            schema_version="1.0",
            data={
                "messages": [],
                "state": {},
                "stash": {"location": "external", "storage_type": "S3Storage"},
            },
            app_data={},
        )
        key = _on_disk_key("s1", "a1")
        asyncio.run(storage.write(key, _serialize_snapshot(snapshot)))

        context_manager = ContextManager(stash={"storage": InMemoryStorage()})
        manager = SnapshotSessionManager("s1", storage=storage)
        with caplog.at_level(logging.WARNING, logger="strands.session.snapshot_session_manager"):
            Agent(model=_model("x"), session_manager=manager, context_manager=context_manager, agent_id="a1")

        assert any("stash storage type changed" in record.message for record in caplog.records)

    @pytest.mark.asyncio
    async def test_delete_session_clears_stash(self, temp_dir):
        """delete_session removes stash data in addition to snapshots."""
        session_storage = LocalFileStorage(f"{temp_dir}/session")
        stash_mem = InMemoryStorage()
        context_manager = ContextManager(stash={"storage": stash_mem})
        manager = SnapshotSessionManager("s1", storage=session_storage)
        agent = Agent(model=_model("hi"), session_manager=manager, context_manager=context_manager, agent_id="a1")
        agent("go")

        await context_manager.stash.load_snapshot({"ref-1": {"text": "data"}})
        assert await context_manager.stash.list() != []

        await manager.delete_session()

        assert await context_manager.stash.list() == []

    @pytest.mark.asyncio
    async def test_delete_session_without_initialize_clears_stash(self, temp_dir):
        """delete_session on an uninitialized manager still clears stash data via storage fallback."""
        shared_storage = LocalFileStorage(f"{temp_dir}/shared")
        context_manager = ContextManager(stash={"storage": shared_storage})
        manager = SnapshotSessionManager("s1", storage=shared_storage)
        agent = Agent(model=_model("hi"), session_manager=manager, context_manager=context_manager, agent_id="a1")
        agent("go")

        await context_manager.stash.load_snapshot({"ref-1": {"text": "orphan"}})
        assert await shared_storage.list("context/s1/") != []

        bare_manager = SnapshotSessionManager("s1", storage=shared_storage)
        await bare_manager.delete_session()

        assert await shared_storage.list("context/s1/") == []

    @pytest.mark.asyncio
    async def test_delete_session_keeps_shared_stash(self, temp_dir):
        """delete_session leaves a stash rooted at an explicitly configured scoped view in place."""
        team = InMemoryStorage().namespace("team")
        context_manager = ContextManager(stash={"storage": team})
        manager = SnapshotSessionManager("s1", storage=LocalFileStorage(f"{temp_dir}/session"))
        agent = Agent(model=_model("hi"), session_manager=manager, context_manager=context_manager, agent_id="a1")
        agent("go")
        await team.write("from-another-session_0", b'{"text": "keep"}')

        await manager.delete_session()

        assert "from-another-session_0" in await team.list("")

    @pytest.mark.asyncio
    async def test_delete_session_with_scoped_agent_storage_keeps_other_data(self, temp_dir):
        """A scoped agent.storage is shared with other subsystems, so delete_session removes only this session."""
        root = LocalFileStorage(temp_dir)
        tenant = root.namespace("tenant")
        await tenant.write("memory/prefs.json", b"{}")
        manager = SnapshotSessionManager("s1")
        agent = Agent(
            model=_model("hi"),
            storage=tenant,
            session_manager=manager,
            context_manager=ContextManager(),
            agent_id="a1",
        )
        agent("go")
        assert await tenant.list("context/s1/scopes/agent/a1/") != []

        await manager.delete_session()

        assert await root.list("") == ["tenant/memory/prefs.json"]

    def test_no_context_manager_save_restore_works(self, storage):
        """Save/restore works normally when no ContextManager is present."""
        manager = SnapshotSessionManager("s1", storage=storage)
        agent = Agent(model=_model("hi"), session_manager=manager, agent_id="a1")
        agent("go")

        manager2 = SnapshotSessionManager("s1", storage=storage)
        agent2 = Agent(model=_model("x"), session_manager=manager2, agent_id="a1")
        assert _texts(agent2) == _texts(agent)

    def test_restore_succeeds_when_stash_load_fails(self, storage):
        """A stash storage error during restore logs a warning but the agent is still restored."""
        context_manager = ContextManager(stash={"storage": InMemoryStorage()})
        manager = SnapshotSessionManager("s1", storage=storage)
        agent = Agent(model=_model("hi"), session_manager=manager, context_manager=context_manager, agent_id="a1")
        agent("go")

        asyncio.run(context_manager.stash.load_snapshot({"ref-1": {"text": "data"}}))
        manager.sync_agent(agent)

        restored_context_manager = ContextManager(stash={"storage": InMemoryStorage()})
        restored_context_manager._stash = Mock()
        restored_context_manager._stash.load_snapshot = AsyncMock(side_effect=RuntimeError("corrupted"))
        restored_context_manager._stash.storage_type_name = "InMemoryStorage"

        manager2 = SnapshotSessionManager("s1", storage=storage)
        agent2 = Agent(
            model=_model("x"), session_manager=manager2, context_manager=restored_context_manager, agent_id="a1"
        )
        assert _texts(agent2) == _texts(agent)

    @pytest.mark.asyncio
    async def test_immutable_snapshot_includes_stash(self, temp_dir):
        """A snapshot_trigger produces an immutable checkpoint with inline stash data."""
        session_storage = LocalFileStorage(f"{temp_dir}/session")
        context_manager = ContextManager(stash={"storage": InMemoryStorage()})
        manager = SnapshotSessionManager("s1", storage=session_storage, snapshot_trigger=lambda **_: True)
        agent = Agent(model=_model("hi"), session_manager=manager, context_manager=context_manager, agent_id="a1")

        await context_manager.stash.load_snapshot({"ref-1": {"text": "immutable data"}})
        agent("go")

        immutable_prefix = f"session/{_session_prefix('s1')}scopes/agent/a1/snapshots/immutable_history/"
        keys = await session_storage.list(immutable_prefix)
        assert len(keys) >= 1

        raw = await session_storage.read(keys[0])
        snapshot_data = json.loads(raw)
        assert snapshot_data["data"]["stash"]["location"] == "inline"
        assert "ref-1" in snapshot_data["data"]["stash"]["entries"]

    @pytest.mark.asyncio
    async def test_ephemeral_detection_survives_namespacing(self, storage):
        """An InMemoryStorage wrapped with .namespace() is still detected as ephemeral."""
        from strands.storage.storage import _NamespacedStorage

        namespaced = _NamespacedStorage(InMemoryStorage(), "tenant")
        context_manager = ContextManager(stash={"storage": namespaced})
        manager = SnapshotSessionManager("s1", storage=storage)
        agent = Agent(model=_model("hi"), session_manager=manager, context_manager=context_manager, agent_id="a1")
        agent("go")

        await context_manager.stash.load_snapshot({"ref-1": {"text": "wrapped ephemeral"}})
        manager.sync_agent(agent)

        key = _on_disk_key("s1", "a1")
        raw = await storage.read(key)
        snapshot_data = json.loads(raw)
        assert snapshot_data["data"]["stash"]["location"] == "inline"

    @pytest.mark.parametrize("stash_mode", ["inline", "durable"])
    def test_resume_keeps_original_of_truncated_tool_result_retrievable(self, storage, stash_mode):
        """After a resume, retrieve_context returns the full original of a tool result truncated before the restart."""
        full_result = "full tool result " * 2_000

        @tool
        def fetch_result() -> str:
            """Return a large result."""
            return full_result

        def build_agent(model):
            storage_options = {"storage": storage} if stash_mode == "durable" else {}
            return Agent(
                model=model,
                tools=[fetch_result],
                context_manager="auto",
                session_manager=SnapshotSessionManager("s1", storage=storage),
                agent_id="a1",
                callback_handler=None,
                **storage_options,
            )

        first_agent = build_agent(
            MockedModelProvider(
                [
                    {
                        "role": "assistant",
                        "content": [{"toolUse": {"toolUseId": "tu-1", "name": "fetch_result", "input": {}}}],
                    },
                    {"role": "assistant", "content": [{"text": "fetched"}]},
                ]
            )
        )
        first_agent("fetch")
        assert _tool_result_text(first_agent, "tu-1").startswith("[Truncated:")

        resumed_agent = build_agent(
            MockedModelProvider(
                [
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "toolUse": {
                                    "toolUseId": "tu-2",
                                    "name": "retrieve_context",
                                    "input": {"reference": "tu-1_0"},
                                }
                            }
                        ],
                    },
                    {"role": "assistant", "content": [{"text": "done"}]},
                ]
            )
        )
        resumed_agent("read it in full")

        assert json.loads(_tool_result_text(resumed_agent, "tu-2")) == {"text": full_result}
        assert asyncio.run(resumed_agent.context_manager.stash.retrieve("tu-1_0")) == {"text": full_result}


# ---------------------------------------------------------------------------
# BidiAgent persistence
# ---------------------------------------------------------------------------


def _bidi_model() -> AsyncMock:
    model = AsyncMock(spec=BidiModel)
    model.get_connection_config.return_value = {}
    model.stateful = False
    return model


def _bidi_agent(manager: SnapshotSessionManager, **kwargs) -> BidiAgent:
    return BidiAgent(model=_bidi_model(), session_manager=manager, agent_id="b1", **kwargs)


def _spy_writes(storage: LocalFileStorage) -> list[str]:
    save_keys: list[str] = []
    original = storage.write

    async def _spy(key, data, **kwargs):
        save_keys.append(key)
        await original(key, data, **kwargs)

    storage.write = _spy  # type: ignore[method-assign]
    return save_keys


@pytest.fixture(
    params=[BidiAgentStopEvent, partial(BidiBeforeConnectionRestartEvent, reason="scheduled")],
    ids=["stop", "restart"],
)
def bidi_save_event(request):
    return request.param


def test_bidi_agent_registers_stop_and_restart_hooks_not_response_hook(storage):
    agent = _bidi_agent(SnapshotSessionManager("s1", storage=storage))

    assert BidiAgentStopEvent in agent.hooks._registered_callbacks
    assert BidiBeforeConnectionRestartEvent in agent.hooks._registered_callbacks
    assert BidiAfterConnectionRestartEvent not in agent.hooks._registered_callbacks
    assert BidiResponseStopEvent not in agent.hooks._registered_callbacks


@pytest.mark.asyncio
async def test_bidi_agent_restores_across_instances_before_start(storage):
    agent = _bidi_agent(SnapshotSessionManager("s1", storage=storage), system_prompt="You are a voice assistant.")
    agent.state.set("favorite", "blue")
    await agent.start()
    await agent.send("What is the answer?")
    await agent.stop()

    agent_2 = _bidi_agent(SnapshotSessionManager("s1", storage=storage))
    started_messages = []
    agent_2.model.start.side_effect = lambda **kwargs: started_messages.extend(
        json.loads(json.dumps(kwargs["messages"]))
    )
    await agent_2.start()
    tru_start_kwargs = agent_2.model.start.call_args.kwargs
    await agent_2.stop()

    assert _texts(agent_2) == ["What is the answer?"]
    assert agent_2.state.get("favorite") == "blue"
    assert agent_2.system_prompt == "You are a voice assistant."
    assert [content["text"] for message in started_messages for content in message["content"]] == [
        "What is the answer?"
    ]
    assert tru_start_kwargs["system_prompt"] == "You are a voice assistant."


@pytest.mark.asyncio
async def test_bidi_agent_snapshot_contains_only_bidi_fields(storage):
    agent = _bidi_agent(SnapshotSessionManager("s1", storage=storage), system_prompt="prompt")
    await agent._append_messages({"role": "user", "content": [{"text": "hi"}]})
    await agent.hooks.invoke_callbacks_async(BidiAgentStopEvent(agent=agent))

    raw = await storage.read(_on_disk_key("s1", "b1"))
    tru_fields = set(_deserialize_snapshot(raw).data)
    exp_fields = {"messages", "state", "system_prompt"}
    assert tru_fields == exp_fields


@pytest.mark.asyncio
async def test_bidi_agent_stop_strategy_saves_once_at_stop_or_restart(temp_dir, bidi_save_event):
    storage = LocalFileStorage(temp_dir)
    save_keys = _spy_writes(storage)
    agent = _bidi_agent(SnapshotSessionManager("s1", storage=storage, bidi_agent_save_latest_on="stop"))
    save_keys.clear()

    await agent._append_messages({"role": "user", "content": [{"text": "one"}]})
    await agent._append_messages({"role": "assistant", "content": [{"text": "two"}]})
    assert save_keys == []

    await agent.hooks.invoke_callbacks_async(bidi_save_event(agent=agent))

    assert save_keys == [_on_disk_key("s1", "b1")]


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["scheduled", "timeout"])
@pytest.mark.parametrize("restart_fails", [False, True])
async def test_bidi_agent_stop_strategy_persists_restart_attempt(storage, reason, restart_fails):
    save_keys = _spy_writes(storage)
    manager = SnapshotSessionManager("s1", storage=storage, bidi_agent_save_latest_on="stop")
    agent = _bidi_agent(manager, system_prompt="Keep replies brief.")

    def record_restart(event):
        event.agent.state.set("restart_reason", event.reason)

    agent.add_hook(record_restart, BidiBeforeConnectionRestartEvent)
    snapshots_before_stop = []

    async def capture_before_stop():
        restored = _bidi_agent(SnapshotSessionManager("s1", storage=storage))
        snapshots_before_stop.append(
            {
                "writes": save_keys.copy(),
                "texts": _texts(restored),
                "state": restored.state.get(),
                "system_prompt": restored.system_prompt,
            }
        )

    timeout_error = ConnectionTimeoutError("connection expired") if reason == "timeout" else None
    await agent.start()
    try:
        await agent.send("Remember this conversation.")
        agent.model.stop.side_effect = capture_before_stop
        if restart_fails:
            agent.model.start.side_effect = RuntimeError("replacement failed")
            with pytest.raises(RuntimeError, match="replacement failed"):
                await agent._loop._restart_connection(timeout_error, agent._loop._generation)
        else:
            await agent._loop._restart_connection(timeout_error, agent._loop._generation)

        restored = _bidi_agent(SnapshotSessionManager("s1", storage=storage))
        tru_saved = {
            "writes": save_keys,
            "texts": _texts(restored),
            "state": restored.state.get(),
            "system_prompt": restored.system_prompt,
        }
        exp_saved = {
            "writes": [_on_disk_key("s1", "b1")],
            "texts": ["Remember this conversation."],
            "state": {"restart_reason": reason},
            "system_prompt": "Keep replies brief.",
        }
        assert tru_saved == exp_saved
        assert snapshots_before_stop == [exp_saved]
    finally:
        agent.model.stop.side_effect = None
        await agent.stop()


@pytest.mark.asyncio
async def test_bidi_agent_defaults_to_message_strategy_saving_replacements_and_at_stop_or_restart(
    temp_dir, bidi_save_event
):
    """The Bidi default is "message": a streaming session has no invocation boundary to save at."""
    storage = LocalFileStorage(temp_dir)
    save_keys = _spy_writes(storage)
    agent = _bidi_agent(SnapshotSessionManager("s1", storage=storage))
    save_keys.clear()

    placeholder = {"role": "assistant", "content": [{"text": ""}]}
    await agent._append_messages(placeholder)
    replacement = {
        "role": "assistant",
        "content": [{"text": "complete"}],
        "tracking_id": placeholder["tracking_id"],
    }
    await agent._update_message(replacement)

    restored = _bidi_agent(SnapshotSessionManager("s1", storage=storage))
    assert _texts(restored) == ["complete"]

    await agent.hooks.invoke_callbacks_async(bidi_save_event(agent=agent))
    assert save_keys == [_on_disk_key("s1", "b1")] * 3


@pytest.mark.asyncio
async def test_bidi_agent_trigger_strategy_skips_latest_without_trigger(temp_dir, bidi_save_event):
    storage = LocalFileStorage(temp_dir)
    save_keys = _spy_writes(storage)
    agent = _bidi_agent(SnapshotSessionManager("s1", storage=storage, bidi_agent_save_latest_on="trigger"))
    save_keys.clear()

    await agent._append_messages({"role": "user", "content": [{"text": "one"}]})
    await agent.hooks.invoke_callbacks_async(bidi_save_event(agent=agent))

    assert save_keys == []


@pytest.mark.asyncio
async def test_bidi_agent_ignores_agent_save_latest_on(temp_dir):
    """The two strategies are independent: the Agent "message" strategy does not leak into a BidiAgent."""
    storage = LocalFileStorage(temp_dir)
    save_keys = _spy_writes(storage)
    manager = SnapshotSessionManager("s1", storage=storage, save_latest_on="message", bidi_agent_save_latest_on="stop")
    agent = _bidi_agent(manager)
    save_keys.clear()

    await agent._append_messages({"role": "user", "content": [{"text": "one"}]})
    assert save_keys == []

    await agent.hooks.invoke_callbacks_async(BidiAgentStopEvent(agent=agent))
    assert save_keys == [_on_disk_key("s1", "b1")]


@pytest.mark.asyncio
async def test_agent_ignores_bidi_agent_save_latest_on(temp_dir):
    """The two strategies are independent: the Bidi "message" default does not leak into an Agent."""
    storage = LocalFileStorage(temp_dir)
    save_keys = _spy_writes(storage)
    manager = SnapshotSessionManager(
        "s1", storage=storage, save_latest_on="trigger", bidi_agent_save_latest_on="message"
    )
    agent = Agent(model=_model("reply"), session_manager=manager, agent_id="a1")
    save_keys.clear()

    await agent.invoke_async("hello")

    assert save_keys == []


@pytest.mark.asyncio
@pytest.mark.parametrize("bidi_agent_save_latest_on", ["message", "stop", "trigger"])
async def test_bidi_agent_trigger_creates_immutable_and_latest_at_stop_or_restart(
    storage, bidi_agent_save_latest_on, bidi_save_event
):
    seen: list[BidiAgent] = []

    def trigger(*, agent_data, **kwargs):
        seen.append(agent_data)
        return True

    manager = SnapshotSessionManager(
        "s1", storage=storage, bidi_agent_save_latest_on=bidi_agent_save_latest_on, snapshot_trigger=trigger
    )
    agent = _bidi_agent(manager)
    await agent._append_messages({"role": "user", "content": [{"text": "one"}]})
    await agent.hooks.invoke_callbacks_async(bidi_save_event(agent=agent))

    assert seen == [agent]
    assert len(await manager.list_snapshot_ids(agent)) == 1
    assert await storage.read(_on_disk_key("s1", "b1")) is not None


@pytest.mark.asyncio
async def test_bidi_agent_trigger_returning_false_appends_nothing(storage, bidi_save_event):
    manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=lambda *, agent_data, **_: False)
    agent = _bidi_agent(manager)
    await agent._append_messages({"role": "user", "content": [{"text": "one"}]})
    await agent.hooks.invoke_callbacks_async(bidi_save_event(agent=agent))

    assert await manager.list_snapshot_ids(agent) == []
    assert await storage.read(_on_disk_key("s1", "b1")) is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("bidi_agent_save_latest_on", ["stop", "trigger"])
async def test_bidi_agent_raising_trigger_still_saves_latest(storage, bidi_agent_save_latest_on, bidi_save_event):
    def boom(*, agent_data, **kwargs):
        raise RuntimeError("trigger blew up")

    manager = SnapshotSessionManager(
        "s1", storage=storage, bidi_agent_save_latest_on=bidi_agent_save_latest_on, snapshot_trigger=boom
    )
    agent = _bidi_agent(manager)
    await agent._append_messages({"role": "user", "content": [{"text": "survived"}]})
    await agent.hooks.invoke_callbacks_async(bidi_save_event(agent=agent))

    agent_2 = _bidi_agent(
        SnapshotSessionManager("s1", storage=storage, bidi_agent_save_latest_on=bidi_agent_save_latest_on)
    )
    assert _texts(agent_2) == ["survived"]
    assert await manager.list_snapshot_ids(agent) == []


@pytest.mark.asyncio
async def test_bidi_agent_state_changed_by_stop_hook_is_persisted(storage):
    class StopStateHook:
        def register_hooks(self, registry):
            registry.add_callback(BidiAgentStopEvent, self.on_stop)

        def on_stop(self, event):
            event.agent.state.set("turns", 1)

    agent = _bidi_agent(SnapshotSessionManager("s1", storage=storage), hooks=[StopStateHook()])
    await agent.start()
    await agent.send("hello")
    await agent.stop()

    agent_2 = _bidi_agent(SnapshotSessionManager("s1", storage=storage))
    assert agent_2.state.get("turns") == 1


@pytest.mark.asyncio
async def test_bidi_agent_stop_cleanup_failure_still_saves_latest(storage):
    agent = _bidi_agent(SnapshotSessionManager("s1", storage=storage))
    await agent.start()
    await agent.send("hello")
    agent.model.stop.side_effect = RuntimeError("provider close failed")

    with pytest.raises(RuntimeError, match="provider close failed"):
        await agent.stop()

    agent_2 = _bidi_agent(SnapshotSessionManager("s1", storage=storage))
    assert _texts(agent_2) == ["hello"]


@pytest.mark.asyncio
async def test_bidi_agent_time_travel_restore_while_stopped(storage):
    manager = SnapshotSessionManager("s1", storage=storage)
    agent = _bidi_agent(manager)
    await agent._append_messages({"role": "user", "content": [{"text": "turn 1"}]})
    snapshot_id = await manager.save_snapshot(agent, is_latest=False)
    await agent._append_messages({"role": "user", "content": [{"text": "turn 2"}]})
    await agent.hooks.invoke_callbacks_async(BidiAgentStopEvent(agent=agent))

    assert await manager.list_snapshot_ids(agent) == [snapshot_id]
    assert await manager.restore_snapshot(agent, snapshot_id=snapshot_id) is True
    assert _texts(agent) == ["turn 1"]

    assert await manager.restore_snapshot(agent) is True
    assert _texts(agent) == ["turn 1", "turn 2"]


@pytest.mark.asyncio
async def test_bidi_agent_restore_snapshot_rejected_while_started(storage):
    manager = SnapshotSessionManager("s1", storage=storage)
    agent = _bidi_agent(manager)
    await agent._append_messages({"role": "user", "content": [{"text": "saved"}]})
    await manager.save_snapshot(agent, is_latest=True)
    agent.messages.clear()

    await agent.start()
    try:
        with pytest.raises(RuntimeError, match="agent started"):
            await manager.restore_snapshot(agent)
        assert agent.messages == []
    finally:
        await agent.stop()


@pytest.mark.asyncio
async def test_bidi_agent_restore_warns_on_overwrite(storage, caplog):
    agent = _bidi_agent(SnapshotSessionManager("s1", storage=storage))
    await agent._append_messages({"role": "user", "content": [{"text": "first"}]})
    await agent.hooks.invoke_callbacks_async(BidiAgentStopEvent(agent=agent))

    _bidi_agent(
        SnapshotSessionManager("s1", storage=storage),
        messages=[{"role": "user", "content": [{"text": "pre-existing"}]}],
    )

    assert "overwritten by session restore" in caplog.text


def test_agent_falls_back_to_local_file_storage(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    agent = Agent(model=_model("reply"), session_manager=SnapshotSessionManager("s1"), agent_id="a1")
    agent("hello")

    agent_2 = Agent(model=_model("x"), session_manager=SnapshotSessionManager("s1"), agent_id="a1")
    assert _texts(agent_2) == ["hello", "reply"]


def test_agent_resolves_agent_level_storage(storage):
    agent = Agent(model=_model("reply"), storage=storage, session_manager=SnapshotSessionManager("s1"), agent_id="a1")
    agent("hello")

    assert asyncio.run(storage.read(_on_disk_key("s1", "a1"))) is not None
    agent_2 = Agent(model=_model("x"), storage=storage, session_manager=SnapshotSessionManager("s1"), agent_id="a1")
    assert _texts(agent_2) == ["hello", "reply"]


@pytest.mark.asyncio
async def test_bidi_agent_falls_back_to_local_file_storage(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    manager = SnapshotSessionManager("s1")
    agent = _bidi_agent(manager)
    await agent._append_messages({"role": "user", "content": [{"text": "hello"}]})
    await agent.hooks.invoke_callbacks_async(BidiAgentStopEvent(agent=agent))

    agent_2 = _bidi_agent(SnapshotSessionManager("s1"))
    assert _texts(agent_2) == ["hello"]


@pytest.mark.asyncio
async def test_bidi_agent_resolves_agent_level_storage(storage):
    agent = _bidi_agent(SnapshotSessionManager("s1"), storage=storage)
    await agent._append_messages({"role": "user", "content": [{"text": "hello"}]})
    await agent.hooks.invoke_callbacks_async(BidiAgentStopEvent(agent=agent))

    assert await storage.read(_on_disk_key("s1", "b1")) is not None
    agent_2 = _bidi_agent(SnapshotSessionManager("s1"), storage=storage)
    assert _texts(agent_2) == ["hello"]


@pytest.mark.asyncio
async def test_bidi_agent_delete_session_removes_snapshots(storage):
    manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=lambda *, agent_data, **_: True)
    agent = _bidi_agent(manager)
    await agent._append_messages({"role": "user", "content": [{"text": "hello"}]})
    await agent.hooks.invoke_callbacks_async(BidiAgentStopEvent(agent=agent))
    assert len(await storage.list(f"session/{_session_prefix('s1')}")) == 2

    await manager.delete_session()

    assert await storage.list(f"session/{_session_prefix('s1')}") == []
    assert _texts(_bidi_agent(SnapshotSessionManager("s1", storage=storage))) == []
