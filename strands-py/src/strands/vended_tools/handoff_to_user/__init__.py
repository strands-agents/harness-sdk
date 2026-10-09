"""Tool for pausing the agent loop and surfacing a message to the user.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import handoff_to_user

    agent = Agent(tools=[handoff_to_user])
    ```
"""

from .handoff_to_user import handoff_to_user, make_handoff_to_user
from .types import HANDOFF_INTERRUPT_NAME

__all__ = [
    "HANDOFF_INTERRUPT_NAME",
    "handoff_to_user",
    "make_handoff_to_user",
]
