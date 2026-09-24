"""A2A client tool for communicating with remote A2A-protocol agents.

Provides :func:`make_a2a_client`, a factory that requires an explicit mapping of
permitted endpoints to their :class:`~a2a.client.ClientConfig`, plus optional size limits.

The tool is a stateless shim over :class:`~strands.agent.a2a_agent.A2AAgent`.
A fresh ``A2AAgent`` is constructed on every call so the tool carries no session
state between invocations.  Each endpoint may carry its own
:class:`~a2a.client.ClientConfig` to support per-endpoint authentication
(bearer tokens, SigV4, OAuth).
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Literal

try:
    from a2a.client import ClientConfig

    from ...agent.a2a_agent import A2AAgent
except ImportError as error:
    raise ImportError("a2a_client requires the 'a2a' extra. Install with: pip install 'strands-agents[a2a]'") from error
from ...tools.decorator import tool

if TYPE_CHECKING:
    from ...tools.decorator import DecoratedFunctionTool

_DEFAULT_MAX_BYTES = 5 * 1024 * 1024

_A2AClientOutput = dict[str, Any]

DEFAULT_A2A_CLIENT_DESCRIPTION = (
    "Interacts with remote A2A (Agent-to-Agent) protocol agents. "
    "Use operation='discover' to fetch an agent card from an endpoint. "
    "Use operation='send_message' to send a message and receive a response. "
    "Only the listed endpoints are permitted."
)


class A2AClientError(RuntimeError):
    """Raised when an A2A operation fails."""


def make_a2a_client(
    *,
    name: str = "a2a_client",
    description: str | None = None,
    allowed_endpoints: dict[str, ClientConfig | None],
    max_bytes: int = _DEFAULT_MAX_BYTES,
) -> DecoratedFunctionTool:
    """Create an A2A client tool.

    Args:
        name: Tool name shown to the model.
        description: Tool description shown to the model. When ``None``,
            generated from ``DEFAULT_A2A_CLIENT_DESCRIPTION`` plus the
            permitted endpoints list.
        allowed_endpoints: Mapping of permitted base URLs to their
            :class:`~a2a.client.ClientConfig`.  Use ``None`` as the value for
            endpoints that need no custom configuration. Any endpoint not in this
            mapping is rejected before a network connection is made.
        max_bytes: Maximum size in bytes of the result dict returned to the model.
            Does not cap the network transfer or binary parts.
            Results larger than this cap are rejected with an error.

    Returns:
        A decorated tool that communicates with A2A agents.
    """
    if not allowed_endpoints:
        raise ValueError("allowed_endpoints must contain at least one endpoint")
    if max_bytes <= 0:
        raise ValueError(f"max_bytes must be positive, got {max_bytes}")

    if description is None:
        endpoints_list = ", ".join(sorted(allowed_endpoints))
        description = f"{DEFAULT_A2A_CLIENT_DESCRIPTION} Permitted endpoints: {endpoints_list}."

    @tool(name=name, description=description)
    async def a2a_client_tool(
        operation: Literal["discover", "send_message"],
        endpoint: str,
        message: str | None = None,
    ) -> _A2AClientOutput:
        """Interact with a remote A2A-protocol agent.

        Args:
            operation: Action to perform — ``discover`` to fetch the agent card,
                or ``send_message`` to send a text message and receive a response.
            endpoint: Base URL of the target A2A agent.
            message: Text to send to the agent.  Required when
                ``operation`` is ``send_message``; ignored otherwise.

        Returns:
            Result dict from the A2A operation.

        Raises:
            A2AClientError: When the endpoint is not in the allowlist, when
                ``message`` is missing for ``send_message``, or when the
                underlying A2A call fails.
        """
        # Check if the endpoint is allowed via exact-match.
        if endpoint not in allowed_endpoints:
            raise A2AClientError(
                f"Endpoint '{endpoint}' is not in the allowed endpoints list. "
                f"Permitted endpoints: {sorted(allowed_endpoints)}"
            )

        agent = A2AAgent(endpoint, client_config=allowed_endpoints[endpoint])

        if operation == "discover":
            return await _handle_discover(agent, max_bytes)

        if operation == "send_message":
            if not message:
                raise A2AClientError("'message' is required for send_message operation")
            return await _handle_send_message(agent, message, max_bytes)

        raise A2AClientError(f"Unknown operation: {operation!r}")

    return a2a_client_tool


async def _handle_discover(agent: A2AAgent, max_bytes: int) -> _A2AClientOutput:
    """Fetch the agent card via *agent* and return it as a dict."""
    try:
        agent_card = await agent.get_agent_card()
    except Exception as error:
        raise A2AClientError(f"Failed to discover agent card at {agent.endpoint!r}: {error}") from error

    result: dict[str, Any] = agent_card.model_dump(mode="json", exclude_none=True)
    size = len(json.dumps(result).encode())
    if size > max_bytes:
        raise A2AClientError(f"Agent card response exceeds max_bytes limit ({size} > {max_bytes})")
    return result


async def _handle_send_message(agent: A2AAgent, message_text: str, max_bytes: int) -> _A2AClientOutput:
    """Send *message_text* via *agent* and return the response as a dict."""
    try:
        agent_result = await agent.invoke_async(message_text)
    except Exception as error:
        raise A2AClientError(f"Failed to send message to {agent.endpoint!r}: {error}") from error

    task_state: str | None = agent_result.state.get("a2a_task_state") if agent_result.state else None
    if task_state and task_state != "completed":
        detail = " ".join(block["text"] for block in agent_result.message["content"] if "text" in block)
        raise A2AClientError(
            f"Remote agent at {agent.endpoint!r} did not complete: task state is {task_state!r}. {detail}".rstrip()
        )

    result: dict[str, Any] = {"message": agent_result.message}
    size = len(json.dumps(result).encode())
    if size > max_bytes:
        raise A2AClientError(f"Response exceeds max_bytes limit ({size} > {max_bytes})")
    return result
