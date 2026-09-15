"""Shared types and constants for the a2a_client tool."""

from typing import Any

_A2AClientOutput = dict[str, Any]
"""Return type for the a2a_client tool."""

DEFAULT_A2A_CLIENT_DESCRIPTION = (
    "Interacts with remote A2A (Agent-to-Agent) protocol agents. "
    "Use operation='discover' to fetch an agent card from an endpoint, "
    "or operation='send_message' to send a message and receive a response. "
    "Only the listed endpoints are permitted."
)
"""Description for the a2a_client tool shown to the model."""
