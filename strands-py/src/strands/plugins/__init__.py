"""Plugin system for extending agent and orchestrator functionality.

This module provides a composable mechanism for building objects that can
extend agent and multi-agent orchestrator behavior through automatic hook
and tool registration.
"""

from .decorator import hook
from .multiagent_plugin import MultiAgentPlugin
from .plugin import Plugin

__all__ = [
    "MultiAgentPlugin",
    "Plugin",
    "hook",
]
