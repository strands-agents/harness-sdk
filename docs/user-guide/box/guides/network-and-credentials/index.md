An `[egress.<name>]` table in `box.toml` binds a credential to a set of destinations. The box’s egress gateway adds the credential to each request to those destinations. Policy decides whether each request goes out.

Audience: an operator with a working box from [getting started](../../quickstart/index.md) who gives the agent a credential for a service. For how the gateway decides and forwards each request, read [how Box controls outbound traffic](https://github.com/strands-agents/box/blob/fbe415cbdfec284bf608a46f125ff8e437a99bda/docs/design/egress.md).

A tool or local MCP server with `network.contain_egress = false` can connect directly, outside gateway policy. On Linux, this includes IPv4 access to reachable private networks, loopback services, and instance metadata endpoints. See [server network settings](../add-an-mcp-server/index.md#network).

## Example

A bearer token for GitHub, and an AWS profile for Bedrock:

```toml
[egress.github]
destinations = ["api.github.com"]
secret.ref   = "env://GITHUB_TOKEN"

[egress.bedrock]
destinations = ["bedrock-runtime.us-west-2.amazonaws.com"]
secret.ref   = "aws://my-profile"
```

`box run` reads `GITHUB_TOKEN` from its own environment. The agent gets a placeholder in `GITHUB_TOKEN`, and sends it as it would send the token. The gateway replaces the placeholder with the real token on each request to `api.github.com`.

> **Every process in the box can use every route.** The agent, each tool, and each stdio MCP server in the box get the same placeholders, and the gateway adds the real credential to a request from any of them. The gateway can’t tell which process sent a request, so no setting limits a route to one process. To keep a credential away from a tool or a server, run it in a separate box. [The box is the credential boundary](https://github.com/strands-agents/box/blob/fbe415cbdfec284bf608a46f125ff8e437a99bda/docs/design/decisions.md#the-box-is-the-credential-boundary) explains why.

To let the requests out, permit them in `policy.dw`:

```text
@id("github_connect")
permit (principal, action == Box::Action::"net:connect", resource)
when { context.input.host == "api.github.com" && context.input.port == 443 };

@id("github_request")
permit (principal, action == Box::Action::"http:request", resource)
when { context.input.host == "api.github.com" };
```

## Keys

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `destinations` | string array | required | The destinations the credential goes to. See [Destinations](#destinations). |
| `secret.ref` | string | required | Where the credential comes from: `env://NAME` or `aws://PROFILE`. See [Credential sources](#credential-sources). |
| `secret.placement` | string | `header` | For `env://`: where the credential goes. `header`, `basic_auth`, or `query_param`. |
| `secret.header` | string | `Authorization` | For `env://` with `placement = "header"`: the header name. |
| `secret.prefix` | string | `Bearer` on `Authorization`, empty on any other header | For `env://` with `placement = "header"`: the text before the credential. |
| `secret.param` | string | none | For `env://` with `placement = "query_param"`: the query parameter name. Required for that placement. |
| `secret.inject` | string | `phantom` | For `env://`: `phantom` adds the credential only to a request that carries the placeholder, and refuses any other request to the destinations. `always` adds it to every request to the destinations. |
| `secret.phantom_prefix` | string | `strands_box_` | For `env://`: the start of the placeholder, such as `sk-ant-` for a client that checks the key’s format. 1 to 64 letters, digits, `-`, `_`, `.`, or `~`. |

### Placement

| `placement` | The request carries | The agent sends the placeholder as |
| --- | --- | --- |
| `header` | `<header>: <prefix><credential>` | `<header>: <prefix><placeholder>` |
| `basic_auth` | `Authorization: Basic <base64 of the credential>`. The credential is `user:password`. | The password, in `Authorization: Basic <base64 of user:placeholder>` |
| `query_param` | `<param>=<credential>` in the query string | `<param>=<placeholder>` |

## Destinations

Each entry in `destinations` is a host, with an optional port and path.

| Entry | Matches |
| --- | --- |
| `api.github.com` | That host, on port 443 or 80 |
| `api.github.com:8443` | That host, on port 8443 |
| `*.example.com` | Every subdomain of `example.com`, on port 443 or 80. `example.com` itself needs its own entry. |
| `api.example.com/v1` | Paths under `/v1` on that host, by whole segment |
| `api.example.com/*/upload` | Paths on that host that end in `/upload` |

A host is matched in lowercase. A path is matched case-sensitively, against the path in the gateway’s canonical form. Two routes, or two entries in one route, can’t match the same destination, and an http MCP server’s host can’t appear in a route.

The canonical form keeps repeated slashes, and a path prefix matches by whole segment. So `api.example.com/v1` covers `/v1//chat`, and `api.example.com/v1/chat` doesn’t cover `/v1//chat`. [Forbid one URL path on a host](../../reference/policy/index.md#forbid-one-url-path-on-a-host) shows rules for these paths in policy.

## Credential sources

| `secret.ref` | Read from | When |
| --- | --- | --- |
| `env://NAME` | The variable `NAME` in the environment of `box run` | Once, when the box starts. The agent and each tool and MCP server get a placeholder in `NAME`. Every destination that names `NAME`, in one route or in several, accepts the same placeholder. |
| `aws://PROFILE` | The static access keys of `PROFILE` in the operator’s AWS configuration | On each request. The gateway signs the request with SigV4. |

An `aws://` route takes no placement, `header`, `prefix`, `param`, `inject`, or `phantom_prefix`. The agent gets placeholder `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` values, and the gateway signs each request to the destinations. The service and region come from the host, which ends in `.amazonaws.com` or `.api.aws`.

The gateway adds a credential only over HTTPS. A plain `http://` request to a destination a route names is refused.

## Errors and exit codes

`box run` exits with an error before the agent starts when a route breaks a rule on this page.

| Cause | Fix |
| --- | --- |
| A route has no `destinations`, or an entry is empty, `*`, or has port `0` | Name each host the credential goes to. |
| Two routes, or two entries in one route, match the same destination | Narrow one of them, for example by path or port. |
| A route names an http MCP server’s host | Put the credential on the `[mcp.<name>]` table. |
| `secret.ref` has a scheme other than `env` or `aws` | Use one of the two schemes. |
| `env://NAME` names a variable that is unset, blank, or reserved by the box | Set `NAME` in the host OS’s shell that runs `box run`, or choose another name. |
| An `aws://` route sets a placement, `header`, `prefix`, `param`, `inject`, or `phantom_prefix` | Remove the key. A signed route takes none. |
| `placement` is not `header`, `basic_auth`, or `query_param`, or is set with a key it does not take | Use one of the three, with only its own keys. |
| `placement = "query_param"` has no `param` | Name the query parameter. |
| `header` is not a valid header name, or `prefix` holds a control character or a brace | Use a plain header name and prefix. |
| `inject` is a value other than `phantom` or `always` | Use `phantom` or `always`. |
| `phantom_prefix` is empty, longer than 64 characters, or holds another character | Use 1 to 64 letters, digits, `-`, `_`, `.`, or `~`. |
| Two routes name one `env://NAME` with a different `phantom_prefix` | Set the same `phantom_prefix` on both. `NAME` holds one placeholder. |

A request the gateway refuses while the box runs gets an HTTP 403 with the header `x-strands-box-egress: refused`. The body says why:

| Body | Cause |
| --- | --- |
| The policy decision, naming the rule | `net:connect` or `http:request` refused the request. |
| `blocked by egress control` | A request to a route’s destinations lacks the placeholder, carries a different value, or can’t be signed. |
| `credential not permitted on a plaintext request` | A plain `http://` request went to a route’s destination. |
| `request authority rejected` | The request inside a `CONNECT` named a different host. |
| `response blocked by egress control` | The server sent a compressed response to a credentialed request. |

A 502 with no `x-strands-box-egress` header means the gateway couldn’t resolve or reach the server.

Responses arrive progressively, including on credentialed routes. Credential redaction retains a short tail until more bytes arrive or the response completes cleanly. Requests and HTTP MCP `tools/list` responses retain the default 16 MiB cap. The gateway’s 300-second upstream deadline covers complete response receipt; expiry or a later transfer error closes an unfinished response.

## See also

-   [How Box controls outbound traffic](https://github.com/strands-agents/box/blob/fbe415cbdfec284bf608a46f125ff8e437a99bda/docs/design/egress.md): routing, the connect and request decisions, and how the gateway adds a credential.
-   [The `[mcp.<name>]` table](../add-an-mcp-server/index.md): a credential for an http MCP server.