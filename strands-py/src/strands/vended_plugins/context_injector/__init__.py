"""Context-injection plugin for Strands Agents.

This module provides the ContextInjector plugin, which writes just-in-time text into the latest
user message before each model call, as an ``injected`` block that stays in the conversation.

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
