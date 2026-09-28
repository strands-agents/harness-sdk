"""A2A client tool for communicating with remote A2A-protocol agents.

A stateless shim over :class:`~strands.agent.a2a_agent.A2AAgent` that exposes
``discover`` and ``send_message`` operations via the ``@tool`` interface.

Requires the optional ``a2a`` extra (``pip install 'strands-agents[a2a]'``)
and is imported lazily, so accessing it without that extra raises :class:`ImportError`.

Example Usage:
    ```python
    import httpx
    from a2a.client import ClientConfig
    from strands import Agent
    from strands.vended_tools import make_a2a_client

    tool = make_a2a_client(
        allowed_endpoints={
            "https://agent.example.com": None,
            "https://secure-agent.example.com": ClientConfig(
                httpx_client=httpx.AsyncClient(
                    headers={"Authorization": "Bearer your-token"},
                ),
            ),
        }
    )
    agent = Agent(tools=[tool])
    ```
"""

from .a2a_client import make_a2a_client

__all__ = [
    "make_a2a_client",
]
