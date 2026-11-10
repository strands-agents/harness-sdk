"""Sleep tool for pausing agent execution for a bounded, cooperative duration.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import sleep

    agent = Agent(tools=[sleep])
    ```
"""

from .sleep import make_sleep, sleep

__all__ = [
    "make_sleep",
    "sleep",
]
