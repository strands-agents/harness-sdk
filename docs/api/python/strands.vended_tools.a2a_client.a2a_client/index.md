A2A client tool for communicating with remote A2A-protocol agents.

Provides :func:`make_a2a_client`, a factory that requires an explicit mapping of permitted endpoints to their :class:`~a2a.client.ClientConfig`, plus optional size limits.

The tool is a stateless shim over :class:`~strands.agent.a2a_agent.A2AAgent`. A fresh `A2AAgent` is constructed on every call so the tool carries no session state between invocations. Each endpoint may carry its own :class:`~a2a.client.ClientConfig` to support per-endpoint authentication (bearer tokens, SigV4, OAuth).

## A2AClientError

```python
class A2AClientError(RuntimeError)
```

Defined in: [src/strands/vended\_tools/a2a\_client/a2a\_client.py:41](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/a2a_client/a2a_client.py#L41)

Raised when an A2A operation fails.

#### make\_a2a\_client

```python
def make_a2a_client(
        *,
        name: str = "a2a_client",
        description: str | None = None,
        allowed_endpoints: dict[str, ClientConfig | None],
        max_bytes: int = _DEFAULT_MAX_BYTES) -> DecoratedFunctionTool
```

Defined in: [src/strands/vended\_tools/a2a\_client/a2a\_client.py:45](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/a2a_client/a2a_client.py#L45)

Create an A2A client tool.

**Arguments**:

-   `name` - Tool name shown to the model.
-   `description` - Tool description shown to the model. When `None`, generated from `DEFAULT_A2A_CLIENT_DESCRIPTION` plus the permitted endpoints list.
-   `allowed_endpoints` - Mapping of permitted base URLs to their :class:`~a2a.client.ClientConfig`. Use `None` as the value for endpoints that need no custom configuration. Any endpoint not in this mapping is rejected before a network connection is made.
-   `max_bytes` - Maximum size in bytes of the result dict returned to the model. Does not cap the network transfer or binary parts. Results larger than this cap are rejected with an error.

**Returns**:

A decorated tool that communicates with A2A agents.