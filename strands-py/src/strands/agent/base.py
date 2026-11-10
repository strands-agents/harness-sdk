"""Agent Interface.

Defines the minimal interface that all agent types must implement.
"""

from collections.abc import AsyncIterator
from typing import Any, Protocol, runtime_checkable

from ..types.agent import AgentInput
from .agent_result import AgentResult


@runtime_checkable
class AgentBase(Protocol):
    """Protocol defining the interface for all agent types in Strands.

    This protocol defines the minimal contract that all agent implementations
    must satisfy.
    """

    async def invoke_async(
        self,
        prompt: AgentInput = None,
        **kwargs: Any,
    ) -> AgentResult:
        """Asynchronously invoke the agent with the given prompt.

        Args:
            prompt: Input to the agent.
            **kwargs: Additional arguments.

        Returns:
            AgentResult containing the agent's response.
        """
        ...

    def __call__(
        self,
        prompt: AgentInput = None,
        **kwargs: Any,
    ) -> AgentResult:
        """Synchronously invoke the agent with the given prompt.

        Args:
            prompt: Input to the agent.
            **kwargs: Additional arguments.

        Returns:
            AgentResult containing the agent's response.
        """
        ...

    def stream_async(
        self,
        prompt: AgentInput = None,
        **kwargs: Any,
    ) -> AsyncIterator[Any]:
        """Stream agent execution asynchronously.

        Args:
            prompt: Input to the agent.
            **kwargs: Additional arguments.

        Yields:
            Events representing the streaming execution.
        """
        ...
