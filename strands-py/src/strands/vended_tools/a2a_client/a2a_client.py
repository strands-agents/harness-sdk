"""A2A client tool for communicating with remote A2A-protocol agents.

Provides :func:`make_a2a_client`, a factory that requires an explicit list of
permitted endpoints (with optional :class:`~a2a.client.ClientConfig`).

The tool is a stateless shim over :class:`~strands.agent.a2a_agent.A2AAgent`.
A fresh ``A2AAgent`` is constructed on every call so the tool carries no session
state between invocations.  Each endpoint may carry its own
:class:`~a2a.client.ClientConfig` to support per-endpoint authentication
(bearer tokens, SigV4, OAuth).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

try:
    from a2a.client import ClientConfig

    from ...agent.a2a_agent import A2AAgent
except ImportError as error:
    raise ImportError("a2a_client requires the 'a2a' extra. Install with: pip install 'strands-agents[a2a]'") from error
from ...tools.decorator import tool

if TYPE_CHECKING:
    from ...tools.decorator import DecoratedFunctionTool

_A2AClientOutput = dict[str, Any]

DEFAULT_A2A_CLIENT_DESCRIPTION = (
    "Interacts with remote A2A (Agent-to-Agent) protocol agents. "
    "Use operation='discover' to fetch an agent card from an endpoint. "
    "Use operation='send_message' to send a message and receive a response. "
    "Only the listed endpoints are permitted."
)


class A2AClientError(RuntimeError):
    """Raised when an A2A operation fails."""


AllowedEndpoint = str | tuple[str, ClientConfig]
"""A permitted endpoint: a bare URL string, or a ``(url, ClientConfig)`` tuple."""


def make_a2a_client(
    *,
    name: str = "a2a_client",
    description: str | None = None,
    allowed_endpoints: list[AllowedEndpoint],
) -> DecoratedFunctionTool:
    """Create an A2A client tool.

    Args:
        name: Tool name shown to the model.
        description: Tool description shown to the model. When ``None``,
            generated from ``DEFAULT_A2A_CLIENT_DESCRIPTION`` plus the
            permitted endpoints list.
        allowed_endpoints: Permitted base URLs.  Each entry is either a bare URL
            string (no custom config) or a ``(url, ClientConfig)`` tuple for
            per-endpoint authentication.  Any endpoint not in this list is
            rejected before a network connection is made.

    Returns:
        A decorated tool that communicates with A2A agents.
    """
    if not allowed_endpoints:
        raise ValueError("allowed_endpoints must contain at least one endpoint")

    for entry in allowed_endpoints:
        if isinstance(entry, str):
            continue
        if not isinstance(entry, tuple) or len(entry) != 2 or not isinstance(entry[0], str):
            raise TypeError(
                f"Each allowed endpoint must be a string URL or (str, ClientConfig) tuple, got {type(entry).__name__}"
            )

    endpoints_map = _normalize_endpoints(allowed_endpoints)

    if description is None:
        endpoints_list = ", ".join(sorted(endpoints_map))
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
        if endpoint not in endpoints_map:
            raise A2AClientError(
                f"Endpoint '{endpoint}' is not in the allowed endpoints list. "
                f"Permitted endpoints: {sorted(endpoints_map)}"
            )

        agent = A2AAgent(endpoint, client_config=endpoints_map[endpoint])

        if operation == "discover":
            return await _handle_discover(agent)

        if operation == "send_message":
            if not message:
                raise A2AClientError("'message' is required for send_message operation")
            return await _handle_send_message(agent, message)

        raise A2AClientError(f"Unknown operation: {operation!r}")

    return a2a_client_tool


def _normalize_endpoints(entries: list[AllowedEndpoint]) -> dict[str, ClientConfig | None]:
    """Convert the user-facing list into an internal ``{url: config}`` mapping."""
    result: dict[str, ClientConfig | None] = {}
    for entry in entries:
        if isinstance(entry, str):
            result[entry] = None
        else:
            url, config = entry
            result[url] = config
    return result


async def _handle_discover(agent: A2AAgent) -> _A2AClientOutput:
    """Fetch the agent card via *agent* and return it as a dict."""
    try:
        agent_card = await agent.get_agent_card()
    except Exception as error:
        raise A2AClientError(f"Failed to discover agent card at {agent.endpoint!r}: {error}") from error

    return agent_card.model_dump(mode="json", exclude_none=True)


async def _handle_send_message(agent: A2AAgent, message_text: str) -> _A2AClientOutput:
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
    return result
