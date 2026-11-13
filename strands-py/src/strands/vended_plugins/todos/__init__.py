"""Todos plugin for Strands Agents.

This module provides the Todos plugin, which gives the agent a ``todo_write`` tool and
re-surfaces the current task list before each model call so a multi-step plan stays in view.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_plugins.todos import Todos

    agent = Agent(plugins=[Todos()])
    ```
"""

from .plugin import TodoItem, Todos

__all__ = [
    "TodoItem",
    "Todos",
]
