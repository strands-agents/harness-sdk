"""Dogwood authorization intervention handler.

Evaluates a Dogwood policy set before each tool call, and records the result afterward, so a
policy can allow a call based on what the agent did earlier in the session.

Requires the ``dogwood-aws`` package::

    pip install strands-agents[dogwood]

Example::

    from strands import Agent
    from strands.vended_interventions.dogwood import DogwoodAuthorization

    dogwood = DogwoodAuthorization(
        policies='permit(principal, action == Action::"search", resource);',
        tools=[search_tool],
    )
    agent = Agent(interventions=[dogwood], tools=[search_tool])
"""

try:
    import dogwood as _dogwood  # noqa: F401
except ImportError as _error:
    raise ImportError(
        "The dogwood intervention handler requires 'dogwood-aws'. Install it with: pip install strands-agents[dogwood]"
    ) from _error

from .dogwood import ContextEnricher, DogwoodAuthorization, PrincipalResolver

__all__ = [
    "ContextEnricher",
    "DogwoodAuthorization",
    "PrincipalResolver",
]
