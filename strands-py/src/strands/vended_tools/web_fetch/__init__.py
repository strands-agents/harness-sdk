"""Web fetch tool for retrieving a URL and returning clean markdown.

Distinct from ``http_request`` (raw API calls): this tool fetches a page and
extracts its relevant content suitable for the model to read.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import web_fetch

    agent = Agent(tools=[web_fetch])
    ```
"""

from .web_fetch import WebFetchError, make_web_fetch, web_fetch

__all__ = [
    "WebFetchError",
    "make_web_fetch",
    "web_fetch",
]
