"""Tests for SnapshotSessionManager."""

import asyncio
import tempfile
import uuid
from unittest.mock import AsyncMock, Mock

import pytest

from strands.agent.agent import Agent
from strands.agent.conversation_manager.sliding_window_conversation_manager import SlidingWindowConversationManager
from strands.experimental.hooks.events import BidiAgentInitializedEvent
from strands.hooks.registry import HookRegistry
from strands.multiagent import GraphBuilder, Swarm
from strands.session.snapshot_session_manager import (
    SnapshotSessionManager,
    _new_snapshot_id,
    _session_prefix,
    _snapshot_key,
)
from strands.storage import LocalFileStorage
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


def test_graph_is_rejected_rather_than_silently_not_persisted(storage):
    """Attaching this single-agent manager to a Graph fails loudly instead of persisting nothing."""
    builder = GraphBuilder()
    builder.add_node(Agent(model=_model("done"), agent_id="n1"), "n1")
    builder.set_session_manager(SnapshotSessionManager("g1", storage=storage))
    with pytest.raises(NotImplementedError, match="does not support multi-agent"):
        builder.build()


def test_swarm_is_rejected_rather_than_silently_not_persisted(storage):
    """Attaching this single-agent manager to a Swarm fails loudly instead of persisting nothing."""
    with pytest.raises(NotImplementedError, match="does not support multi-agent"):
        Swarm(
            nodes=[Agent(model=_model("done"), agent_id="n1")],
            session_manager=SnapshotSessionManager("sw1", storage=storage),
        )


def test_bidi_agent_is_rejected_rather_than_silently_not_persisted(storage):
    """Attaching this single-agent manager to a BidiAgent fails loudly instead of persisting nothing.

    The base SessionManager wires BidiAgent hooks to message-log methods; this manager replaces
    that wiring, so without an explicit rejection a BidiAgent would appear persisted while
    nothing was ever written.
    """
    manager = SnapshotSessionManager("b1", storage=storage)
    registry = HookRegistry()
    manager.register_hooks(registry)

    with pytest.raises(NotImplementedError, match="does not support BidiAgent"):
        registry.invoke_callbacks(BidiAgentInitializedEvent(agent=Mock()))


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
    history_prefix = "session/s1/scopes/agent/a1/snapshots/immutable_history/"
    await storage.write(f"{history_prefix}snapshot_not-a-uuid.json", b"invalid")

    assert len(all_ids) == 3
    assert all_ids == sorted(all_ids)

    assert await manager.list_snapshot_ids(agent, limit=2) == all_ids[:2]
    assert "not-a-uuid" not in await manager.list_snapshot_ids(agent)
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
