from typing import Any

from typing_extensions import assert_type

from strands import Agent, LocalAgent, Snapshot, ToolContext, tool
from strands.experimental.bidi.agent import BidiAgent
from strands.hooks import AfterToolCallEvent, AgentInitializedEvent, BeforeToolCallEvent, MessageAddedEvent
from strands.session.repository_session_manager import RepositorySessionManager
from strands.session.session_manager import SessionManager
from strands.session.snapshot_session_manager import SnapshotSessionManager, SnapshotTrigger
from strands.storage import Storage
from strands.types.content import Message
from strands.types.session import SessionAgent


@tool(context=True)
def unparameterized_tool(tool_context: ToolContext) -> str:
    assert_type(tool_context.agent, Any)
    return "unparameterized"


@tool(context=True)
def agent_tool(tool_context: ToolContext[Agent]) -> str:
    assert_type(tool_context.agent, Agent)
    return tool_context.agent.name


@tool(context=True)
def local_agent_tool(tool_context: ToolContext[LocalAgent]) -> str:
    assert_type(tool_context.agent, LocalAgent)
    return tool_context.agent.name


def before_tool_call(event: BeforeToolCallEvent) -> None:
    assert_type(event.agent, Agent)


def before_local_tool_call(event: BeforeToolCallEvent[LocalAgent]) -> None:
    assert_type(event.agent, LocalAgent)


async def after_local_tool_call(event: AfterToolCallEvent[LocalAgent]) -> None:
    assert_type(event.agent, LocalAgent)


def local_tool_call(event: BeforeToolCallEvent[LocalAgent] | AfterToolCallEvent[LocalAgent]) -> None:
    assert_type(event.agent, LocalAgent)


def agent_initialized(event: AgentInitializedEvent) -> None:
    assert_type(event.agent, Agent)


def message_added(event: MessageAddedEvent) -> None:
    assert_type(event.agent, Agent)


def local_agent_initialized(event: AgentInitializedEvent[LocalAgent]) -> None:
    assert_type(event.agent, LocalAgent)


async def local_message_added(event: MessageAddedEvent[LocalAgent]) -> None:
    assert_type(event.agent, LocalAgent)


def register_hooks(agent: Agent, bidi_agent: BidiAgent, local_agent: LocalAgent) -> None:
    shared_agent: LocalAgent = agent
    assert_type(shared_agent, LocalAgent)
    shared_bidi_agent: LocalAgent = bidi_agent
    assert_type(shared_bidi_agent, LocalAgent)

    agent.add_hook(before_tool_call)
    agent.add_hook(before_local_tool_call)
    agent.add_hook(after_local_tool_call)
    agent.add_hook(local_tool_call)

    bidi_agent.add_hook(before_local_tool_call)
    bidi_agent.add_hook(after_local_tool_call)
    bidi_agent.add_hook(local_tool_call)

    local_agent.add_hook(before_local_tool_call)
    local_agent.add_hook(after_local_tool_call)
    local_agent.add_hook(local_tool_call)

    local_agent.add_hook(before_local_tool_call, BeforeToolCallEvent)
    local_agent.add_hook(local_tool_call, [BeforeToolCallEvent, AfterToolCallEvent])

    agent.add_hook(agent_initialized)
    agent.add_hook(message_added)
    for shared in (agent, bidi_agent, local_agent):
        shared.add_hook(local_agent_initialized)
        shared.add_hook(local_message_added)
        shared.add_hook(local_agent_initialized, AgentInitializedEvent)
        shared.add_hook(local_message_added, MessageAddedEvent)


def local_agent_excludes_agent_only_members(local_agent: LocalAgent) -> None:
    local_agent.cleanup()  # type: ignore[attr-defined]


def snapshot_local_agent(agent: Agent, bidi_agent: BidiAgent, local_agent: LocalAgent) -> None:
    for shared in (agent, bidi_agent, local_agent):
        snapshot = shared.take_snapshot(preset="session")
        assert_type(snapshot, Snapshot)
        shared.take_snapshot(include=["messages", "state"], exclude=["state"], app_data={"key": "value"})
        shared.load_snapshot(snapshot)


def persist_local_agent(manager: RepositorySessionManager, agent: LocalAgent, message: Message) -> None:
    manager.initialize(agent)
    manager.append_message(message, agent)
    manager.redact_latest_message(message, agent)
    manager.sync_agent(agent)
    session_agent = SessionAgent.from_agent(agent)
    assert_type(session_agent, SessionAgent)
    session_agent.initialize_internal_state(agent)


class AgentOnlySessionManager(SessionManager):
    def initialize(self, agent: Agent, **kwargs: Any) -> None:
        pass

    def append_message(self, message: Message, agent: Agent, **kwargs: Any) -> None:
        pass

    def sync_agent(self, agent: Agent, **kwargs: Any) -> None:
        pass

    def redact_latest_message(self, redact_message: Message, agent: Agent, **kwargs: Any) -> None:
        pass


def session_manager_types(
    manager: SessionManager,
    shared_manager: SessionManager[LocalAgent],
    repository_manager: RepositorySessionManager,
    snapshot_manager: SnapshotSessionManager,
    agent: Agent,
    bidi_agent: BidiAgent,
    message: Message,
) -> None:
    manager.append_message(message, agent)
    manager.append_message(message, bidi_agent)  # type: ignore[arg-type]
    shared_manager.append_message(message, agent)
    shared_manager.append_message(message, bidi_agent)

    standard_manager: SessionManager = repository_manager
    shared_repository_manager: SessionManager[LocalAgent] = repository_manager
    Agent(session_manager=standard_manager)
    Agent(session_manager=shared_manager)
    Agent(session_manager=AgentOnlySessionManager())
    Agent(session_manager=snapshot_manager)
    BidiAgent(session_manager=shared_repository_manager)
    BidiAgent(session_manager=shared_manager)
    BidiAgent(session_manager=manager)  # type: ignore[arg-type]
    BidiAgent(session_manager=snapshot_manager)  # type: ignore[arg-type]


def agent_snapshot_trigger(*, agent_data: Agent, **kwargs: Any) -> bool:
    return agent_data.conversation_manager.removed_message_count == 0


def local_snapshot_trigger(*, agent_data: LocalAgent, **kwargs: Any) -> bool:
    return len(agent_data.messages) % 2 == 0


def snapshot_manager_types(storage: Storage) -> None:
    agent_trigger: SnapshotTrigger = agent_snapshot_trigger
    shared_trigger: SnapshotTrigger[LocalAgent] = local_snapshot_trigger
    widened_trigger: SnapshotTrigger = local_snapshot_trigger
    assert_type(agent_trigger, SnapshotTrigger[Agent])
    assert_type(shared_trigger, SnapshotTrigger[LocalAgent])
    assert_type(widened_trigger, SnapshotTrigger[Agent])

    default_manager = SnapshotSessionManager("s1", storage=storage)
    assert_type(default_manager, SnapshotSessionManager[Agent])
    Agent(session_manager=default_manager)
    BidiAgent(session_manager=default_manager)  # type: ignore[arg-type]

    shared_manager = SnapshotSessionManager[LocalAgent]("s1", storage=storage)
    assert_type(shared_manager, SnapshotSessionManager[LocalAgent])
    Agent(session_manager=shared_manager)
    BidiAgent(session_manager=shared_manager)
    BidiAgent(session_manager=SnapshotSessionManager("s1", storage=storage))

    shared_trigger_manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=local_snapshot_trigger)
    assert_type(shared_trigger_manager, SnapshotSessionManager[LocalAgent])
    Agent(session_manager=shared_trigger_manager)
    BidiAgent(session_manager=shared_trigger_manager)

    agent_trigger_manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=agent_snapshot_trigger)
    assert_type(agent_trigger_manager, SnapshotSessionManager[Agent])
    Agent(session_manager=agent_trigger_manager)
    BidiAgent(session_manager=agent_trigger_manager)  # type: ignore[arg-type]

    untyped_trigger_manager = SnapshotSessionManager("s1", storage=storage, snapshot_trigger=lambda **_: True)
    assert_type(untyped_trigger_manager, SnapshotSessionManager[Any])
    Agent(session_manager=untyped_trigger_manager)
    BidiAgent(session_manager=untyped_trigger_manager)


async def snapshot_manager_method_types(
    agent_manager: SnapshotSessionManager,
    shared_manager: SnapshotSessionManager[LocalAgent],
    agent: Agent,
    bidi_agent: BidiAgent,
) -> None:
    await agent_manager.save_snapshot(agent, is_latest=True)
    await agent_manager.save_snapshot(bidi_agent, is_latest=True)  # type: ignore[arg-type]
    await shared_manager.save_snapshot(agent, is_latest=True)
    await shared_manager.save_snapshot(bidi_agent, is_latest=True)
    await shared_manager.restore_snapshot(bidi_agent)
    await shared_manager.list_snapshot_ids(bidi_agent)


class AgentOnlySnapshotSessionManager(SnapshotSessionManager):
    def sync_agent(self, agent: Agent, **kwargs: Any) -> None:
        super().sync_agent(agent, **kwargs)


class SharedSnapshotSessionManager(SnapshotSessionManager[LocalAgent]):
    def sync_agent(self, agent: LocalAgent, **kwargs: Any) -> None:
        super().sync_agent(agent, **kwargs)
