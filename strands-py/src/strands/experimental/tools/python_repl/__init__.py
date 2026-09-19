"""Python REPL tool for running Python in a Monty sandbox.

This tool is experimental and subject to change in future revisions without notice.

Runs model-generated Python inside an isolated `Monty <https://pydantic.dev/docs/monty/>`_
worker with no filesystem, network, or environment access and bounded memory
and time. Session state persists across calls via :attr:`~strands.Agent.state`,
so later code can build on earlier calls; pass ``reset_state=True`` to start
from an empty namespace.

Requires the optional ``python-repl`` extra
(``pip install 'strands-agents[python-repl]'``).

Example Usage:
    ```python
    from strands import Agent
    from strands.experimental.tools import python_repl

    agent = Agent(tools=[python_repl])
    ```
"""

from .python_repl import make_python_repl, python_repl

__all__ = [
    "make_python_repl",
    "python_repl",
]
