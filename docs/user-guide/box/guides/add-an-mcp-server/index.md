An `[mcp.<name>]` table in `box.toml` identifies an MCP server for Box’s tool restrictions. MCP means Model Context Protocol. A stdio server is a program that the box starts in its own sandbox. An http server runs somewhere else, and the agent reaches it through the box’s egress gateway.

Audience: an operator with a working box from [getting started](/docs/user-guide/box/core/quickstart/index.md) who adds an MCP server to it. To let the agent use the server, write its rules as in [write policy for an MCP server](/docs/user-guide/box/guides/write-mcp-policy/index.md).

## Example

A stdio server and an http server:

```toml
[mcp.fetch]
type    = "stdio"
command = ["mcp-server-fetch"]

[mcp.fetch.filesystem]
read = ["~/.local/share/uv/tools/mcp-server-fetch", "~/.local/share/uv/python"]

[mcp.github]
type         = "http"
destinations = ["api.githubcopilot.com"]
secret.ref   = "env://GITHUB_MCP_TOKEN"
```

The table’s name, `fetch` or `github`, is the server name. Policy reads it as `context.input.server`.

## Protocol versions

The stdio broker accepts MCP `2026-07-28` and the legacy versions `2024-11-05`, `2025-03-26`, `2025-06-18`, and `2025-11-25`. No configuration change is needed. Server frames with duplicate JSON object keys are refused for both protocol paths.

A modern client sends its protocol version and capabilities with each request. It can list tools without an initialization handshake or a discovery request. A legacy client must complete its handshake before listing tools. Both paths use the same tool catalog and policy checks. `policy generate-schema` also discovers modern stdio servers and falls back to a legacy handshake when its discovery probe receives an error other than a recognized error from the new protocol, or no reply within two seconds. A server that closes stdout without replying gets one fresh start with the legacy handshake. A valid modern discovery reply that arrives while the handshake waits selects one fresh start with modern requests. Discovery permits at most one restart within its 30-second deadline. Partial or malformed replies fail discovery.

Some modern calls ask the client for more input, such as a list of roots or an elicitation answer. Box first checks the retried call against the catalog and its policy, then checks each answer under the requested method’s `mcp:call` policy. The client must retry on the same connection with the original parameters and the server’s exact request state. If that connection closes, start the operation again. Box retains up to 64 active requests and 64 pending continuations per connection, with up to 64 input requests per continuation. A new continuation at capacity replaces the oldest one. A matching retry uses its allowance even if policy denies it. Restart an operation whose allowance was used or replaced. Identical pending calls retain separate retry allowances. A server must return distinct request states when parallel calls need distinct identities. Conflicting input IDs or methods for the same parameters and state close the connection. Unknown result types from protocol extensions are refused.

Cancelling a modern request releases its active slot. Box retains the cancelled request’s ID until a late reply arrives or the connection closes, so the client cannot reuse that ID meanwhile. Box retains up to 1,024 cancelled requests per connection and up to 16 MiB of their request IDs and method names. If another cancellation exceeds either limit, Box closes the connection and stops the server. Other calls on that connection can be interrupted. Start a new connection to continue.

Cancelling an admitted modern `tools/call`, `prompts/get`, or `resources/read` records one `mcp:call::response` immediately, even if the server never replies. A late reply adds no second event, including a reply that asks for more input. When a stdio connection ends, Box stops the server and records its remaining admitted calls as indeterminate outcomes. These [response events](/docs/user-guide/box/reference/policy-actions/index.md#what-a-temporal-rule-observes) count toward policy budgets and can satisfy response-based rules; they do not establish tool success.

## `[mcp.<name>]`, `type = "stdio"`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `type` | string | required | `"stdio"`. |
| `command` | string array | required | Element 0 is a bare program name or an absolute executable path, and the rest are its arguments. The box places an alias named for the executable’s filename in its `bin/`, on the agent’s `PATH`. Arguments match exactly unless you enable [argument wildcards](#argument-wildcards). |
| `workspace` | path | the agent’s workspace | The server’s initial working directory. |
| `env` | table | empty | Variables the server receives. The server also receives `PATH` and `HOME` from the host OS’s shell that runs `box run`, unless `env` sets them, and a placeholder for each credential that has one: in `NAME` for an `env://NAME` route, and in the `secret.env` variable for a route in a declared scheme. |
| `filesystem` | table | empty | The paths the server’s own system calls reach. See [Filesystem](#filesystem). |
| `network.contain_egress` | bool | `true` | How the server reaches the network. See [Network](#network). |

The box starts the server when the agent’s harness runs its alias with the declared arguments, and only when policy permits `shell:spawn` for it. When an experimental tool grammar binds the server’s program, the grammar’s action decides the start in place of `shell:spawn`, as for a [spawn in the Shell](/docs/user-guide/box/reference/shell/index.md#shellspawn). By default, the box runs the `command` and arguments from `box.toml`.

Servers start on demand, so an unused server program can be missing when Box starts. When a command matches a declared server and its executable’s filename matches an installed tool grammar’s program name, starting that server requires the file identity and called name that Box bound at startup. A later executable cannot receive general `shell:spawn` permission instead. If Box reports `its tool grammar requires an approved program file`, it refuses that server’s start and keeps running.

If the program was missing or unreadable when Box started, make it readable and executable by the user running Box, then start a new Box run. A link to an already-bound file under the same called name can pass this check on retry, provided the existing replacement checks pass. See [which program files a grammar binds](/docs/user-guide/box/guides/tool-grammars/index.md#which-program-files-a-grammar-binds) for retries and newly installed programs.

Without argument wildcards, the harness must use the alias name and the same arguments, in the same order, as `command`. The harness runs the alias with its arguments, and the box starts the matching server. A harness entry that sets only the program reaches only a server whose `command` is the program alone. For a server whose `command` has arguments, set the same arguments in the harness. [Connect the harness](/docs/user-guide/box/guides/write-mcp-policy/index.md#step-2-connect-the-harness) shows the settings.

The executable’s filename and the server name hold only letters, digits, `.`, `_`, and `-`. Neither can be empty. The filename cannot be `.`, `..`, `zsh`, `bash`, `sh`, `python3`, or `python`. Each server has its own name. Duplicate exact alias invocations are refused.

### Select an executable by path

An absolute path selects that executable even when it is outside `PATH` or another executable with the same filename comes first on `PATH`. For example, set `command = ["/opt/mcp/bin/weather-mcp", "--stdio"]` to select that installation. The harness runs `weather-mcp --stdio`. It uses the filename, not the absolute path. Box still launches `/opt/mcp/bin/weather-mcp`.

A bare program name uses the server’s `env.PATH`, or the `PATH` of the host OS’s shell that runs `box run` when it is unset. Relative paths, including `./weather-mcp` and `~/bin/weather-mcp`, are refused. The executable name or path is literal. `${...}` tokens in `command[0]` are refused. Arguments retain the token rules described below. An invalid absolute target fails without falling back to `PATH`. The filename comes from the path as written. A symbolic link named `uvx` keeps that name even when its target is named `uv`.

Selecting a path adds no filesystem grants beyond the command’s implicit executable grant and the runtime minimum. Declare the server’s other files and directories in [`filesystem`](#filesystem), including any required [script interpreters on Linux](/docs/user-guide/box/reference/configuration/index.md#script-commands-on-linux).

An absolute MCP executable path requires record version 28 or newer. Older builds refuse versions they do not support. To return to an older build, select a bare program name and follow the [stored configuration rollback steps](/docs/user-guide/box/security/native-filesystem-policy/index.md#stored-configuration-and-rollback).

### Share a launcher

Two or more servers can share an alias, such as `npx` or `uvx`, when their arguments distinguish their commands:

```toml
[mcp.playwright]
type    = "stdio"
command = ["npx", "-y", "@playwright/mcp"]

[mcp.github]
type    = "stdio"
command = ["npx", "-y", "@modelcontextprotocol/server-github"]
```

The box places one alias, `bin/npx`, for both servers. The arguments the harness passes select the server:

| The harness runs | The box starts |
| --- | --- |
| `npx -y @playwright/mcp` | `playwright` |
| `npx -y @modelcontextprotocol/server-github` | `github` |
| `npx --version` | The ordinary `npx` program, inside the agent’s sandbox. |

The same rule applies when executable paths have the same filename. Two installations can share `bin/npx` when their arguments distinguish them. Different executable paths alone do not distinguish the commands the harness sends.

If no declared command matches, the alias runs the next ordinary program on the agent’s `PATH`. When `PATH` is absent or empty, the alias searches `/usr/bin:/bin` instead of the working directory. It skips Box’s alias directory and retains the agent’s existing sandbox grants and environment. It receives none of a server’s extra sandbox grants or credentials. The program still needs the agent’s execution and filesystem grants. A mistyped server command takes this same path. A policy denial, ambiguous match, or broker failure never falls back. Box records each non-match as a [`strands.box.mcp.unmatched` diagnostic](/docs/user-guide/box/guides/record-telemetry/index.md#an-unmatched-mcp-route), so you can find a harness command that drifted from its declaration. This records only that no declared command matched. A server started through fallback has no Box MCP tool checks.

Words that mean the same thing to the server are still different words. `--port=3000` and `--port 3000` don’t match, and neither do `~/data` and `/Users/me/data`. Write each argument the same way in `box.toml` and in the harness. An argument that holds `${OTEL_EXPORTER_OTLP_ENDPOINT}`, `${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT}`, or `${OTEL_EXPORTER_OTLP_PROTOCOL}` matches both the name as written and the value the box puts in its place. The endpoint values hold a port that is new on each run, so a harness with a fixed configuration passes the name, as written in `box.toml`.

A box whose servers share a program stores a newer record than earlier `box` builds read. An earlier build refuses that box directory.

### Argument wildcards

To let the caller supply an argument at runtime, set `argument_wildcards = true` on that stdio MCP entry and put `*` in the argument’s position:

```toml
[mcp.example]
type = "stdio"
command = ["example-server", "--token", "*"]
argument_wildcards = true
```

If the harness runs `example-server --token runtime-value`, Box matches the entry and starts `example-server --token runtime-value` after policy permits it. The same server filesystem and network settings still apply. Box supplies the configured executable and fixed arguments; the caller supplies the arguments in `*` positions. The matched entry selects the MCP server’s configuration, and Box continues to mediate its MCP traffic.

Any process in the workload can invoke the MCP alias and supply values for the `*` positions. The operator chooses those positions in `box.toml`; the workload cannot add wildcards. A `shell:spawn` permit that checks only the program matches every value in those positions. The server runs with its own configured permissions, which can exceed the workload’s. For example, `["npx", "-y", "*"]` lets the caller choose the package that runs with those permissions. Put `*` only in positions whose values you intend the caller to choose. When an experimental tool grammar binds the server’s program file under another name, such as a mise shim, the start is a `shell:spawn` decision, and no grammar reads the values in the `*` positions.

Only an argument equal to `*` is a wildcard. It accepts one argument, including an empty string. The executable, argument count, order, and every other argument must match. `--token=*` is literal text. To accept a changing argument such as `--token=value`, replace that entire argument with `*`.

For a direct invocation of the MCP alias, Box matches the supplied argument array and copies each wildcard argument unchanged. For example, `["example-server", "--token", "abc"]` starts the server with `--token abc`. If the caller supplies the literal text `${TOKEN}`, Box passes that text unchanged. Fixed arguments keep Box’s existing expansion. Policy checks the effective launch arguments.

Strands Shell does not route external commands to declared MCP servers. Its command selection uses tool entries and agent execution grants. Invoke the MCP alias directly to use MCP command matching.

Exact commands take priority over wildcard commands. An entry with `argument_wildcards = false` keeps its stars literal and participates in exact matching. For example, `["example-server", "--token", "fixed-value"]` wins over the wildcard example above when the caller supplies `fixed-value`. Other values select the wildcard entry. Box refuses to start if two wildcard commands could match the same request, including after configured expansion. Keep fixed arguments that distinguish those wildcard entries.

The setting defaults to `false` on each server. With it omitted or false, `*` matches and launches as a literal star. Enabling it on one server leaves other servers unchanged. The feature applies only to stdio MCP commands, not agent or tool commands. `box policy generate-schema` refuses enabled wildcard commands because offline discovery has no caller to supply their arguments. Use a configuration with concrete arguments for that command.

Enabling `argument_wildcards` on any server requires record version 26 or newer. Older builds refuse versions they do not support. Before returning to an older build, replace wildcard arguments with concrete values, disable the feature, and follow the [stored configuration rollback steps](/docs/user-guide/box/security/native-filesystem-policy/index.md#stored-configuration-and-rollback) for the other selected features.

### Filesystem

`[mcp.<name>.filesystem]` holds six lists. Each entry is a path, and `~` is the operator’s home.

| List | Entry | The server can |
| --- | --- | --- |
| `read` | directory or file | Read it, and everything under a directory. |
| `write` | directory or file | Write it, and everything under a directory. `write` does not grant `read`. |
| `read_file` | file | Read the file. |
| `write_file` | existing file | Write the file. |
| `list` | directory | List the directory’s entries on macOS. Linux refuses this list. |
| `deny` | file, directory, or absent path | Reach nothing there, even under a path another list grants. On Linux, the target must exist. |

A server with no `filesystem` table reaches its own program and the runtime minimum. On macOS, a server that runs on an interpreter, such as Node or Python, needs `read` for that interpreter’s install directory.

The table takes no `metadata` or `exec` list, and `box run` refuses either one by name. On macOS, a server can test whether a path exists and read its metadata across the operator’s home. Linux does not provide that same discovery access.

For a local server that needs macOS FSEvents, set `file-watching = true` in its `[mcp.<name>]` table. The agent’s setting does not carry over, and remote HTTP servers refuse it. Read the [FSEvents limitations](/docs/user-guide/box/reference/configuration/index.md#file-watching) before enabling it.

On Linux and macOS, a server can execute helpers and load native code from its readable and writable grants. For a Python extension outside the runtime minimum, grant `read` to its directory or `read_file` to the extension file. Grant access to any additional libraries and helpers it needs. A directory grant includes its descendants, so it also permits execution of programs there. File permissions, explicit denials, and protected paths still apply.

On Linux, each write grant also needs a covering read grant. Run Box as a non-root user for directory writes. See [direct access by operating system](/docs/user-guide/box/reference/configuration/index.md#direct-access-by-operating-system). A server can execute code it writes within those grants. Automatic temporary directories do not acquire this execution permission. The agent retains its separate execution restrictions. A filesystem grant does not grant network access.

A credential store, such as `~/.aws` or `~/.ssh`, is reachable only from an entry that names it exactly. `box run` prints each credential store a server’s lists name.

A grant in this table is direct access, outside every `fs:*` decision.

The separate `receive_mounts` array in `[mcp.<name>.filesystem]` selects paths where this local server’s sandbox would receive externally attached filesystems. Omitting it selects no paths. It does not inherit the agent’s entries and grants no filesystem access. Linux requires no additional experimental setting, but this build still rejects nonempty arrays because forwarding is unavailable. Leave the array empty or omit it on Linux.

On macOS, omit `receive_mounts`: even an explicit empty array rejects configuration loading. Both platform refusals happen before Box creates state or starts a workload. See [incoming mount declarations](/docs/user-guide/box/reference/configuration/index.md#incoming-mount-declarations) for the path checks.

### Network

`[mcp.<name>.network]` holds one key, `contain_egress`.

| Value | The server’s own connections |
| --- | --- |
| `true` | Go through the egress gateway. The box sets `HTTPS_PROXY` for the server. Policy decides each `net:connect` and `http:request`, the gateway attaches credentials, and the decision log records each one. |
| `false` | Can connect directly, outside gateway policy. The box sets no proxy variable and no CA file, so the server uses its own defaults and checks the real certificate; its `env` may set `HTTPS_PROXY`, `SSL_CERT_FILE` and the other proxy and CA names. Direct connections receive no gateway credential. The decision log records an `egress:native` entry when the server starts. |

On Linux, `false` permits direct IPv4 connections through the surrounding OS. This includes reachable private networks, loopback services, and instance metadata endpoints.

`false` applies to a server whose client does not read `HTTPS_PROXY`, such as a client that signs in through single sign-on.

Replace `<HOME>` with your home directory’s full path:

```toml
[mcp.sso-tools]
type    = "stdio"
command = ["sso-tools-mcp"]
env     = { PATH = "<HOME>/.local/share/sso-tools/bin:/usr/bin:/bin" }

[mcp.sso-tools.network]
contain_egress = false

[mcp.sso-tools.filesystem]
read  = ["~/.local/share/sso-tools", "~/.config/sso-tools"]
write = ["~/.config/sso-tools"]
```

In `filesystem` lists, `~` means your home directory. Box uses `env.PATH` as written, so `~` stays literal there. Use a full path in `env.PATH`, such as `/home/alex` on Linux or `/Users/alex` on macOS.

`contain_egress` sets the server’s own connections. Policy decides every request the agent sends to the server in both modes.

## `[mcp.<name>]`, `type = "http"`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `type` | string | required | `"http"`. |
| `destinations` | string array | required | Destinations for MCP identification and optional credential routing. Entries accept a host, `host:port`, or a host with a path prefix. A `*.` wildcard entry is refused, because MCP identification uses the explicit host; see [remote destination matching](#remote-destination-matching). |
| `secret.ref` | string | none | The credential the gateway attaches to each request to the server: `env://NAME`, `aws://PROFILE`, a bare `aws://` for the AWS default credential chain, `credsd://NAME` for a credential in the credentials daemon ([credential sources](/docs/user-guide/box/guides/network-and-credentials/index.md#credential-sources)), or a reference in a scheme that a [`[secret-source.<scheme>]`](/docs/user-guide/box/reference/configuration/index.md#secret-sourcescheme) table declares. |
| `secret.env` | string | `NAME` for `env://NAME` | Experimental: needs `secret-sources = true` in [`[experimental-features]`](/docs/user-guide/box/reference/configuration/index.md#experimental-features). The variable that holds the placeholder in the workload. Required for a reference in a declared scheme. |
| `secret.header` | string | `Authorization` | The header the credential goes in. |
| `secret.prefix` | string | `Bearer` on `Authorization` | The text before the credential. |
| `secret.placement` | string | `header` | `header`, `basic_auth`, or `query_param`. |
| `secret.param` | string | none | The query parameter’s name, for `placement = "query_param"`. |
| `secret.inject` | string | `phantom` | For `env://` and a declared scheme: `phantom` attaches the credential to a request that carries the placeholder, and `always` attaches it to every request to the destinations. |
| `secret.phantom_prefix` | string | `strands_box_` | For `env://` and a declared scheme: the start of the placeholder value. |
| `backends` | table array | none | A backend to re-route the server’s requests to. At most one. See [Backends](#backends). |

With `secret.ref = "env://NAME"`, `box run` reads `NAME` from its own environment. The agent gets a placeholder in `NAME`, and the gateway swaps in the real value on each request to the server.

### Remote destination matching

For MCP policy, Box compares the request’s host with the explicit host in each `destinations` entry. Hostname comparison ignores letter case and trailing dots. IP literals match by their parsed address. Box does not use DNS results to treat different hostnames, or a hostname and an IP address, as the same MCP server.

Write each host as a connection names it: ASCII letters, digits, `.`, `-`, and `_`, with no empty label. Write an internationalized name in its punycode form, such as `xn--bcher-kva.example`. A remote MCP server’s destination may not be a `*.` wildcard, because MCP identification uses the exact host. The loader refuses each of these, because no request could enter MCP checks for it. The loader removes a trailing dot, so `mcp.example.com.` loads as `mcp.example.com`. Two server tables that name `mcp.example.com` and `mcp.example.com.` name one host, and the loader refuses the pair. The loader also refuses an egress backend whose `url` host is a remote MCP server’s host, because the gateway dials a backend directly and would skip the server’s `mcp:call` decisions.

MCP matching ignores an entry’s port and path. A request to the matching host enters MCP checks on any port and path that network and HTTP policy permit.

Credential routing uses the [destination patterns](/docs/user-guide/box/guides/network-and-credentials/index.md#destinations), including their port and path rules. Attaching a credential does not establish an MCP server identity. Requests to destinations without an MCP match remain subject to network and HTTP policy. Follow [the remote-server policy guidance](/docs/user-guide/box/guides/write-mcp-policy/index.md#scope-of-remote-server-rules) to restrict alternative routes to the same application.

### Backends

A backend re-routes the server’s requests to a gateway you control, such as a Bedrock AgentCore Gateway. The agent sends a request to the server’s `destinations`, and the box sends it to the backend instead. Policy still decides the original server, not the backend: it reads `context.input.server` as the server’s name, and decides `mcp:call` and `http:request` on the original host, before the re-route.

```toml
[mcp.github]
type         = "http"
destinations = ["api.githubcopilot.com"]

[[mcp.github.backends]]
url              = "https://abc.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp"
auth.ref         = "aws://bedrock"
auth.aws.service = "bedrock-agentcore"
auth.aws.region  = "us-east-1"
```

A remote MCP backend is the egress backend applied to a remote MCP server: the same `url` and `auth` keys, the same validation, and the same re-route on the wire. See [Backends in the egress guide](/docs/user-guide/box/guides/network-and-credentials/index.md#backends) for the full rules: the backend `url` shape, the backend `auth`, the backend address check, and how a phantom-only `env://` `secret` rides beside a backend. The one difference is scope: a backend here re-routes a remote MCP server, and a `backends` key is refused on a `type = "stdio"` server, which is a local child with no remote endpoint.

`policy generate-schema` cannot discover a re-routed server: the re-route and its backend `auth` apply only at `box run` time, in the egress gateway, and the offline command has no gateway. It refuses a `[mcp.<name>]` with a backend by name, which stops the whole run. Generate a schema from a `box.toml` without that server to get the rest, then write its `mcp:call` rules by hand.

`policy generate-schema` also runs the load checks of `box run` on each remote MCP server. A server whose `secret`, destinations, or name the loader rejects stops the whole run.

When a server’s `secret.ref` names a scheme that a [`[secret-source.<scheme>]`](/docs/user-guide/box/reference/configuration/index.md#secret-sourcescheme) table declares, `policy generate-schema` runs that table’s program to read the secret, as `box run` does, and prints the same line on stderr first. It reads that secret before it starts a stdio server. A program that returns no secret stops the whole run, and the error names the server.

## Errors and exit codes

`box run` exits with an error before the agent starts when the configuration loader rejects a table.

| Message | Cause |
| --- | --- |
| A configuration error that names `[mcp.<name>]` | A key is unknown, a required key is missing, or the name or the program breaks a rule on this page. A `backends` key on a `type = "stdio"` table is an unknown field. |
| `` `[mcp.<a>]` and `[mcp.<b>]` declare the same command "<command>" `` | Two tables declare the same exact command or wildcard pattern on one alias. Remove one, or change its arguments. |
| A `secret` error (a scheme that no table declares, a declared scheme with no `secret.env`, a `secret.env` while `secret-sources` is off, two entries with one placeholder variable and different secrets, or a reference to a `pass-secret-env` variable) | A remote MCP server’s `secret` follows the egress secret rules. See [Errors in the egress guide](/docs/user-guide/box/guides/network-and-credentials/index.md#errors-and-exit-codes). |
| `` `[mcp.<name>] secret.ref` names a secret that the secret source `<scheme>` (<program>) did not return `` | The program of a declared secret source returned no secret when the box started. See [how a run reads the secrets](/docs/user-guide/box/reference/configuration/index.md#how-a-run-reads-the-secrets). |
| `` `[mcp.<name>]` filesystem entry "<entry>" is refused: this grant reaches <path>, which the secret source `<scheme>` keeps from each workload `` | A stdio server’s `filesystem` entry reaches a `reads` or `deny` path of a declared secret source. Remove the entry. See [what Box protects](/docs/user-guide/box/reference/configuration/index.md#what-box-protects). |
| `destination host "<host>" is not the spelling the gateway matches a connection against` | A `type = "http"` destination has an empty label, a character other than an ASCII letter, a digit, `.`, `-`, or `_`, a label over 63 bytes, or a name over 253 bytes, or it ends in a number, such as `10.5`. Write an internationalized name in its punycode (`xn--`) form, and an IPv4 address as four decimal numbers, such as `10.0.0.5`. See [remote destination matching](#remote-destination-matching). |
| `a remote MCP server destination may not be a wildcard` | A `type = "http"` destination is a `*.` pattern. Name each host of the server. |
| `` `<entry>` re-routes to backend host "<host>", which `<name>` declares as a remote MCP server `` | An egress or MCP backend `url` names this server’s host. Point the backend at another host. |
| A backend error (more than one backend, a bad backend `url`, a signed `secret` beside a backend, or a refused backend `auth`) | A remote MCP backend follows the egress backend rules. See [Errors in the egress guide](/docs/user-guide/box/guides/network-and-credentials/index.md#errors-and-exit-codes). |
| `MCP server "<name>" failed during <step>` | The server failed while the box read its tool list. stderr names the step. |
| `modern MCP requests require ...` | The client omitted required protocol metadata. Update the client to one that sends the fields on every request. |
| `Unsupported MCP protocol version` | The request names a modern version Box does not support. The error lists the supported version. |
| `modern MCP requests cannot use a legacy handshake connection` | The client mixed the modern request protocol with a legacy handshake. Start a new connection using one protocol era. |
| `MCP input answers do not match a pending server request` | A retry changed its original parameters or request state, used a consumed or evicted continuation, or arrived on another connection. Restart the operation. |
| `too many retained cancelled MCP requests; reconnect` | Box already retains 1,024 cancelled request IDs without replies. Cancelling another active request closes the connection and stops the server. Start a new connection. |
| `too much retained cancelled MCP request data; reconnect` | A cancellation exceeds the 16 MiB limit for retained request IDs and method names. Box closes the connection and stops the server. Start a new connection. |
| `failed to record MCP response: ...` | Box could not save the call’s outcome. The connection stops. |
| `a modern MCP result has an unsupported resultType` | The server returned a result type the broker cannot validate. |

The harness gets these errors when it starts a server, and the box keeps running:

| Message | Cause |
| --- | --- |
| `no MCP server declares "<command>"; servers on <program>: <name>, ...` | A command on that alias cannot expand, so Box cannot safely select ordinary fallback. Check the declaration named in the error. |
| ``<name> (its `command` does not expand)`` in that list | The server’s `command` holds a `${...}` name the box does not fill in. Use one of the three `OTEL_EXPORTER_OTLP_` names. |
| ``no MCP server declares "<command>"; no `[mcp.<name>]` table in box.toml declares the program "<program>"`` | The harness ran a program that no `[mcp.<name>]` table names. |

An ordinary fallback reports the program’s own exit status. If no ordinary executable exists on the agent’s visible `PATH`, the alias reports status 127. A missing grant can make a program invisible on Linux, so this status does not prove the program is absent from the surrounding OS. If a visible program is refused execution, the alias reports status 126. A script also needs its interpreter to be visible and executable; a missing interpreter can produce status 127 even when the script itself is visible. Scripts need a `#!` line: Box does not try an implicit shell for an unrecognized executable.

Failures before the broker selects a route report status 125. After readiness, an incompatible protocol version or program identifier also reports 125. After readiness, a closed stream or read error ends the alias with status 0. Unrelated recognized frames are ignored.

For a request the policy refuses, see [troubleshooting](/docs/user-guide/box/guides/write-mcp-policy/index.md#troubleshooting).

## See also

-   [Write policy for an MCP server](/docs/user-guide/box/guides/write-mcp-policy/index.md): the rules that let the agent start, list, and call a server, and how to connect the harness.
-   [MCP servers in the design guide](https://github.com/strands-agents/box/blob/28071d0dad40cbd428ffb920adbb1a4920c252b4/docs/design/mcp.md): how the box starts a server and decides each call.
-   [Local MCP servers in the design guide](https://github.com/strands-agents/box/blob/28071d0dad40cbd428ffb920adbb1a4920c252b4/docs/design/containment.md#local-mcp-servers): what a stdio server’s sandbox reaches.
-   [macOS network restrictions](https://github.com/strands-agents/box/blob/28071d0dad40cbd428ffb920adbb1a4920c252b4/docs/design/macos-enforcement.md#network-connections-and-local-services): how the sandbox limits a server’s connections.