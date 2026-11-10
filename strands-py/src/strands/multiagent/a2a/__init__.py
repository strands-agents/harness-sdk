"""Agent-to-Agent (A2A) communication protocol implementation for Strands Agents.

This module provides classes and utilities for enabling Strands Agents to communicate
with other agents using the Agent-to-Agent (A2A) protocol.

Docs: https://a2a-protocol.org/latest/

Classes:
    A2AServer: A server that adapts a Strands Agent to be A2A-compatible.
    StrandsA2AExecutor: The A2A executor that runs Strands Agents per request.

Types:
    AgentFactory: Callable ``(context_id) -> Agent`` for building a fresh agent per A2A context.
"""

from .executor import AgentFactory, StrandsA2AExecutor
from .server import A2AServer

__all__ = ["A2AServer", "AgentFactory", "StrandsA2AExecutor"]
