"""Tests for FileSessionManager."""

import json
import os
import tempfile
from unittest.mock import Mock, patch

import pytest

from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager
from strands.session.file_session_manager import FileSessionManager
from strands.types.content import ContentBlock
from strands.types.exceptions import SessionException
from strands.types.session import Session, SessionAgent, SessionMessage, SessionType


@pytest.fixture
def temp_dir():
    """Create a temporary directory for testing."""
    with tempfile.TemporaryDirectory() as temp_dir:
        yield temp_dir


@pytest.fixture
def file_manager(temp_dir):
    """Create FileSessionManager for testing."""
    return FileSessionManager(session_id="test", storage_dir=temp_dir)


@pytest.fixture
def sample_session():
    """Create sample session for testing."""
    return Session(session_id="test-session", session_type=SessionType.AGENT)


@pytest.fixture
def sample_agent():
    """Create sample agent for testing."""
    return SessionAgent(
        agent_id="test-agent", state={"key": "value"}, conversation_manager_state=NullConversationManager().get_state()
    )


@pytest.fixture
def sample_message():
    """Create sample message for testing."""
    return SessionMessage.from_message(
        message={
            "role": "user",
            "content": [ContentBlock(text="Hello world")],
        },
        index=0,
    )


@pytest.fixture
def mock_multi_agent():
    """Create mock multi-agent for testing."""
    mock = Mock()
    mock.id = "test-multi-agent"
    mock.state = {"key": "value"}
    mock.serialize_state.return_value = {"id": "test-multi-agent", "state": {"key": "value"}}
    return mock


@pytest.fixture
def multi_agent_manager(temp_dir):
    """Create FileSessionManager."""
    return FileSessionManager(session_id="test", storage_dir=temp_dir)


def test_create_session(file_manager, sample_session):
    """Test creating a session."""
    file_manager.create_session(sample_session)

    # Verify directory structure created
    session_path = file_manager._get_session_path(sample_session.session_id)
    assert os.path.exists(session_path)

    # Verify session file created
    session_file = os.path.join(session_path, "session.json")
    assert os.path.exists(session_file)

    # Verify content
    with open(session_file) as f:
        data = json.load(f)
        assert data["session_id"] == sample_session.session_id
        assert data["session_type"] == sample_session.session_type


def test_read_session(file_manager, sample_session):
    """Test reading an existing session."""
    # Create session first
    file_manager.create_session(sample_session)

    # Read it back
    result = file_manager.read_session(sample_session.session_id)

    assert result.session_id == sample_session.session_id
    assert result.session_type == sample_session.session_type


def test_read_nonexistent_session(file_manager):
    """Test reading a session that doesn't exist."""
    result = file_manager.read_session("nonexistent-session")
    assert result is None


def test_delete_session(file_manager, sample_session):
    """Test deleting a session."""
    # Create session first
    file_manager.create_session(sample_session)
    session_path = file_manager._get_session_path(sample_session.session_id)
    assert os.path.exists(session_path)

    # Delete session
    file_manager.delete_session(sample_session.session_id)

    # Verify deletion
    assert not os.path.exists(session_path)


def test_delete_nonexistent_session(file_manager):
    """Test deleting a session that doesn't exist."""
    # Should raise an error according to the implementation
    with pytest.raises(SessionException, match="does not exist"):
        file_manager.delete_session("nonexistent-session")


def test_create_agent(file_manager, sample_session, sample_agent):
    """Test creating an agent in a session."""
    # Create session first
    file_manager.create_session(sample_session)

    # Create agent
    file_manager.create_agent(sample_session.session_id, sample_agent)

    # Verify directory structure
    agent_path = file_manager._get_agent_path(sample_session.session_id, sample_agent.agent_id)
    assert os.path.exists(agent_path)

    # Verify agent file
    agent_file = os.path.join(agent_path, "agent.json")
    assert os.path.exists(agent_file)

    # Verify content
    with open(agent_file) as f:
        data = json.load(f)
        assert data["agent_id"] == sample_agent.agent_id
        assert data["state"] == sample_agent.state


def test_read_agent(file_manager, sample_session, sample_agent):
    """Test reading an agent from a session."""
    # Create session and agent
    file_manager.create_session(sample_session)
    file_manager.create_agent(sample_session.session_id, sample_agent)

    # Read agent
    result = file_manager.read_agent(sample_session.session_id, sample_agent.agent_id)

    assert result.agent_id == sample_agent.agent_id
    assert result.state == sample_agent.state


def test_read_nonexistent_agent(file_manager, sample_session):
    """Test reading an agent that doesn't exist."""
    result = file_manager.read_agent(sample_session.session_id, "nonexistent_agent")
    assert result is None


def test_update_agent(file_manager, sample_session, sample_agent):
    """Test updating an agent."""
    # Create session and agent
    file_manager.create_session(sample_session)
    file_manager.create_agent(sample_session.session_id, sample_agent)

    # Update agent
    sample_agent.state = {"updated": "value"}
    file_manager.update_agent(sample_session.session_id, sample_agent)

    # Verify update
    result = file_manager.read_agent(sample_session.session_id, sample_agent.agent_id)
    assert result.state == {"updated": "value"}


def test_update_nonexistent_agent(file_manager, sample_session, sample_agent):
    """Test updating an agent."""
    # Create session and agent
    file_manager.create_session(sample_session)

    # Update agent
    with pytest.raises(SessionException):
        file_manager.update_agent(sample_session.session_id, sample_agent)


def test_create_message(file_manager, sample_session, sample_agent, sample_message):
    """Test creating a message for an agent."""
    # Create session and agent
    file_manager.create_session(sample_session)
    file_manager.create_agent(sample_session.session_id, sample_agent)

    # Create message
    file_manager.create_message(sample_session.session_id, sample_agent.agent_id, sample_message)

    # Verify message file
    message_path = file_manager._get_message_path(
        sample_session.session_id, sample_agent.agent_id, sample_message.message_id
    )
    assert os.path.exists(message_path)

    # Verify content
    with open(message_path) as f:
        data = json.load(f)
        assert data["message_id"] == sample_message.message_id


def test_message_durable_id_persists(file_manager, sample_session, sample_agent):
    """The durable message id is written to disk and survives a create/read round-trip."""
    file_manager.create_session(sample_session)
    file_manager.create_agent(sample_session.session_id, sample_agent)

    message = SessionMessage.from_message(
        message={"role": "user", "content": [ContentBlock(text="Hello")], "tracking_id": "durable-1"},
        index=0,
    )
    file_manager.create_message(sample_session.session_id, sample_agent.agent_id, message)

    message_path = file_manager._get_message_path(sample_session.session_id, sample_agent.agent_id, message.message_id)
    with open(message_path) as f:
        data = json.load(f)
    assert data["message"]["tracking_id"] == "durable-1"

    result = file_manager.read_message(sample_session.session_id, sample_agent.agent_id, message.message_id)
    assert result.to_message()["tracking_id"] == "durable-1"


def test_read_message(file_manager, sample_session, sample_agent, sample_message):
    """Test reading a message."""
    # Create session, agent, and message
    file_manager.create_session(sample_session)
    file_manager.create_agent(sample_session.session_id, sample_agent)
    file_manager.create_message(sample_session.session_id, sample_agent.agent_id, sample_message)

    # Create multiple messages when reading
    sample_message.message_id = sample_message.message_id + 1
    file_manager.create_message(sample_session.session_id, sample_agent.agent_id, sample_message)

    # Read message
    result = file_manager.read_message(sample_session.session_id, sample_agent.agent_id, sample_message.message_id)

    assert result.message_id == sample_message.message_id
    assert result.message["role"] == sample_message.message["role"]
    assert result.message["content"] == sample_message.message["content"]


def test_read_messages_with_new_agent(file_manager, sample_session, sample_agent):
    """Test reading a message with with a new agent."""
    # Create session and agent
    file_manager.create_session(sample_session)
    file_manager.create_agent(sample_session.session_id, sample_agent)

    result = file_manager.read_message(sample_session.session_id, sample_agent.agent_id, 999)

    assert result is None


def test_read_nonexistent_message(file_manager, sample_session, sample_agent):
    """Test reading a message that doesnt exist."""
    result = file_manager.read_message(sample_session.session_id, sample_agent.agent_id, 999)
    assert result is None


def test_list_messages_all(file_manager, sample_session, sample_agent):
    """Test listing all messages for an agent."""
    # Create session and agent
    file_manager.create_session(sample_session)
    file_manager.create_agent(sample_session.session_id, sample_agent)

    # Create multiple messages
    messages = []
    for i in range(5):
        message = SessionMessage(
            message={
                "role": "user",
                "content": [ContentBlock(text=f"Message {i}")],
            },
            message_id=i,
        )
        messages.append(message)
        file_manager.create_message(sample_session.session_id, sample_agent.agent_id, message)

    # List all messages
    result = file_manager.list_messages(sample_session.session_id, sample_agent.agent_id)

    assert len(result) == 5


def test_list_messages_with_limit(file_manager, sample_session, sample_agent):
    """Test listing messages with limit."""
    # Create session and agent
    file_manager.create_session(sample_session)
    file_manager.create_agent(sample_session.session_id, sample_agent)

    # Create multiple messages
    for i in range(10):
        message = SessionMessage(
            message={
                "role": "user",
                "content": [ContentBlock(text=f"Message {i}")],
            },
            message_id=i,
        )
        file_manager.create_message(sample_session.session_id, sample_agent.agent_id, message)

    # List with limit
    result = file_manager.list_messages(sample_session.session_id, sample_agent.agent_id, limit=3)

    assert len(result) == 3


def test_list_messages_with_offset(file_manager, sample_session, sample_agent):
    """Test listing messages with offset."""
    # Create session and agent
    file_manager.create_session(sample_session)
    file_manager.create_agent(sample_session.session_id, sample_agent)

    # Create multiple messages
    for i in range(10):
        message = SessionMessage(
            message={
                "role": "user",
                "content": [ContentBlock(text=f"Message {i}")],
            },
            message_id=i,
        )
        file_manager.create_message(sample_session.session_id, sample_agent.agent_id, message)

    # List with offset
    result = file_manager.list_messages(sample_session.session_id, sample_agent.agent_id, offset=5)

    assert len(result) == 5


def test_list_messages_with_new_agent(file_manager, sample_session, sample_agent):
    """Test listing messages with new agent."""
    # Create session and agent
    file_manager.create_session(sample_session)
    file_manager.create_agent(sample_session.session_id, sample_agent)

    result = file_manager.list_messages(sample_session.session_id, sample_agent.agent_id)

    assert len(result) == 0


def test_update_message(file_manager, sample_session, sample_agent, sample_message):
    """Test updating a message."""
    # Create session, agent, and message
    file_manager.create_session(sample_session)
    file_manager.create_agent(sample_session.session_id, sample_agent)
    file_manager.create_message(sample_session.session_id, sample_agent.agent_id, sample_message)

    # Update message
    sample_message.message["content"] = [ContentBlock(text="Updated content")]
    file_manager.update_message(sample_session.session_id, sample_agent.agent_id, sample_message)

    # Verify update
    result = file_manager.read_message(sample_session.session_id, sample_agent.agent_id, sample_message.message_id)
    assert result.message["content"][0]["text"] == "Updated content"


def test_update_nonexistent_message(file_manager, sample_session, sample_agent, sample_message):
    """Test updating a message."""
    # Create session, agent, and message
    file_manager.create_session(sample_session)
    file_manager.create_agent(sample_session.session_id, sample_agent)

    # Update nonexistent message
    with pytest.raises(SessionException):
        file_manager.update_message(sample_session.session_id, sample_agent.agent_id, sample_message)


def test_corrupted_json_file(file_manager, temp_dir):
    """Test handling of corrupted JSON files."""
    # Create a corrupted session file
    session_path = os.path.join(temp_dir, "session_test")
    os.makedirs(session_path, exist_ok=True)
    session_file = os.path.join(session_path, "session.json")

    with open(session_file, "w") as f:
        f.write("invalid json content")

    # Should raise SessionException
    with pytest.raises(SessionException, match="Invalid JSON"):
        file_manager._read_file(session_file)


def test_permission_error_handling(file_manager):
    """Test handling of permission errors."""
    with patch("builtins.open", side_effect=PermissionError("Access denied")):
        session = Session(session_id="test", session_type=SessionType.AGENT)

        with pytest.raises(SessionException):
            file_manager.create_session(session)


@pytest.mark.parametrize(
    "session_id",
    [
        "a/../b",
        "a/b",
    ],
)
def test__get_session_path_invalid_session_id(session_id, file_manager):
    with pytest.raises(ValueError, match=f"session_id={session_id} | id cannot contain path separators"):
        file_manager._get_session_path(session_id)


@pytest.mark.parametrize(
    "agent_id",
    [
        "a/../b",
        "a/b",
    ],
)
def test__get_agent_path_invalid_agent_id(agent_id, file_manager):
    with pytest.raises(ValueError, match=f"agent_id={agent_id} | id cannot contain path separators"):
        file_manager._get_agent_path("session1", agent_id)


@pytest.mark.parametrize(
    "message_id",
    [
        "../../../secret",
        "../../attack",
        "../escape",
        "path/traversal",
        "not_an_int",
        None,
        [],
    ],
)
def test__get_message_path_invalid_message_id(message_id, file_manager):
    """Test that message_id that is not an integer raises ValueError."""
    with pytest.raises(ValueError, match=r"message_id=<.*> \| message id must be an integer"):
        file_manager._get_message_path("session1", "agent1", message_id)


def test_create_multi_agent(multi_agent_manager, sample_session, mock_multi_agent):
    """Test creating multi-agent state."""
    multi_agent_manager.create_session(sample_session)
    multi_agent_manager.create_multi_agent(sample_session.session_id, mock_multi_agent)

    # Verify file created
    multi_agent_file = os.path.join(
        multi_agent_manager._get_multi_agent_path(sample_session.session_id, mock_multi_agent.id),
        "multi_agent.json",
    )
    assert os.path.exists(multi_agent_file)

    # Verify content
    with open(multi_agent_file) as f:
        data = json.load(f)
        assert data["id"] == mock_multi_agent.id
        assert data["state"] == mock_multi_agent.state


def test_read_multi_agent(multi_agent_manager, sample_session, mock_multi_agent):
    """Test reading multi-agent state."""
    # Create session and multi-agent
    multi_agent_manager.create_session(sample_session)
    multi_agent_manager.create_multi_agent(sample_session.session_id, mock_multi_agent)

    # Read multi-agent
    result = multi_agent_manager.read_multi_agent(sample_session.session_id, mock_multi_agent.id)

    assert result["id"] == mock_multi_agent.id
    assert result["state"] == mock_multi_agent.state


def test_read_nonexistent_multi_agent(multi_agent_manager, sample_session):
    """Test reading multi-agent state that doesn't exist."""
    result = multi_agent_manager.read_multi_agent(sample_session.session_id, "nonexistent")
    assert result is None


def test_update_multi_agent(multi_agent_manager, sample_session, mock_multi_agent):
    """Test updating multi-agent state."""
    # Create session and multi-agent
    multi_agent_manager.create_session(sample_session)
    multi_agent_manager.create_multi_agent(sample_session.session_id, mock_multi_agent)

    updated_mock = Mock()
    updated_mock.id = mock_multi_agent.id
    updated_mock.serialize_state.return_value = {"id": mock_multi_agent.id, "state": {"updated": "value"}}
    multi_agent_manager.update_multi_agent(sample_session.session_id, updated_mock)

    # Verify update
    result = multi_agent_manager.read_multi_agent(sample_session.session_id, mock_multi_agent.id)
    assert result["state"] == {"updated": "value"}


def test_update_nonexistent_multi_agent(multi_agent_manager, sample_session):
    """Test updating multi-agent state that doesn't exist."""
    # Create session
    multi_agent_manager.create_session(sample_session)

    nonexistent_mock = Mock()
    nonexistent_mock.id = "nonexistent"
    with pytest.raises(SessionException):
        multi_agent_manager.update_multi_agent(sample_session.session_id, nonexistent_mock)


def test_create_session_multi_agent_directory_structure(multi_agent_manager, sample_session):
    """Test multi-agent session creates correct directory structure."""
    multi_agent_manager.create_session(sample_session)

    # Verify directory structure
    session_dir = multi_agent_manager._get_session_path(sample_session.session_id)
    multi_agents_dir = os.path.join(session_dir, "multi_agents")

    assert os.path.exists(session_dir)
    assert os.path.exists(multi_agents_dir)
