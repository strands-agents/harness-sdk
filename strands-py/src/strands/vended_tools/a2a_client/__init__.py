"""A2A client tool for communicating with remote A2A-protocol agents.

This tool is a stateless shim over :class:`~strands.agent.a2a_agent.A2AAgent`.
Each call creates a fresh agent, makes the requested operation (``discover`` or
``send_message``), and returns the result — no session state is held between calls.

Use :func:`make_a2a_client` to create a tool instance, supplying the required
``allowed_endpoints`` list along with optional authentication via a
:class:`~a2a.client.ClientConfig`, a ``timeout``, and a ``max_bytes`` cap.

Requires the optional ``a2a`` extra::

    pip install 'strands-agents[a2a]'

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools.a2a_client import make_a2a_client

    tool = make_a2a_client(allowed_endpoints=["https://agent.example.com"])
    agent = Agent(tools=[tool])
    ```
"""

from .a2a_client import A2AClientError, make_a2a_client

__all__ = [
    "A2AClientError",
    "make_a2a_client",
]
