"""Inspect HTTP response headers with an SDK-vended tool."""

from strands import Agent
from strands.vended_tools import http_request

agent = Agent(
    system_prompt="Use HTTP requests to inspect remote resources and summarize responses.",
    tools=[http_request],
)

agent("Send a HEAD request to https://example.com and summarize the response headers.")
