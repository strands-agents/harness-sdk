"""Tests for AgentSessionManager."""

import copy
from unittest.mock import Mock

import pytest

from strands.agent.agent import Agent
from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager
from strands.agent.conversation_manager.sliding_window_conversation_manager import SlidingWindowConversationManager
from strands.agent.conversation_manager.summarizing_conversation_manager import SummarizingConversationManager
from strands.agent.state import AgentState
from strands.interrupt import _InterruptState
from strands.session.repository_session_manager import RepositorySessionManager
from strands.types.content import ContentBlock
from strands.types.exceptions import SessionException
from strands.types.session import Session, SessionAgent, SessionMessage, SessionType
from tests.fixtures.mock_session_repository import MockedSessionRepository


@pytest.fixture
def mock_repository():
    """Create a mock repository."""
    return MockedSessionRepository()


@pytest.fixture
def session_manager(mock_repository):
    """Create a session manager with mock repository."""
    return RepositorySessionManager(session_id="test-session", session_repository=mock_repository)


@pytest.fixture
def existing_session_manager(mock_repository):
    """Create a session manager with a pre-existing session in the repository."""
    # Create session first so the manager sees it as existing
    session = Session(session_id="test-session", session_type=SessionType.AGENT)
    mock_repository.create_session(session)
    return RepositorySessionManager(session_id="test-session", session_repository=mock_repository)


@pytest.fixture
def agent():
    """Create a mock agent."""
    return Agent(messages=[{"role": "user", "content": [{"text": "Hello!"}]}])


@pytest.fixture
def mock_multi_agent():
    """Create mock multi-agent for testing."""

    mock = Mock()
    mock.id = "test-multi-agent"
    mock.serialize_state.return_value = {"id": "test-multi-agent", "state": {"key": "value"}}
    mock.deserialize_state = Mock()
    return mock


def test_init_creates_session_if_not_exists(mock_repository):
    """Test that init creates a session if it doesn't exist."""
    # Session doesn't exist yet
    assert mock_repository.read_session("test-session") is None

    # Creating manager should create session
    RepositorySessionManager(session_id="test-session", session_repository=mock_repository)

    # Verify session created
    session = mock_repository.read_session("test-session")
    assert session is not None
    assert session.session_id == "test-session"
    assert session.session_type == SessionType.AGENT


def test_init_uses_existing_session(mock_repository):
    """Test that init uses existing session if it exists."""
    # Create session first
    session = Session(session_id="test-session", session_type=SessionType.AGENT)
    mock_repository.create_session(session)

    # Creating manager should use existing session
    manager = RepositorySessionManager(session_id="test-session", session_repository=mock_repository)

    # Verify session used
    assert manager.session == session


def test_initialize_with_existing_agent_id(session_manager, agent):
    """Test initializing an agent with existing agent_id."""
    # Set agent ID
    agent.agent_id = "custom-agent"

    # Initialize agent
    session_manager.initialize(agent)

    # Verify agent created in repository
    agent_data = session_manager.session_repository.read_agent("test-session", "custom-agent")
    assert agent_data is not None
    assert agent_data.agent_id == "custom-agent"


def test_initialize_multiple_agents_without_id(session_manager, agent):
    """Test initializing multiple agents with same ID."""
    # First agent initialization works
    agent.agent_id = "custom-agent"
    session_manager.initialize(agent)

    # Second agent with no set agent_id should fail
    agent2 = Agent(agent_id="custom-agent")

    with pytest.raises(SessionException, match="The `agent_id` of an agent must be unique in a session."):
        session_manager.initialize(agent2)


def test_initialize_restores_existing_agent(existing_session_manager, agent):
    """Test that initializing an existing agent restores its state."""
    # Set agent ID
    agent.agent_id = "existing-agent"

    # Create agent in repository first
    session_agent = SessionAgent(
        agent_id="existing-agent",
        state={"key": "value"},
        conversation_manager_state=SlidingWindowConversationManager().get_state(),
        _internal_state={"interrupt_state": {"interrupts": {}, "context": {"test": "init"}, "activated": False}},
    )
    existing_session_manager.session_repository.create_agent("test-session", session_agent)

    # Create some messages
    message = SessionMessage(
        message={
            "role": "user",
            "content": [ContentBlock(text="Hello")],
        },
        message_id=0,
    )
    existing_session_manager.session_repository.create_message("test-session", "existing-agent", message)

    # Initialize agent
    existing_session_manager.initialize(agent)

    # Verify agent state restored
    assert agent.state.get("key") == "value"
    assert len(agent.messages) == 1
    assert agent.messages[0]["role"] == "user"
    assert agent.messages[0]["content"][0]["text"] == "Hello"
    assert agent._interrupt_state == _InterruptState(interrupts={}, context={"test": "init"}, activated=False)


def test_initialize_restores_existing_agent_with_summarizing_conversation_manager(existing_session_manager):
    """Test that initializing an existing agent restores its state."""
    conversation_manager = SummarizingConversationManager()
    conversation_manager.removed_message_count = 1
    conversation_manager._summary_message = {"role": "assistant", "content": [{"text": "summary"}]}

    # Create agent in repository first
    session_agent = SessionAgent(
        agent_id="existing-agent",
        state={"key": "value"},
        conversation_manager_state=conversation_manager.get_state(),
    )
    existing_session_manager.session_repository.create_agent("test-session", session_agent)

    # Create some messages
    message = SessionMessage(
        message={
            "role": "user",
            "content": [ContentBlock(text="Hello")],
        },
        message_id=0,
    )
    # Create two messages as one will be removed by the conversation manager
    existing_session_manager.session_repository.create_message("test-session", "existing-agent", message)
    message.message_id = 1
    existing_session_manager.session_repository.create_message("test-session", "existing-agent", message)

    # Initialize agent
    agent = Agent(agent_id="existing-agent", conversation_manager=SummarizingConversationManager())
    existing_session_manager.initialize(agent)

    # Verify agent state restored
    assert agent.state.get("key") == "value"
    # The session message plus the summary message
    assert len(agent.messages) == 2
    assert agent.messages[1]["role"] == "user"
    assert agent.messages[1]["content"][0]["text"] == "Hello"
    assert agent.conversation_manager.removed_message_count == 1


def test_append_message(session_manager):
    """Test appending a message to an agent's session."""
    # Set agent ID and session manager
    agent = Agent(agent_id="test-agent", session_manager=session_manager)

    # Create message
    message = {"role": "user", "content": [{"type": "text", "text": "Hello"}]}

    # Append message
    session_manager.append_message(message, agent)

    # Verify message created in repository
    messages = session_manager.session_repository.list_messages("test-session", "test-agent")
    assert len(messages) == 1
    assert messages[0].message["role"] == "user"
    assert messages[0].message["content"][0]["text"] == "Hello"


def test_sync_multi_agent(session_manager, mock_multi_agent):
    """Test syncing multi-agent state."""
    # Create multi-agent first
    session_manager.session_repository.create_multi_agent("test-session", mock_multi_agent)

    # Sync multi-agent
    session_manager.sync_multi_agent(mock_multi_agent)

    # Verify repository update_multi_agent was called
    state = session_manager.session_repository.read_multi_agent("test-session", mock_multi_agent.id)
    assert state["id"] == "test-multi-agent"
    assert state["state"] == {"key": "value"}


def test_initialize_multi_agent_new(session_manager, mock_multi_agent):
    """Test initializing new multi-agent state."""
    session_manager.initialize_multi_agent(mock_multi_agent)

    # Verify multi-agent was created
    state = session_manager.session_repository.read_multi_agent("test-session", mock_multi_agent.id)
    assert state["id"] == "test-multi-agent"
    assert state["state"] == {"key": "value"}


def test_initialize_multi_agent_existing(existing_session_manager, mock_multi_agent):
    """Test initializing existing multi-agent state."""
    # Create existing state first
    existing_session_manager.session_repository.create_multi_agent("test-session", mock_multi_agent)

    # Create a mock with updated state for the update call
    updated_mock = Mock()
    updated_mock.id = "test-multi-agent"
    existing_state = {"id": "test-multi-agent", "state": {"restored": "data"}}
    updated_mock.serialize_state.return_value = existing_state
    existing_session_manager.session_repository.update_multi_agent("test-session", updated_mock)

    # Initialize multi-agent
    existing_session_manager.initialize_multi_agent(mock_multi_agent)

    # Verify deserialize_state was called with existing state
    mock_multi_agent.deserialize_state.assert_called_once_with(existing_state)


def test_initialize_skips_message_restore_for_server_managed_conversation(existing_session_manager):
    """Test that messages are not restored when model manages conversation server-side."""
    session_agent = SessionAgent(
        agent_id="existing-agent",
        state={},
        conversation_manager_state=NullConversationManager().get_state(),
        _internal_state={
            "interrupt_state": {"interrupts": {}, "context": {}, "activated": False},
            "model_state": {"response_id": "resp_abc123"},
        },
    )
    existing_session_manager.session_repository.create_agent("test-session", session_agent)

    message = SessionMessage.from_message({"role": "user", "content": [{"text": "Hello"}]}, 0)
    existing_session_manager.session_repository.create_message("test-session", "existing-agent", message)

    mock_model = Mock()
    mock_model.stateful = True
    agent = Agent(agent_id="existing-agent", model=mock_model)
    existing_session_manager.initialize(agent)

    assert agent.messages == []
    assert agent._model_state == {"response_id": "resp_abc123"}
    assert existing_session_manager.session_repository.list_messages("test-session", "existing-agent") == [message]


def test_fix_broken_tool_use_adds_missing_tool_results(existing_session_manager):
    """Test that _fix_broken_tool_use adds missing toolResult messages."""
    conversation_manager = SlidingWindowConversationManager()

    # Create agent in repository first
    session_agent = SessionAgent(
        agent_id="existing-agent",
        state={"key": "value"},
        conversation_manager_state=conversation_manager.get_state(),
    )
    existing_session_manager.session_repository.create_agent("test-session", session_agent)

    broken_messages = [
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "orphaned-123", "name": "test_tool", "input": {"input": "test"}}}],
        },
        {"role": "user", "content": [{"text": "Some other message"}]},
    ]
    # Create some session messages
    for index, broken_message in enumerate(broken_messages):
        broken_session_message = SessionMessage(
            message=broken_message,
            message_id=index,
        )
        existing_session_manager.session_repository.create_message(
            "test-session", "existing-agent", broken_session_message
        )

    # Initialize agent
    agent = Agent(agent_id="existing-agent")
    existing_session_manager.initialize(agent)

    fixed_messages = agent.messages

    # Should insert toolResult message between toolUse and other message
    assert len(fixed_messages) == 3
    assert "toolResult" in fixed_messages[1]["content"][0]
    assert fixed_messages[1]["content"][0]["toolResult"]["toolUseId"] == "orphaned-123"
    assert fixed_messages[1]["content"][0]["toolResult"]["status"] == "error"
    assert fixed_messages[1]["content"][0]["toolResult"]["content"][0]["text"] == "Tool was interrupted."
    # The synthesized message is spliced into history outside the append chokepoint, so it must
    # still carry a durable tracking id like any other message.
    assert isinstance(fixed_messages[1].get("tracking_id"), str)
    assert fixed_messages[1]["tracking_id"]


def test_fix_broken_tool_use_extends_partial_tool_results(existing_session_manager):
    """Test fixing messages where some toolResults are missing."""
    conversation_manager = SlidingWindowConversationManager()
    # Create agent in repository first
    session_agent = SessionAgent(
        agent_id="existing-agent",
        state={"key": "value"},
        conversation_manager_state=conversation_manager.get_state(),
    )
    existing_session_manager.session_repository.create_agent("test-session", session_agent)

    broken_messages = [
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "complete-123", "name": "test_tool", "input": {"input": "test1"}}},
                {"toolUse": {"toolUseId": "missing-456", "name": "test_tool", "input": {"input": "test2"}}},
            ],
        },
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": "complete-123", "status": "success", "content": [{"text": "result"}]}}
            ],
        },
    ]
    # Create some session messages
    for index, broken_message in enumerate(broken_messages):
        broken_session_message = SessionMessage(
            message=broken_message,
            message_id=index,
        )
        existing_session_manager.session_repository.create_message(
            "test-session", "existing-agent", broken_session_message
        )

    # Initialize agent
    agent = Agent(agent_id="existing-agent")
    existing_session_manager.initialize(agent)

    fixed_messages = agent.messages

    # Should add missing toolResult to existing message
    assert len(fixed_messages) == 2
    assert len(fixed_messages[1]["content"]) == 2

    tool_use_ids = {tr["toolResult"]["toolUseId"] for tr in fixed_messages[1]["content"]}
    assert tool_use_ids == {"complete-123", "missing-456"}

    # Check the added toolResult has correct properties
    missing_result = next(tr for tr in fixed_messages[1]["content"] if tr["toolResult"]["toolUseId"] == "missing-456")
    assert missing_result["toolResult"]["status"] == "error"
    assert missing_result["toolResult"]["content"][0]["text"] == "Tool was interrupted."


def test_fix_broken_tool_use_removes_stale_tool_results(session_manager):
    """Test that toolResults with IDs not matching any preceding toolUse are dropped (#2296)."""
    messages = [
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "valid-123", "name": "test_tool", "input": {"input": "test"}}},
            ],
        },
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": "stale-999", "status": "success", "content": [{"text": "stale"}]}},
                {"toolResult": {"toolUseId": "valid-123", "status": "success", "content": [{"text": "result"}]}},
            ],
        },
        {"role": "user", "content": [{"text": "Final message"}]},
    ]

    fixed_messages = session_manager._fix_broken_tool_use(messages)

    assert len(fixed_messages) == 3
    assert fixed_messages[1]["content"] == [
        {"toolResult": {"toolUseId": "valid-123", "status": "success", "content": [{"text": "result"}]}}
    ]


def test_fix_broken_tool_use_handles_multiple_orphaned_tools(existing_session_manager):
    """Test fixing multiple orphaned toolUse messages."""

    conversation_manager = SlidingWindowConversationManager()
    # Create agent in repository first
    session_agent = SessionAgent(
        agent_id="existing-agent",
        state={"key": "value"},
        conversation_manager_state=conversation_manager.get_state(),
    )
    existing_session_manager.session_repository.create_agent("test-session", session_agent)

    broken_messages = [
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "orphaned-123", "name": "test_tool", "input": {"input": "test1"}}},
                {"toolUse": {"toolUseId": "orphaned-456", "name": "test_tool", "input": {"input": "test2"}}},
            ],
        },
        {"role": "user", "content": [{"text": "Next message"}]},
    ]
    # Create some session messages
    for index, broken_message in enumerate(broken_messages):
        broken_session_message = SessionMessage(
            message=broken_message,
            message_id=index,
        )
        existing_session_manager.session_repository.create_message(
            "test-session", "existing-agent", broken_session_message
        )

    # Initialize agent
    agent = Agent(agent_id="existing-agent")
    existing_session_manager.initialize(agent)

    fixed_messages = agent.messages

    # Should insert message with both toolResults
    assert len(fixed_messages) == 3
    assert len(fixed_messages[1]["content"]) == 2

    tool_use_ids = {tr["toolResult"]["toolUseId"] for tr in fixed_messages[1]["content"]}
    assert tool_use_ids == {"orphaned-123", "orphaned-456"}


def test_fix_broken_tool_use_ignores_last_message(session_manager):
    """Test that orphaned toolUse in the last message is not fixed."""
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "last-message-123", "name": "test_tool", "input": {"input": "test"}}}
            ],
        },
    ]
    original = copy.deepcopy(messages)

    fixed_messages = session_manager._fix_broken_tool_use(messages)

    # Should remain unchanged since toolUse is in last message
    assert fixed_messages == original


def test_fix_broken_tool_use_ignores_single_orphaned_tool_use(session_manager):
    """Test that a conversation with only a single orphaned toolUse is left untouched."""
    messages = [
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "only-message-123", "name": "test_tool", "input": {"input": "test"}}}
            ],
        },
    ]
    original = copy.deepcopy(messages)

    fixed_messages = session_manager._fix_broken_tool_use(messages)

    assert fixed_messages == original


def test_fix_broken_tool_use_consecutive_orphaned_tool_uses(session_manager):
    """Consecutive non-trailing orphaned toolUse messages each receive a toolResult (issue #2028).

    The trailing message is intentionally left for the agent class to handle at prompt-arrival
    time, so this covers the mid-iteration skip caused by enumerate+insert against a live
    ``len(messages)`` guard: with two orphans followed by a text message, the second orphan
    used to end up as the new "last" index mid-loop and get skipped.
    """
    tru_messages = [
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "first-123", "name": "test_tool", "input": {"input": "test1"}}}],
        },
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "second-456", "name": "test_tool", "input": {"input": "test2"}}}],
        },
        {"role": "user", "content": [{"text": "Next message"}]},
    ]
    exp_messages = [
        tru_messages[0],
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "first-123",
                        "status": "error",
                        "content": [{"text": "Tool was interrupted."}],
                    }
                }
            ],
        },
        tru_messages[1],
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "second-456",
                        "status": "error",
                        "content": [{"text": "Tool was interrupted."}],
                    }
                }
            ],
        },
        tru_messages[2],
    ]

    tru_fixed = session_manager._fix_broken_tool_use(tru_messages)

    # Each synthesized toolResult message is spliced in outside the append chokepoint, so it
    # carries its own durable tracking id. Assert those are present, then fold the actual ids into
    # the expected messages so the structural comparison still holds.
    assert tru_fixed[1]["tracking_id"] and tru_fixed[3]["tracking_id"]
    exp_messages[1]["tracking_id"] = tru_fixed[1]["tracking_id"]
    exp_messages[3]["tracking_id"] = tru_fixed[3]["tracking_id"]

    assert tru_fixed == exp_messages


def test_fix_broken_tool_use_does_not_change_valid_message(session_manager):
    """Test that orphaned toolUse in the last message is not fixed."""
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "last-message-123", "name": "test_tool", "input": {"input": "test"}}}
            ],
        },
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": "last-message-123", "input": {"input": "test"}, "status": "success"}}
            ],
        },
    ]
    expected = copy.deepcopy(messages)

    fixed_messages = session_manager._fix_broken_tool_use(messages)

    # Should remain unchanged since toolUse is in last message
    assert fixed_messages == expected


# ============================================================================
# BidiAgent Session Tests
# ============================================================================


@pytest.fixture
def mock_bidi_agent():
    """Create a mock BidiAgent for testing."""
    agent = Mock()
    agent.agent_id = "bidi-agent-1"
    agent.messages = [{"role": "user", "content": [{"text": "Hello from bidi!"}]}]
    agent.state = AgentState({"key": "value"})
    # BidiAgent doesn't have _interrupt_state yet
    return agent


def test_initialize_bidi_agent_creates_new(session_manager, mock_bidi_agent):
    """Test initializing a new BidiAgent creates session data."""
    session_manager.initialize_bidi_agent(mock_bidi_agent)

    # Verify agent created in repository
    agent_data = session_manager.session_repository.read_agent("test-session", "bidi-agent-1")
    assert agent_data is not None
    assert agent_data.agent_id == "bidi-agent-1"
    assert agent_data.conversation_manager_state == {}  # Empty for BidiAgent
    assert agent_data.state == {"key": "value"}

    # Verify message created
    messages = session_manager.session_repository.list_messages("test-session", "bidi-agent-1")
    assert len(messages) == 1
    assert messages[0].message["role"] == "user"


def test_initialize_bidi_agent_restores_existing(existing_session_manager, mock_bidi_agent):
    """Test initializing BidiAgent restores from existing session."""
    # Create existing session data
    session_agent = SessionAgent(
        agent_id="bidi-agent-1",
        state={"restored": "state"},
        conversation_manager_state={},  # Empty for BidiAgent
    )
    existing_session_manager.session_repository.create_agent("test-session", session_agent)

    # Add messages
    msg1 = SessionMessage.from_message({"role": "user", "content": [{"text": "Message 1"}]}, 0)
    msg2 = SessionMessage.from_message({"role": "assistant", "content": [{"text": "Response 1"}]}, 1)
    existing_session_manager.session_repository.create_message("test-session", "bidi-agent-1", msg1)
    existing_session_manager.session_repository.create_message("test-session", "bidi-agent-1", msg2)

    # Initialize agent
    existing_session_manager.initialize_bidi_agent(mock_bidi_agent)

    # Verify state restored
    assert mock_bidi_agent.state.get() == {"restored": "state"}

    # Verify messages restored
    assert len(mock_bidi_agent.messages) == 2
    assert mock_bidi_agent.messages[0]["role"] == "user"
    assert mock_bidi_agent.messages[1]["role"] == "assistant"


def test_append_bidi_message(session_manager, mock_bidi_agent):
    """Test appending messages to BidiAgent session."""
    # Initialize agent first
    session_manager.initialize_bidi_agent(mock_bidi_agent)

    # Append new message
    new_message = {"role": "assistant", "content": [{"text": "Response"}]}
    session_manager.append_bidi_message(new_message, mock_bidi_agent)

    # Verify message stored
    messages = session_manager.session_repository.list_messages("test-session", "bidi-agent-1")
    assert len(messages) == 2  # Initial + new
    assert messages[1].message["role"] == "assistant"


def test_sync_bidi_agent(session_manager, mock_bidi_agent):
    """Test syncing BidiAgent state to session."""
    # Initialize agent
    session_manager.initialize_bidi_agent(mock_bidi_agent)

    # Update agent state
    mock_bidi_agent.state = AgentState({"updated": "state"})

    # Sync agent
    session_manager.sync_bidi_agent(mock_bidi_agent)

    # Verify state updated in repository
    agent_data = session_manager.session_repository.read_agent("test-session", "bidi-agent-1")
    assert agent_data.state == {"updated": "state"}


def test_bidi_agent_no_conversation_manager(session_manager, mock_bidi_agent):
    """Test that BidiAgent session doesn't use conversation_manager."""
    session_manager.initialize_bidi_agent(mock_bidi_agent)

    # Verify conversation_manager_state is empty
    agent_data = session_manager.session_repository.read_agent("test-session", "bidi-agent-1")
    assert agent_data.conversation_manager_state == {}


def test_bidi_agent_unique_id_constraint(session_manager, mock_bidi_agent):
    """Test that BidiAgent agent_id must be unique in session."""
    # Initialize first agent
    session_manager.initialize_bidi_agent(mock_bidi_agent)

    # Try to initialize another agent with same ID
    agent2 = Mock()
    agent2.agent_id = "bidi-agent-1"  # Same ID
    agent2.messages = []
    agent2.state = AgentState({})

    with pytest.raises(SessionException, match="The `agent_id` of an agent must be unique in a session."):
        session_manager.initialize_bidi_agent(agent2)


def test_bidi_agent_messages_with_offset_zero(existing_session_manager, mock_bidi_agent):
    """Test that BidiAgent uses offset=0 for message restoration (no conversation_manager)."""
    # Create session with messages
    session_agent = SessionAgent(
        agent_id="bidi-agent-1",
        state={},
        conversation_manager_state={},
    )
    existing_session_manager.session_repository.create_agent("test-session", session_agent)

    # Add 5 messages
    for i in range(5):
        msg = SessionMessage.from_message({"role": "user", "content": [{"text": f"Message {i}"}]}, i)
        existing_session_manager.session_repository.create_message("test-session", "bidi-agent-1", msg)

    # Initialize agent
    existing_session_manager.initialize_bidi_agent(mock_bidi_agent)

    # Verify all messages restored (offset=0, no removed_message_count)
    assert len(mock_bidi_agent.messages) == 5


def test_fix_broken_tool_use_removes_orphaned_tool_result_at_start(session_manager):
    """Test that orphaned toolResult at the start of conversation is removed."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "orphaned-result-123",
                        "status": "success",
                        "content": [{"text": "Seattle, USA"}],
                    }
                }
            ],
        },
        {"role": "assistant", "content": [{"text": "You live in Seattle, USA."}]},
        {"role": "user", "content": [{"text": "I like pizza"}]},
    ]

    fixed_messages = session_manager._fix_broken_tool_use(messages)

    # Should remove the first message with orphaned toolResult
    assert len(fixed_messages) == 2
    assert fixed_messages[0]["role"] == "assistant"
    assert fixed_messages[0]["content"][0]["text"] == "You live in Seattle, USA."
    assert fixed_messages[1]["role"] == "user"
    assert fixed_messages[1]["content"][0]["text"] == "I like pizza"


def test_fix_broken_tool_use_does_not_affect_normal_conversations(session_manager):
    """Test that normal conversations without orphaned toolResults are unaffected."""
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Hi there!"}]},
        {"role": "user", "content": [{"text": "How are you?"}]},
    ]
    expected = copy.deepcopy(messages)

    fixed_messages = session_manager._fix_broken_tool_use(messages)

    # Should remain unchanged
    assert fixed_messages == expected


# ============================================================================
# Conditional Sync Tests
# ============================================================================


def test_sync_agent_skips_update_when_state_not_dirty_and_internal_state_unchanged(mock_repository):
    """Test that sync_agent() skips update_agent() when state is not dirty and internal state unchanged."""
    session_manager = RepositorySessionManager(session_id="test-session", session_repository=mock_repository)

    # Create and initialize agent
    agent = Agent(agent_id="test-agent", session_manager=session_manager)

    # Track update_agent calls
    update_agent_calls = []
    original_update_agent = mock_repository.update_agent

    def tracking_update_agent(session_id, session_agent):
        update_agent_calls.append((session_id, session_agent))
        return original_update_agent(session_id, session_agent)

    mock_repository.update_agent = tracking_update_agent

    # First sync should update (to establish baseline)
    session_manager.sync_agent(agent)
    assert len(update_agent_calls) == 1

    # Clear tracking
    update_agent_calls.clear()

    # Second sync without changes should skip update
    session_manager.sync_agent(agent)
    assert len(update_agent_calls) == 0


def test_sync_agent_calls_update_when_state_is_dirty(mock_repository):
    """Test that sync_agent() calls update_agent() when agent.state is dirty."""
    session_manager = RepositorySessionManager(session_id="test-session", session_repository=mock_repository)

    # Create and initialize agent
    agent = Agent(agent_id="test-agent", session_manager=session_manager)

    # Track update_agent calls
    update_agent_calls = []
    original_update_agent = mock_repository.update_agent

    def tracking_update_agent(session_id, session_agent):
        update_agent_calls.append((session_id, session_agent))
        return original_update_agent(session_id, session_agent)

    mock_repository.update_agent = tracking_update_agent

    # First sync to establish baseline
    session_manager.sync_agent(agent)
    update_agent_calls.clear()

    # Modify state (makes it dirty)
    agent.state.set("key", "value")

    # Sync should call update_agent because state is dirty
    session_manager.sync_agent(agent)
    assert len(update_agent_calls) == 1


def test_sync_agent_calls_update_when_internal_state_changed(mock_repository):
    """Test that sync_agent() calls update_agent() when internal state (interrupt_state) is dirty."""
    session_manager = RepositorySessionManager(session_id="test-session", session_repository=mock_repository)

    # Create and initialize agent
    agent = Agent(agent_id="test-agent", session_manager=session_manager)

    # Track update_agent calls
    update_agent_calls = []
    original_update_agent = mock_repository.update_agent

    def tracking_update_agent(session_id, session_agent):
        update_agent_calls.append((session_id, session_agent))
        return original_update_agent(session_id, session_agent)

    mock_repository.update_agent = tracking_update_agent

    # First sync to establish baseline
    session_manager.sync_agent(agent)
    update_agent_calls.clear()

    # Modify internal state (activate interrupt state which sets dirty flag)
    agent._interrupt_state.activate()

    # Sync should call update_agent because internal state is dirty
    session_manager.sync_agent(agent)
    assert len(update_agent_calls) == 1


def test_sync_agent_calls_update_when_conversation_manager_state_changed(mock_repository):
    """Test that sync_agent() calls update_agent() when conversation manager state changed."""
    session_manager = RepositorySessionManager(session_id="test-session", session_repository=mock_repository)

    # Create and initialize agent
    agent = Agent(agent_id="test-agent", session_manager=session_manager)

    # Track update_agent calls
    update_agent_calls = []
    original_update_agent = mock_repository.update_agent

    def tracking_update_agent(session_id, session_agent):
        update_agent_calls.append((session_id, session_agent))
        return original_update_agent(session_id, session_agent)

    mock_repository.update_agent = tracking_update_agent

    # First sync to establish baseline
    session_manager.sync_agent(agent)
    update_agent_calls.clear()

    # Modify conversation manager state
    agent.conversation_manager.removed_message_count = 5

    # Sync should call update_agent because conversation manager state changed
    session_manager.sync_agent(agent)
    assert len(update_agent_calls) == 1


def test_sync_agent_calls_update_when_model_state_changed(mock_repository):
    """Test that sync_agent() calls update_agent() when model state changed."""
    session_manager = RepositorySessionManager(session_id="test-session", session_repository=mock_repository)

    # Create and initialize agent
    agent = Agent(agent_id="test-agent", session_manager=session_manager)

    # Track update_agent calls
    update_agent_calls = []
    original_update_agent = mock_repository.update_agent

    def tracking_update_agent(session_id, session_agent):
        update_agent_calls.append((session_id, session_agent))
        return original_update_agent(session_id, session_agent)

    mock_repository.update_agent = tracking_update_agent

    # First sync to establish baseline
    session_manager.sync_agent(agent)
    update_agent_calls.clear()

    # Modify model state
    agent._model_state["response_id"] = "resp_abc123"

    # Sync should call update_agent because model state changed
    session_manager.sync_agent(agent)
    assert len(update_agent_calls) == 1


def test_sync_agent_tracks_version_after_successful_sync(mock_repository):
    """Test that sync_agent() tracks version after successful sync."""
    session_manager = RepositorySessionManager(session_id="test-session", session_repository=mock_repository)

    # Create and initialize agent
    agent = Agent(agent_id="test-agent", session_manager=session_manager)

    # First sync to establish baseline
    session_manager.sync_agent(agent)
    initial_version = agent.state._get_version()

    # Modify state (increments version)
    agent.state.set("key", "value")
    assert agent.state._get_version() == initial_version + 1

    # Track update_agent calls
    update_agent_calls = []
    original_update_agent = mock_repository.update_agent

    def tracking_update_agent(session_id, session_agent):
        update_agent_calls.append((session_id, session_agent))
        return original_update_agent(session_id, session_agent)

    mock_repository.update_agent = tracking_update_agent

    # Sync should update because version changed
    session_manager.sync_agent(agent)
    assert len(update_agent_calls) == 1

    # Second sync without changes should skip
    update_agent_calls.clear()
    session_manager.sync_agent(agent)
    assert len(update_agent_calls) == 0


def test_sync_agent_retries_on_failure(mock_repository):
    """Test that sync_agent() retries on next call if update_agent() fails."""
    session_manager = RepositorySessionManager(session_id="test-session", session_repository=mock_repository)

    # Create and initialize agent
    agent = Agent(agent_id="test-agent", session_manager=session_manager)

    # First sync to establish baseline
    session_manager.sync_agent(agent)

    # Modify state (increments version)
    agent.state.set("key", "value")

    # Make update_agent fail
    def failing_update_agent(session_id, session_agent):
        raise SessionException("Update failed")

    mock_repository.update_agent = failing_update_agent

    # Sync should fail
    with pytest.raises(SessionException, match="Update failed"):
        session_manager.sync_agent(agent)

    # Restore working update_agent
    update_agent_calls = []
    original_update_agent = MockedSessionRepository.update_agent

    def tracking_update_agent(self, session_id, session_agent):
        update_agent_calls.append((session_id, session_agent))
        return original_update_agent(self, session_id, session_agent)

    mock_repository.update_agent = lambda sid, sa: tracking_update_agent(mock_repository, sid, sa)

    # Retry should work because version wasn't updated on failure
    session_manager.sync_agent(agent)
    assert len(update_agent_calls) == 1


def test_sync_agent_first_sync_always_updates(mock_repository):
    """Test that the first sync_agent() call always updates (no previous state to compare)."""
    session_manager = RepositorySessionManager(session_id="test-session", session_repository=mock_repository)

    # Create and initialize agent
    agent = Agent(agent_id="test-agent", session_manager=session_manager)

    # Track update_agent calls
    update_agent_calls = []
    original_update_agent = mock_repository.update_agent

    def tracking_update_agent(session_id, session_agent):
        update_agent_calls.append((session_id, session_agent))
        return original_update_agent(session_id, session_agent)

    mock_repository.update_agent = tracking_update_agent

    # First sync should always update (no previous state)
    session_manager.sync_agent(agent)
    assert len(update_agent_calls) == 1


# ============================================================================
# New Session Optimization Tests (Issue #1828)
# ============================================================================


def test_is_new_session_true_when_session_created(mock_repository):
    """Test that _is_new_session is True when creating a new session."""
    # Session doesn't exist yet
    assert mock_repository.read_session("new-session") is None

    # Creating manager should set _is_new_session to True
    manager = RepositorySessionManager(session_id="new-session", session_repository=mock_repository)

    assert manager._is_new_session is True


def test_is_new_session_false_when_session_exists(mock_repository):
    """Test that _is_new_session is False when using an existing session."""
    # Create session first
    session = Session(session_id="existing-session", session_type=SessionType.AGENT)
    mock_repository.create_session(session)

    # Creating manager should set _is_new_session to False
    manager = RepositorySessionManager(session_id="existing-session", session_repository=mock_repository)

    assert manager._is_new_session is False


def test_initialize_skips_read_agent_for_new_session(mock_repository):
    """Test that initialize() skips read_agent() call when _is_new_session is True."""
    # Create manager (new session)
    manager = RepositorySessionManager(session_id="new-session", session_repository=mock_repository)
    assert manager._is_new_session is True

    # Track read_agent calls
    read_agent_calls = []
    original_read_agent = mock_repository.read_agent

    def tracking_read_agent(session_id, agent_id):
        read_agent_calls.append((session_id, agent_id))
        return original_read_agent(session_id, agent_id)

    mock_repository.read_agent = tracking_read_agent

    # Initialize agent
    agent = Agent(agent_id="test-agent")
    manager.initialize(agent)

    # read_agent should NOT be called for new session
    assert len(read_agent_calls) == 0


def test_initialize_calls_read_agent_for_existing_session(mock_repository):
    """Test that initialize() calls read_agent() when _is_new_session is False."""
    # Create session first
    session = Session(session_id="existing-session", session_type=SessionType.AGENT)
    mock_repository.create_session(session)

    # Create manager (existing session)
    manager = RepositorySessionManager(session_id="existing-session", session_repository=mock_repository)
    assert manager._is_new_session is False

    # Track read_agent calls
    read_agent_calls = []
    original_read_agent = mock_repository.read_agent

    def tracking_read_agent(session_id, agent_id):
        read_agent_calls.append((session_id, agent_id))
        return original_read_agent(session_id, agent_id)

    mock_repository.read_agent = tracking_read_agent

    # Initialize agent
    agent = Agent(agent_id="test-agent")
    manager.initialize(agent)

    # read_agent should be called for existing session
    assert len(read_agent_calls) == 1
    assert read_agent_calls[0] == ("existing-session", "test-agent")


def test_initialize_bidi_agent_skips_read_agent_for_new_session(mock_repository):
    """Test that initialize_bidi_agent() skips read_agent() call when _is_new_session is True."""
    # Create manager (new session)
    manager = RepositorySessionManager(session_id="new-session", session_repository=mock_repository)
    assert manager._is_new_session is True

    # Track read_agent calls
    read_agent_calls = []
    original_read_agent = mock_repository.read_agent

    def tracking_read_agent(session_id, agent_id):
        read_agent_calls.append((session_id, agent_id))
        return original_read_agent(session_id, agent_id)

    mock_repository.read_agent = tracking_read_agent

    # Create mock BidiAgent
    bidi_agent = Mock()
    bidi_agent.agent_id = "bidi-agent-1"
    bidi_agent.messages = [{"role": "user", "content": [{"text": "Hello!"}]}]
    bidi_agent.state = AgentState({})

    # Initialize bidi agent
    manager.initialize_bidi_agent(bidi_agent)

    # read_agent should NOT be called for new session
    assert len(read_agent_calls) == 0


def test_initialize_bidi_agent_calls_read_agent_for_existing_session(mock_repository):
    """Test that initialize_bidi_agent() calls read_agent() when _is_new_session is False."""
    # Create session first
    session = Session(session_id="existing-session", session_type=SessionType.AGENT)
    mock_repository.create_session(session)

    # Create manager (existing session)
    manager = RepositorySessionManager(session_id="existing-session", session_repository=mock_repository)
    assert manager._is_new_session is False

    # Track read_agent calls
    read_agent_calls = []
    original_read_agent = mock_repository.read_agent

    def tracking_read_agent(session_id, agent_id):
        read_agent_calls.append((session_id, agent_id))
        return original_read_agent(session_id, agent_id)

    mock_repository.read_agent = tracking_read_agent

    # Create mock BidiAgent
    bidi_agent = Mock()
    bidi_agent.agent_id = "bidi-agent-1"
    bidi_agent.messages = [{"role": "user", "content": [{"text": "Hello!"}]}]
    bidi_agent.state = AgentState({})

    # Initialize bidi agent
    manager.initialize_bidi_agent(bidi_agent)

    # read_agent should be called for existing session
    assert len(read_agent_calls) == 1
    assert read_agent_calls[0] == ("existing-session", "bidi-agent-1")


def test_initialize_multi_agent_skips_read_for_new_session(mock_repository):
    """Test that initialize_multi_agent() skips read_multi_agent() call when _is_new_session is True."""
    # Create manager (new session)
    manager = RepositorySessionManager(session_id="new-session", session_repository=mock_repository)
    assert manager._is_new_session is True

    # Track read_multi_agent calls
    read_multi_agent_calls = []
    original_read_multi_agent = mock_repository.read_multi_agent

    def tracking_read_multi_agent(session_id, multi_agent_id, **kwargs):
        read_multi_agent_calls.append((session_id, multi_agent_id))
        return original_read_multi_agent(session_id, multi_agent_id, **kwargs)

    mock_repository.read_multi_agent = tracking_read_multi_agent

    # Create mock multi-agent
    multi_agent = Mock()
    multi_agent.id = "test-multi-agent"
    multi_agent.serialize_state.return_value = {"id": "test-multi-agent", "state": {}}

    # Initialize multi-agent
    manager.initialize_multi_agent(multi_agent)

    # read_multi_agent should NOT be called for new session
    assert len(read_multi_agent_calls) == 0


def test_initialize_multi_agent_calls_read_for_existing_session(mock_repository):
    """Test that initialize_multi_agent() calls read_multi_agent() when _is_new_session is False."""
    # Create session first
    session = Session(session_id="existing-session", session_type=SessionType.AGENT)
    mock_repository.create_session(session)

    # Create manager (existing session)
    manager = RepositorySessionManager(session_id="existing-session", session_repository=mock_repository)
    assert manager._is_new_session is False

    # Track read_multi_agent calls
    read_multi_agent_calls = []
    original_read_multi_agent = mock_repository.read_multi_agent

    def tracking_read_multi_agent(session_id, multi_agent_id, **kwargs):
        read_multi_agent_calls.append((session_id, multi_agent_id))
        return original_read_multi_agent(session_id, multi_agent_id, **kwargs)

    mock_repository.read_multi_agent = tracking_read_multi_agent

    # Create mock multi-agent
    multi_agent = Mock()
    multi_agent.id = "test-multi-agent"
    multi_agent.serialize_state.return_value = {"id": "test-multi-agent", "state": {}}

    # Initialize multi-agent
    manager.initialize_multi_agent(multi_agent)

    # read_multi_agent should be called for existing session
    assert len(read_multi_agent_calls) == 1
    assert read_multi_agent_calls[0] == ("existing-session", "test-multi-agent")


def test_fix_broken_tool_use_removes_orphaned_tool_result_mid_conversation(session_manager):
    """Orphaned toolResult after a message that carries no toolUse is removed (issue #3651)."""
    messages = [
        {"role": "user", "content": [{"text": "Where do I live?"}]},
        {"role": "assistant", "content": [{"text": "You live in Seattle, USA."}]},
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "orphaned-result-123",
                        "status": "success",
                        "content": [{"text": "Seattle, USA"}],
                    }
                }
            ],
        },
        {"role": "assistant", "content": [{"text": "Anything else?"}]},
    ]

    fixed_messages = session_manager._fix_broken_tool_use(messages)

    assert fixed_messages == [
        {"role": "user", "content": [{"text": "Where do I live?"}]},
        {"role": "assistant", "content": [{"text": "You live in Seattle, USA."}]},
        {"role": "assistant", "content": [{"text": "Anything else?"}]},
    ]


def test_fix_broken_tool_use_keeps_non_tool_result_content_of_orphaned_message(session_manager):
    """Only the orphaned toolResult blocks are dropped; other content in that message survives."""
    messages = [
        {"role": "assistant", "content": [{"text": "Summary of earlier conversation."}]},
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "orphaned-result-123",
                        "status": "success",
                        "content": [{"text": "Seattle, USA"}],
                    }
                },
                {"text": "and what about Portland?"},
            ],
        },
    ]

    fixed_messages = session_manager._fix_broken_tool_use(messages)

    assert fixed_messages == [
        {"role": "assistant", "content": [{"text": "Summary of earlier conversation."}]},
        {"role": "user", "content": [{"text": "and what about Portland?"}]},
    ]


def test_fix_broken_tool_use_removes_orphaned_tool_result_after_prepended_message(session_manager):
    """A prepended summary message must not hide an orphaned toolResult at the window head."""
    messages = [
        {"role": "assistant", "content": [{"text": "Summary of earlier conversation."}]},
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "orphaned-result-123",
                        "status": "success",
                        "content": [{"text": "42"}],
                    }
                }
            ],
        },
        {"role": "assistant", "content": [{"text": "done"}]},
    ]

    fixed_messages = session_manager._fix_broken_tool_use(messages)

    assert fixed_messages == [
        {"role": "assistant", "content": [{"text": "Summary of earlier conversation."}]},
        {"role": "assistant", "content": [{"text": "done"}]},
    ]


def test_fix_broken_tool_use_keeps_paired_tool_result_after_a_text_turn(session_manager):
    """A toolResult that does follow a toolUse is left alone."""
    messages = [
        {"role": "user", "content": [{"text": "What is the weather?"}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "abc", "name": "weather", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "abc", "status": "success", "content": [{"text": "sunny"}]}}],
        },
        {"role": "assistant", "content": [{"text": "It is sunny."}]},
    ]
    expected = copy.deepcopy(messages)

    fixed_messages = session_manager._fix_broken_tool_use(messages)

    assert fixed_messages == expected
