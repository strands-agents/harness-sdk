"""Session repository interface for agent session management."""

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

from ..types.session import Session, SessionAgent, SessionMessage

if TYPE_CHECKING:
    from ..multiagent import MultiAgentBase


class SessionRepository(ABC):
    """Abstract repository for creating, reading, and updating Sessions, AgentSessions, and AgentMessages."""

    @abstractmethod
    def create_session(self, session: Session, **kwargs: Any) -> Session:
        """Create a new Session."""

    @abstractmethod
    def read_session(self, session_id: str, **kwargs: Any) -> Session | None:
        """Read a Session."""

    @abstractmethod
    def create_agent(self, session_id: str, session_agent: SessionAgent, **kwargs: Any) -> None:
        """Create a new Agent in a Session."""

    @abstractmethod
    def read_agent(self, session_id: str, agent_id: str, **kwargs: Any) -> SessionAgent | None:
        """Read an Agent."""

    @abstractmethod
    def update_agent(self, session_id: str, session_agent: SessionAgent, **kwargs: Any) -> None:
        """Update an Agent."""

    @abstractmethod
    def create_message(self, session_id: str, agent_id: str, session_message: SessionMessage, **kwargs: Any) -> None:
        """Create a new Message for the Agent."""

    @abstractmethod
    def read_message(self, session_id: str, agent_id: str, message_id: int, **kwargs: Any) -> SessionMessage | None:
        """Read a Message."""

    @abstractmethod
    def update_message(self, session_id: str, agent_id: str, session_message: SessionMessage, **kwargs: Any) -> None:
        """Update a Message.

        A message is usually only updated when some content is redacted due to a guardrail.
        """

    @abstractmethod
    def list_messages(
        self, session_id: str, agent_id: str, limit: int | None = None, offset: int = 0, **kwargs: Any
    ) -> list[SessionMessage]:
        """List Messages from an Agent with pagination."""

    def create_multi_agent(self, session_id: str, multi_agent: "MultiAgentBase", **kwargs: Any) -> None:
        """Create a new MultiAgent state for the Session."""
        raise NotImplementedError("MultiAgent is not implemented for this repository")

    def read_multi_agent(self, session_id: str, multi_agent_id: str, **kwargs: Any) -> dict[str, Any] | None:
        """Read the MultiAgent state for the Session."""
        raise NotImplementedError("MultiAgent is not implemented for this repository")

    def update_multi_agent(self, session_id: str, multi_agent: "MultiAgentBase", **kwargs: Any) -> None:
        """Update the MultiAgent state for the Session."""
        raise NotImplementedError("MultiAgent is not implemented for this repository")
