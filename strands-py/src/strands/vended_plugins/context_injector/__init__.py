"""Context-injection plugin for Strands Agents.

This module provides the ContextInjector plugin, which folds just-in-time text into the model
input before each call without touching durable history.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_plugins.context_injector import ContextInjector

    agent = Agent(
        plugins=[
            ContextInjector(lambda context: f"<context>{derive(context.messages)}</context>")
        ]
    )
    ```
"""

from ...injection import InjectionContext, InjectionTrigger
from .plugin import ContextInjector

__all__ = [
    "ContextInjector",
    "InjectionContext",
    "InjectionTrigger",
]
