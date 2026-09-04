"""Repository session manager implementation."""

import copy
import logging
from typing import TYPE_CHECKING, Any

from ..agent.state import AgentState
from ..tools._tool_helpers import generate_missing_tool_result_content
from ..types.content import ContentBlock, Message, _generate_tracking_id
from ..types.exceptions import SessionException
from ..types.session import (
    Session,
    SessionAgent,
    SessionMessage,
    SessionType,
)
from .session_manager import SessionManager
from .session_repository import SessionRepository

if TYPE_CHECKING:
    from ..agent.agent import Agent
    from ..experimental.bidi.agent.agent import BidiAgent
    from ..multiagent.base import MultiAgentBase

logger = logging.getLogger(__name__)


class RepositorySessionManager(SessionManager):
    """Session manager for persisting agents in a SessionRepository.

    This manager uses a :class:`SessionRepository` (a structured per-message CRUD interface),
    not the unified :class:`~strands.storage.storage.Storage` protocol. It does not resolve
    from the agent-level ``storage`` parameter. For snapshot-based persistence that integrates
    with agent-level storage, use :class:`~strands.session.snapshot_session_manager.SnapshotSessionManager`.
    """

    # Process-global to avoid repeated log noise when multiple instances see agent-level storage.
    _warned_storage_ignored: bool = False

    def __init__(
        self,
        session_id: str,
        session_repository: SessionRepository,
        **kwargs: Any,
    ):
        """Initialize the RepositorySessionManager.

        If no session with the specified session_id exists yet, it will be created
        in the session_repository.

        Args:
            session_id: ID to use for the session. A new session with this id will be created if it does
                not exist in the repository yet
            session_repository: Underlying session repository to use to store the sessions state.
            **kwargs: Additional keyword arguments for future extensibility.

        """
        self.session_repository = session_repository
        self.session_id = session_id
        session = session_repository.read_session(session_id)
        # Create a session if it does not exist yet
        if session is None:
            logger.debug("session_id=<%s> | session not found, creating new session", self.session_id)
            self._is_new_session = True
            session = Session(session_id=session_id, session_type=SessionType.AGENT)
            session_repository.create_session(session)
        else:
            self._is_new_session = False

        self.session = session

        # Keep track of the latest message of each agent in case we need to redact it.
        self._latest_agent_message: dict[str, SessionMessage | None] = {}

        # Track the previously synced internal state for each agent to detect changes.
        self._last_synced_internal_state: dict[str, dict[str, Any]] = {}

    def append_message(self, message: Message, agent: "Agent", **kwargs: Any) -> None:
        """Append a message to the agent's session.

        Args:
            message: Message to add to the agent in the session
            agent: Agent to append the message to
            **kwargs: Additional keyword arguments for future extensibility.
        """
        # Calculate the next index (0 if this is the first message, otherwise increment the previous index)
        latest_agent_message = self._latest_agent_message[agent.agent_id]
        if latest_agent_message:
            next_index = latest_agent_message.message_id + 1
        else:
            next_index = 0

        session_message = SessionMessage.from_message(message, next_index)
        self._latest_agent_message[agent.agent_id] = session_message
        self.session_repository.create_message(self.session_id, agent.agent_id, session_message)

    def redact_latest_message(self, redact_message: Message, agent: "Agent", **kwargs: Any) -> None:
        """Redact the latest message appended to the session.

        Args:
            redact_message: New message to use that contains the redact content
            agent: Agent to apply the message redaction to
            **kwargs: Additional keyword arguments for future extensibility.
        """
        latest_agent_message = self._latest_agent_message[agent.agent_id]
        if latest_agent_message is None:
            raise SessionException("No message to redact.")
        latest_agent_message.redact_message = redact_message
        return self.session_repository.update_message(self.session_id, agent.agent_id, latest_agent_message)

    def sync_agent(self, agent: "Agent", **kwargs: Any) -> None:
        """Serialize and update the agent into the session repository.

        Only updates the agent if state has been modified or internal state has changed.
        This optimization reduces unnecessary I/O operations when the agent processes
        messages without modifying its state.

        Args:
            agent: Agent to sync to the session.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        # Get current versions and conversation manager state
        current_state_version = agent.state._get_version()
        current_interrupt_state_version = agent._interrupt_state._get_version()
        current_conversation_manager_state = agent.conversation_manager.get_state()
        current_model_state = agent._model_state

        # Check if we have a previous state to compare against
        last_synced = self._last_synced_internal_state.get(agent.agent_id)

        # Determine if we need to update by comparing versions
        if last_synced is None:
            # First sync for this agent - always update
            state_changed = True
            internal_state_changed = True
            conversation_manager_state_changed = True
        else:
            state_changed = current_state_version != last_synced.get("state_version")
            internal_state_changed = current_interrupt_state_version != last_synced.get(
                "interrupt_state_version"
            ) or current_model_state != last_synced.get("model_state")
            conversation_manager_state_changed = current_conversation_manager_state != last_synced.get(
                "conversation_manager_state"
            )

        if not state_changed and not internal_state_changed and not conversation_manager_state_changed:
            logger.debug(
                "agent_id=<%s> | session_id=<%s> | skipping sync, no changes detected",
                agent.agent_id,
                self.session_id,
            )
            return

        logger.debug(
            "agent_id=<%s> | session_id=<%s> | state_changed=<%s>, internal_state_changed=<%s>, "
            "conversation_manager_state_changed=<%s> | syncing agent",
            agent.agent_id,
            self.session_id,
            state_changed,
            internal_state_changed,
            conversation_manager_state_changed,
        )

        # Perform the update
        self.session_repository.update_agent(
            self.session_id,
            SessionAgent.from_agent(agent),
        )

        # Update tracked versions after successful sync
        self._last_synced_internal_state[agent.agent_id] = {
            "state_version": current_state_version,
            "interrupt_state_version": current_interrupt_state_version,
            "conversation_manager_state": copy.deepcopy(current_conversation_manager_state),
            "model_state": copy.deepcopy(current_model_state),
        }

    def initialize(self, agent: "Agent", **kwargs: Any) -> None:
        """Initialize an agent with a session.

        Args:
            agent: Agent to initialize from the session
            **kwargs: Additional keyword arguments for future extensibility.
        """
        if not RepositorySessionManager._warned_storage_ignored and agent.storage is not None:
            RepositorySessionManager._warned_storage_ignored = True
            logger.warning(
                "agent_id=<%s> | agent-level storage is set but RepositorySessionManager does not use it;"
                " use SnapshotSessionManager for unified storage integration",
                agent.agent_id,
            )
        if agent.agent_id in self._latest_agent_message:
            raise SessionException("The `agent_id` of an agent must be unique in a session.")
        self._latest_agent_message[agent.agent_id] = None

        # Skip read_agent call for new sessions since no agents can exist yet
        if self._is_new_session:
            session_agent = None
        else:
            session_agent = self.session_repository.read_agent(self.session_id, agent.agent_id)

        if session_agent is None:
            logger.debug(
                "agent_id=<%s> | session_id=<%s> | creating agent",
                agent.agent_id,
                self.session_id,
            )

            session_agent = SessionAgent.from_agent(agent)
            self.session_repository.create_agent(self.session_id, session_agent)
            # Initialize messages with sequential indices
            session_message = None
            for i, message in enumerate(agent.messages):
                session_message = SessionMessage.from_message(message, i)
                self.session_repository.create_message(self.session_id, agent.agent_id, session_message)
            self._latest_agent_message[agent.agent_id] = session_message
        else:
            logger.debug(
                "agent_id=<%s> | session_id=<%s> | restoring agent",
                agent.agent_id,
                self.session_id,
            )
            agent.state = AgentState(session_agent.state)

            session_agent.initialize_internal_state(agent)

            # Restore the conversation manager to its previous state, and get the optional prepend messages
            prepend_messages = agent.conversation_manager.restore_from_session(session_agent.conversation_manager_state)

            if prepend_messages is None:
                prepend_messages = []

            # List the messages currently in the session, using an offset of the messages previously removed
            # by the conversation manager.
            session_messages = self.session_repository.list_messages(
                session_id=self.session_id,
                agent_id=agent.agent_id,
                offset=agent.conversation_manager.removed_message_count,
            )
            if len(session_messages) > 0:
                self._latest_agent_message[agent.agent_id] = session_messages[-1]

            # Skip restoring messages when conversation is managed server-side
            if agent.model.stateful:
                logger.debug(
                    "agent_id=<%s> | session_id=<%s> | skipping message restore for server-managed conversation",
                    agent.agent_id,
                    self.session_id,
                )
            else:
                # Restore the agents messages array including the optional prepend messages
                agent.messages = prepend_messages + [
                    session_message.to_message() for session_message in session_messages
                ]

                # Fix broken session histories: https://github.com/strands-agents/harness-sdk/issues/859
                agent.messages = self._fix_broken_tool_use(agent.messages)

        self._is_new_session = False

    def _fix_broken_tool_use(self, messages: list[Message]) -> list[Message]:
        """Fix broken tool use/result pairs in message history.

        Handles orphaned toolUse (no corresponding toolResult), stale toolResult (IDs that don't match
        the preceding toolUse), and orphaned toolResult at any index (no preceding toolUse).

        Uses a declarative rebuild: for each assistant message with toolUse, the next message's toolResult
        content is rebuilt to have exactly one result per toolUse ID, filling gaps with error results and
        dropping stale ones by construction.

        Args:
            messages: The list of messages to fix

        Returns:
            Fixed list of messages with proper tool use/result pairs
        """
        # Reverse iteration keeps the lower indices valid after a removal.
        for index in range(len(messages) - 1, -1, -1):
            message = messages[index]
            if message["role"] != "user" or not any("toolResult" in content for content in message["content"]):
                continue
            previous_message = messages[index - 1] if index > 0 else None
            if previous_message is not None and any("toolUse" in content for content in previous_message["content"]):
                continue

            logger.warning(
                "message_index=<%d> | orphaned toolResult with no preceding toolUse. "
                "This typically happens when messages are truncated due to pagination limits. "
                "Removing orphaned toolResult to maintain valid conversation structure.",
                index,
            )
            remaining_content = [content for content in message["content"] if "toolResult" not in content]
            if remaining_content:
                message["content"] = remaining_content
            else:
                messages.pop(index)

        # Snapshot eligible indices before iterating. Trailing message excluded (handled by agent class
        # at prompt-arrival time). Reverse iteration keeps snapshotted indices valid after inserts.
        original_last_index = len(messages) - 1
        tool_use_indices = [
            index
            for index, message in enumerate(messages)
            if index < original_last_index and any("toolUse" in content for content in message["content"])
        ]

        for index in reversed(tool_use_indices):
            message = messages[index]
            tool_use_ids = [content["toolUse"]["toolUseId"] for content in message["content"] if "toolUse" in content]

            next_message = messages[index + 1]
            next_content = next_message["content"]

            existing_results: dict[str, ContentBlock] = {}
            non_tool_result_content: list[ContentBlock] = []
            for block in next_content:
                if "toolResult" in block:
                    existing_results[block["toolResult"]["toolUseId"]] = block
                else:
                    non_tool_result_content.append(block)

            if set(existing_results.keys()) == set(tool_use_ids):
                continue

            logger.warning(
                "tool_use_ids=<%s>, result_ids=<%s> | session history has mismatched toolUse/toolResult pairing,"
                " rebuilding",
                tool_use_ids,
                list(existing_results.keys()),
            )

            # Ensure a toolResult slot exists after this assistant message
            # This synthesized message bypasses the append chokepoint, so give it a durable
            # tracking id — matching messages appended through the normal path.
            if not existing_results and non_tool_result_content:
                messages.insert(index + 1, {"role": "user", "content": [], "tracking_id": _generate_tracking_id()})
                next_message = messages[index + 1]
                non_tool_result_content = []

            next_message["content"] = [
                existing_results.get(tid, generate_missing_tool_result_content([tid])[0]) for tid in tool_use_ids
            ] + non_tool_result_content

        return messages

    def sync_multi_agent(self, source: "MultiAgentBase", **kwargs: Any) -> None:
        """Serialize and update the multi-agent state into the session repository.

        Args:
            source: Multi-agent source object to sync to the session.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        self.session_repository.update_multi_agent(self.session_id, source)

    def initialize_multi_agent(self, source: "MultiAgentBase", **kwargs: Any) -> None:
        """Initialize multi-agent state from the session repository.

        Args:
            source: Multi-agent source object to restore state into
            **kwargs: Additional keyword arguments for future extensibility.
        """
        # Skip read_multi_agent call for new sessions since no multi-agents can exist yet
        if self._is_new_session:
            state = None
        else:
            state = self.session_repository.read_multi_agent(self.session_id, source.id, **kwargs)

        if state is None:
            self.session_repository.create_multi_agent(self.session_id, source, **kwargs)
        else:
            logger.debug("session_id=<%s> | restoring multi-agent state", self.session_id)
            source.deserialize_state(state)

        self._is_new_session = False

    def initialize_bidi_agent(self, agent: "BidiAgent", **kwargs: Any) -> None:
        """Initialize a bidirectional agent with a session.

        Args:
            agent: BidiAgent to initialize from the session
            **kwargs: Additional keyword arguments for future extensibility.
        """
        if agent.agent_id in self._latest_agent_message:
            raise SessionException("The `agent_id` of an agent must be unique in a session.")
        self._latest_agent_message[agent.agent_id] = None

        # Skip read_agent call for new sessions since no agents can exist yet
        if self._is_new_session:
            session_agent = None
        else:
            session_agent = self.session_repository.read_agent(self.session_id, agent.agent_id)

        if session_agent is None:
            logger.debug(
                "agent_id=<%s> | session_id=<%s> | creating bidi agent",
                agent.agent_id,
                self.session_id,
            )

            session_agent = SessionAgent.from_bidi_agent(agent)
            self.session_repository.create_agent(self.session_id, session_agent)
            # Initialize messages with sequential indices
            session_message = None
            for i, message in enumerate(agent.messages):
                session_message = SessionMessage.from_message(message, i)
                self.session_repository.create_message(self.session_id, agent.agent_id, session_message)
            self._latest_agent_message[agent.agent_id] = session_message
        else:
            logger.debug(
                "agent_id=<%s> | session_id=<%s> | restoring bidi agent",
                agent.agent_id,
                self.session_id,
            )
            agent.state = AgentState(session_agent.state)

            session_agent.initialize_bidi_internal_state(agent)

            # BidiAgent has no conversation_manager, so no prepend_messages or removed_message_count
            session_messages = self.session_repository.list_messages(
                session_id=self.session_id,
                agent_id=agent.agent_id,
                offset=0,
            )
            if len(session_messages) > 0:
                self._latest_agent_message[agent.agent_id] = session_messages[-1]

            # Restore the agents messages array
            agent.messages = [session_message.to_message() for session_message in session_messages]

            # Fix broken session histories: https://github.com/strands-agents/harness-sdk/issues/859
            agent.messages = self._fix_broken_tool_use(agent.messages)

        self._is_new_session = False

    def append_bidi_message(self, message: Message, agent: "BidiAgent", **kwargs: Any) -> None:
        """Append a message to the bidirectional agent's session.

        Args:
            message: Message to add to the agent in the session
            agent: BidiAgent to append the message to
            **kwargs: Additional keyword arguments for future extensibility.
        """
        # Calculate the next index (0 if this is the first message, otherwise increment the previous index)
        latest_agent_message = self._latest_agent_message[agent.agent_id]
        if latest_agent_message:
            next_index = latest_agent_message.message_id + 1
        else:
            next_index = 0

        session_message = SessionMessage.from_message(message, next_index)
        self._latest_agent_message[agent.agent_id] = session_message
        self.session_repository.create_message(self.session_id, agent.agent_id, session_message)

    def sync_bidi_agent(self, agent: "BidiAgent", **kwargs: Any) -> None:
        """Serialize and update the bidirectional agent into the session repository.

        Args:
            agent: BidiAgent to sync to the session.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        self.session_repository.update_agent(
            self.session_id,
            SessionAgent.from_bidi_agent(agent),
        )
