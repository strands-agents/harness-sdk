"""Session manager interface for agent session management."""

import logging
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, Generic

from typing_extensions import TypeVar

from ..experimental.hooks.events import (
    BidiAfterInvocationEvent,
    BidiAgentInitializedEvent,
    BidiMessageAddedEvent,
)
from ..hooks.events import (
    AfterInvocationEvent,
    AfterMultiAgentInvocationEvent,
    AfterNodeCallEvent,
    AgentInitializedEvent,
    MessageAddedEvent,
    MultiAgentInitializedEvent,
)
from ..hooks.registry import HookProvider, HookRegistry
from ..types.content import Message

if TYPE_CHECKING:
    from ..agent.agent import Agent
    from ..multiagent.base import MultiAgentBase
    from ..types.agent import LocalAgent

logger = logging.getLogger(__name__)


_SessionAgentT = TypeVar("_SessionAgentT", bound="LocalAgent", default="Agent", contravariant=True)


class SessionManager(HookProvider, ABC, Generic[_SessionAgentT]):
    """Abstract interface for managing sessions.

    A session manager is in charge of persisting the conversation and state of an agent across its interaction.
    Changes made to the agents conversation, state, or other attributes should be persisted immediately after
    they are changed. The different methods introduced in this class are called at important lifecycle events
    for an agent, and should be persisted in the session.

    The agent type defaults to Agent. Managers supporting both Agent and BidiAgent
    implement SessionManager[LocalAgent].
    """

    session_id: str
    """The unique session identifier for this session manager."""

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        """Register hooks for persisting the agent to the session."""
        # After the normal Agent initialization behavior, call the session initialize function to restore the agent
        registry.add_callback(AgentInitializedEvent, lambda event: self.initialize(event.agent))

        # For each message appended to the Agents messages, store that message in the session
        registry.add_callback(MessageAddedEvent, lambda event: self.append_message(event.message, event.agent))

        # Sync the agent into the session for each message in case the agent state was updated
        registry.add_callback(MessageAddedEvent, lambda event: self.sync_agent(event.agent))

        # After an agent was invoked, sync it with the session to capture any conversation manager state updates
        registry.add_callback(AfterInvocationEvent, lambda event: self.sync_agent(event.agent))

        registry.add_callback(MultiAgentInitializedEvent, lambda event: self.initialize_multi_agent(event.source))
        registry.add_callback(AfterNodeCallEvent, lambda event: self.sync_multi_agent(event.source))
        registry.add_callback(AfterMultiAgentInvocationEvent, lambda event: self.sync_multi_agent(event.source))

        # Register BidiAgent hooks
        registry.add_callback(BidiAgentInitializedEvent, lambda event: self.initialize(event.agent))
        registry.add_callback(BidiMessageAddedEvent, lambda event: self.append_message(event.message, event.agent))
        registry.add_callback(BidiMessageAddedEvent, lambda event: self.sync_agent(event.agent))
        registry.add_callback(BidiAfterInvocationEvent, lambda event: self.sync_agent(event.agent))

    @abstractmethod
    def redact_latest_message(self, redact_message: Message, agent: _SessionAgentT, **kwargs: Any) -> None:
        """Redact the message most recently appended to the agent in the session.

        Args:
            redact_message: New message to use that contains the redact content
            agent: Agent to apply the message redaction to
            **kwargs: Additional keyword arguments for future extensibility.
        """

    @abstractmethod
    def append_message(self, message: Message, agent: _SessionAgentT, **kwargs: Any) -> None:
        """Append a message to the agent's session.

        Args:
            message: Message to add to the agent in the session
            agent: Agent to append the message to
            **kwargs: Additional keyword arguments for future extensibility.
        """

    @abstractmethod
    def sync_agent(self, agent: _SessionAgentT, **kwargs: Any) -> None:
        """Serialize and sync the agent with the session storage.

        Args:
            agent: Agent who should be synchronized with the session storage
            **kwargs: Additional keyword arguments for future extensibility.
        """

    @abstractmethod
    def initialize(self, agent: _SessionAgentT, **kwargs: Any) -> None:
        """Initialize an agent with a session.

        Args:
            agent: Agent to initialize
            **kwargs: Additional keyword arguments for future extensibility.
        """

    def sync_multi_agent(self, source: "MultiAgentBase", **kwargs: Any) -> None:
        """Serialize and sync multi-agent with the session storage.

        Args:
            source: Multi-agent source object to persist
            **kwargs: Additional keyword arguments for future extensibility.
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} does not support multi-agent persistence "
            "(sync_multi_agent). Provide an implementation or use a "
            "SessionManager with session_type=SessionType.MULTI_AGENT."
        )

    def initialize_multi_agent(self, source: "MultiAgentBase", **kwargs: Any) -> None:
        """Read multi-agent state from persistent storage.

        Args:
            **kwargs: Additional keyword arguments for future extensibility.
            source: Multi-agent state to initialize.

        Returns:
            Multi-agent state dictionary or empty dict if not found.

        """
        raise NotImplementedError(
            f"{self.__class__.__name__} does not support multi-agent persistence "
            "(initialize_multi_agent). Provide an implementation or use a "
            "SessionManager with session_type=SessionType.MULTI_AGENT."
        )
