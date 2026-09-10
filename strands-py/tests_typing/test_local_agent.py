from typing import Any

from typing_extensions import assert_type

from strands import Agent, LocalAgent, ToolContext, tool
from strands.experimental.bidi import BidiAgent
from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent
from strands.session.repository_session_manager import RepositorySessionManager
from strands.session.session_manager import SessionManager
from strands.session.snapshot_session_manager import SnapshotSessionManager
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


def local_agent_excludes_agent_only_members(local_agent: LocalAgent) -> None:
    local_agent.cleanup()  # type: ignore[attr-defined]


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
