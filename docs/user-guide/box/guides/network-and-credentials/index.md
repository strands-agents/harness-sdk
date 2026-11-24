An `[egress.<name>]` table in `box.toml` binds a credential to a set of destinations. The box’s egress gateway adds the credential to each request to those destinations. Policy decides whether each request goes out.

Audience: an operator with a working box from [getting started](/docs/user-guide/box/core/quickstart/index.md) who gives the agent a credential for a service. For how the gateway decides and forwards each request, read [how Box controls outbound traffic](https://github.com/strands-agents/box/blob/a2a97eede44b01f536faa4ada8c3085f97634681/docs/design/egress.md).

A tool or local MCP server with `network.contain_egress = false` can connect directly, outside gateway policy. On Linux, this includes IPv4 access to reachable private networks, loopback services, and instance metadata endpoints. See [server network settings](/docs/user-guide/box/guides/add-an-mcp-server/index.md#network).

Such a program connects as it would on the host. Box sets no proxy variable and no CA file for it, so it uses its own defaults and verifies the real server’s certificate. Its table’s `env` may set `HTTPS_PROXY`, `SSL_CERT_FILE`, `GIT_SSL_CAINFO` and the other proxy and CA names, for a company proxy or CA bundle; add a `read_file` entry for a file it names. On macOS, the program may ask the system’s certificate services (`trustd` and `SecurityServer`), and keychain files stay unreadable. On Linux, if the default bundle is a link outside `/etc/ssl`, such as into `/etc/pki`, add a `read` entry for it. The startup report shows a `native trust:` line for the program. See [a native-egress process keeps its own proxy and trust settings](https://github.com/strands-agents/box/blob/a2a97eede44b01f536faa4ada8c3085f97634681/docs/design/decisions.md#a-native-egress-process-keeps-its-own-proxy-and-trust-settings).

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

> **Every process in the box can use every route.** The agent, each tool, each stdio MCP server, and the Shell that runs the agent’s commands get the same placeholders, and the gateway adds the real credential to a request from any of them. The gateway can’t tell which process sent a request, so no setting limits a route to one process. To keep a credential away from a tool or a server, run it in a separate box. [The box is the credential boundary](https://github.com/strands-agents/box/blob/a2a97eede44b01f536faa4ada8c3085f97634681/docs/design/decisions.md#the-box-is-the-credential-boundary) explains why.

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
| `secret.ref` | string | required, unless the entry declares a backend | Where the credential comes from: `env://NAME`, `aws://PROFILE`, a bare `aws://` for the default credential chain, or a reference in a declared scheme. See [Credential sources](#credential-sources). |
| `secret.env` | string | `NAME` for `env://NAME` | Experimental: needs `secret-sources = true` in [`[experimental-features]`](/docs/user-guide/box/reference/configuration/index.md#experimental-features). The variable that holds the placeholder in the workload. Required for a reference in a declared scheme. For `env://NAME` it is optional and must equal `NAME`. Refused for `aws://`. |
| `backends` | table array | none | A destination to re-route this entry’s requests to. At most one. See [Backends](#backends). |
| `secret.placement` | string | `header` | For `env://` and a declared scheme: where the credential goes. `header`, `basic_auth`, or `query_param`. |
| `secret.header` | string | `Authorization` | For `env://` and a declared scheme, with `placement = "header"`: the header name. |
| `secret.prefix` | string | `Bearer` on `Authorization`, empty on any other header | For `env://` and a declared scheme, with `placement = "header"`: the text before the credential. |
| `secret.param` | string | none | For `env://` and a declared scheme, with `placement = "query_param"`: the query parameter name. Required for that placement. |
| `secret.inject` | string | `phantom` | For `env://` and a declared scheme: `phantom` adds the credential only to a request that carries the placeholder, and refuses any other request to the destinations. `always` adds it to every request to the destinations. Refused beside a backend, where the destination secret is phantom-only and the box injects nothing. |
| `secret.phantom_prefix` | string | `strands_box_` | For `env://` and a declared scheme: the start of the placeholder, such as `sk-ant-` for a client that checks the key’s format. 1 to 64 letters, digits, `-`, `_`, `.`, or `~`. |

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

The canonical form keeps repeated slashes, and a path prefix matches by whole segment. So `api.example.com/v1` covers `/v1//chat`, and `api.example.com/v1/chat` doesn’t cover `/v1//chat`. [Forbid one URL path on a host](/docs/user-guide/box/reference/policy/index.md#forbid-one-url-path-on-a-host) shows rules for these paths in policy.

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
| `backends.url` | string | required | The backend to dial, as `scheme://host[:port][/prefix]`. `https` or `http`. An explicit port must be 1 to 65535. A path prefix is allowed; a query or fragment is not. A prefix adds a request-path restriction; see the note below. |
| `backends.auth.ref` | string | none | The backend’s own credential: `env://NAME` or a reference in a declared scheme for a static token (takes `backends.auth.header`, `backends.auth.placement`, `backends.auth.prefix`, `backends.auth.param`, but no `env`, `inject`, or `phantom_prefix`), or `aws://PROFILE` to SigV4-sign the request over the backend host (requires `backends.auth.aws.service` and `backends.auth.aws.region`). |
| `backends.auth.aws.service` / `backends.auth.aws.region` | string | none | The SigV4 service (e.g. `bedrock-agentcore`) and region (e.g. `us-east-1`) to sign under. Each must be non-empty and only lowercase letters, digits, or `-`, because the signer uses the value verbatim. Required for an `aws://` auth, refused otherwise. |

The box dials the backend’s host and port, presents the backend host for TLS and in the `Host` header, and validates the backend’s certificate against the backend host. If the `url` has a path prefix, the box puts it in front of the agent’s request path, so a request to `api.github.com/zen` with a backend `url` of `https://gateway-1.example.com/github` leaves as `gateway-1.example.com/github/zen`. The original destination and the agent’s own path stay in policy and in the audit record. The box checks the backend’s address against policy before it connects, so a `forbid` on a metadata or private address refuses a backend that resolves there.

A `secret` on the entry may sit beside a backend, but only as `env://`, and it is phantom-only: the box provisions a placeholder in the named variable (so the agent’s credential-shaped code works) and strips it from the request, and never sends the real value. The backend handles the destination’s auth downstream. Because the box never reads the real value, the named variable may be unset, and `secret.inject` is refused (there is nothing to inject). A signed destination `secret` (`aws://` or `credsd://`) is refused beside a backend, because it mints no placeholder to strip. A destination `secret` in a declared scheme is refused too, because the box never reads that secret.

When the backend `url` has a path prefix, the box refuses a request whose path contains an encoded slash (`%2F`) or backslash (`%5C`): joining a prefix in front of an escaped separator could change which path the backend sees, so the box fails the request rather than risk a traversal. This rejects some legitimate requests, for example a GitLab path such as `/api/v4/projects/1/repository/files/src%2FREADME.md`. If a destination needs encoded separators, give the backend a **dedicated host with no path prefix** (`url = "https://gw.example.com"`), which carries no join and so no restriction.

A backend’s `auth` rides an `https` backend. An `env://` token is attached as-is; an `aws://` profile is SigV4-signed over the **backend** host. The box signs the request after it rewrites the `Host` to the backend, so the signature covers the bytes the backend receives. The service and region are **stated explicitly** in `backends.auth.aws` (e.g. `service = "bedrock-agentcore"`, `region = "us-east-1"`); the box does not guess them from the host, because a gateway or custom-domain host carries no standard AWS scope. A `credsd://` auth is refused.

```toml
[[egress.github.backends]]
url              = "https://my-gw.gateway.bedrock-agentcore.us-east-1.amazonaws.com/github"
auth.ref         = "aws://default"
auth.aws.service = "bedrock-agentcore"
auth.aws.region  = "us-east-1"
```

An entry may keep its own `secret` beside a backend, and it must be `env://`. It is phantom-only: the box provisions the placeholder to the workload (so the agent’s credential-shaped code works) and strips it from the request, and never injects the real destination credential. The backend handles the destination’s auth. Because the box never reads the real value, the named variable need not be set; name it for the placeholder the workload expects. If the destination `secret` and the backend `auth` name the same header, the backend token wins.

A backend entry names exactly one destination with an exact host: no path, no wildcard, and not several destinations. The box presents the backend host on the wire, so distinct origins sent to one backend would reach it as the same bytes with the agent’s host lost. Write one entry per host.

A host that re-routes to a backend may be named by no other entry, on any port. The box matches a re-route by host alone, so any other entry that covers the host would load and then be refused on every request. That includes a direct entry on another port, a second backend, or a `*`/`*.suffix` wildcard that spans it. The loader refuses the pair instead.

This version re-routes to one backend. More than one backend and routing rules are not yet available.

A remote MCP server re-routes the same way: attach `[[mcp.<name>.backends]]` to a `type = "http"` server. See [Backends in the MCP guide](/docs/user-guide/box/guides/add-an-mcp-server/index.md#backends).

## Credential sources

| `secret.ref` | Read from | When |
| --- | --- | --- |
| `env://NAME` | The variable `NAME` in the environment of `box run` | Once, when the box starts. The agent, each tool, each stdio MCP server, and the Shell get a placeholder in `NAME`. Every destination that names `NAME`, in one route or in several, accepts the same placeholder. |
| `aws://PROFILE` | The named profile `PROFILE`, resolved through the AWS SDK | On each request. The gateway signs the request with SigV4. |
| `aws://` (no profile) | The AWS SDK default credential provider chain on the host | On each request. The gateway signs the request with SigV4, under the host’s ambient identity. |
| `<scheme>://NAME[#FIELD]`, for a scheme that a [`[secret-source.<scheme>]`](/docs/user-guide/box/reference/configuration/index.md#secret-sourcescheme) table declares | The host program that the table names | Experimental. Once, when the box starts: Box runs the program and reads the secret from its stdout. The agent, each tool, each stdio MCP server, and the Shell get a placeholder in the variable that `secret.env` names. You don’t set that variable. See [how a run reads the secrets](/docs/user-guide/box/reference/configuration/index.md#how-a-run-reads-the-secrets). |

An `aws://` route takes no placement, `header`, `prefix`, `param`, `inject`, or `phantom_prefix`. The gateway signs each request to the destinations. The service and region come from the host, which ends in `.amazonaws.com` or `.api.aws`.

Both forms resolve through the AWS SDK, so they share one capability. A bare `aws://` resolves the default credential provider chain, in order: the `AWS_*` environment variables, the profile files (including `credential_process`), web identity, the ECS or EKS container endpoint, then EC2 instance metadata: the host’s **ambient** identity. `aws://PROFILE` resolves **only** the named profile: its static keys, `credential_process`, assume-role, or web identity. It never reads the ambient `AWS_*` keys or instance metadata. Like the AWS CLI’s `--profile`, a missing profile is refused rather than signing as the ambient identity. Naming a profile pins *which* identity signs; it does not avoid `credential_process` (see the writable-`~/.aws` note below).

This build does **not** resolve **AWS SSO** or `aws login` profiles (the SDK’s `sso` provider is compiled out to keep the dependency surface small). Such a profile, named or default, is refused, and the refusal names the missing provider. If your identity is SSO, log in with a tool that writes static or session keys to `~/.aws/credentials`.

Because a bare `aws://` signs with whatever identity the host carries, the box prints a warning in the startup disclosure, once for each destination that signs this way:

```plaintext
strands-box: warning: aws:// for bedrock-runtime.us-west-2.amazonaws.com signs with this machine's AWS identity
```

The line names the destination as the route writes it, so a box with two such destinations prints two lines.

Each request it signs that way still gets its own audit record. To pin which identity signs, name a profile with `aws://PROFILE`, and grant the workload no write access to `~/.aws`.

Naming a profile with `aws://PROFILE` pins *which* identity signs and does not warn. The shipped box has no setting that refuses a bare `aws://` outright. It always signs with a warning. So a deployment that must pin the identity writes `aws://PROFILE` rather than a bare `aws://`.

> **Writable `~/.aws` is a remote-code-execution path.** Both `aws://` forms read the profile files, which include the `credential_process` setting: a program the AWS SDK **executes** to obtain credentials. That program runs inside the box’s trusted process, **outside** the sandbox. So if a filesystem list grants the workload (the agent, a tool, the interpreter, or the Shell) write access to `~/.aws` or any parent of it, the workload can write `credential_process = /path/to/its-own-program` and have the box run it outside containment on the next `aws://` request. This covers a named profile as much as the bare form, since both resolve `credential_process` through the SDK. **Grant write access to `~/.aws` only when every process that can write there is trusted**. That is the box’s only mitigation for either form.

The gateway adds a credential only over HTTPS. A plain `http://` request to a destination a route names is refused. The one exception is a service on your own machine, at `host.box.internal`; see [a service on your machine](#a-service-on-your-machine).

## A service on your machine

Inside a box, `localhost` is the box itself. To reach a service on your machine’s loopback, such as a local LLM gateway on `127.0.0.1:4259`, point the agent at `http://host.box.internal:4259`. The gateway sends the request to `127.0.0.1:4259`. No starter policy permits the name; [reach a service on your machine](/docs/user-guide/box/reference/policy/index.md#reach-a-service-on-your-machine) shows the rules.

A route can add the service’s key, also over plain `http://`:

```toml
[egress.local_llm]
destinations = ["host.box.internal:4259"]
secret.ref   = "env://LOCAL_LLM_KEY"
```

A secret rides a plain request only when every route that matches names `host.box.internal` exactly, with a port, and no backend re-routes it. Plain HTTP doesn’t check who answers, so the secret goes to whatever process holds that port: start the service before the agent. The route can’t use an `[[agent.ingress]]` port, because that port leads back to the agent.

-   Use `http://`. An `https://` request fails the gateway’s certificate check, because a local service seldom has a trusted certificate for `host.box.internal`.
-   The name is IPv4 `127.0.0.1` only, so a service on `::1` alone is out of reach.
-   When Box runs in a container, the name reaches the container’s loopback.

## Networks that re-sign TLS

Some company networks re-sign HTTPS traffic with their own root certificate. The gateway checks each server’s certificate against its built-in public roots and the roots your machine trusts, so a root that your machine already trusts works in the box with no setting.

-   On macOS, the gateway reads the trusted roots in the keychain, including one your administrator installed.
-   On Linux, it reads the system bundle, such as `/etc/pki/tls/certs/ca-bundle.crt` or `/etc/ssl/certs/ca-certificates.crt`.
-   When `box run` has `SSL_CERT_FILE` or `SSL_CERT_DIR` set, the gateway reads only the file and directories they name, on both platforms. On macOS that replaces the keychain.

The gateway reads the roots once, when the box starts, and stderr says how many it added:

```text
strands-box: the egress gateway also trusts 136 root certificates from this host's trust store for upstream servers (0 ignored)
```

A trusted root can vouch for any server, and the network that re-signs the traffic reads every request in plain text, including each credential the gateway adds. Policy still decides every destination.

The box doesn’t start when a `write` or `write_file` entry, in any table, reaches a file or directory that `SSL_CERT_FILE` or `SSL_CERT_DIR` names. A root written there would be trusted by the next run. Read access is fine. A common case is `SSL_CERT_FILE` set to Python’s `certifi` bundle inside a project’s `.venv`, with the project writable: unset the variable for `box run`, or add a `deny` entry for the bundle. The Shell and Python also refuse to change these paths, whatever your policy permits.

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
| An entry has a backend and a signed (`aws://`/`credsd://`) `secret`, or one in a declared scheme | A re-routed destination secret is phantom-only, so it must be `env://`. |
| An entry has a backend and sets `secret.inject` | A re-routed destination secret is phantom-only: it is provisioned to the workload and stripped, never injected. So `inject` has no effect. Remove `secret.inject`. |
| A `backends.auth` uses `credsd://`, or sits on an `http` backend | Use an `env://` token or an `aws://` profile on an `https` backend. |
| A `backends.auth` uses `aws://` without a valid `aws.service`/`aws.region` (or sets them on a non-`aws://` auth) | An `aws://` backend auth signs over the backend host, so state `backends.auth.aws.service` and `backends.auth.aws.region`, each non-empty and only lowercase letters, digits, or `-`. They are valid only on an `aws://` auth. |
| `secret.ref` has a scheme other than `env` or `aws`, and no `[secret-source.<scheme>]` table declares it | Use one of the two schemes, or declare the [secret source](/docs/user-guide/box/reference/configuration/index.md#secret-sourcescheme). |
| A route in a declared scheme has no `secret.env` | Name the variable that holds the placeholder, such as `secret.env = "GH_TOKEN"`. |
| `secret.env` on an `env://NAME` route is not `NAME`, or an `aws://` route sets `secret.env` | Remove `secret.env`. |
| `secret.env` is set while `secret-sources` is off | Set `secret-sources = true` in `[experimental-features]`, or remove `secret.env` from an `env://` route, where it has no effect. |
| Two entries hold a placeholder in one variable and name different secrets | Give one of them another variable. One placeholder variable holds one secret. |
| An entry holds a placeholder in `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` beside a signed (`aws://`/`credsd://`) route | Give the entry another variable. A signed route fills those two variables with its own placeholders. |
| `env://NAME` names a variable that a `pass-secret-env` list of a `[secret-source.<scheme>]` table names | Use another variable. No `env://` reference can read the credential of a declared source’s vault. |
| `` `[egress.<name>] secret.ref` names a secret that the secret source `<scheme>` (<program>) did not return ``, at startup | Read the line before it on stderr, which holds the reason and the program’s own words. Sign in to the vault or correct the reference, then start the box again. |
| `env://NAME` names a variable that is unset, blank, or reserved by the box | Set `NAME` in the host OS’s shell that runs `box run`, or choose another name. |
| A bare `aws://` route whose default credential chain resolves no credentials at startup (no env keys, no default profile, no IMDS), or whose `credential_process` does not finish within the resolve timeout | Configure the host’s AWS credentials, or name a profile with `aws://PROFILE`. The box validates a bare `aws://` chain once at startup, so a broken one stops `box run` rather than the first request. |
| An `aws://` route sets a placement, `header`, `prefix`, `param`, `inject`, or `phantom_prefix` | Remove the key. A signed route takes none. |
| `placement` is not `header`, `basic_auth`, or `query_param`, or is set with a key it does not take | Use one of the three, with only its own keys. |
| `placement = "query_param"` has no `param` | Name the query parameter. |
| `header` is not a valid header name, or `prefix` holds a control character or a brace | Use a plain header name and prefix. |
| `inject` is a value other than `phantom` or `always` | Use `phantom` or `always`. |
| `phantom_prefix` is empty, longer than 64 characters, or holds another character | Use 1 to 64 letters, digits, `-`, `_`, `.`, or `~`. |
| Two routes hold a placeholder in one variable with a different `phantom_prefix` | Set the same `phantom_prefix` on both. One variable holds one placeholder. |
| A `[gateway] upgrade_http` entry names a scheme, a port, a path, a `*` wildcard, or an IP address, or holds another character | Write the host name alone, such as `static.rust-lang.org`. |
| A `write` or `write_file` entry reaches a path that `SSL_CERT_FILE` or `SSL_CERT_DIR` names | Remove the write, subtract the path with a `deny` entry, or run `box run` without that variable. See [networks that re-sign TLS](#networks-that-re-sign-tls). |
| A secret on `host.box.internal` names no port, or an `[[agent.ingress]]` port | Name the service’s own port, such as `host.box.internal:4259`. |

A request the gateway refuses while the box runs gets an HTTP 403 with the header `x-strands-box-egress: refused`. The body says why:

| Body | Cause |
| --- | --- |
| The policy decision, naming the rule | `net:connect` or `http:request` refused the request. |
| `blocked by egress control` | A request to a route’s destinations lacks the placeholder, carries a different value, or can’t be signed. A bare `aws://` chain that resolved at startup but later stops (a rotated-away credential, a `credential_process` that begins to fail) can’t be signed and refuses here; one that is already broken at startup stops `box run` instead. |
| `credential not permitted on a plaintext request` | A plain `http://` request went to a route’s destination, including one the gateway [upgrades to HTTPS](#upgrade-plain-http-to-https). |
| `... the gateway's own listener ...` | The request named the gateway’s own port. |
| `request authority rejected` | The request inside a `CONNECT` named a different host. |
| `response blocked by egress control` | The server sent a compressed response to a credentialed request. |

A request inside a `CONNECT` that the gateway can’t read gets an HTTP 400 with the same header. The body says why, such as `response limit exceeded: body length exceeds limit 16777216` for a body over the request limit, or `intercept error: malformed Connection header`. Nothing reaches the server.

A request the gateway doesn’t refuse but can’t complete gets an HTTP 502 with the header `x-strands-box-egress: failed`. The body says why, for example:

| Body | Cause |
| --- | --- |
| `io error: upstream TLS handshake: <reason>` | The server’s certificate chains to no root the gateway trusts, or the TLS handshake failed. See [networks that re-sign TLS](#networks-that-re-sign-tls). |
| `io error: upstream exchange: <reason>` | The server closed the connection before it replied. |
| `io error: upstream deadline passed` | The server didn’t reply within the upstream deadline. |
| `effect interceptor unavailable` | The box’s policy check failed. |

Except for `effect interceptor unavailable`, policy permitted the request, so it may have reached the server. The box also prints the reason on stderr, naming the backend when the destination re-routes to one: `strands-box: warning: egress request to <host>:<port> failed: <reason>`.

A 502 with no `x-strands-box-egress` header answers a `CONNECT`, or a plain `http://` request, that the gateway couldn’t resolve or connect to. Any other 502 without the header comes from the server.

A WebSocket needs `wss://`, so it rides a `CONNECT`. The handshake is decided as [`websocket:connect`](/docs/user-guide/box/reference/policy-actions/index.md#network), and the gateway adds the credential to it and redacts the credential in the `101`, as for any request. After the `101`, the gateway copies bytes both ways, unchanged, and asks policy nothing more. It doesn’t redact a credential in a WebSocket message. The handshake can be refused:

| Response | Cause |
| --- | --- |
| 400 `malformed WebSocket handshake` | The handshake isn’t an HTTP/1.1 `GET` with `Connection: upgrade`, `Sec-WebSocket-Version: 13`, one `Sec-WebSocket-Key`, and no body. |
| 403 `WebSocket requires TLS` | A plain `ws://` handshake, including to a host in `upgrade_http`. |
| 403 `WebSocket refused for an MCP server` | The handshake went to an HTTP MCP server’s host. |
| 502 | The server’s `101` doesn’t name `websocket` as its `Upgrade`, or doesn’t carry the `Sec-WebSocket-Accept` for the handshake’s key. A reply other than `101` that has no `Content-Length` and isn’t chunked also gets 502. |

The gateway ends both connections, with no Close frame, when no byte moves for 300 seconds.

Responses arrive progressively, including on credentialed routes. Credential redaction retains a short tail until more bytes arrive or the response completes cleanly. Requests and HTTP MCP `tools/list` responses retain the default 16 MiB cap. The gateway’s 300-second upstream deadline covers complete response receipt; expiry or a later transfer error closes an unfinished response.

While the workload runs, Ctrl-C sends it an interrupt. After the workload stops, `strands-box run` restores the terminal before waiting for cleanup. While Box waits for upstream exchanges or other work that produces policy records, Ctrl-C or the termination signal `SIGTERM` ends `strands-box` immediately. This interruption path also applies during the final history flush. The hangup signal `SIGHUP` also ends it, unless Box inherited that signal as ignored, such as under `nohup`. Forced termination can lose pending history. The later telemetry drain has a separate ten-second timeout and runs after Box restores the signal handlers saved before these stages.

Without forced termination, Box waits for active upstream exchanges and other work that produces policy records to finish before its final history flush. This also applies in default builds. An unfinished response can keep cleanup waiting until the remaining part of the 300-second exchange deadline expires. That deadline limits the upstream exchange, not the whole shutdown: policy callbacks, history writes, and other shutdown work have no shared completion deadline.

## See also

-   [How Box controls outbound traffic](https://github.com/strands-agents/box/blob/a2a97eede44b01f536faa4ada8c3085f97634681/docs/design/egress.md): routing, the connect and request decisions, and how the gateway adds a credential.
-   [The `[mcp.<name>]` table](/docs/user-guide/box/guides/add-an-mcp-server/index.md): a credential for an http MCP server.