"""Cedar authorization intervention handler.

Evaluates Cedar policies before each tool call to enforce fine-grained,
identity-aware access control over agent tool invocations.

Requires the ``cedarpy`` package::

    pip install strands-agents[cedar]

Example::

    from strands import Agent
    from strands.vended_interventions.cedar import CedarAuthorization

    cedar = CedarAuthorization(
        policies='permit(principal, action == Action::"search", resource);'
    )
    agent = Agent(interventions=[cedar], tools=[search_tool])
"""

try:
    import cedarpy as _cedarpy  # noqa: F401
except ImportError as _e:
    raise ImportError(
        "The cedar intervention handler requires 'cedarpy'. Install it with: pip install strands-agents[cedar]"
    ) from _e

from ._schema_generator import ToolDefinition
from .cedar_authorization import CedarAuthorization

__all__ = [
    "CedarAuthorization",
    "ToolDefinition",
]
