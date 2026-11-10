"""Integration tests for snapshot-based session management."""

import asyncio
import os
import tempfile
from uuid import uuid4

import boto3
import pytest
from botocore.client import ClientError

from strands import Agent
from strands.models.openai_responses import OpenAIResponsesModel
from strands.session.snapshot_session_manager import SnapshotSessionManager
from strands.storage import LocalFileStorage, S3Storage
from tests_integ.models.providers import openai as openai_provider

# yellow_img imported from conftest


@pytest.fixture
def temp_dir():
    """Create a temporary directory for testing."""
    with tempfile.TemporaryDirectory() as temp_dir:
        yield temp_dir


@pytest.fixture
def bucket_name():
    # Shares the bucket the message-log session tests use, because the integ-test IAM role only
    # grants S3 access to an explicit allowlist of bucket names. Snapshots key under "session/"
    # while the message log keys under "session_<id>", so the two cannot collide.
    bucket_name = f"test-strands-session-bucket-{boto3.client('sts').get_caller_identity()['Account']}"
    s3_client = boto3.resource("s3", region_name="us-west-2")
    try:
        s3_client.create_bucket(Bucket=bucket_name, CreateBucketConfiguration={"LocationConstraint": "us-west-2"})
    except ClientError as error:
        if "BucketAlreadyOwnedByYou" not in str(error):
            raise error
    yield bucket_name


def test_agent_with_file_snapshot_session(temp_dir):
    """A fresh agent rehydrates its conversation from a file-backed snapshot."""
    test_session_id = str(uuid4())
    manager = SnapshotSessionManager(test_session_id, storage=LocalFileStorage(temp_dir))
    agent = Agent(session_manager=manager)
    agent("Hello!")
    assert len(agent.messages) == 2

    # Simulate process restart: new manager + agent over the same storage.
    manager_2 = SnapshotSessionManager(test_session_id, storage=LocalFileStorage(temp_dir))
    agent_2 = Agent(session_manager=manager_2)
    assert len(agent_2.messages) == 2
    agent_2("Hello again!")
    assert len(agent_2.messages) == 4


def test_agent_with_file_snapshot_session_with_image(temp_dir, yellow_img):
    """Image bytes survive a snapshot round-trip across instances."""
    test_session_id = str(uuid4())
    manager = SnapshotSessionManager(test_session_id, storage=LocalFileStorage(temp_dir))
    agent = Agent(session_manager=manager)
    agent([{"image": {"format": "png", "source": {"bytes": yellow_img}}}])
    assert len(agent.messages) == 2

    manager_2 = SnapshotSessionManager(test_session_id, storage=LocalFileStorage(temp_dir))
    agent_2 = Agent(session_manager=manager_2)
    assert agent_2.messages[0]["content"][0]["image"]["source"]["bytes"] == yellow_img


def test_agent_with_s3_snapshot_session(bucket_name):
    """A fresh agent rehydrates its conversation from an S3-backed snapshot."""
    test_session_id = str(uuid4())
    store = S3Storage(bucket=bucket_name, region_name="us-west-2")
    manager = SnapshotSessionManager(test_session_id, storage=store)
    try:
        agent = Agent(session_manager=manager)
        agent("Hello!")
        assert len(agent.messages) == 2

        manager_2 = SnapshotSessionManager(
            test_session_id, storage=S3Storage(bucket=bucket_name, region_name="us-west-2")
        )
        agent_2 = Agent(session_manager=manager_2)
        assert len(agent_2.messages) == 2
        agent_2("Hello again!")
        assert len(agent_2.messages) == 4
    finally:
        asyncio.run(manager.delete_session())


def test_snapshot_session_time_travel(temp_dir):
    """Immutable checkpoints allow restoring an agent to an earlier turn."""
    test_session_id = str(uuid4())
    store = LocalFileStorage(temp_dir)
    manager = SnapshotSessionManager(test_session_id, storage=store, snapshot_trigger=lambda *, agent_data, **_: True)
    agent = Agent(session_manager=manager)
    agent("My favorite color is blue.")
    agent("My favorite number is seven.")

    ids = asyncio.run(manager.list_snapshot_ids(agent))
    assert len(ids) == 2

    # Restore to the first checkpoint: only the first turn should be present.
    restored = asyncio.run(manager.restore_snapshot(agent, snapshot_id=ids[0]))
    assert restored is True
    assert len(agent.messages) == 2


@openai_provider.mark
def test_agent_with_snapshot_session_server_side_conversation(temp_dir):
    """Server-side conversation state survives snapshot save/restore for a stateful model."""
    test_session_id = str(uuid4())
    store = LocalFileStorage(temp_dir)
    manager = SnapshotSessionManager(test_session_id, storage=store)

    model = OpenAIResponsesModel(
        model_id="gpt-4o-mini",
        stateful=True,
        client_args={"api_key": os.getenv("OPENAI_API_KEY")},
    )
    agent = Agent(model=model, system_prompt="Reply in one short sentence.", session_manager=manager)
    agent("My name is Alice.")
    assert len(agent.messages) == 0

    # Simulate process restart.
    manager_2 = SnapshotSessionManager(test_session_id, storage=LocalFileStorage(temp_dir))
    model_2 = OpenAIResponsesModel(
        model_id="gpt-4o-mini",
        stateful=True,
        client_args={"api_key": os.getenv("OPENAI_API_KEY")},
    )
    agent_2 = Agent(model=model_2, system_prompt="Reply in one short sentence.", session_manager=manager_2)
    assert len(agent_2.messages) == 0
    result = agent_2("What is my name?")
    assert "alice" in result.message["content"][0]["text"].lower()
