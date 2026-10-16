"""S3-based session manager for cloud storage."""

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import TYPE_CHECKING, Any, cast

import boto3
from botocore.config import Config as BotocoreConfig
from botocore.exceptions import ClientError
from typing_extensions import deprecated

from .. import _identifier
from ..types.exceptions import SessionException
from ..types.session import Session, SessionAgent, SessionMessage
from .repository_session_manager import RepositorySessionManager
from .session_repository import SessionRepository

if TYPE_CHECKING:
    from mypy_boto3_s3.type_defs import ObjectIdentifierTypeDef

    from ..multiagent.base import MultiAgentBase

logger = logging.getLogger(__name__)

SESSION_PREFIX = "session_"
AGENT_PREFIX = "agent_"
MESSAGE_PREFIX = "message_"
MULTI_AGENT_PREFIX = "multi_agent_"


@deprecated(
    "S3SessionManager is deprecated and will be removed in v2.0.0. "
    "Use SnapshotSessionManager with an S3Storage backend instead. See the migration guide: "
    "https://strandsagents.com/docs/user-guide/sdk/agents/session-management/#migrating-from-the-message-log-session-managers"
)
class S3SessionManager(RepositorySessionManager, SessionRepository):
    """S3-based session manager for cloud storage.

    .. deprecated:: 1.x
        Deprecated and will be removed in v2.0.0. Use
        :class:`~strands.session.snapshot_session_manager.SnapshotSessionManager` with an
        ``S3Storage`` backend instead. See the migration guide linked in the deprecation
        warning above.

    Creates the following filesystem structure for the session storage:
    ```bash
    /<sessions_dir>/
    └── session_<session_id>/
        ├── session.json                # Session metadata
        └── agents/
            └── agent_<agent_id>/
                ├── agent.json          # Agent metadata
                └── messages/
                    ├── message_<id1>.json
                    └── message_<id2>.json
    ```
    """

    def __init__(
        self,
        session_id: str,
        bucket: str,
        prefix: str = "",
        boto_session: boto3.Session | None = None,
        boto_client_config: BotocoreConfig | None = None,
        region_name: str | None = None,
        endpoint_url: str | None = None,
        **kwargs: Any,
    ):
        """Initialize S3SessionManager with S3 storage.

        Args:
            session_id: ID for the session
                ID is not allowed to contain path separators (e.g., a/b).
            bucket: S3 bucket name (required)
            prefix: S3 key prefix for storage organization
            boto_session: Optional boto3 session
            boto_client_config: Optional boto3 client configuration
            region_name: AWS region for S3 storage
            endpoint_url: Custom endpoint URL for S3-compatible storage backends (e.g., MinIO, LocalStack)
                or VPC endpoints (PrivateLink)
            **kwargs: Additional keyword arguments for future extensibility.
        """
        self.bucket = bucket
        self.prefix = prefix

        session = boto_session or boto3.Session(region_name=region_name)

        # Add strands-agents to the request user agent
        if boto_client_config:
            existing_user_agent = getattr(boto_client_config, "user_agent_extra", None)
            # Append 'strands-agents' to existing user_agent_extra or set it if not present
            if existing_user_agent:
                new_user_agent = f"{existing_user_agent} strands-agents"
            else:
                new_user_agent = "strands-agents"
            client_config = boto_client_config.merge(BotocoreConfig(user_agent_extra=new_user_agent))
        else:
            client_config = BotocoreConfig(user_agent_extra="strands-agents")

        self.client = session.client(service_name="s3", config=client_config, endpoint_url=endpoint_url)
        super().__init__(session_id=session_id, session_repository=self)

    def _get_session_path(self, session_id: str) -> str:
        """Get session S3 prefix.

        Args:
            session_id: ID for the session.

        Raises:
            ValueError: If session id contains a path separator.
        """
        session_id = _identifier.validate(session_id, _identifier.Identifier.SESSION)
        prefix = self.prefix.strip("/")
        if prefix:
            return f"{prefix}/{SESSION_PREFIX}{session_id}/"
        return f"{SESSION_PREFIX}{session_id}/"

    def _get_agent_path(self, session_id: str, agent_id: str) -> str:
        """Get agent S3 prefix.

        Args:
            session_id: ID for the session.
            agent_id: ID for the agent.

        Raises:
            ValueError: If session id or agent id contains a path separator.
        """
        session_path = self._get_session_path(session_id)
        agent_id = _identifier.validate(agent_id, _identifier.Identifier.AGENT)
        return f"{session_path}agents/{AGENT_PREFIX}{agent_id}/"

    def _get_message_path(self, session_id: str, agent_id: str, message_id: int) -> str:
        """Get message S3 key.

        Args:
            session_id: ID of the session
            agent_id: ID of the agent
            message_id: Index of the message

        Returns:
            The key for the message

        Raises:
            ValueError: If message_id is not an integer.
        """
        if not isinstance(message_id, int):
            raise ValueError(f"message_id=<{message_id}> | message id must be an integer")

        agent_path = self._get_agent_path(session_id, agent_id)
        return f"{agent_path}messages/{MESSAGE_PREFIX}{message_id}.json"

    def _read_s3_object(self, key: str) -> dict[str, Any] | None:
        """Read JSON object from S3."""
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
            content = response["Body"].read().decode("utf-8")
            return cast(dict[str, Any], json.loads(content))
        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchKey":
                return None
            else:
                raise SessionException(f"S3 error reading {key}: {e}") from e
        except json.JSONDecodeError as e:
            raise SessionException(f"Invalid JSON in S3 object {key}: {e}") from e

    def _write_s3_object(self, key: str, data: dict[str, Any]) -> None:
        """Write JSON object to S3."""
        try:
            content = json.dumps(data, indent=2, ensure_ascii=False)
            self.client.put_object(
                Bucket=self.bucket, Key=key, Body=content.encode("utf-8"), ContentType="application/json"
            )
        except ClientError as e:
            raise SessionException(f"Failed to write S3 object {key}: {e}") from e

    def create_session(self, session: Session, **kwargs: Any) -> Session:
        """Create a new session in S3."""
        session_key = f"{self._get_session_path(session.session_id)}session.json"

        # Check if session already exists
        try:
            self.client.head_object(Bucket=self.bucket, Key=session_key)
            raise SessionException(f"Session {session.session_id} already exists")
        except ClientError as e:
            if e.response["Error"]["Code"] != "404":
                raise SessionException(f"S3 error checking session existence: {e}") from e

        # Write session object
        session_dict = session.to_dict()
        self._write_s3_object(session_key, session_dict)
        return session

    def read_session(self, session_id: str, **kwargs: Any) -> Session | None:
        """Read session data from S3."""
        session_key = f"{self._get_session_path(session_id)}session.json"
        session_data = self._read_s3_object(session_key)
        if session_data is None:
            return None
        return Session.from_dict(session_data)

    def delete_session(self, session_id: str, **kwargs: Any) -> None:
        """Delete session and all associated data from S3."""
        session_prefix = self._get_session_path(session_id)
        try:
            paginator = self.client.get_paginator("list_objects_v2")
            pages = paginator.paginate(Bucket=self.bucket, Prefix=session_prefix)

            objects_to_delete: list[ObjectIdentifierTypeDef] = []
            for page in pages:
                if "Contents" in page:
                    objects_to_delete.extend([{"Key": obj["Key"]} for obj in page["Contents"]])

            if not objects_to_delete:
                raise SessionException(f"Session {session_id} does not exist")

            # Delete objects in batches
            for i in range(0, len(objects_to_delete), 1000):
                batch = objects_to_delete[i : i + 1000]
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": batch})

        except ClientError as e:
            raise SessionException(f"S3 error deleting session {session_id}: {e}") from e

    def create_agent(self, session_id: str, session_agent: SessionAgent, **kwargs: Any) -> None:
        """Create a new agent in S3."""
        agent_id = session_agent.agent_id
        agent_dict = session_agent.to_dict()
        agent_key = f"{self._get_agent_path(session_id, agent_id)}agent.json"
        self._write_s3_object(agent_key, agent_dict)

    def read_agent(self, session_id: str, agent_id: str, **kwargs: Any) -> SessionAgent | None:
        """Read agent data from S3."""
        agent_key = f"{self._get_agent_path(session_id, agent_id)}agent.json"
        agent_data = self._read_s3_object(agent_key)
        if agent_data is None:
            return None
        return SessionAgent.from_dict(agent_data)

    def update_agent(self, session_id: str, session_agent: SessionAgent, **kwargs: Any) -> None:
        """Update agent data in S3."""
        agent_id = session_agent.agent_id
        previous_agent = self.read_agent(session_id=session_id, agent_id=agent_id)
        if previous_agent is None:
            raise SessionException(f"Agent {agent_id} in session {session_id} does not exist")

        # Preserve creation timestamp
        session_agent.created_at = previous_agent.created_at
        agent_key = f"{self._get_agent_path(session_id, agent_id)}agent.json"
        self._write_s3_object(agent_key, session_agent.to_dict())

    def create_message(self, session_id: str, agent_id: str, session_message: SessionMessage, **kwargs: Any) -> None:
        """Create a new message in S3."""
        message_id = session_message.message_id
        message_dict = session_message.to_dict()
        message_key = self._get_message_path(session_id, agent_id, message_id)
        self._write_s3_object(message_key, message_dict)

    def read_message(self, session_id: str, agent_id: str, message_id: int, **kwargs: Any) -> SessionMessage | None:
        """Read message data from S3."""
        message_key = self._get_message_path(session_id, agent_id, message_id)
        message_data = self._read_s3_object(message_key)
        if message_data is None:
            return None
        return SessionMessage.from_dict(message_data)

    def update_message(self, session_id: str, agent_id: str, session_message: SessionMessage, **kwargs: Any) -> None:
        """Update message data in S3."""
        message_id = session_message.message_id
        previous_message = self.read_message(session_id=session_id, agent_id=agent_id, message_id=message_id)
        if previous_message is None:
            raise SessionException(f"Message {message_id} does not exist")

        # Preserve creation timestamp
        session_message.created_at = previous_message.created_at
        message_key = self._get_message_path(session_id, agent_id, message_id)
        self._write_s3_object(message_key, session_message.to_dict())

    def list_messages(
        self, session_id: str, agent_id: str, limit: int | None = None, offset: int = 0, **kwargs: Any
    ) -> list[SessionMessage]:
        """List messages for an agent with pagination from S3.

        Args:
            session_id: ID of the session
            agent_id: ID of the agent
            limit: Optional limit on number of messages to return
            offset: Optional offset for pagination
            **kwargs: Additional keyword arguments

        Returns:
            List of SessionMessage objects, sorted by message_id.

        Raises:
            SessionException: If S3 error occurs during message retrieval.
        """
        messages_prefix = f"{self._get_agent_path(session_id, agent_id)}messages/"
        try:
            paginator = self.client.get_paginator("list_objects_v2")
            pages = paginator.paginate(Bucket=self.bucket, Prefix=messages_prefix)

            # Collect all message keys and extract their indices
            message_index_keys: list[tuple[int, str]] = []
            for page in pages:
                if "Contents" in page:
                    for obj in page["Contents"]:
                        key = obj["Key"]
                        if key.endswith(".json") and MESSAGE_PREFIX in key:
                            # Extract the filename part from the full S3 key
                            filename = key.split("/")[-1]
                            # Extract index from message_<index>.json format
                            index = int(filename[len(MESSAGE_PREFIX) : -5])  # Remove prefix and .json suffix
                            message_index_keys.append((index, key))

            # Sort by index and extract just the keys
            message_keys = [k for _, k in sorted(message_index_keys)]

            # Apply pagination to keys before loading content
            if limit is not None:
                message_keys = message_keys[offset : offset + limit]
            else:
                message_keys = message_keys[offset:]

            # Load message objects in parallel for better performance
            messages: list[SessionMessage] = []
            if not message_keys:
                return messages

            # Optimize for single worker case - avoid thread pool overhead
            if len(message_keys) == 1:
                for key in message_keys:
                    message_data = self._read_s3_object(key)
                    if message_data:
                        messages.append(SessionMessage.from_dict(message_data))
                return messages

            with ThreadPoolExecutor() as executor:
                # Submit all read tasks
                future_to_key = {executor.submit(self._read_s3_object, key): key for key in message_keys}

                # Create a mapping from key to index to maintain order
                key_to_index = {key: idx for idx, key in enumerate(message_keys)}

                # Initialize results list with None placeholders to maintain order
                results: list[dict[str, Any] | None] = [None] * len(message_keys)

                # Process results as they complete
                for future in as_completed(future_to_key):
                    key = future_to_key[future]
                    message_data = future.result()
                    # Store result at the correct index to maintain order
                    results[key_to_index[key]] = message_data

            # Convert results to SessionMessage objects, filtering out None values
            for message_data in results:
                if message_data:
                    messages.append(SessionMessage.from_dict(message_data))

            return messages

        except ClientError as e:
            raise SessionException(f"S3 error reading messages: {e}") from e

    def _get_multi_agent_path(self, session_id: str, multi_agent_id: str) -> str:
        """Get multi-agent S3 prefix."""
        session_path = self._get_session_path(session_id)
        multi_agent_id = _identifier.validate(multi_agent_id, _identifier.Identifier.AGENT)
        return f"{session_path}multi_agents/{MULTI_AGENT_PREFIX}{multi_agent_id}/"

    def create_multi_agent(self, session_id: str, multi_agent: "MultiAgentBase", **kwargs: Any) -> None:
        """Create a new multiagent state in S3."""
        multi_agent_id = multi_agent.id
        multi_agent_key = f"{self._get_multi_agent_path(session_id, multi_agent_id)}multi_agent.json"
        session_data = multi_agent.serialize_state()
        self._write_s3_object(multi_agent_key, session_data)

    def read_multi_agent(self, session_id: str, multi_agent_id: str, **kwargs: Any) -> dict[str, Any] | None:
        """Read multi-agent state from S3."""
        multi_agent_key = f"{self._get_multi_agent_path(session_id, multi_agent_id)}multi_agent.json"
        return self._read_s3_object(multi_agent_key)

    def update_multi_agent(self, session_id: str, multi_agent: "MultiAgentBase", **kwargs: Any) -> None:
        """Update multi-agent state in S3."""
        multi_agent_state = multi_agent.serialize_state()
        previous_multi_agent_state = self.read_multi_agent(session_id=session_id, multi_agent_id=multi_agent.id)
        if previous_multi_agent_state is None:
            raise SessionException(f"MultiAgent state {multi_agent.id} in session {session_id} does not exist")

        multi_agent_key = f"{self._get_multi_agent_path(session_id, multi_agent.id)}multi_agent.json"
        self._write_s3_object(multi_agent_key, multi_agent_state)
