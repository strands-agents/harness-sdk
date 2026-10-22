"""Cross-session actor memory for Strands agents.

This module provides the ``ActorMemory`` plugin, which persists small facts
about an actor (a user, tenant, or other stable identity) so they are recalled
in later sessions, independent of any particular ``session_id``.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_plugins.actor_memory import ActorMemory

    agent = Agent(plugins=[ActorMemory(actor_id="user-123")])
    ```
"""

from .plugin import ActorMemory

__all__ = [
    "ActorMemory",
]
