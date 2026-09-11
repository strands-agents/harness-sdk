"""Notebook tool for managing text notebooks within agent invocations.

Notebooks are stored in the agent's :attr:`~strands.Agent.state` under the
``notebooks`` key and persist within an agent session. Supports create, list,
read, write (append, replace, or insert), and clear operations.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import notebook

    agent = Agent(tools=[notebook])
    ```
"""

from .notebook import make_notebook, notebook

__all__ = [
    "make_notebook",
    "notebook",
]
