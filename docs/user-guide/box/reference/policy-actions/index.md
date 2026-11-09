A rule names one action. The action decides which `context.input` fields the rule can read. The box ships ten actions, and generates one more for each MCP tool it discovers. Each experimental [tool grammar](../configuration/index.md#toolnamegrammar) adds its own `Tool::<name>` actions.

Audience: an operator writing a `policy.dw` who needs the exact action name, its `context.input` fields, and which part of the box raises it. [Policy](../policy/index.md) introduces the rules, and [common rules](../policy/index.md#common-rules) shows each field in use.

> **Status.** The vocabulary can change before 1.0.0. Pin the Box build you install. A rule that names an action the build does not have refuses to load.

## The fixed parts

```text
@id("no_env")
forbid (principal, action == Box::Action::"fs:read", resource)
when { context.input.path == "~/project/.env" };
```

Every request is one principal, one action, one resource, and a context. In the rule above:

-   **Principal** is `Box::Agent::"self"`, always. Write `principal` with no condition.
-   **Action** is one of the names below. `action == Box::Action::"fs:read"` selects it.
-   **Resource** is `Box::Resource::"unused"`, always. Write `resource` with no condition.
-   **Context** is `context.input.<field>`, and the fields depend on the action. `context.input.path == "~/project/.env"` reads the `path` field of `fs:read`.

A field marked `?` below is optional. Read it behind a guard, as `context.input has arg1 && context.input.arg1 == "-rf"`. A rule that reads an optional field with no guard refuses to load.

Some field names mean different things on different actions. `path` is a file on `fs:read` and the path part of a URL on `http:request`. So a rule that checks `context.input` covers actions of one family: actions whose names start the same way before the `:`, such as `fs:read` and `fs:write`. Each MCP tool action is a family of its own. A rule that checks `context.input` for `fs:read` and `http:request` together refuses to load, so write one rule for each.

## The ten actions

Ten actions in four categories, and one generated action per MCP tool:

-   **[Filesystem](#filesystem)**, raised by Strands Shell (the box’s shell) and by Monty (the box’s Python interpreter).
    -   `fs:read`: reading content or metadata, listing a directory, reading a symlink target, changing directory, and testing a file for execution.
    -   `fs:write`: writing content, creating a directory, changing permission bits, and creating a symlink.
    -   `fs:delete`: removing a file or an empty directory.
    -   `fs:move`: renaming or moving a path, once per path.
    -   `fs:other`: reserved. No operation raises it.
-   **[Network](#network)**, raised by the egress gateway.
    -   `net:connect`: each connection, before TLS.
    -   `http:request`: each HTTP request inside the connection, after TLS on an HTTPS connection.
-   **[Shell](#shell)**, raised by Strands Shell.
    -   `shell:exec`: a command line that runs a program the shell implements, such as `cat` or `grep`.
    -   `shell:spawn`: a command line that runs a program of the surrounding OS, such as `git`. The box also raises it at startup, once for each stdio MCP server `box.toml` declares.
-   **[MCP](#mcp)**, raised by the MCP broker for a local server and by the egress gateway for a remote one.
    -   `mcp:call`: each MCP request, on every method.
    -   `<server>::Action::"<tool>"`: a `tools/call`, after `mcp:call` permitted it.

## Filesystem

The five `fs:*` actions carry the same two fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | String | The resolved path, spelled `~/…` under the operator’s home and absolute elsewhere. |
| `operation` | `Box::Fs<Verb>Operation` | The exact verb. The table below gives the spelling and the values for each action. |

A rule spells an operation with the action’s own prefix, as `Box::FsReadOperation::"read_content"`:

| Action | Spelled in a rule as | Values |
| --- | --- | --- |
| `fs:read` | `Box::FsReadOperation::"<value>"` | `read_content`, `read_metadata`, `enumerate`, `read_link`, `change_dir`, `exec` |
| `fs:write` | `Box::FsWriteOperation::"<value>"` | `write_content`, `create_dir`, `set_permissions`, `symlink` |
| `fs:delete` | `Box::FsDeleteOperation::"<value>"` | `remove_file`, `remove_dir` |
| `fs:move` | `Box::FsMoveOperation::"<value>"` | `rename` |
| `fs:other` | `Box::FsOtherOperation::"<value>"` | `other` |

A value outside the action’s set refuses to load. A value with another action’s prefix loads, and the rule matches no request. Use the prefix from the action’s row in the table.

What `path` holds depends on the caller. From Strands Shell, `path` is the target with every symlink resolved. From Monty, `path` has `.` and `..` resolved and keeps a symlink as the script spelled it. Monty decides a path that goes through a symlink on that spelling and then refuses it, whatever the verdict.

A rename is three or four decisions: `fs:read` and `fs:move` on the source, `fs:move` on the destination, and `fs:delete` on the destination when it exists (`remove_dir` for a directory, `remove_file` otherwise). All of them must permit. A denial names the path it refused.

`fs:other` is reserved: the box raises it for no operation. A rule that names `fs:other` must also name a raised action, as `action in [Box::Action::"fs:read", Box::Action::"fs:other"]`. A rule that names only `fs:other` refuses to load.

## Network

Each outbound call is two decisions, both of which must permit.

**`net:connect`**, once per connection, before TLS:

| Field | Type | Meaning |
| --- | --- | --- |
| `host` | String | The destination host. |
| `port` | Long | The destination port. |
| `ip4?` | String | The IPv4 address the gateway connects to, as a dotted quad, such as `"203.0.113.7"`. Present for an IPv4 destination, and for an IPv6 destination that carries an IPv4 address in a wrapping Box recognises. |
| `ip6?` | String | The IPv6 address the gateway connects to, as text, compressed and in lowercase, such as `"64:ff9b::cb00:7107"`. Present for every IPv6 destination, and absent for an IPv4 one. |

Both are absent before resolution, on the decision for the host. A destination that arrives wrapped carries both: dialling `64:ff9b::cb00:7107` gives `ip4 = "203.0.113.7"` and `ip6 = "64:ff9b::cb00:7107"`. A plain IPv4 destination carries `ip4` alone, because one IPv4 address has many IPv6 encodings and there is no single IPv6 form to report.

Compare either as a String behind its own guard, as `context.input has ip4 && context.input.ip4 == "203.0.113.7"`. An `ipaddr` comparison refuses to load with `expected ipaddr but saw String`.

**`http:request`**, once per request inside the connection, after TLS on an HTTPS connection:

| Field | Type | Meaning |
| --- | --- | --- |
| `host` | String | The destination host. |
| `port` | Long | The destination port. |
| `method` | String | `GET`, `POST`, and so on. |
| `path` | String | The URL path in canonical form, without the query. |
| `body_bytes` | Long | The request body length. |
| `intercepted` | Bool | `true` when the gateway decrypted a TLS exchange, `false` for plain HTTP. |

A rule on `path` has caveats for repeated slashes and `%2F`. [Forbid one URL path on a host](../policy/index.md#forbid-one-url-path-on-a-host) lists them.

Cloud metadata and link-local protection is two `forbid` rules on `net:connect`; [what Box always enforces](../../security/index.md#what-box-always-enforces) lists them.

## Shell

A command line is judged once, after the shell parses it, expands it, and resolves its first word to a program. Each nested command, such as the one `find -exec` or `xargs` runs, is judged on its own.

**`shell:exec`**, for a program the shell implements:

| Field | Type | Meaning |
| --- | --- | --- |
| `command` | String | The submitted text. |
| `program` | String | The program the first word resolved to. A shell alias changes `command`; `program` is the resolved target. |
| `arg1?` | String | The first argument after the program. |
| `arg2?` | String | The second argument. |
| `arg_count` | Long | How many arguments follow the program. |
| `cwd` | String | The working directory. |

**`shell:spawn`**, for a program of the surrounding OS, carries the six `shell:exec` fields and two more:

| Field | Type | Meaning |
| --- | --- | --- |
| `program_path` | String | The resolved binary, spelled `~/…` under the operator’s home and absolute elsewhere. |
| `credential_reads?` | Set of String | The credential stores that `box.toml` names for this program under its `[tool.<name>]` table, such as `~/.aws`. |

When a tool grammar binds the program, the grammar action decides the spawn, and the spawn enters history as that action and not as `shell:spawn`. A spawn that the grammar binding refuses before any rule decides it enters history as a `shell:spawn` request. [`shell:spawn`](../shell/index.md#shellspawn) states when Box refuses one.

A rule that covers both actions names both, as `action in [Box::Action::"shell:exec", Box::Action::"shell:spawn"]`. A `shell:exec` permit covers the shell’s own programs, and a `shell:spawn` permit covers a program of the surrounding OS. A permitted program of the surrounding OS runs in its own sandbox, separate from the agent’s sandbox and wider than it. Its own file operations raise no `fs:*` decision; [Security](../../security/index.md#the-two-tiers) states that boundary.

## MCP

**`mcp:call`**, once per request on any method:

| Field | Type | Meaning |
| --- | --- | --- |
| `server` | String | The server name from `box.toml`. |
| `method` | String | The JSON-RPC method: `tools/call`, `tools/list`, `resources/read`, and so on. |
| `tool?` | String | The tool, on `tools/call`. |
| `prompt?` | String | The prompt, on `prompts/get`. |
| `uri?` | String | The resource URI, on `resources/read`. |

Each stdio server in `box.toml` starts through a `shell:spawn` decision on the program its `[mcp.<name>]` table names, or through the grammar action when a tool grammar binds that program. A policy with no matching permit refuses the server at startup. For an enabled [MCP wildcard command](../../guides/add-an-mcp-server/index.md#argument-wildcards), `command` contains the effective launch command, joined by spaces. Its argument fields contain the same values, including the caller’s values in wildcard positions. A permit on `mcp:call` for a server covers every method and tool on it. Refuse one tool by name with a `tool` guard, or with the per-tool `forbid` that [MCP policy](../../guides/write-mcp-policy/index.md#step-4-narrow-the-server) shows:

```text
forbid (principal, action == Box::Action::"mcp:call", resource)
when { context.input.server == "demo" && context.input has tool && context.input.tool == "echo" };
```

**A generated per-tool action**, `<server>::Action::"<tool>"`, carries the tool’s arguments as `context.input.<argument>`, with the types the server’s `tools/list` declares. Run the `policy generate-schema` verb to see the exact names:

```sh
./box-core/box policy generate-schema --config my-box/box.toml --output-dir ./schema
```

It writes `actions.cedarschema`, with every action and its fields, including the actions of each tool grammar, and `events.dwschema`, with what a `when temporal` clause observes. The namespace is the server name with every character other than a letter, a digit, or `_` changed to `_`. A leading digit gets a `_` prefix. Server `demo-mcp` and tool `lookup` give `demo_mcp::Action::"lookup"`.

A `tools/call` is two decisions: `mcp:call` first, then the tool’s generated action when one exists. A per-tool `forbid` refuses the call. When no per-tool rule matches, the `mcp:call` verdict stands.

A few protocol methods pass with no decision, and the set depends on the transport:

| Method | Local stdio server | Server over HTTP |
| --- | --- | --- |
| `initialize` | Passes | Decided as `mcp:call` |
| Each of `server/discover`, `ping`, `subscriptions/listen` | Passes | Passes |
| A notification (a frame with no `id`) | Passes | Passes |
| Every other method | Decided as `mcp:call` | Decided as `mcp:call` |

Over HTTP, each frame is also decided as `http:request` first. Because `tools/list` is decided, a rule can refuse it and hide a server’s tools.

## Tool grammar actions

Each experimental [tool grammar](../../guides/tool-grammars/index.md) adds the actions `Tool::<name>::Action::"<action>"`, one for each `[shell.<action>]` table, and `Tool::<name>::Action::"unmodeled"`. Version 2 and later of a grammar use the namespace `Tool::<name>::v<version>`. `Tool::<name>::Action::"*"` is the group of every action except `unmodeled`.

Every action of a grammar carries these fields, and `unmodeled` carries only these:

| Field | Type | Meaning |
| --- | --- | --- |
| `program` | String | The first word after expansion, as on `shell:spawn`. |
| `program_path` | String | The resolved program file, spelled `~/…` under the operator’s home and absolute elsewhere. |
| `cwd` | String | The Shell’s working directory, as an absolute path. |
| `args` | Set of String | Every word after the program. |
| `effects` | Set of `Tool::<name>::Effect` | The effects of this command. A grammar that declares no effect has no `effects` field. |
| `credential_reads?` | Set of String | The credential stores that the program’s `[tool.<name>]` lists name, as on `shell:spawn`. |

Each other action also carries one field for each of its options and operands, named by its key in `options` or `operands`:

| The option or operand | Type |
| --- | --- |
| An option with no `value` | Bool |
| An option with one value, or an operand `<name>` | String, and optional |
| A `repeated` option, an option with `value = "many"`, or an operand `<name>...` | Set of String |

Box refuses to load a rule that reads `context.input` over two grammars, or over a grammar action and a `Box::` action.

## What a temporal rule observes

A `when temporal { … }` clause reads recorded events. The box records three events for each action `A`:

| Event | Recorded when | Fields |
| --- | --- | --- |
| `A::request` | Every submitted decision, permitted or denied | `requestId` and the action’s `input` fields |
| `A::response` | The operation ended, or its end is `indeterminate` | `requestId`, the `input` fields, and `output` when available |
| `A::error` | The operation did not happen | `requestId` and the `input` fields |

`requestId` is a nonempty string that identifies one policy request within this box’s history. Its recorded response or error carries the same identifier. Separate requests receive separate identifiers, even when their inputs are identical. Bind the same variable to `requestId` in two predicates to require events from the same request. Treat the identifier’s spelling as opaque. Older events that lack this field remain in history, but cannot match a predicate that requires it.

To cap how many times the agent tries an action, count `A::request`, which also counts denied attempts. Use `A::response` when a later rule needs a recorded outcome. Partial or indeterminate outcomes also count; an MCP response does not establish tool success.

What each caller records as a response:

| Action | Response recorded | `output` |
| --- | --- | --- |
| `fs:*` | When the operation ends. A `test -e`, `test -L`, or `test -r` in the Shell, or an `os.stat()`, `Path.exists()`, `Path.is_file()`, `Path.is_dir()`, or `Path.is_symlink()` in Python, that got an answer is a response even when the answer is “no”: for example, a missing file in an existing folder. A check of a path inside the reachable paths that can’t be resolved, such as one under a missing folder or under a folder the operating system won’t let Box search, is also a response, although the reachable paths check refuses it. This holds only when the path has no `.` or `..` component, crosses no symbolic link, and isn’t in Box’s own state. Any other check that Box itself refuses is an error: the reach floor refuses it, or a guard refuses it because a path changed during the check. | `result`, spelled `Box::FsResponseResult::"<value>"`: `completed`, `descriptor_issued`, or `indeterminate` |
| `net:connect` | When the connect attempt ends | none |
| `http:request` | When the upstream response completes, fails, or reaches its deadline, once per exchange | `status`: the upstream’s reply status, when received |
| `shell:exec`, `shell:spawn` | When the command ends | `status`: the exit status. When a signal ends the command, `status` is `128` plus the signal number. |
| A tool grammar action, `Tool::<name>::Action::"<action>"` | When a program the Shell started ends | `status`, as on `shell:spawn` |
| `mcp:call` | For `tools/call`, `prompts/get`, and `resources/read`: when the call completes over stdio, or when the upstream response completes, fails, or reaches its deadline over HTTP | none |

Each temporal operator carries a window of at most `24h`. A temporal predicate names exactly one action, so a budget that spans `fs:read` and `fs:write` is one clause per action.

## See also

-   [Policy](../policy/index.md): what a policy is, the common rules, and the refusal for a misspelled action, value, or field.
-   [Write a policy and read what it decided](../../guides/write-a-policy/index.md): the rule shape and the denial text.
-   [Security](../../security/index.md): what the operating system enforces with no policy decision.