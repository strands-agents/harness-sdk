A transport carries messages between the agent and an MCP server. Which one you use depends on where the server runs: a local process reachable over standard I/O, or a remote server reachable over HTTP. This page covers each transport Strands supports and how to configure it, including authentication for HTTP servers.

To connect an agent to a server and use its tools, see [Connect your agent to MCP tools](/docs/user-guide/sdk/tools/mcp-tools/index.md). The connection pattern is the same for every transport; only how you point the client at the server changes.

## Standard I/O (stdio)

For command-line tools and local processes that speak MCP over stdin and stdout:

(( tab "Python" ))
```python
from mcp import stdio_client, StdioServerParameters
from strands import Agent
from strands.tools.mcp import MCPClient

# For macOS/Linux:
stdio_mcp_client = MCPClient(lambda: stdio_client(
    StdioServerParameters(
        command="uvx",
        args=["awslabs.aws-documentation-mcp-server@latest"]
    )
))

# For Windows:
stdio_mcp_client = MCPClient(lambda: stdio_client(
    StdioServerParameters(
        command="uvx",
        args=[
            "--from",
            "awslabs.aws-documentation-mcp-server@latest",
            "awslabs.aws-documentation-mcp-server.exe"
        ]
    )
))

with stdio_mcp_client:
    tools = stdio_mcp_client.list_tools_sync()
    agent = Agent(tools=tools)
    response = agent("What is AWS Lambda?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const stdioClient = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
})

const agentStdio = new Agent({
  tools: [stdioClient],
})

await agentStdio.invoke('What is AWS Lambda?')
```
(( /tab "TypeScript" ))

## Streamable HTTP

For HTTP-based MCP servers that use the Streamable HTTP transport:

(( tab "Python" ))
Pass the server `url` and `MCPClient` builds the transport from the installed `mcp` package:

```python
from strands import Agent
from strands.tools.mcp import MCPClient

streamable_http_mcp_client = MCPClient(url="http://localhost:8000/mcp")

with streamable_http_mcp_client:
    tools = streamable_http_mcp_client.list_tools_sync()
    agent = Agent(tools=tools)
```

Pass `headers` to send authentication or other request headers:

```python
import os
from strands.tools.mcp import MCPClient

github_mcp_client = MCPClient(
    url="https://api.githubcopilot.com/mcp/",
    headers={"Authorization": f"Bearer {os.getenv('MCP_PAT')}"},
)
```

To configure the transport yourself, pass a callback that opens it instead, as in the stdio example; for Streamable HTTP that is `streamable_http_client` from `mcp.client.streamable_http`.

#### OAuth Authentication

For servers protected by OAuth, pass the server `url` directly with an `auth` credential. `MCPClient` builds the Streamable HTTP transport internally and authenticates with the OAuth client\_credentials grant, which suits machine-to-machine deployments where no user is present to complete a browser flow.

```python
import os
from strands.tools.mcp import MCPClient

oauth_mcp_client = MCPClient(
    url="https://api.example.com/mcp/",
    auth={
        "client_id": os.environ["OAUTH_CLIENT_ID"],
        "client_secret": os.environ["OAUTH_CLIENT_SECRET"],
        "scopes": ["mcp:tools"],  # optional
    },
)
```

`scopes` is joined with spaces and is advisory only: if the server advertises its own scopes (via the `WWW-Authenticate` header or its protected-resource or authorization-server metadata), those scopes are used instead and this value is ignored. Token acquisition and refresh happen automatically. Combine `headers` with `auth` when the server also expects custom headers.

For advanced flows such as the interactive authorization\_code grant, pass any `httpx.Auth` implementation as `auth_provider` instead. The `mcp` package’s `OAuthClientProvider` is one such implementation:

```python
from mcp.client.auth import OAuthClientProvider

oauth_mcp_client = MCPClient(
    url="https://api.example.com/mcp/",
    auth_provider=OAuthClientProvider(...),
)
```

`auth` and `auth_provider` are mutually exclusive, both require `url`, and OAuth is supported for Streamable HTTP only. Set the same `auth` credential on a server entry in a [`load_servers`](/docs/user-guide/sdk/tools/mcp-tools/index.md#using-multiple-mcp-servers) config, where `${VAR}` interpolation keeps secrets in the environment:

```json
{
  "mcpServers": {
    "protected-server": {
      "url": "https://api.example.com/mcp/",
      "auth": {
        "client_id": "${OAUTH_CLIENT_ID}",
        "client_secret": "${OAUTH_CLIENT_SECRET}"
      }
    }
  }
}
```

#### AWS IAM

For MCP servers on AWS that use SigV4 authentication with IAM credentials, the [`mcp-proxy-for-aws`](https://pypi.org/project/mcp-proxy-for-aws/) package handles AWS credential management and request signing. See the [detailed guide](https://dev.to/aws/no-oauth-required-an-mcp-client-for-aws-iam-k1o) for background.

First, install the package:

```bash
pip install mcp-proxy-for-aws
```

Then use it like any other transport:

```python
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client
from strands.tools.mcp import MCPClient

mcp_client = MCPClient(lambda: aws_iam_streamablehttp_client(
    endpoint="https://your-service.us-east-1.amazonaws.com/mcp",
    aws_region="us-east-1",
    aws_service="bedrock-agentcore"
))
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const httpClient = new McpClient({
  transport: new StreamableHTTPClientTransport(
    new URL('http://localhost:8000/mcp')
  ) as Transport,
})

const agentHttp = new Agent({
  tools: [httpClient],
})

// With authentication
const githubMcpClient = new McpClient({
  transport: new StreamableHTTPClientTransport(
    new URL('https://api.githubcopilot.com/mcp/'),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_PAT}`,
        },
      },
    }
  ) as Transport,
})
```
(( /tab "TypeScript" ))

## Server-Sent Events (SSE)

For HTTP-based MCP servers that use the older Server-Sent Events transport:

(( tab "Python" ))
```python
from mcp.client.sse import sse_client
from strands import Agent
from strands.tools.mcp import MCPClient

sse_mcp_client = MCPClient(lambda: sse_client("http://localhost:8000/sse"))

with sse_mcp_client:
    tools = sse_mcp_client.list_tools_sync()
    agent = Agent(tools=tools)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

const sseClient = new McpClient({
  transport: new SSEClientTransport(new URL('http://localhost:8000/sse')),
})

const agentSse = new Agent({
  tools: [sseClient],
})
```
(( /tab "TypeScript" ))

## Related pages

- [Add tools to your agent](/docs/user-guide/sdk/tools/index.md) (2 shared tags)
- [Connect your agent to MCP tools](/docs/user-guide/sdk/tools/mcp-tools/index.md) (2 shared tags)
- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) (1 shared tag)
- [File editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) (1 shared tag)
- [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/tools/mcp/mcp_client.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py)

### TypeScript

- [harness-sdk/strands-ts/src/mcp/client.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts)
