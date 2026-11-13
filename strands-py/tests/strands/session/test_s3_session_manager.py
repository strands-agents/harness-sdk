"""Tests for S3SessionManager."""

import json
from unittest.mock import Mock

import boto3
import pytest
from botocore.config import Config as BotocoreConfig
from botocore.exceptions import ClientError
from moto import mock_aws

from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager
from strands.session.s3_session_manager import S3SessionManager
from strands.types.content import ContentBlock
from strands.types.exceptions import SessionException
from strands.types.session import Session, SessionAgent, SessionMessage, SessionType


@pytest.fixture
def mocked_aws():
    """
    Mock all AWS interactions
    Requires you to create your own boto3 clients
    """
    with mock_aws():
        yield


@pytest.fixture(scope="function")
def s3_bucket(mocked_aws):
    """S3 bucket name for testing."""
    # Create the bucket
    s3_client = boto3.client("s3", region_name="us-west-2")
    s3_client.create_bucket(Bucket="test-session-bucket", CreateBucketConfiguration={"LocationConstraint": "us-west-2"})
    return "test-session-bucket"


@pytest.fixture
def s3_manager(mocked_aws, s3_bucket):
    """Create S3SessionManager with mocked S3."""
    yield S3SessionManager(session_id="test", bucket=s3_bucket, prefix="sessions/", region_name="us-west-2")


def test__init__emits_deprecation_warning(mocked_aws, s3_bucket):
    """S3SessionManager is deprecated in favor of SnapshotSessionManager."""
    with pytest.warns(DeprecationWarning, match="S3SessionManager is deprecated"):
        S3SessionManager(session_id="test", bucket=s3_bucket, region_name="us-west-2")


@pytest.fixture
def sample_session():
    """Create sample session for testing."""
    return Session(
        session_id="test-session-123",
        session_type=SessionType.AGENT,
    )


@pytest.fixture
def sample_agent():
    """Create sample agent for testing."""
    return SessionAgent(
        agent_id="test-agent-456",
        state={"key": "value"},
        conversation_manager_state=NullConversationManager().get_state(),
    )


@pytest.fixture
def sample_message():
    """Create sample message for testing."""
    return SessionMessage.from_message(
        message={
            "role": "user",
            "content": [ContentBlock(text="test_message")],
        },
        index=0,
    )


def test_init_s3_session_manager(mocked_aws, s3_bucket):
    session_manager = S3SessionManager(session_id="test", bucket=s3_bucket)
    assert "strands-agents" in session_manager.client.meta.config.user_agent_extra


def test_init_s3_session_manager_with_config(mocked_aws, s3_bucket):
    session_manager = S3SessionManager(session_id="test", bucket=s3_bucket, boto_client_config=BotocoreConfig())
    assert "strands-agents" in session_manager.client.meta.config.user_agent_extra


def test_init_s3_session_manager_with_existing_user_agent(mocked_aws, s3_bucket):
    session_manager = S3SessionManager(
        session_id="test", bucket=s3_bucket, boto_client_config=BotocoreConfig(user_agent_extra="test")
    )
    assert "strands-agents" in session_manager.client.meta.config.user_agent_extra


def test_init_s3_session_manager_with_endpoint_url(mocked_aws, s3_bucket, monkeypatch):
    custom_endpoint = "http://localhost:9000"
    monkeypatch.setenv("MOTO_S3_CUSTOM_ENDPOINTS", custom_endpoint)
    session_manager = S3SessionManager(session_id="test", bucket=s3_bucket, endpoint_url=custom_endpoint)
    assert session_manager.client.meta.endpoint_url == custom_endpoint


def test_empty_prefix_session_roundtrip(mocked_aws, s3_bucket, sample_session, sample_agent):
    """Test that session data can be written and read back with default empty prefix."""
    manager = S3SessionManager(session_id="test", bucket=s3_bucket, prefix="", region_name="us-west-2")
    manager.create_session(sample_session)
    manager.create_agent(sample_session.session_id, sample_agent)

    result = manager.read_agent(sample_session.session_id, sample_agent.agent_id)
    assert result is not None
    assert result.agent_id == sample_agent.agent_id


def test_create_session(s3_manager, sample_session):
    """Test creating a session in S3."""
    result = s3_manager.create_session(sample_session)

    assert result == sample_session

    # Verify S3 object created
    key = f"{s3_manager._get_session_path(sample_session.session_id)}session.json"
    response = s3_manager.client.get_object(Bucket=s3_manager.bucket, Key=key)
    data = json.loads(response["Body"].read().decode("utf-8"))

    assert data["session_id"] == sample_session.session_id
    assert data["session_type"] == sample_session.session_type


def test_create_session_already_exists(s3_manager, sample_session):
    """Test creating a session in S3."""
    s3_manager.create_session(sample_session)

    with pytest.raises(SessionException):
        s3_manager.create_session(sample_session)


def test_read_session(s3_manager, sample_session):
    """Test reading a session from S3."""
    # Create session first
    s3_manager.create_session(sample_session)

    # Read it back
    result = s3_manager.read_session(sample_session.session_id)

    assert result.session_id == sample_session.session_id
    assert result.session_type == sample_session.session_type


def test_read_nonexistent_session(s3_manager):
    """Test reading a session that doesn't exist in S3."""
    with mock_aws():
        result = s3_manager.read_session("nonexistent-session")
        assert result is None


def test_delete_session(s3_manager, sample_session):
    """Test deleting a session from S3."""
    # Create session first
    s3_manager.create_session(sample_session)

    # Verify session exists
    key = f"{s3_manager._get_session_path(sample_session.session_id)}session.json"
    s3_manager.client.head_object(Bucket=s3_manager.bucket, Key=key)

    # Delete session
    s3_manager.delete_session(sample_session.session_id)

    # Verify deletion
    with pytest.raises(ClientError) as excinfo:
        s3_manager.client.head_object(Bucket=s3_manager.bucket, Key=key)
    assert excinfo.value.response["Error"]["Code"] == "404"


def test_create_agent(s3_manager, sample_session, sample_agent):
    """Test creating an agent in S3."""
    # Create session first
    s3_manager.create_session(sample_session)

    # Create agent
    s3_manager.create_agent(sample_session.session_id, sample_agent)

    # Verify S3 object created
    key = f"{s3_manager._get_agent_path(sample_session.session_id, sample_agent.agent_id)}agent.json"
    response = s3_manager.client.get_object(Bucket=s3_manager.bucket, Key=key)
    data = json.loads(response["Body"].read().decode("utf-8"))

    assert data["agent_id"] == sample_agent.agent_id
    assert data["state"] == sample_agent.state


def test_read_agent(s3_manager, sample_session, sample_agent):
    """Test reading an agent from S3."""
    # Create session and agent
    s3_manager.create_session(sample_session)
    s3_manager.create_agent(sample_session.session_id, sample_agent)

    # Read agent
    result = s3_manager.read_agent(sample_session.session_id, sample_agent.agent_id)

    assert result.agent_id == sample_agent.agent_id
    assert result.state == sample_agent.state


def test_read_nonexistent_agent(s3_manager, sample_session, sample_agent):
    """Test reading an agent from S3."""
    # Create session and agent
    s3_manager.create_session(sample_session)
    # Read agent
    result = s3_manager.read_agent(sample_session.session_id, "nonexistent_agent")

    assert result is None


def test_update_agent(s3_manager, sample_session, sample_agent):
    """Test updating an agent in S3."""
    # Create session and agent
    s3_manager.create_session(sample_session)
    s3_manager.create_agent(sample_session.session_id, sample_agent)

    # Update agent
    sample_agent.state = {"updated": "value"}
    s3_manager.update_agent(sample_session.session_id, sample_agent)

    # Verify update
    result = s3_manager.read_agent(sample_session.session_id, sample_agent.agent_id)
    assert result.state == {"updated": "value"}


def test_update_nonexistent_agent(s3_manager, sample_session, sample_agent):
    """Test updating an agent in S3."""
    # Create session and agent
    s3_manager.create_session(sample_session)

    with pytest.raises(SessionException):
        s3_manager.update_agent(sample_session.session_id, sample_agent)


def test_create_message(s3_manager, sample_session, sample_agent, sample_message):
    """Test creating a message in S3."""
    # Create session and agent
    s3_manager.create_session(sample_session)
    s3_manager.create_agent(sample_session.session_id, sample_agent)

    # Create message
    s3_manager.create_message(sample_session.session_id, sample_agent.agent_id, sample_message)

    # Verify S3 object created
    key = s3_manager._get_message_path(sample_session.session_id, sample_agent.agent_id, sample_message.message_id)
    response = s3_manager.client.get_object(Bucket=s3_manager.bucket, Key=key)
    data = json.loads(response["Body"].read().decode("utf-8"))

    assert data["message_id"] == sample_message.message_id


def test_read_message(s3_manager, sample_session, sample_agent, sample_message):
    """Test reading a message from S3."""
    # Create session, agent, and message
    s3_manager.create_session(sample_session)
    s3_manager.create_agent(sample_session.session_id, sample_agent)
    s3_manager.create_message(sample_session.session_id, sample_agent.agent_id, sample_message)

    # Read message
    result = s3_manager.read_message(sample_session.session_id, sample_agent.agent_id, sample_message.message_id)

    assert result.message_id == sample_message.message_id
    assert result.message["role"] == sample_message.message["role"]
    assert result.message["content"] == sample_message.message["content"]


def test_read_nonexistent_message(s3_manager, sample_session, sample_agent, sample_message):
    """Test reading a message from S3."""
    # Create session, agent, and message
    s3_manager.create_session(sample_session)
    s3_manager.create_agent(sample_session.session_id, sample_agent)

    # Read message
    result = s3_manager.read_message(sample_session.session_id, sample_agent.agent_id, 999)

    assert result is None


def test_list_messages_all(s3_manager, sample_session, sample_agent):
    """Test listing all messages from S3."""
    # Create session and agent
    s3_manager.create_session(sample_session)
    s3_manager.create_agent(sample_session.session_id, sample_agent)

    # Create multiple messages
    messages = []
    for i in range(5):
        message = SessionMessage(
            {
                "role": "user",
                "content": [ContentBlock(text=f"Message {i}")],
            },
            i,
        )
        messages.append(message)
        s3_manager.create_message(sample_session.session_id, sample_agent.agent_id, message)

    # List all messages
    result = s3_manager.list_messages(sample_session.session_id, sample_agent.agent_id)

    assert len(result) == 5


def test_list_messages_single_message(s3_manager, sample_session, sample_agent):
    """Test listing all messages from S3."""
    # Create session and agent
    s3_manager.create_session(sample_session)
    s3_manager.create_agent(sample_session.session_id, sample_agent)

    # Create single message
    message = SessionMessage(
        {
            "role": "user",
            "content": [ContentBlock(text="Single Message")],
        },
        0,
    )
    s3_manager.create_message(sample_session.session_id, sample_agent.agent_id, message)

    # List all messages
    result = s3_manager.list_messages(sample_session.session_id, sample_agent.agent_id)

    assert len(result) == 1


def test_list_no_messages(s3_manager, sample_session, sample_agent):
    """Test listing all messages from S3."""
    # Create session and agent
    s3_manager.create_session(sample_session)
    s3_manager.create_agent(sample_session.session_id, sample_agent)

    # List all messages
    result = s3_manager.list_messages(sample_session.session_id, sample_agent.agent_id)

    assert len(result) == 0


def test_list_messages_with_pagination(s3_manager, sample_session, sample_agent):
    """Test listing messages with pagination in S3."""
    # Create session and agent
    s3_manager.create_session(sample_session)
    s3_manager.create_agent(sample_session.session_id, sample_agent)

    # Create multiple messages
    for index in range(10):
        message = SessionMessage.from_message(
            message={
                "role": "user",
                "content": [ContentBlock(text="test_message")],
            },
            index=index,
        )
        s3_manager.create_message(sample_session.session_id, sample_agent.agent_id, message)

    # List with limit
    result = s3_manager.list_messages(sample_session.session_id, sample_agent.agent_id, limit=3)
    assert len(result) == 3

    # List with offset
    result = s3_manager.list_messages(sample_session.session_id, sample_agent.agent_id, offset=5)
    assert len(result) == 5


def test_update_message(s3_manager, sample_session, sample_agent, sample_message):
    """Test updating a message in S3."""
    # Create session, agent, and message
    s3_manager.create_session(sample_session)
    s3_manager.create_agent(sample_session.session_id, sample_agent)
    s3_manager.create_message(sample_session.session_id, sample_agent.agent_id, sample_message)

    # Update message
    sample_message.message["content"] = [ContentBlock(text="Updated content")]
    s3_manager.update_message(sample_session.session_id, sample_agent.agent_id, sample_message)

    # Verify update
    result = s3_manager.read_message(sample_session.session_id, sample_agent.agent_id, sample_message.message_id)
    assert result.message["content"][0]["text"] == "Updated content"


def test_update_nonexistent_message(s3_manager, sample_session, sample_agent, sample_message):
    """Test updating a message in S3."""
    # Create session, agent, and message
    s3_manager.create_session(sample_session)
    s3_manager.create_agent(sample_session.session_id, sample_agent)

    # Update message
    with pytest.raises(SessionException):
        s3_manager.update_message(sample_session.session_id, sample_agent.agent_id, sample_message)


@pytest.mark.parametrize(
    "prefix, expected_path",
    [
        ("", "session_test-id/"),
        ("sessions", "sessions/session_test-id/"),
        ("sessions/", "sessions/session_test-id/"),
        ("/sessions", "sessions/session_test-id/"),
        ("/sessions/", "sessions/session_test-id/"),
        ("a/b/c", "a/b/c/session_test-id/"),
        ("a/b/c/", "a/b/c/session_test-id/"),
    ],
)
def test__get_session_path_prefix_normalization(mocked_aws, s3_bucket, prefix, expected_path):
    """Test that _get_session_path normalizes prefix to avoid leading or double slashes."""
    manager = S3SessionManager(session_id="test", bucket=s3_bucket, prefix=prefix, region_name="us-west-2")
    assert manager._get_session_path("test-id") == expected_path


@pytest.mark.parametrize(
    "session_id",
    [
        "a/../b",
        "a/b",
    ],
)
def test__get_session_path_invalid_session_id(session_id, s3_manager):
    with pytest.raises(ValueError, match=f"session_id={session_id} | id cannot contain path separators"):
        s3_manager._get_session_path(session_id)


@pytest.mark.parametrize(
    "agent_id",
    [
        "a/../b",
        "a/b",
    ],
)
def test__get_agent_path_invalid_agent_id(agent_id, s3_manager):
    with pytest.raises(ValueError, match=f"agent_id={agent_id} | id cannot contain path separators"):
        s3_manager._get_agent_path("session1", agent_id)


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
def test__get_message_path_invalid_message_id(message_id, s3_manager):
    """Test that message_id that is not an integer raises ValueError."""
    with pytest.raises(ValueError, match=r"message_id=<.*> \| message id must be an integer"):
        s3_manager._get_message_path("session1", "agent1", message_id)


@pytest.fixture
def mock_multi_agent():
    """Create mock multi-agent for testing."""

    mock = Mock()
    mock.id = "test-multi-agent"
    mock.state = {"key": "value"}
    mock.serialize_state.return_value = {"id": "test-multi-agent", "state": {"key": "value"}}
    return mock


def test_create_multi_agent(s3_manager, sample_session, mock_multi_agent):
    """Test creating multi-agent state in S3."""
    s3_manager.create_session(sample_session)
    s3_manager.create_multi_agent(sample_session.session_id, mock_multi_agent)

    # Verify S3 object created
    key = f"{s3_manager._get_multi_agent_path(sample_session.session_id, mock_multi_agent.id)}multi_agent.json"
    response = s3_manager.client.get_object(Bucket=s3_manager.bucket, Key=key)
    data = json.loads(response["Body"].read().decode("utf-8"))

    assert data["id"] == mock_multi_agent.id
    assert data["state"] == mock_multi_agent.state


def test_read_multi_agent(s3_manager, sample_session, mock_multi_agent):
    """Test reading multi-agent state from S3."""
    # Create session and multi-agent
    s3_manager.create_session(sample_session)
    s3_manager.create_multi_agent(sample_session.session_id, mock_multi_agent)

    # Read multi-agent
    result = s3_manager.read_multi_agent(sample_session.session_id, mock_multi_agent.id)

    assert result["id"] == mock_multi_agent.id
    assert result["state"] == mock_multi_agent.state


def test_read_nonexistent_multi_agent(s3_manager, sample_session):
    """Test reading multi-agent state that doesn't exist."""
    s3_manager.create_session(sample_session)
    result = s3_manager.read_multi_agent(sample_session.session_id, "nonexistent")
    assert result is None


def test_update_multi_agent(s3_manager, sample_session, mock_multi_agent):
    """Test updating multi-agent state in S3."""
    # Create session and multi-agent
    s3_manager.create_session(sample_session)
    s3_manager.create_multi_agent(sample_session.session_id, mock_multi_agent)

    updated_mock = Mock()
    updated_mock.id = mock_multi_agent.id
    updated_mock.serialize_state.return_value = {"id": mock_multi_agent.id, "state": {"updated": "value"}}
    s3_manager.update_multi_agent(sample_session.session_id, updated_mock)

    # Verify update
    result = s3_manager.read_multi_agent(sample_session.session_id, mock_multi_agent.id)
    assert result["state"] == {"updated": "value"}


def test_update_nonexistent_multi_agent(s3_manager, sample_session):
    """Test updating multi-agent state that doesn't exist."""
    # Create session
    s3_manager.create_session(sample_session)

    nonexistent_mock = Mock()
    nonexistent_mock.id = "nonexistent"
    with pytest.raises(SessionException):
        s3_manager.update_multi_agent(sample_session.session_id, nonexistent_mock)
