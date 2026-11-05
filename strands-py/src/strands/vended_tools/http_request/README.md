# http_request

Vended tool for making raw HTTP calls from an agent. Thin shim over httpx.AsyncClient.

## Usage

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
    max_redirects=10,
)
tool = make_http_request(client=client)
agent = Agent(tools=[tool])
```

Model-facing inputs: `method`, `url`, `headers?`, `body?`. Model-facing output: `status`, `status_text`, `headers`, `body`.

## Configuration

All configuration is done through the `httpx.AsyncClient` you pass in:

- **Timeout**: `httpx.AsyncClient(timeout=30.0)`
- **Redirects**: `httpx.AsyncClient(follow_redirects=True, max_redirects=5)`
- **Authentication**: `httpx.AsyncClient(headers={"Authorization": "Bearer ..."})`
- **Proxies**: `httpx.AsyncClient(proxy="http://proxy.example.com")`
- **Transport**: `httpx.AsyncClient(transport=custom_transport)`

When no client is provided, a default `httpx.AsyncClient()` is created per request.

## Behavior

- The tool delegates entirely to the provided (or default) httpx client for timeouts, redirects, and connection management.
- Request errors (`httpx.TimeoutException`, `httpx.TooManyRedirects`, `httpx.RequestError`) are wrapped in `HttpRequestError`.
- The parent agent's cancel signal is read via the injected `ToolContext`. A set signal raises `asyncio.CancelledError` before the request is sent.
