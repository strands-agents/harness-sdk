An `[egress.<name>]` table in `box.toml` binds a credential to a set of destinations. The box’s egress gateway adds the credential to each request to those destinations. Policy decides whether each request goes out.

Audience: an operator with a working box from [getting started](../../quickstart/index.md) who gives the agent a credential for a service. For how the gateway decides and forwards each request, read [how Box controls outbound traffic](https://github.com/strands-agents/box/blob/a2cf46ed6a9ea0a8144101bfdef3f2406390952b/docs/design/egress.md).

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

> **Every process in the box can use every route.** The agent, each tool, each stdio MCP server, and the Shell that runs the agent’s commands get the same placeholders, and the gateway adds the real credential to a request from any of them. The gateway can’t tell which process sent a request, so no setting limits a route to one process. To keep a credential away from a tool or a server, run it in a separate box. [The box is the credential boundary](https://github.com/strands-agents/box/blob/a2cf46ed6a9ea0a8144101bfdef3f2406390952b/docs/design/decisions.md#the-box-is-the-credential-boundary) explains why.

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
| `secret.ref` | string | required, unless the entry declares a backend | Where the credential comes from: `env://NAME`, `aws://PROFILE`, or a bare `aws://` for the default credential chain. See [Credential sources](#credential-sources). |
| `backends` | table array | none | A destination to re-route this entry’s requests to. At most one. See [Backends](#backends). |
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

## Backends

A backend re-routes an entry’s requests to a destination you control. The agent sends a request to the destination, and the box sends it to the backend instead. Policy still decides the original destination, not the backend: the re-route is the box’s action, not the agent’s.

```toml
[egress.github]
destinations = ["api.github.com"]

[[egress.github.backends]]
url      = "https://gateway-1.example.com/github"
auth.ref = "env://BOX_GW_TOKEN"
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `backends.url` | string | required | The backend to dial, as `scheme://host[:port][/prefix]`. `https` or `http`. A path prefix is allowed; a query or fragment is not. |
| `backends.auth.ref` | string | none | The backend’s own credential: `env://NAME` for a static token (takes `backends.auth.header`, `backends.auth.placement`, `backends.auth.prefix`, `backends.auth.param`, but no `inject` or `phantom_prefix`), or `aws://PROFILE` to SigV4-sign the request over the backend host (requires `backends.auth.aws.service` and `backends.auth.aws.region`). |
| `backends.auth.aws.service` / `backends.auth.aws.region` | string | none | The SigV4 service (e.g. `bedrock-agentcore`) and region (e.g. `us-east-1`) to sign under. Each must be non-empty and only lowercase letters, digits, or `-`, because the signer uses the value verbatim. Required for an `aws://` auth, refused otherwise. |

The box dials the backend’s host and port, presents the backend host for TLS and in the `Host` header, and validates the backend’s certificate against the backend host. If the `url` has a path prefix, the box puts it in front of the agent’s request path, so a request to `api.github.com/zen` with a backend `url` of `https://gateway-1.example.com/github` leaves as `gateway-1.example.com/github/zen`. The original destination and the agent’s own path stay in policy and in the audit record. The box checks the backend’s address against policy before it connects, so a `forbid` on a metadata or private address refuses a backend that resolves there.

A backend’s `auth` rides an `https` backend. An `env://` token is attached as-is; an `aws://` profile is SigV4-signed over the **backend** host — the box signs the request after it rewrites the `Host` to the backend, so the signature covers the bytes the backend receives. The service and region are **stated explicitly** in `backends.auth.aws` (e.g. `service = "bedrock-agentcore"`, `region = "us-east-1"`); the box does not guess them from the host, because a gateway or custom-domain host carries no standard AWS scope. A `credsd://` auth is refused.

```toml
[[egress.github.backends]]
url              = "https://my-gw.gateway.bedrock-agentcore.us-east-1.amazonaws.com/github"
auth.ref         = "aws://default"
auth.aws.service = "bedrock-agentcore"
auth.aws.region  = "us-east-1"
```

An entry may keep its own `secret` beside a backend, and it must be `env://`. It is phantom-only: the box provisions the placeholder to the workload (so the agent’s credential-shaped code works) and strips it from the request, and never injects the real destination credential — the backend handles the destination’s auth. Because the box never reads the real value, the named variable need not be set; name it for the placeholder the workload expects. If the destination `secret` and the backend `auth` name the same header, the backend token wins.

A backend entry names exactly one destination with an exact host: no path, no wildcard, and not several destinations. The box presents the backend host on the wire, so distinct origins sent to one backend would reach it as the same bytes with the agent’s host lost. Write one entry per host.

A host that re-routes to a backend may be named by no other entry, on any port. The box matches a re-route by host alone, so any other entry that covers the host — a direct entry on another port, a second backend, or a `*`/`*.suffix` wildcard that spans it — would load and then be refused on every request. The loader refuses the pair instead.

This version re-routes to one backend. More than one backend and routing rules are not yet available.

## Credential sources

| `secret.ref` | Read from | When |
| --- | --- | --- |
| `env://NAME` | The variable `NAME` in the environment of `box run` | Once, when the box starts. The agent, each tool, each stdio MCP server, and the Shell get a placeholder in `NAME`. Every destination that names `NAME`, in one route or in several, accepts the same placeholder. |
| `aws://PROFILE` | The static access keys of `PROFILE` in the operator’s AWS configuration | On each request. The gateway signs the request with SigV4. |
| `aws://` (no profile) | The AWS SDK default credential provider chain on the host | On each request. The gateway signs the request with SigV4, under the host’s ambient identity. |

An `aws://` route takes no placement, `header`, `prefix`, `param`, `inject`, or `phantom_prefix`. The gateway signs each request to the destinations. The service and region come from the host, which ends in `.amazonaws.com` or `.api.aws`.

A bare `aws://` with no profile signs with the host’s **ambient** AWS identity. It resolves the AWS SDK default credential provider chain, in order: the `AWS_*` environment variables, the profile files (including `credential_process`), web identity, the ECS or EKS container endpoint, then EC2 instance metadata. `aws://PROFILE` instead reads the static keys of one named profile and nothing else.

This build does **not** resolve **AWS SSO** or `aws login` profiles (the SDK’s `sso` provider is compiled out to keep the dependency surface small). A default profile from `aws configure sso` is refused, and the refusal names the missing provider. If your ambient identity is SSO, log in with a tool that writes static or session keys to `~/.aws/credentials`, or bind `aws://PROFILE` to a profile that carries keys.

Because a bare `aws://` signs with whatever identity the host carries, the box prints a warning on **every** request it signs that way:

```plaintext
strands-box credentials [<tenant>]: signing with the host's ambient AWS identity: a bare aws://
resolved the default credential provider chain, not a declared scoped profile. Prefer aws://PROFILE
to pin the identity, and grant the workload no write access to ~/.aws
```

To pin the identity, name a profile: `aws://PROFILE` reads one profile’s static keys, never the ambient chain, and never warns. The shipped box has no setting that refuses a bare `aws://` outright — it always signs with a warning — so a deployment that must not sign with an ambient identity writes `aws://PROFILE` rather than a bare `aws://`.

> **Writable `~/.aws` is a remote-code-execution path.** The default chain reads the profile files, which include the `credential_process` setting — a program the AWS SDK **executes** to obtain credentials. That program runs inside the box’s trusted process, **outside** the sandbox. So if a filesystem list grants the workload (the agent, a tool, the interpreter, or the Shell) write access to `~/.aws` or any parent of it, the workload can write `credential_process = /path/to/its-own-program` and have the box run it outside containment on the next bare-`aws://` request. **Grant write access to `~/.aws` only when every process that can write there is trusted** — this is the box’s only mitigation for a bare `aws://`. `aws://PROFILE` does not read `credential_process`, so a named profile is not exposed to this path; prefer one when the workload may reach `~/.aws`.

The gateway adds a credential only over HTTPS. A plain `http://` request to a destination a route names is refused.

## Upgrade plain HTTP to HTTPS

Some tools check certificates with the macOS platform verifier, which can’t trust the box’s CA. rustup is one: `rustup toolchain install` in a box on macOS fails with `OSStatus -26276`. Such a tool can send plain `http://` to the gateway instead, and the gateway makes the `https://` call itself. List each host in the top-level `[gateway]` table:

```toml
[gateway]
upgrade_http = ["static.rust-lang.org"]
```

Then point the tool at the `http://` address, for rustup with `[agent] env.RUSTUP_DIST_SERVER = "http://static.rust-lang.org"`.

A plain `http://` request to port 80 of a listed host is upgraded. The gateway decides it as `https://` on port 443, exactly as it decides a `CONNECT` to that host: `net:connect` and `http:request` see port 443, and the decision records name port 443. Permit it with the rules you would write for HTTPS to that host. The gateway then connects with TLS and checks the server’s certificate against its usual roots, with the host as the server name. `Host` is the bare host. Every other plain `http://` request is unchanged: an unlisted host, and any port other than 80 on a listed host, go out as plain HTTP on their own port.

The hop from the tool to the gateway stays plain HTTP. It stays on the machine, but anything in the box that can read that traffic can read the request. For the same reason the request’s `intercepted` attribute is `false`, and a credential is still never added to it: a request to an upgraded host that a route’s `destinations` match is refused with `credential not permitted on a plaintext request`. Use `upgrade_http` only for hosts that need no credential, such as a public download server. rustup still checks each package against the SHA-256 hash in its channel manifest.

The list applies to every process in the box. An entry is a host name alone: the box refuses a scheme, a port, a path, a `*` wildcard, or an IP address when the configuration loads, with ``invalid Box configuration: `[gateway] upgrade_http` entry "<entry>" is not a host name: <reason>``. The match ignores case and a trailing dot, and names one host: listing `static.rust-lang.org` does not upgrade `rust-lang.org`.

## Errors and exit codes

`box run` exits with an error before the agent starts when a route breaks a rule on this page.

| Cause | Fix |
| --- | --- |
| A route has no `destinations`, or an entry is empty, `*`, or has port `0` | Name each host the credential goes to. |
| Two routes, or two entries in one route, match the same destination | Narrow one of them, for example by path or port. |
| A route names an http MCP server’s host | Put the credential on the `[mcp.<name>]` table. |
| An entry declares more than one backend | Keep one backend. Routing across several is not yet available. |
| A `backends.url` has a query, fragment, no host, or a scheme other than `http`/`https` | Name the backend as `scheme://host[:port][/prefix]`. A path prefix is allowed; a query or fragment is not. |
| An entry has a backend, and its destination is not one exact host | A re-route is matched per connection, on host and port, and the box presents the backend host on the wire. Give a backend entry exactly one destination with an exact host (no path, no wildcard). Write one entry per host. |
| A host with a backend is also named by another entry (any port) | A re-route is matched by host alone, so a host that re-routes may name no other entry. Move the other destination to its own host, or drop it. |
| An entry has a backend and a signed (`aws://`/`credsd://`) `secret` | A re-routed destination secret is phantom-only, so it must be `env://`. |
| An entry has a backend and sets `secret.inject` | A re-routed destination secret is phantom-only — provisioned to the workload and stripped, never injected — so `inject` has no effect. Remove `secret.inject`. |
| A `backends.auth` uses `credsd://`, or sits on an `http` backend | Use an `env://` token or an `aws://` profile on an `https` backend. |
| A `backends.auth` uses `aws://` without a valid `aws.service`/`aws.region` (or sets them on a non-`aws://` auth) | An `aws://` backend auth signs over the backend host, so state `backends.auth.aws.service` and `backends.auth.aws.region`, each non-empty and only lowercase letters, digits, or `-`. They are valid only on an `aws://` auth. |
| `secret.ref` has a scheme other than `env` or `aws` | Use one of the two schemes. |
| `env://NAME` names a variable that is unset, blank, or reserved by the box | Set `NAME` in the host OS’s shell that runs `box run`, or choose another name. |
| An `aws://` route sets a placement, `header`, `prefix`, `param`, `inject`, or `phantom_prefix` | Remove the key. A signed route takes none. |
| `placement` is not `header`, `basic_auth`, or `query_param`, or is set with a key it does not take | Use one of the three, with only its own keys. |
| `placement = "query_param"` has no `param` | Name the query parameter. |
| `header` is not a valid header name, or `prefix` holds a control character or a brace | Use a plain header name and prefix. |
| `inject` is a value other than `phantom` or `always` | Use `phantom` or `always`. |
| `phantom_prefix` is empty, longer than 64 characters, or holds another character | Use 1 to 64 letters, digits, `-`, `_`, `.`, or `~`. |
| Two routes name one `env://NAME` with a different `phantom_prefix` | Set the same `phantom_prefix` on both. `NAME` holds one placeholder. |
| A `[gateway] upgrade_http` entry names a scheme, a port, a path, a `*` wildcard, or an IP address, or holds another character | Write the host name alone, such as `static.rust-lang.org`. |

A request the gateway refuses while the box runs gets an HTTP 403 with the header `x-strands-box-egress: refused`. The body says why:

| Body | Cause |
| --- | --- |
| The policy decision, naming the rule | `net:connect` or `http:request` refused the request. |
| `blocked by egress control` | A request to a route’s destinations lacks the placeholder, carries a different value, or can’t be signed. A bare `aws://` route whose default chain resolves no credentials can’t be signed and refuses here. |
| `credential not permitted on a plaintext request` | A plain `http://` request went to a route’s destination, including one the gateway [upgrades to HTTPS](#upgrade-plain-http-to-https). |
| `request authority rejected` | The request inside a `CONNECT` named a different host. |
| `response blocked by egress control` | The server sent a compressed response to a credentialed request. |

A 502 with no `x-strands-box-egress` header means the gateway couldn’t resolve or reach the server.

Responses arrive progressively, including on credentialed routes. Credential redaction retains a short tail until more bytes arrive or the response completes cleanly. Requests and HTTP MCP `tools/list` responses retain the default 16 MiB cap. The gateway’s 300-second upstream deadline covers complete response receipt; expiry or a later transfer error closes an unfinished response.

## See also

-   [How Box controls outbound traffic](https://github.com/strands-agents/box/blob/a2cf46ed6a9ea0a8144101bfdef3f2406390952b/docs/design/egress.md): routing, the connect and request decisions, and how the gateway adds a credential.
-   [The `[mcp.<name>]` table](../add-an-mcp-server/index.md): a credential for an http MCP server.