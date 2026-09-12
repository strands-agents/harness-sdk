"""A2A client tool for communicating with remote A2A-protocol agents.

Provides :func:`make_a2a_client`, a factory that requires an explicit allowlist
of permitted endpoints, optional transport configuration, and size limits.

The tool is a stateless shim over :class:`~strands.agent.a2a_agent.A2AAgent`.
A fresh ``A2AAgent`` is constructed on every call so the tool carries no session
state between invocations.  If the caller needs authentication (bearer tokens,
SigV4, OAuth), pass a :class:`~a2a.client.ClientConfig` with a pre-configured
``httpx_client`` to the factory.
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
from .types import DEFAULT_A2A_CLIENT_DESCRIPTION, _A2AClientOutput

if TYPE_CHECKING:
    from ...tools.decorator import DecoratedFunctionTool

_DEFAULT_TIMEOUT = 300
_DEFAULT_MAX_BYTES = 5 * 1024 * 1024


class A2AClientError(RuntimeError):
    """Raised when an A2A operation fails."""


def make_a2a_client(
    *,
    name: str = "a2a_client",
    description: str | None = None,
    allowed_endpoints: list[str],
    client_config: ClientConfig | None = None,
    timeout: int = _DEFAULT_TIMEOUT,
    max_bytes: int = _DEFAULT_MAX_BYTES,
) -> DecoratedFunctionTool:
    """Create an A2A client tool.

    Args:
        name: Tool name shown to the model.
        description: Tool description shown to the model.  When ``None``, a
            description is generated automatically, including the list of
            permitted endpoints.
        allowed_endpoints: List of permitted base URLs.  Any endpoint not in
            this list is rejected before a network connection is made.
        client_config: Optional :class:`~a2a.client.ClientConfig` for
            authentication and transport settings.  Passed through to
            :class:`~strands.agent.a2a_agent.A2AAgent` on every call.
        timeout: Timeout for HTTP operations in seconds.  Only used when
            ``client_config`` does not supply an ``httpx_client``.
        max_bytes: Maximum size in bytes returned to the model. Results larger
            than this cap are rejected with an error.

    Returns:
        A decorated tool that communicates with A2A agents.
    """
    _allowed = frozenset(allowed_endpoints)
    if not _allowed:
        raise ValueError("allowed_endpoints must contain at least one endpoint")
    if max_bytes <= 0:
        raise ValueError(f"max_bytes must be positive, got {max_bytes}")

    if description is None:
        endpoints_list = ", ".join(sorted(_allowed))
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
        if endpoint not in _allowed:
            raise A2AClientError(
                f"Endpoint '{endpoint}' is not in the allowed endpoints list. Permitted endpoints: {sorted(_allowed)}"
            )

        agent = A2AAgent(endpoint, client_config=client_config, timeout=timeout)

        if operation == "discover":
            return await _discover(agent, max_bytes)

        if operation == "send_message":
            if not message:
                raise A2AClientError("'message' is required for send_message operation")
            return await _send_message(agent, message, max_bytes)

        raise A2AClientError(f"Unknown operation: {operation!r}")

    return a2a_client_tool


async def _discover(agent: A2AAgent, max_bytes: int) -> _A2AClientOutput:
    """Fetch the agent card via *agent* and return it as a dict."""
    try:
        agent_card = await agent.get_agent_card()
    except Exception as error:
        raise A2AClientError(f"Failed to discover agent card at {agent.endpoint!r}: {error}") from error

    result: dict[str, Any] = agent_card.model_dump(mode="python", exclude_none=True)
    size = len(json.dumps(result).encode())
    if size > max_bytes:
        raise A2AClientError(f"Agent card response exceeds max_bytes limit ({size} > {max_bytes})")
    return result


async def _send_message(agent: A2AAgent, message_text: str, max_bytes: int) -> _A2AClientOutput:
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
