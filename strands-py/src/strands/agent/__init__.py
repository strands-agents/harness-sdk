"""This package provides the core Agent interface and supporting components for building AI agents with the SDK.

It includes:

- Agent: The main interface for interacting with AI models and tools
- ConversationManager: Classes for managing conversation history and context windows
- Retry Strategies: Configurable retry behavior for model calls
"""

from typing import Any

from ..event_loop._retry import ModelRetryStrategy
from .agent import Agent
from .agent_metadata import AgentMetadata
from .agent_result import AgentResult
from .base import AgentBase
from .conversation_manager import (
    ConversationManager,
    NullConversationManager,
    SlidingWindowConversationManager,
    SummarizingConversationManager,
)

__all__ = [
    "Agent",
    "AgentBase",
    "AgentMetadata",
    "AgentResult",
    "ConversationManager",
    "NullConversationManager",
    "SlidingWindowConversationManager",
    "SummarizingConversationManager",
    "ModelRetryStrategy",
]


def __getattr__(name: str) -> Any:
    """Lazy load A2AAgent to defer import of optional a2a dependency."""
    if name == "A2AAgent":
        from .a2a_agent import A2AAgent

        return A2AAgent
    raise AttributeError(f"cannot import name '{name}' from '{__name__}' ({__file__})")
