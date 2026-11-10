"""Integration tests for session management."""

import os
import tempfile
from uuid import uuid4

import boto3
import pytest
from botocore.client import ClientError

from strands import Agent
from strands.agent.conversation_manager.sliding_window_conversation_manager import SlidingWindowConversationManager
from strands.models.openai_responses import OpenAIResponsesModel
from strands.session.file_session_manager import FileSessionManager
from strands.session.s3_session_manager import S3SessionManager
from tests_integ.models.providers import openai as openai_provider

# yellow_img imported from conftest


@pytest.fixture
def temp_dir():
    """Create a temporary directory for testing."""
    with tempfile.TemporaryDirectory() as temp_dir:
        yield temp_dir


@pytest.fixture
def bucket_name():
    bucket_name = f"test-strands-session-bucket-{boto3.client('sts').get_caller_identity()['Account']}"
    s3_client = boto3.resource("s3", region_name="us-west-2")
    try:
        s3_client.create_bucket(Bucket=bucket_name, CreateBucketConfiguration={"LocationConstraint": "us-west-2"})
    except ClientError as e:
        if "BucketAlreadyOwnedByYou" not in str(e):
            raise e
    yield bucket_name


def test_agent_with_file_session(temp_dir):
    # Set up the session manager and add an agent
    test_session_id = str(uuid4())
    # Create a session
    session_manager = FileSessionManager(session_id=test_session_id, storage_dir=temp_dir)
    try:
        agent = Agent(session_manager=session_manager)
        agent("Hello!")
        assert len(session_manager.list_messages(test_session_id, agent.agent_id)) == 2

        # After agent is persisted and run, restore the agent and run it again
        session_manager_2 = FileSessionManager(session_id=test_session_id, storage_dir=temp_dir)
        agent_2 = Agent(session_manager=session_manager_2)
        assert len(agent_2.messages) == 2
        agent_2("Hello!")
        assert len(agent_2.messages) == 4
        assert len(session_manager_2.list_messages(test_session_id, agent_2.agent_id)) == 4
    finally:
        # Delete the session
        session_manager.delete_session(test_session_id)
        assert session_manager.read_session(test_session_id) is None


def test_agent_with_file_session_and_conversation_manager(temp_dir):
    # Use window_size=2 because the sliding window now enforces that the first remaining
    # message after trimming is a user message (#2087). With a simple (no-tool) turn producing
    # [user, assistant], window_size=1 can never trim (the sole remaining message would be
    # assistant). window_size=2 keeps a valid [user, assistant] pair after trimming.
    test_session_id = str(uuid4())
    session_manager = FileSessionManager(session_id=test_session_id, storage_dir=temp_dir)
    try:
        agent = Agent(
            session_manager=session_manager, conversation_manager=SlidingWindowConversationManager(window_size=2)
        )
        # First call: 2 messages [user, assistant], fits in window — no trim
        agent("Hello!")
        assert len(agent.messages) == 2
        assert len(session_manager.list_messages(test_session_id, agent.agent_id)) == 2

        # Second call: 4 messages, exceeds window, trimmed back to 2 [user, assistant]
        agent("Hi again!")
        assert len(agent.messages) == 2
        assert agent.conversation_manager.removed_message_count == 2
        # Session manager persists ALL messages even though agent memory was trimmed
        assert len(session_manager.list_messages(test_session_id, agent.agent_id)) == 4

        # Restore agent from session — should load trimmed state
        session_manager_2 = FileSessionManager(session_id=test_session_id, storage_dir=temp_dir)
        agent_2 = Agent(
            session_manager=session_manager_2, conversation_manager=SlidingWindowConversationManager(window_size=2)
        )
        assert len(agent_2.messages) == 2
        assert agent_2.conversation_manager.removed_message_count == 2

        # Third call on restored agent: triggers another trim
        agent_2("Hello!")
        assert len(agent_2.messages) == 2
        assert agent_2.conversation_manager.removed_message_count == 4
        assert len(session_manager_2.list_messages(test_session_id, agent_2.agent_id)) == 6
    finally:
        session_manager.delete_session(test_session_id)
        assert session_manager.read_session(test_session_id) is None


def test_agent_with_file_session_with_image(temp_dir, yellow_img):
    test_session_id = str(uuid4())
    # Create a session
    session_manager = FileSessionManager(session_id=test_session_id, storage_dir=temp_dir)
    try:
        agent = Agent(session_manager=session_manager)
        agent([{"image": {"format": "png", "source": {"bytes": yellow_img}}}])
        assert len(session_manager.list_messages(test_session_id, agent.agent_id)) == 2

        # After agent is persisted and run, restore the agent and run it again
        session_manager_2 = FileSessionManager(session_id=test_session_id, storage_dir=temp_dir)
        agent_2 = Agent(session_manager=session_manager_2)
        assert len(agent_2.messages) == 2
        agent_2("Hello!")
        assert len(agent_2.messages) == 4
        assert len(session_manager_2.list_messages(test_session_id, agent_2.agent_id)) == 4
    finally:
        # Delete the session
        session_manager.delete_session(test_session_id)
        assert session_manager.read_session(test_session_id) is None


def test_agent_with_s3_session(bucket_name):
    test_session_id = str(uuid4())
    session_manager = S3SessionManager(session_id=test_session_id, bucket=bucket_name, region_name="us-west-2")
    try:
        agent = Agent(session_manager=session_manager)
        agent("Hello!")
        assert len(session_manager.list_messages(test_session_id, agent.agent_id)) == 2

        # After agent is persisted and run, restore the agent and run it again
        session_manager_2 = S3SessionManager(session_id=test_session_id, bucket=bucket_name, region_name="us-west-2")
        agent_2 = Agent(session_manager=session_manager_2)
        assert len(agent_2.messages) == 2
        agent_2("Hello!")
        assert len(agent_2.messages) == 4
        assert len(session_manager_2.list_messages(test_session_id, agent_2.agent_id)) == 4
    finally:
        session_manager.delete_session(test_session_id)
        assert session_manager.read_session(test_session_id) is None


def test_agent_with_s3_session_with_image(yellow_img, bucket_name):
    test_session_id = str(uuid4())
    session_manager = S3SessionManager(session_id=test_session_id, bucket=bucket_name, region_name="us-west-2")
    try:
        agent = Agent(session_manager=session_manager)
        agent([{"image": {"format": "png", "source": {"bytes": yellow_img}}}])
        assert len(session_manager.list_messages(test_session_id, agent.agent_id)) == 2

        # After agent is persisted and run, restore the agent and run it again
        session_manager_2 = S3SessionManager(session_id=test_session_id, bucket=bucket_name, region_name="us-west-2")
        agent_2 = Agent(session_manager=session_manager_2)
        assert len(agent_2.messages) == 2
        agent_2("Hello!")
        assert len(agent_2.messages) == 4
        assert len(session_manager_2.list_messages(test_session_id, agent_2.agent_id)) == 4
    finally:
        session_manager.delete_session(test_session_id)
        assert session_manager.read_session(test_session_id) is None


@openai_provider.mark
def test_agent_with_file_session_server_side_conversation(temp_dir):
    """Test that server-side conversation state survives session save/restore."""
    test_session_id = str(uuid4())
    session_manager = FileSessionManager(session_id=test_session_id, storage_dir=temp_dir)
    try:
        model = OpenAIResponsesModel(
            model_id="gpt-4o-mini",
            stateful=True,
            client_args={"api_key": os.getenv("OPENAI_API_KEY")},
        )
        agent = Agent(model=model, system_prompt="Reply in one short sentence.", session_manager=session_manager)

        agent("My name is Alice.")
        assert len(agent.messages) == 0

        # Simulate process restart: create new session manager and agent
        session_manager_2 = FileSessionManager(session_id=test_session_id, storage_dir=temp_dir)
        model_2 = OpenAIResponsesModel(
            model_id="gpt-4o-mini",
            stateful=True,
            client_args={"api_key": os.getenv("OPENAI_API_KEY")},
        )
        agent_2 = Agent(model=model_2, system_prompt="Reply in one short sentence.", session_manager=session_manager_2)

        assert len(agent_2.messages) == 0
        result = agent_2("What is my name?")
        assert "alice" in result.message["content"][0]["text"].lower()
    finally:
        session_manager.delete_session(test_session_id)
