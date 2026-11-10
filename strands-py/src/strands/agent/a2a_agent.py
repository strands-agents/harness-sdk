"""A2A Agent client for Strands Agents.

This module provides the A2AAgent class, which acts as a client wrapper for remote A2A agents,
allowing them to be used standalone or as part of multi-agent patterns.

A2AAgent can be used to get the Agent Card and interact with the agent.
"""

import dataclasses
import logging
import warnings
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
from a2a.types import AgentCard, Message, TaskArtifactUpdateEvent, TaskStatusUpdateEvent

from .._async import run_async
from ..multiagent.a2a._converters import (
    _STATE_TO_STOP_REASON,
    convert_input_to_message,
    convert_response_to_agent_result,
)
from ..types._events import AgentResultEvent
from ..types.a2a import A2AResponse, A2AStreamEvent
from ..types.agent import AgentInput
from .agent_result import AgentResult
from .base import AgentBase

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = 300

# A2A task states that indicate the response stream is complete.
# Derived from the canonical _STATE_TO_STOP_REASON mapping in _converters.
# Terminal states (end_turn) mean no more events; input states (interrupt) mean execution is paused.
_TERMINAL_STATES = {state for state, reason in _STATE_TO_STOP_REASON.items() if reason == "end_turn"}
_INPUT_STATES = {state for state, reason in _STATE_TO_STOP_REASON.items() if reason == "interrupt"}
_COMPLETE_STATES = _TERMINAL_STATES | _INPUT_STATES


class A2AAgent(AgentBase):
    """Client wrapper for remote A2A agents."""

    def __init__(
        self,
        endpoint: str,
        *,
        name: str | None = None,
        description: str | None = None,
        timeout: int = _DEFAULT_TIMEOUT,
        client_config: ClientConfig | None = None,
        a2a_client_factory: ClientFactory | None = None,
    ):
        """Initialize A2A agent.

        Args:
            endpoint: The base URL of the remote A2A agent.
            name: Agent name. If not provided, will be populated from agent card.
            description: Agent description. If not provided, will be populated from agent card.
            timeout: Timeout for HTTP operations in seconds (defaults to 300).
            client_config: A2A ``ClientConfig`` for authentication and transport settings.
                The ``httpx_client`` configured here is used for both card discovery and
                message sending, enabling authenticated endpoints (SigV4, OAuth, bearer tokens).
                When providing an ``httpx_client``, you are responsible for configuring its timeout.
            a2a_client_factory: Deprecated. Use ``client_config`` instead.

        Raises:
            ValueError: If both ``client_config`` and ``a2a_client_factory`` are provided.
        """
        if client_config is not None and a2a_client_factory is not None:
            raise ValueError(
                "Cannot provide both client_config and a2a_client_factory. "
                "Use client_config (recommended) or a2a_client_factory (deprecated), not both."
            )

        if a2a_client_factory is not None:
            warnings.warn(
                "a2a_client_factory is deprecated. Use client_config instead. "
                "a2a_client_factory will be removed in a future version.",
                DeprecationWarning,
                stacklevel=2,
            )

        self.endpoint = endpoint
        self.name = name
        self.description = description
        self.timeout = timeout
        self._client_config: ClientConfig | None = client_config
        self._agent_card: AgentCard | None = None
        self._a2a_client_factory: ClientFactory | None = a2a_client_factory

    def __call__(
        self,
        prompt: AgentInput = None,
        **kwargs: Any,
    ) -> AgentResult:
        """Synchronously invoke the remote A2A agent.

        Args:
            prompt: Input to the agent (string, message list, or content blocks).
            **kwargs: Additional arguments (ignored).

        Returns:
            AgentResult containing the agent's response.

        Raises:
            ValueError: If prompt is None.
            RuntimeError: If no response received from agent.
        """
        return run_async(lambda: self.invoke_async(prompt, **kwargs))

    async def invoke_async(
        self,
        prompt: AgentInput = None,
        **kwargs: Any,
    ) -> AgentResult:
        """Asynchronously invoke the remote A2A agent.

        Args:
            prompt: Input to the agent (string, message list, or content blocks).
            **kwargs: Additional arguments (ignored).

        Returns:
            AgentResult containing the agent's response.

        Raises:
            ValueError: If prompt is None.
            RuntimeError: If no response received from agent.
        """
        result: AgentResult | None = None
        async for event in self.stream_async(prompt, **kwargs):
            if "result" in event:
                result = event["result"]

        if result is None:
            raise RuntimeError("No response received from A2A agent")

        return result

    async def stream_async(
        self,
        prompt: AgentInput = None,
        **kwargs: Any,
    ) -> AsyncIterator[Any]:
        """Stream remote agent execution asynchronously.

        This method provides an asynchronous interface for streaming A2A protocol events.
        Unlike Agent.stream_async() which yields text deltas and tool events, this method
        yields raw A2A protocol events wrapped in A2AStreamEvent dictionaries.

        Args:
            prompt: Input to the agent (string, message list, or content blocks).
            **kwargs: Additional arguments (ignored).

        Yields:
            An async iterator that yields events. Each event is a dictionary:
                - A2AStreamEvent: {"type": "a2a_stream", "event": <A2A object>}
                  where the A2A object can be a Message, or a tuple of
                  (Task, TaskStatusUpdateEvent) or (Task, TaskArtifactUpdateEvent).
                - AgentResultEvent: {"result": AgentResult} - always emitted last.

        Raises:
            ValueError: If prompt is None.

        Example:
            ```python
            async for event in a2a_agent.stream_async("Hello"):
                if event.get("type") == "a2a_stream":
                    print(f"A2A event: {event['event']}")
                elif "result" in event:
                    print(f"Final result: {event['result'].message}")
            ```
        """
        last_event = None
        last_complete_event = None

        async for event in self._send_message(prompt):
            last_event = event
            if self._is_complete_event(event):
                last_complete_event = event
            yield A2AStreamEvent(event)

        # Use the last complete event if available, otherwise fall back to last event
        final_event = last_complete_event or last_event

        if final_event is not None:
            result = convert_response_to_agent_result(final_event)
            yield AgentResultEvent(result)

    async def get_agent_card(self) -> AgentCard:
        """Fetch and return the remote agent's card.

        Eagerly fetches the agent card from the remote endpoint, populating name and description
        if not already set. The card is cached after the first fetch.

        When ``client_config`` is provided with an ``httpx_client``, that client is used for
        card resolution, enabling authenticated card discovery (e.g., SigV4, OAuth, bearer tokens).

        Returns:
            The remote agent's AgentCard containing name, description, capabilities, skills, etc.
        """
        if self._agent_card is not None:
            return self._agent_card

        if self._client_config is not None and self._client_config.httpx_client is not None:
            resolver = A2ACardResolver(httpx_client=self._client_config.httpx_client, base_url=self.endpoint)
            self._agent_card = await resolver.get_agent_card()
        else:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resolver = A2ACardResolver(httpx_client=client, base_url=self.endpoint)
                self._agent_card = await resolver.get_agent_card()

        # Populate name from card if not set
        if self.name is None and self._agent_card.name is not None:
            self.name = self._agent_card.name

        # Populate description from card if not set
        if self.description is None and self._agent_card.description is not None:
            self.description = self._agent_card.description

        logger.debug("agent=<%s>, endpoint=<%s> | discovered agent card", self.name, self.endpoint)
        return self._agent_card

    @asynccontextmanager
    async def _get_a2a_client(self) -> AsyncIterator[Any]:
        """Get A2A client for sending messages.

        If a deprecated factory was provided, delegates to it for client creation.
        If client_config was provided, uses it directly — ClientFactory handles defaults.
        Otherwise creates a managed httpx client with the agent's timeout.

        Yields:
            Configured A2A client instance.
        """
        agent_card = await self.get_agent_card()

        if self._a2a_client_factory is not None:
            yield self._a2a_client_factory.create(agent_card)
            return

        if self._client_config is not None:
            config = dataclasses.replace(self._client_config, streaming=True)
            yield ClientFactory(config).create(agent_card)
            return

        # No client_config — create a managed httpx client, consistent with get_agent_card() path
        async with httpx.AsyncClient(timeout=self.timeout) as httpx_client:
            config = ClientConfig(httpx_client=httpx_client, streaming=True)
            yield ClientFactory(config).create(agent_card)

    async def _send_message(self, prompt: AgentInput) -> AsyncIterator[A2AResponse]:
        """Send message to A2A agent.

        Args:
            prompt: Input to send to the agent.

        Yields:
            A2A response events.

        Raises:
            ValueError: If prompt is None.
        """
        if prompt is None:
            raise ValueError("prompt is required for A2AAgent")

        message = convert_input_to_message(prompt)
        logger.debug("agent=<%s>, endpoint=<%s> | sending message", self.name, self.endpoint)

        async with self._get_a2a_client() as client:
            async for event in client.send_message(message):
                yield event

    def _is_complete_event(self, event: A2AResponse) -> bool:
        """Check if an A2A event represents a complete response.

        Recognizes all terminal states (completed, failed, canceled, rejected)
        and pausing states (input_required, auth_required) as complete events.

        Args:
            event: A2A event.

        Returns:
            True if the event represents a complete response.
        """
        # Direct Message is always complete
        if isinstance(event, Message):
            return True

        # Handle tuple responses (Task, UpdateEvent | None)
        if isinstance(event, tuple) and len(event) == 2:
            task, update_event = event

            # Initial task response (no update event)
            if update_event is None:
                return True

            # Artifact update with last_chunk flag
            if isinstance(update_event, TaskArtifactUpdateEvent):
                if hasattr(update_event, "last_chunk") and update_event.last_chunk is not None:
                    return update_event.last_chunk
                return False

            # Status update - check for terminal or pausing states
            if isinstance(update_event, TaskStatusUpdateEvent):
                if update_event.status and hasattr(update_event.status, "state"):
                    state = update_event.status.state
                    return state in _COMPLETE_STATES

        return False
