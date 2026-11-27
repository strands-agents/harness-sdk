"""Multiagent capabilities for Strands Agents.

This module provides support for multiagent systems, including agent-to-agent (A2A)
communication protocols and coordination mechanisms.

Submodules:
    a2a: Implementation of the Agent-to-Agent (A2A) protocol, which enables
         standardized communication between agents.
"""

from .base import MultiAgentBase, MultiAgentResult, Status
from .graph import EdgeCondition, EdgeConditionWithContext, GraphBuilder, GraphResult
from .spec import AgentSpec, Choice, Fixed, Inherit, Open, Option, Preset
from .swarm import Swarm, SwarmResult

__all__ = [
    "AgentSpec",
    "Choice",
    "EdgeCondition",
    "EdgeConditionWithContext",
    "Fixed",
    "GraphBuilder",
    "GraphResult",
    "Inherit",
    "MultiAgentBase",
    "MultiAgentResult",
    "Open",
    "Option",
    "Preset",
    "Status",
    "Swarm",
    "SwarmResult",
]
