"""Data models for session management."""

import base64
import inspect
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING, Any

from ..interrupt import _InterruptState
from .content import Message

if TYPE_CHECKING:
    from .agent import LocalAgent


class SessionType(str, Enum):
    """Enumeration of session types.

    As sessions are expanded to support new use cases like multi-agent patterns,
    new types will be added here.
    """

    AGENT = "AGENT"


def encode_bytes_values(obj: Any) -> Any:
    """Recursively encode any bytes values in an object to base64.

    Handles dictionaries, lists, and nested structures.
    """
    if isinstance(obj, bytes):
        return {"__bytes_encoded__": True, "data": base64.b64encode(obj).decode()}
    elif isinstance(obj, dict):
        return {k: encode_bytes_values(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [encode_bytes_values(item) for item in obj]
    else:
        return obj


def decode_bytes_values(obj: Any) -> Any:
    """Recursively decode any base64-encoded bytes values in an object.

    Handles dictionaries, lists, and nested structures.
    """
    if isinstance(obj, dict):
        if obj.get("__bytes_encoded__") is True and "data" in obj:
            return base64.b64decode(obj["data"])
        return {k: decode_bytes_values(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [decode_bytes_values(item) for item in obj]
    else:
        return obj


@dataclass
class SessionMessage:
    """Message within a SessionAgent.

    Attributes:
        message: Message content
        message_id: Index of the message in the conversation history
        redact_message: If the original message is redacted, this is the new content to use
        created_at: ISO format timestamp for when this message was created
        updated_at: ISO format timestamp for when this message was last updated
    """

    message: Message
    message_id: int
    redact_message: Message | None = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @classmethod
    def from_message(cls, message: Message, index: int) -> "SessionMessage":
        """Convert from a Message, base64 encoding bytes values."""
        return cls(
            message=message,
            message_id=index,
            created_at=datetime.now(timezone.utc).isoformat(),
            updated_at=datetime.now(timezone.utc).isoformat(),
        )

    def to_message(self) -> Message:
        """Convert SessionMessage back to a Message, decoding any bytes values.

        If the message was redacted, return the redact content instead.
        """
        if self.redact_message is not None:
            return self.redact_message
        else:
            return self.message

    @classmethod
    def from_dict(cls, env: dict[str, Any]) -> "SessionMessage":
        """Initialize a SessionMessage from a dictionary, ignoring keys that are not class parameters."""
        extracted_relevant_parameters = {k: v for k, v in env.items() if k in inspect.signature(cls).parameters}
        return cls(**decode_bytes_values(extracted_relevant_parameters))

    def to_dict(self) -> dict[str, Any]:
        """Convert the SessionMessage to a dictionary representation."""
        return encode_bytes_values(asdict(self))  # type: ignore[no-any-return]


@dataclass
class SessionAgent:
    """Agent that belongs to a Session.

    Attributes:
        agent_id: Unique id for the agent.
        state: User managed state.
        conversation_manager_state: State for conversation management.
        created_at: Created at time.
        updated_at: Updated at time.
    """

    agent_id: str
    state: dict[str, Any]
    conversation_manager_state: dict[str, Any]
    _internal_state: dict[str, Any] = field(default_factory=dict)  # Strands managed state
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @classmethod
    def from_agent(cls, agent: "LocalAgent") -> "SessionAgent":
        """Convert a local agent to a SessionAgent."""
        from ..agent.agent import Agent

        if agent.agent_id is None:
            raise ValueError("agent_id needs to be defined.")

        internal_state = {}
        conversation_manager_state = {}
        if isinstance(agent, Agent):
            conversation_manager_state = agent.conversation_manager.get_state()
            internal_state = {
                "interrupt_state": agent._interrupt_state.to_dict(),
                "model_state": agent._model_state,
            }

        return cls(
            agent_id=agent.agent_id,
            conversation_manager_state=conversation_manager_state,
            state=agent.state.get(),
            _internal_state=internal_state,
        )

    @classmethod
    def from_dict(cls, env: dict[str, Any]) -> "SessionAgent":
        """Initialize a SessionAgent from a dictionary, ignoring keys that are not class parameters."""
        extracted_relevant_parameters = {k: v for k, v in env.items() if k in inspect.signature(cls).parameters}
        return cls(**decode_bytes_values(extracted_relevant_parameters))

    def to_dict(self) -> dict[str, Any]:
        """Convert the SessionAgent to a dictionary representation."""
        return encode_bytes_values(asdict(self))  # type: ignore[no-any-return]

    def initialize_internal_state(self, agent: "LocalAgent") -> None:
        """Restore internal state for Agent instances."""
        from ..agent.agent import Agent

        if not isinstance(agent, Agent):
            return

        if "interrupt_state" in self._internal_state:
            agent._interrupt_state = _InterruptState.from_dict(self._internal_state["interrupt_state"])
        if "model_state" in self._internal_state:
            agent._model_state = self._internal_state["model_state"]


@dataclass
class Session:
    """Session data model."""

    session_id: str
    session_type: SessionType
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @classmethod
    def from_dict(cls, env: dict[str, Any]) -> "Session":
        """Initialize a Session from a dictionary, ignoring keys that are not class parameters."""
        return cls(**{k: v for k, v in env.items() if k in inspect.signature(cls).parameters})

    def to_dict(self) -> dict[str, Any]:
        """Convert the Session to a dictionary representation."""
        return asdict(self)
