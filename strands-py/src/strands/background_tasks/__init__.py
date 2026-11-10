"""Background tool execution.

Only :class:`BackgroundTasksConfig` is public; the task engine, manager, and the plugin that
connects them to an :class:`~strands.agent.Agent` are internal.
"""

from ._types import BackgroundTasksConfig

__all__ = ["BackgroundTasksConfig"]
