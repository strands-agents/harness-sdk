Policy decides each request the agent makes to an MCP server. Permit the server’s startup or network connection, then permit its MCP calls. Use a `forbid` rule to block a tool or a specific argument value.

Audience: an operator who has declared a server in [the `[mcp.<name>]` table](../add-an-mcp-server/index.md) and writes its rules in `policy.dw`.

## Before you start

-   A box from [getting started](../../quickstart/index.md).
-   An `[mcp.<name>]` table for the server in its `box.toml`.

## Step 1. Allow the server

To allow a `stdio` server, permit `shell:spawn` for its program and `mcp:call` for its name:

```text
@id("fetch_start")
permit (principal, action == Box::Action::"shell:spawn", resource)
when { context.input.program == "mcp-server-fetch" };

@id("fetch_calls")
permit (principal, action == Box::Action::"mcp:call", resource)
when { context.input.server == "fetch" };
```

To allow an `http` server, permit `net:connect` and `http:request` for its host, and `mcp:call` for its name:

```text
@id("github_connect")
permit (principal, action == Box::Action::"net:connect", resource)
when { context.input.host == "api.githubcopilot.com" && context.input.port == 443 };

@id("github_request")
permit (principal, action == Box::Action::"http:request", resource)
when { context.input.host == "api.githubcopilot.com" };

@id("github_calls")
permit (principal, action == Box::Action::"mcp:call", resource)
when { context.input.server == "github" };
```

The `mcp:call` permit covers every method and every tool on the server. One permit can name several servers:

```text
@id("mcp_servers")
permit (principal, action == Box::Action::"mcp:call", resource)
when { ["fetch", "github"].contains(context.input.server) };
```

| Action | Field | Value |
| --- | --- | --- |
| `shell:spawn` | `context.input.program` | Element 0 of the server’s `command`. |
|  | `context.input.program_path` | The program’s file, with every link resolved. `~` is the operator’s home. |
|  | `context.input.arg1`, `arg2`, `arg_count` | The server’s arguments. |
|  | `context.input.command` | By default, the server’s full `command` as written in `box.toml`: the program and its arguments, joined by spaces. Use it with `like` to match an argument past the second. An argument that holds `${OTEL_EXPORTER_OTLP_*}` is the name here, and the value the box puts in its place in `arg1` and `arg2`. |
| `mcp:call` | `context.input.server` | The `[mcp.<name>]` table’s name. |
|  | `context.input.method` | The MCP method, such as `tools/list` or `tools/call`. For the harness’s reply to a stdio server’s own request, the method of that request, such as `roots/list`. |
|  | `context.input.tool` | The tool name, on `tools/call`. |

For an enabled [wildcard command](../add-an-mcp-server/index.md#argument-wildcards), `command` instead holds the effective launch command, with received values in the `*` positions and fixed arguments expanded. `arg1`, `arg2`, and `arg_count` describe those same launch arguments. A permit that checks only `program`, as above, matches every value supplied in the `*` positions. To restrict those values, add conditions on the effective arguments.

## Step 2. Connect the harness

Add each server to the harness’s own MCP configuration.

-   **A `stdio` server:** set its command to the server’s full `command` from `box.toml`: the program, then every argument, in the same order. The harness runs the alias with those arguments, and the box starts the server whose `command` matches. With `argument_wildcards = true` on that server, supply the runtime value for each `*` position.
-   **An `http` server:** set its URL. For a server with `secret.ref = "env://NAME"`, send the placeholder from `NAME` in the header, or set `secret.inject = "always"` and send no header.

Use your client’s configuration format for these settings. For this `box.toml` table:

```toml
[mcp.playwright]
type    = "stdio"
command = ["npx", "-y", "@playwright/mcp"]
```

a client that takes a command and its arguments apart gets:

```json
{ "mcpServers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp"] } } }
```

A harness entry that sets only the program, `"command": "npx"` with no `args`, is refused for this server with `no MCP server declares "npx"; servers on npx: playwright`. Add the arguments to the harness entry. The same applies to every `stdio` server whose `command` has arguments.

The server URL must match the server declared in `box.toml`.

## Step 3. Find the tool and argument names

A per-tool rule names a tool as `<server>::Action::"<tool>"`, and reads that tool’s arguments as `context.input.<argument>`. The namespace is the server name with each character other than a letter, a digit, or `_` changed to `_`, so `my-server` becomes `my_server`.

`policy generate-schema` starts each declared server, reads its `tools/list`, and writes the per-tool actions and their argument types:

```sh
./box-core/box policy generate-schema --config my-box/box.toml --output-dir /tmp/schema
```

`/tmp/schema/actions.cedarschema` holds one `namespace` per server, one `action` per tool, and the arguments of each tool. A JSON `integer` or `number` is a `Long`, and an `enum` is its base type. A `type` list of one type and `null` is that type.

An argument that can have more than one type, from `anyOf`, `oneOf`, or a `type` list, is a record with one optional field for each type: `typeChoice0`, `typeChoice1`, and so on, in the server’s order. Box puts the value in every field whose type matches, and refuses a call whose value matches none. Test the field with `has` before you compare it:

```text
forbid (principal, action == deepwiki::Action::"ask_wiki_question", resource)
when {
  context.input.repoName has typeChoice0 &&
  context.input.repoName.typeChoice0 == "my-org/private-repo"
};
```

## Step 4. Narrow the server

Each rule below sits beside the server’s `mcp:call` permit.

| Goal | Rule |
| --- | --- |
| Block one tool | `forbid (principal, action == github::Action::"get_me", resource);` |
| Block one argument value | `forbid (principal, action == github::Action::"search_repositories", resource) when { context.input has perPage && context.input.perPage > 5 };` |
| Allow one argument value only | `forbid (principal, action == my_server::Action::"query", resource) when { !(context.input has mode && context.input.mode == "read") };` |
| Hide a server’s tools | `forbid (principal, action == Box::Action::"mcp:call", resource) when { context.input.server == "deepwiki" && context.input.method == "tools/list" };` |

To allow only some tools, name them in the server’s `mcp:call` permit:

```text
@id("github_calls")
permit (principal, action == Box::Action::"mcp:call", resource)
when {
  context.input.server == "github" &&
  (context.input.method != "tools/call" ||
   (context.input has tool &&
    ["search_repositories", "get_file_contents"].contains(context.input.tool)))
};
```

A per-tool rule works the same for a `stdio` server and an `http` server.

-   Narrow a tool with a per-tool `forbid`, or with the tool list in the `mcp:call` permit. A per-tool `permit` leaves the verdict as the `mcp:call` permit set it.
-   Test an optional argument with `has` before you compare it. A rule that allows one value only, like the third row above, also refuses a call that omits the argument.
-   A tool name and an argument name match the server’s `tools/list` spelling exactly.

## Step 5. Cap how often the agent calls a server

A `forbid` with a `when temporal` clause caps calls. This rule refuses a third `tools/call` to `github` within five minutes:

```text
@id("cap_github_calls")
forbid (principal, action == Box::Action::"mcp:call", resource)
when { context.input.server == "github" && context.input.method == "tools/call" }
when temporal {
  exists (n: Long). (
    (count for (t: Timepoint). where (
      formerly within 300s (
        Box::Action::"mcp:call"::request{ input.server: "github", input.method: "tools/call" } && tp(t)
      )
    )) == n
    && n >= 2
  )
};
```

`::request` counts every attempt, including a refused one. `::response` counts calls that reached the server.

## Result

Restart the box. The decision log records each decision with the rule’s `@id`. A call the server permit allows names that permit, such as `github_calls`. A call a per-tool `forbid` refuses names that `forbid` and the per-tool action. The agent gets each refusal as an MCP error.

## Troubleshooting

| Error message (excerpt) or symptom | What to do |
| --- | --- |
| `MCP server "<name>" may not start` | No `shell:spawn` permit for the program. |
| `no MCP server declares "<command>"` | The harness command or arguments do not match a declared server. Copy its `command` from `box.toml`, as in [step 2](#step-2-connect-the-harness). With `argument_wildcards = true`, supply a value for each `*` argument. |
| Two MCP tables `declare overlapping wildcard commands` | The wildcard entries can match the same request, so Box refuses to start. Give them fixed arguments that distinguish them. An exact entry may overlap a wildcard entry; the exact entry takes priority. |
| `MCP command matches multiple servers` | No exact entry matched, and more than one wildcard entry matched the received command. The launch is refused. |
| The harness shows the server with zero tools | A rule refuses `tools/list` for the server. |
| `the MCP tool catalog is not accepted` | The agent called a tool before the server’s `tools/list` succeeded. |
| `the tool is not in the accepted MCP catalog` | The server’s `tools/list` does not name the tool, spelled exactly. |
| A refusal that says `[default-deny]` | No `mcp:call` permit names the server. |
| A refusal that says `[default-deny]`, and the startup warning `a per-tool rule never loaded` printed | Box cannot enforce a per-tool rule and refuses the calls it can identify. See [When a rule cannot load](#when-a-rule-cannot-load) for causes and fixes. |
| A refusal that names an `@id` | That `forbid` matched, on `mcp:call` or on the per-tool action. |

Resource address errors

A URI (Uniform Resource Identifier) is a resource address, such as `file:///tmp/report.txt`. These errors concern the address in a `resources/read` request.

The messages use `hier-part` for the part after `file:` or `https:` and before a query (`?`) or fragment (`#`). For example, in `https://notes/page?format=text`, the `hier-part` is `//notes/page`. The `authority` contains the host, an optional port, and any login information before `@`. For example, in `https://notes:443/page`, the authority is `notes:443`.

| Error message (excerpt) | What to do |
| --- | --- |
| `a file URI that carries a query is refused` | The file address includes a non-empty query, such as `?format=text`. Remove the query. |
| `a resource URI that holds a space, a control character, or a backslash is refused` | The address contains a space, control character, or backslash. Encode spaces in paths or queries as `%20`. Remove control characters. Use `/` for path separators. |
| `a resource URI whose hier-part is neither an absolute path nor an authority is refused` | The address is missing a leading slash or `//` before its host. Use `file:///etc/passwd` instead of `file:etc/passwd`, or `https://notes/page` instead of `https:notes/page`. |
| `an http or https URI with no authority is refused` | The web address has no host. Use `https://host/path` instead of `https:///path`. |
| `a resource URI whose authority is not RFC 3986 is refused` | The host or port has an invalid format. Put IPv6 addresses in brackets. Use digits for the port and the ASCII `xn--` form for international domain names. |
| `an http or https URI that carries userinfo is refused` | The web address contains login information before the host, such as `user@`. Remove that information from the address. |
| `a file URI whose path holds an encoded slash is refused` | The file path contains `%2F`, an encoded slash. Use `/` between path components. HTTP and HTTPS resource addresses can retain `%2F`. |
| `a resource URI whose host holds a percent-escape of a reserved or non-ASCII octet is refused` | The host contains unsupported percent-encoded characters. Write the host name directly. For international domain names, use the ASCII `xn--` form. |

### When a rule cannot load

When a per-tool rule cannot load at startup, Box starts without that rule. A later tool list can load it if the list completes the policy. Until then, Box refuses the calls it identifies as subject to the rule with `[default-deny]`. Otherwise, those calls can still pass under the server’s `mcp:call` permit. Check [which rules Box can refuse for](#which-rules-box-can-refuse-for) before relying on the policy.

The startup warning is `a per-tool rule never loaded for ["<server>"]`. Check these causes:

| Cause | Fix |
| --- | --- |
| A rule refuses `tools/list`, so Box cannot discover the server’s tools. | Permit `tools/list` for that server. |
| The server’s catalog does not offer the named tool. | Correct the tool name, or update the rule if the server removed the tool. |
| The rule reads an argument with a different name or compares it against the wrong type. | Match the argument name and type in the server’s catalog. |
| The server’s first tool list timed out or Box could not read it. | Keep the per-tool rule. For an http server, request the list again. For a stdio server with no accepted catalog, restart the box. |

Remove a per-tool rule only when you intend to remove its restriction. Keep a valid rule after a temporary discovery failure. The warning describes startup. Box prints no message when the rule starts enforcing.

The warning names every server the rule was waiting for, so when a rule reads one server’s tool from history it names that server too, even when that server is answering correctly.

### Which rules Box can refuse for

Box works out which calls an inert rule would have decided in two ways: from the tool the rule names in its head, and from a `when` condition that pins `context.input.server` and `context.input.tool` to one quoted name each. Those two rules **fail closed**: their calls get refused.

A pin still counts when other tests sit beside it, as in `context.input.server == "svc" && context.input.tool == "approve" && context.input.method != "tools/list"`, because each test joined by `&&` has to hold. A pin does not count when it sits inside a `||`, a negation, or an `if`, or in an `unless` condition, because there the rule may reach some other tool instead.

Every other rule **fails open**: its calls run on the `mcp:call` permit while the rule enforces nothing. These are the shapes, and each is worth checking your own policy against:

| An inert rule on `mcp:call` whose condition … | Why Box holds nothing |
| --- | --- |
| pins the server alone | Every tool on that server is in reach, and the rule names none of them. |
| picks tools with `["approve", "reject"].contains(context.input.tool)` | A set membership is not an equality, so neither name is a pin. |
| matches with `context.input.tool like "appro*"` | A pattern is not an equality. |
| offers a choice, as in `context.input.server == "svc" && (context.input.tool == "a" || context.input.tool == "b")` | The server pin counts, because it still has to hold; the two tool names do not, because only one of them need hold. One pin alone names no tool. |
| narrows on `context.input.method`, or on an argument | Those reach tools the rule never names. |
| does not narrow at all | Every tool call is in reach. |

Read the startup warning as the signal that a rule went inert, then check it against the table above to learn whether its calls are being refused or allowed. To get the refusal, name the tool in the rule’s head, or pin the server and the tool to one name each in a `when` condition. Write one rule per tool where you need several.

## See also

-   [The `[mcp.<name>]` table](../add-an-mcp-server/index.md): the keys for a `stdio` and an `http` server.
-   [MCP servers in the design guide](https://github.com/strands-agents/box/blob/fbe415cbdfec284bf608a46f125ff8e437a99bda/docs/design/mcp.md): how the box starts a server and decides each call.
-   [Policy in the design guide](https://github.com/strands-agents/box/blob/fbe415cbdfec284bf608a46f125ff8e437a99bda/docs/design/policy.md): how the engine decides, and what refuses to load.