"""HTTP request tool for making raw HTTP calls to external APIs.

The tool delegates all networking to an ``httpx.AsyncClient`` — either one
supplied by the operator or one created per-request with httpx defaults.
Timeouts, redirects, authentication, proxies, and all other transport
settings are configured on the client.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import http_request

    agent = Agent(tools=[http_request])
    ```

    Custom configuration with a pre-configured client:
    ```python
    import httpx
    from strands.vended_tools import make_http_request

    client = httpx.AsyncClient(
        headers={"Authorization": "Bearer token"},
        timeout=15.0,
        follow_redirects=True,
    )
    tool = make_http_request(client=client)
    agent = Agent(tools=[tool])
    ```
"""

from .http_request import HttpRequestError, http_request, make_http_request
from .types import HttpMethod, HttpRequestOutput

__all__ = [
    "HttpMethod",
    "HttpRequestError",
    "HttpRequestOutput",
    "http_request",
    "make_http_request",
]
