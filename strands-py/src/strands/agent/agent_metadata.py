"""Read-only view of agent metadata passed to a model on ``stream()``."""

from dataclasses import dataclass


@dataclass(frozen=True, kw_only=True)
class AgentMetadata:
    """Read-only view of agent metadata passed to a model on ``stream()``.

    Populated by the agent per request. Because it is rebuilt for every request, a single model instance shared across
    agents sees each agent's own identity rather than a value baked in at construction.

    Attributes:
        session_id: The agent's persisted session id, set only when a session manager is attached;
            None for an ephemeral agent.
    """

    session_id: str | None = None
