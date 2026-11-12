A policy is the `policy.dw` file of `permit` and `forbid` rules that decides each request the workload makes through the box’s trusted process (the part of Box that runs outside the box and answers its requests). `box.toml` sets what the workload’s own system calls can reach, and the operating system enforces that. Inside that reach, policy decides each request the workload sends through the box’s trusted process.

Audience: an operator who wants to write or change a policy. [Write a policy and read what it decided](../../guides/write-a-policy/index.md) walks through a first one, and [the action vocabulary](../policy-actions/index.md) lists every field a rule can read.

> **Status.** The action vocabulary and the context fields can change before 1.0.0. Pin the Box build you install (`./box-core/box --version`).

## When the box asks policy

Four parts of the box ask policy, each about its own boundary:

-   **Strands Shell**, the box’s own shell, which the agent’s shell tool runs. It asks once per command line, as `shell:exec` or `shell:spawn`, and once per file operation a command makes, as `fs:*`.
-   **Monty**, the Python interpreter the box runs for the agent’s scripts. It asks once per file operation, as `fs:*`.
-   **The egress gateway.** It asks once per connection, as `net:connect`, once per HTTP request, as `http:request`, and once per MCP request over HTTP, as `mcp:call`.
-   **The MCP broker.** It asks once per request to a local MCP server, as `mcp:call`. On a `tools/call` it asks a second time, as the tool’s own generated action. At startup it asks once for each declared server, as `shell:spawn`.

Three facts decide every request:

-   **The box denies by default.** With no matching `permit`, a request is refused. A `box.toml` with no `policy` key, or a `policy.dw` with no rules, refuses every request that reaches policy.
-   **A `forbid` beats a `permit`.** Write an exception to a broad permit as a `forbid`.
-   **A `permit` only widens.** A restriction such as a budget is a `forbid`.

The agent’s own system calls reach a path in `[agent.filesystem]` with no decision and no record. [Security](../../security/index.md) states where each tier governs.

## How a rule reads

```text
@id("no_env")
@description("The .env file holds credentials the agent must not read.")
forbid (principal, action == Box::Action::"fs:read", resource)
when { context.input.path == "~/project/.env" };
```

From the top:

-   **`@id("no_env")`** names the rule. A denial and the decision log name the rule by this id, so give each rule its own.
-   **`@description("…")`** is the error message returned when the rule denies.
-   **`forbid`** is the effect. The other effect is `permit`.
-   **`principal`** is always the agent. Write it as `principal`, with no condition.
-   **`action == Box::Action::"fs:read"`** names the one action this rule decides.
-   **`resource`** is always the same fixed resource. Write it as `resource`, with no condition.
-   **`when { … }`** is the condition. It reads the request’s `context.input` fields, and `path` is one of the fields `fs:read` carries.

A rule with a `when temporal { … }` clause also reads the box’s recorded history, so it can count earlier events or require one. [A budget over time](#a-budget-over-time) and [commit only after the tests passed](#commit-only-after-the-tests-passed) show the two shapes.

## How a denial reads

A denial names the path, program, or host the rule saw, then the rule, then its description:

```text
strands-shell: cat: policy denied this operation on '~/project/.env' [policy: no_env]: The .env file holds credentials the agent must not read.
```

The agent reads the same text, so write each `@description` for the agent. The tail has one of these shapes:

-   `[policy: <id>]: <description>`: a `forbid` with that `@id` matched.
-   `[policy: <id>]`: a `forbid` matched, and it has no `@description`.
-   `[default-deny]: No permit policy matched this request.`: no `permit` matched. Add one if the operation is intended.
-   `[policy-pending]: The complete policy bundle is not installed.`: an MCP tool’s schema is still being discovered. The call can be retried.
-   `because the request could not be evaluated.`: the engine hit an internal fault, and it denied the request.

A denial of an experimental [tool grammar](../configuration/index.md#toolnamegrammar) action reads the same way, on the path of the program. The decision log names the grammar action.

Each caller shows the text in its own form:

-   **A shell command** prints it on stderr. A command the policy refused exits `126`. When policy refuses a file operation inside a command it permitted, the command fails with its own status (`1` for `cat`).
-   **Python in the box** raises a `PermissionError` whose message is the text. The script can catch it.
-   **An HTTP request** receives a `403` response whose body is the text. The request never leaves the box.
-   **An MCP call** receives a JSON-RPC error with code `-32001` and the text, followed by the method in parentheses.

Three refusals look like a denial, and no `permit` lifts them:

-   **A path inside the box directory, or the `box.toml` or `policy.dw` this run loaded, is refused whatever the policy says.** The decision log records the cause as `enforcement`, and [step 4 of the tutorial](../../guides/write-a-policy/index.md#step-4-read-the-decision-log) shows how to read it. [What Box always enforces](../../security/index.md#what-box-always-enforces) states the rule.
-   **A program that a tool grammar binds, run by its bound name after its file was replaced or removed, or run by the agent under a name that only a stdio `[mcp.<name>]` declares, is refused whatever the policy says.** The tail is `[tool-grammar]`, then the reason, then `No policy can permit it.` [`shell:spawn`](../shell/index.md#shellspawn) states the cases.
-   **A file tool of the harness itself fails with “operation not permitted” on macOS, or “no such file or directory” on Linux, and the decision log holds no record.** The path is outside every `[agent.filesystem]` list. Add it to a list in `box.toml` if the agent is meant to reach it.

## The actions

The box ships ten actions in four categories, and generates one more for each MCP tool it discovers. Each experimental [tool grammar](../configuration/index.md#toolnamegrammar) adds its own `Tool::<name>` actions. [The action vocabulary](../policy-actions/index.md) lists the fields of each one.

-   **[Filesystem](../policy-actions/index.md#filesystem)**: a file operation in Strands Shell or Monty. `fs:read`, `fs:write`, `fs:delete`, `fs:move`, and the reserved `fs:other`.
-   **[Network](../policy-actions/index.md#network)**: an outbound call through the egress gateway. Each call is two decisions: `net:connect` for the connection, before TLS, and `http:request` for each request inside it, after TLS on an HTTPS connection.
-   **[Shell](../policy-actions/index.md#shell)**: a command line in Strands Shell, judged once after the shell resolves its first word to a program. `shell:exec` for a program the shell implements, such as `cat` or `grep`, and `shell:spawn` for a program of the surrounding OS, such as `git`, and for the start of each stdio MCP server `box.toml` declares.
-   **[MCP](../policy-actions/index.md#mcp)**: a request to an MCP server. `mcp:call` for each request, on every method, and one generated `<server>::Action::"<tool>"` for each discovered tool, decided on a `tools/call` after `mcp:call` permitted it.

## Common rules

Seven rules an operator writes often. Each one is a working rule. Copy it beside the permits from [your first policy](../../guides/write-a-policy/index.md), replace `~/project` with your project directory, and run the box. Two of them say what else `box.toml` needs. The first six are `forbid` rules. The last is a pair of `permit` rules that replace two from the tutorial.

### A budget over time

At most twenty writes of file content in one hour. The twenty-first is refused until the oldest counted write is more than an hour old.

```text
@id("write_budget")
@description("At most 20 content writes completed in one hour.")
forbid (principal, action == Box::Action::"fs:write", resource)
when { context.input.operation == Box::FsWriteOperation::"write_content" }
when temporal {
  exists (total: Long). (
    (count for (t: Timepoint). where (
      formerly within 1h (
        Box::Action::"fs:write"::response{ input.path: _, input.operation: Box::FsWriteOperation::"write_content", output.result: Box::FsResponseResult::"completed" } && tp(t)
      )
    )) == total && total >= 20
  )
};
```

```text
strands-shell: tee: policy denied this operation on '~/project/notes.md' [policy: write_budget]: At most 20 content writes completed in one hour.
```

-   The rule counts `fs:write::response` events with result `completed`, which the box records when a content write finishes. A refused write does not count, and a write still in flight does not count yet, so a burst of writes started together can exceed the budget by the size of the burst.
-   The `when` clause limits the `forbid` to content writes. A `mkdir` is `fs:write` with operation `create_dir`, so the budget leaves it alone. A rename is `fs:move`, and a delete is `fs:delete`; each needs its own rule.
-   The count persists across a restart of the box and across an edit to another rule.

For an exact count of attempts, including refused ones, replace the predicate inside `formerly within 1h ( … )` with:

```text
Box::Action::"fs:write"::request{ input.path: _, input.operation: Box::FsWriteOperation::"write_content" } && tp(t)
```

Write a budget as a `forbid`. [A cap written as a permit](#a-cap-written-as-a-permit) shows what happens at load when a budget is written as a `permit`.

### A rate limit on one host

At most sixty completed requests to one host in ten minutes. The sixty-first is refused until the oldest counted request is more than ten minutes old. Write it beside a `permit` for `api.github.com` on `http:request`, such as the `github_request` rule in [the `[egress.<name>]` table](../../guides/network-and-credentials/index.md#example).

```text
@id("github_rate_limit")
@description("At most 60 requests to api.github.com completed in 10 minutes.")
forbid (principal, action == Box::Action::"http:request", resource)
when { context.input.host == "api.github.com" }
when temporal {
  exists (total: Long). (
    (count for (t: Timepoint). where (
      formerly within 10m (
        Box::Action::"http:request"::response{ input.host: "api.github.com" } && tp(t)
      )
    )) == total && total >= 60
  )
};
```

-   The rule counts `http:request::response` events for the host, which the box records when the reply arrives. A refused request does not count, and one still in flight does not count yet.
-   The `when` clause scopes the `forbid` to the one host, so a request to any other host is unaffected. The same shape on `net:connect` limits connections rather than requests.
-   The agent receives a `403` whose body names the rule, as `[policy: github_rate_limit]`, and its description. [How a denial reads](#how-a-denial-reads) shows the form.

### Deny a program and its aliases

`rm` is refused under every spelling that resolves to the shell’s `rm`: `"rm" x`, `\rm x`, `X=rm; $X x`, and `alias safe=rm; safe x` are each judged as `rm`. Every other command the shell implements still runs.

```text
@id("no_rm")
@description("Nothing is removed from the command line.")
forbid (principal, action == Box::Action::"shell:exec", resource)
when { context.input.program == "rm" };
```

```text
strands-shell: effect denied: policy denied this operation on 'rm' [policy: no_rm]: Nothing is removed from the command line.
```

A path spelling such as `/bin/rm` names a binary of the surrounding OS, which is a `shell:spawn`. A rule on a spawned binary compares `program_path`, the resolved path of the binary:

```text
@id("no_host_git")
forbid (principal, action == Box::Action::"shell:spawn", resource)
when { context.input.program_path == "/usr/bin/git" };
```

### Read files, keep listings closed

A file the agent names is readable, and every directory listing is refused. `cat ~/project/src/main.rs` succeeds. `ls ~/project/src` is refused, and so is a pattern such as `~/project/src/*.rs`, because expanding it lists the directory.

```text
@id("no_listing")
@description("Directory listings stay closed.")
forbid (principal, action == Box::Action::"fs:read", resource)
when { context.input.operation == Box::FsReadOperation::"enumerate" };
```

```text
strands-shell: ls: policy denied this operation on '~/project/src' [policy: no_listing]: Directory listings stay closed.
```

Every filesystem request carries `operation`, the exact verb, so a rule can single out one verb of an action. [The action vocabulary](../policy-actions/index.md#filesystem) lists the verbs of each action.

### Commit only after the tests passed

`git commit` runs only when a `cargo test` exited `0` in the last hour. Before the first pass, after a failure with no later pass, or once the last pass is more than an hour old, it is refused.

```text
@id("test_before_commit")
@description("Run the tests first.")
forbid (principal, action == Box::Action::"shell:spawn", resource)
when {
  context.input.program == "git" &&
  context.input has arg1 && context.input.arg1 == "commit"
}
unless temporal {
  formerly within 1h (
    Box::Action::"shell:spawn"::response{ input.program: "cargo", input.arg1: "test", output.status: 0 }
  )
};
```

```text
strands-shell: effect denied: policy denied this operation on '/usr/bin/git' [policy: test_before_commit]: Run the tests first.
```

-   The rule needs a `shell:spawn` permit for `git` and one for `cargo`, and a [`[tool.<name>]`](../shell/index.md#toolname) table in `box.toml` for each of the two programs. The policy in [your first policy](../../guides/write-a-policy/index.md) has no `shell:spawn` permit, so add these two:
    
    ```text
    @id("spawn_git")
    permit (principal, action == Box::Action::"shell:spawn", resource)
    when { context.input.program_path == "/usr/bin/git" && context.input.program == "git" };
    
    @id("spawn_cargo")
    permit (principal, action == Box::Action::"shell:spawn", resource)
    when { context.input.program_path == "~/.cargo/bin/cargo" && context.input.program == "cargo" };
    ```
    
-   `arg1` is optional, because a command can have no arguments, so the rule guards it with `context.input has arg1`.
    
-   The condition is keyed on `::response`, the event the box records when `cargo test` finishes, with the exit status as `output.status`. A `::request` event exists for a refused attempt too, so a rule keyed on it would pass after a refused `cargo test`.
    

### Forbid one URL path on a host

Every request under `/v1/` on `api.example.com` is permitted, except the endpoints under `/v1/admin`.

`context.input.path` is the exact path the gateway forwards. The gateway puts the path in canonical form first: it decodes the percent-escapes of unreserved characters, keeps `%2F` encoded with uppercase hex digits, and removes `.` and `..` segments. `/v1/./admin`, `/v1/%61dmin`, and `/v1/users/../admin` all reach policy as `/v1/admin`, and `/v1/admin%2fexport` reaches it as `/v1/admin%2Fexport`.

The gateway keeps repeated slashes and `%2F`, and the server receives them. Servers disagree about such a path: some serve `/v1//admin` as `/v1/admin`, and others, such as S3, treat `a//b` and `a/b` as two different keys. A `forbid` on `/v1/admin` beside a permit on `/v1/*` therefore leaves `/v1//admin` and `/v1/admin%2Fexport` permitted. Add a second `forbid` that refuses both forms on that host:

```text
@id("api_connect")
permit (principal, action == Box::Action::"net:connect", resource)
when { context.input.host == "api.example.com" };

@id("api_v1")
permit (principal, action == Box::Action::"http:request", resource)
when { context.input.host == "api.example.com" && context.input.path like "/v1/*" };

@id("no_admin")
forbid (principal, action == Box::Action::"http:request", resource)
when {
  context.input.host == "api.example.com" &&
  (context.input.path == "/v1/admin" || context.input.path like "/v1/admin/*")
};

@id("no_ambiguous_slash")
forbid (principal, action == Box::Action::"http:request", resource)
when {
  context.input.host == "api.example.com" &&
  (context.input.path like "*//*" || context.input.path like "*%2F*")
};
```

| Request | Decision | Rule |
| --- | --- | --- |
| `/v1/users` | Permitted | `api_v1` |
| `/v1/administrator` | Permitted | `api_v1` |
| `/v1/users?next=//login` | Permitted | `api_v1` |
| `/v1/admin`, `/v1/./admin`, `/v1/%61dmin`, `/v1/users/../admin` | Refused | `no_admin` |
| `/v1/admin/export` | Refused | `no_admin` |
| `/v1//admin`, `/v1///admin/export` | Refused | `no_ambiguous_slash` |
| `/v1/users//42`, `/v1/admin%2Fexport`, `/v1/admin%2fexport` | Refused | `no_ambiguous_slash` |

`context.input.path` holds no query, so the `//` in `?next=//login` is outside the path.

```text
http:request gate: policy denied this operation on 'api.example.com:443/v1//admin' [policy: no_ambiguous_slash].
```

-   `no_ambiguous_slash` refuses every path on the host that holds `//` or `%2F`, including paths the server treats as distinct resources. Scope it to the hosts whose paths your rules forbid.
-   Write the forbid on the path and its children, as `no_admin` does. A pattern on the end of the path, such as `context.input.path like "*/admin"`, refuses `/v1//admin` and also `/v1/users/admin`, and it permits `/v1/admin/` and `/v1/admin/export`.

### Bind a credential to one host and one method

A `POST` to the Bedrock host on port 443 goes out with the key the box holds. Every other method on that host, and every other host, is refused.

The credential is bound in `box.toml`, and the policy permits the request. The two name the same host. Edit the `[egress.model]` table in `box.toml`; [the `[egress.<name>]` table](../../guides/network-and-credentials/index.md) lists its keys:

```toml
[egress.model]
destinations = ["bedrock-runtime.us-west-2.amazonaws.com"]
secret.ref = "env://AWS_BEARER_TOKEN_BEDROCK"
```

Replace the `model_connect` and `model_request` rules of [your first policy](../../guides/write-a-policy/index.md) with these two. Replace rather than add: a second rule with the same `@id` refuses to load, and a renamed copy leaves the broad `model_request` permit in force.

```text
@id("model_connect")
permit (principal, action == Box::Action::"net:connect", resource)
when { context.input.host == "bedrock-runtime.us-west-2.amazonaws.com" && context.input.port == 443 };

@id("model_request")
permit (principal, action == Box::Action::"http:request", resource)
when {
  context.input.host == "bedrock-runtime.us-west-2.amazonaws.com" &&
  context.input.port == 443 &&
  context.input.method == "POST"
};
```

The agent receives a `403` response whose body is the denial, and the request never leaves the box:

```text
http:request gate: policy denied this operation on 'bedrock-runtime.us-west-2.amazonaws.com:443/model/anthropic.claude/invoke' [default-deny]: No permit policy matched this request.
```

A connection to another host is refused before TLS:

```text
policy denied this operation on 'example.com:443' [default-deny]: No permit policy matched this request.
```

A `[egress.<name>]` table with no matching permit leaves the host unreachable. A permit with no binding sends the request with a placeholder in place of the secret, which the provider rejects.

## Troubleshooting load failures

The box validates `policy.dw` before it starts. It refuses to start on a policy it cannot read, or on a policy with a rule it can prove will never match (the refusals call such a rule inert). `box run` prints the refusal on stderr and exits with status `1`. No workload starts, and a box that has run before keeps its state.

```text
strands-box: error: policy file /Users/you/box-tutorial/my-box/policy.dw will not load: <refusal>
```

Each refusal below is the text after `will not load:` . Two numberings appear. `rule N` counts from `1` in file order. `policy_N` is the engine’s own name and counts from `0`, so `policy_0` is rule

1.  A rule with no `@id` is named by its effect and position, as `the permit rule with no @id (rule 1)`. When the engine can point at the text, the refusal ends with the line and column in the file, and often a hint in parentheses, such as ``(did you mean `path`?)``.

When the box suspects a rule is inert but cannot prove it, it prints a warning and starts:

```text
strands-box: warning: <finding>
```

### The rule does not parse

A rule ends with `;`, or continues with `when` or `unless`. This one ends with neither:

```text
permit (principal, action == Box::Action::"fs:read", resource)
```

```text
failed to parse policy source: dogwood parse: unexpected end of input; expected `;` to end the policy, or `when`/`unless` to add a condition at line 2, column 1
```

A rule reads the request’s own fields and the recorded history. This one calls out to an external function (an information provider, in the engine’s words), which does not parse:

```text
permit (principal, action == Box::Action::"shell:exec", resource)
when { Scanner::classify(context.input.command) == "safe" };
```

```text
failed to parse policy source: dogwood: information providers are not enabled in this build
```

### A name the vocabulary does not have

An action name is one of [the actions](#the-actions), spelled exactly. This one misspells `fs:read`:

```text
permit (principal, action == Box::Action::"fs:raed", resource);
```

```text
policy references unknown action: for policy `policy_0`, unrecognized action `Box::Action::"fs:raed"` at line 1, column 30 (did you mean `Box::Action::"fs:read"`?); for policy `policy_0`, unable to find an applicable action given the policy scope constraints
```

A field name is one the action carries, and [the action vocabulary](../policy-actions/index.md) lists them. This one misspells `path`:

```text
permit (principal, action == Box::Action::"fs:read", resource)
when { context.input.paht like "~/project/*" };
```

```text
policy fails schema validation: for policy `policy_0`, attribute `input.paht` in context for Box::Action::"fs:read" not found at line 2, column 8 (did you mean `path`?)
```

An `operation` value is one of the fixed set its action has. The value for a listing is `enumerate`, and this one writes `list`:

```text
forbid (principal, action == Box::Action::"fs:read", resource)
when { context.input.operation == Box::FsReadOperation::"list" };
```

```text
policy fails schema validation: for policy `policy_0`: entity `Box::FsReadOperation::"list"` is of an enumerated entity type, but `"list"` is not declared as a valid eid at line 1, column 1 (valid entity eids: "read_content", "read_metadata", "enumerate", "read_link", "change_dir", "exec")
```

### An optional field read without a guard

An optional field (marked `?` in [the action vocabulary](../policy-actions/index.md)) is read behind a guard, as `context.input has arg1 && context.input.arg1 == "-rf"`. This one reads `arg1` with no guard:

```text
forbid (principal, action == Box::Action::"shell:exec", resource)
when { context.input.program == "rm" && context.input.arg1 == "-rf" };
```

```text
policy fails schema validation: for policy `policy_0`, unable to guarantee safety of access to optional attribute `input.arg1` in context for Box::Action::"shell:exec" at line 2, column 41 (try testing for the attribute's presence with `context.input has arg1 && ..`)
```

### A temporal clause the engine cannot evaluate

A temporal predicate names one action, so a rule covers a family with one clause per action. This one names the family `fs`:

```text
forbid (principal, action == Box::Action::"fs:write", resource)
when temporal {
  formerly within 60s ( Box::Action::"fs"::request{ input.path: _ } )
};
```

```text
policy fails schema validation: predicate `Box::Action::"fs"::request` does not name a declared event (no event kind `request` derived for action `fs`) at line 3, column 3 (check the action name and event kind; event kinds are typically `request` or `response` and derive from the schema)
```

The longest window is `24h`. The refusal offers to raise `max_window`, but that schema ships inside the box, so shorten the window:

```text
forbid (principal, action == Box::Action::"fs:write", resource)
when temporal {
  formerly within 48h ( Box::Action::"fs:write"::response{ input.path: _ } )
};
```

```text
policy fails schema validation: temporal window `48h` exceeds the maximum allowed window `24h` set by the event schema's `max_window`; shorten this window to at most `24h`, or raise `max_window` in the event schema at line 3, column 3 (every temporal `within` window is capped by the event schema's `max_window` (default 24h); either shorten this window or raise the cap with a `max_window = <interval>` directive at the top of the event schema)
```

An MCP call always records `::response`, even when the server replies with an error, so it never records `::error`. A predicate on `mcp:call::error`, or on a tool action’s `::error`, can’t match:

```text
forbid (principal, action == Box::Action::"shell:exec", resource)
when temporal { formerly within 1h ( Box::Action::"mcp:call"::error{ input.server: "github" } ) };
```

```text
policy uses an unsupported clause: the forbid rule with no @id (rule 1): a temporal predicate names Box::Action::"mcp:call"::error; Box records every MCP outcome as `::response`, so the predicate cannot match; name `::response` instead
```

### A literal that nothing can match

A path under the operator’s home is reported `~/…`, and the home itself is reported `~`. A directory is reported without a trailing slash. The check also covers `context.input.cwd` on `shell:exec` and `shell:spawn`. A directory outside the operator’s home keeps its absolute path. The refusal names the spelling to write:

```text
@id("project_read")
permit (principal, action == Box::Action::"fs:read", resource)
when { context.input.path like "/Users/dev/project/*" };
```

```text
policy compares an inert literal: rule @id("project_read") compares context.input.path with the pattern "/Users/dev/project/*", and a path under the operator home is spelled ~/…; write "~/project/*"
```

```text
@id("project_read")
permit (principal, action == Box::Action::"fs:read", resource)
when { context.input.path like "~/project/" };
```

```text
policy compares an inert literal: rule @id("project_read") compares context.input.path with the pattern "~/project/", and a directory is spelled without a trailing slash; write "~/project"
```

A host reaches policy in lowercase and without a trailing dot:

```text
@id("block_host")
forbid (principal, action == Box::Action::"net:connect", resource)
when { context.input.host == "API.Example.com" };
```

```text
policy compares an inert literal: rule @id("block_host") compares context.input.host with "API.Example.com", and a host is spelled in lowercase and without a trailing dot; write "api.example.com"
```

Two other host spellings each get their own refusal:

-   **A host that carries a port**, such as `api.example.com:443`. Write the name alone, and compare `context.input.port` for the port.
-   **An internationalized domain**, such as `bücher.example`. The gateway sees the punycode form, so write `xn--bcher-kva.example`.

A pinned address reaches policy as two fields, one per address family. `ip4` holds the IPv4 address, as a dotted quad. `ip6` holds the IPv6 address, compressed and in lowercase. Each needs its own `has` guard, so a rule that covers both families gives each one its own clause:

```text
@id("metadata_addresses")
forbid (principal, action == Box::Action::"net:connect", resource)
when {
  (context.input has ip4 && (
    context.input.ip4 like "169.254.*" ||
    context.input.ip4 == "168.63.129.16" ||
    context.input.ip4 == "100.100.100.200")) ||
  (context.input has ip6 && (
    context.input.ip6 == "fd00:ec2::254" ||
    context.input.ip6 like "fe8*" || context.input.ip6 like "fe9*" ||
    context.input.ip6 like "fea*" || context.input.ip6 like "feb*"))
};
```

That is longer than one clause over both families would be. What you get for it is that you can tell from the rule which addresses it will match.

#### Which field matches what

**`ip4` matches an IPv4 address however it arrives, when Box recognises the wrapping.** A destination that reaches the box as an IPv6 encoding of an IPv4 address carries the IPv4 address on `ip4` as well. So one `ip4 like "169.254.*"` covers the dotted quad and every encoding in the table below, and you need no clause per encoding.

**`ip6` matches the wire form** — the address the gateway actually dials. A destination that arrives wrapped carries both fields, so `ip6 like "64:ff9b::*"` refuses every address routed through the well-known NAT64 translator, whatever IPv4 address each one carries. Use `ip6` when the route is what you care about and `ip4` when the endpoint is.

**A dual-stack destination needs a clause per family.** A host that resolves to both an IPv4 and an IPv6 address raises one `net:connect` per pinned address, and each carries only the fields its own address has. A rule that names `ip4` alone leaves the IPv6 address to whatever else the policy says.

**An IPv4 destination carries no `ip6`.** Box never computes an IPv6 form for one, because a single IPv4 address has many IPv6 encodings and none of them is the address that was dialled.

| The destination arrives as | `ip4` | `ip6` |
| --- | --- | --- |
| `169.254.169.254` | `169.254.169.254` | absent |
| `::ffff:169.254.169.254` (IPv4-mapped) | `169.254.169.254` | `::ffff:169.254.169.254` |
| `::169.254.169.254` (IPv4-compatible) | `169.254.169.254` | `::a9fe:a9fe` |
| `2002:a9fe:a9fe::` (6to4) | `169.254.169.254` | `2002:a9fe:a9fe::` |
| `2001::5601:5601` (Teredo) | `169.254.169.254` | `2001::5601:5601` |
| `64:ff9b::a9fe:a9fe` (NAT64, well-known prefix) | `169.254.169.254` | `64:ff9b::a9fe:a9fe` |
| `::ffff:0:a9fe:a9fe` (IPv4-translated) | `169.254.169.254` | `::ffff:0:a9fe:a9fe` |
| `64:ff9b:1::a9fe:a9fe` (NAT64, local use) | **absent** | `64:ff9b:1::a9fe:a9fe` |
| an address on a network’s own NAT64 prefix | **absent** | the address as dialled |
| `fd00:ec2::254` | absent | `fd00:ec2::254` |

**Where `ip4` is absent, an `ip4` rule does not fire.** The last two rows are the ones to watch. RFC 6052 lets a network choose its own NAT64 prefix and RFC 7050 exists so a host can discover it; Box takes no such prefix as configuration, so it cannot tell such an address from any other IPv6 address. On a network like that, pin the destination with `ip6` or with `host`, not with `ip4`.

#### Address spellings that refuse to load

Each field is held to its own spelling at load, and the refusal names the form to write.

-   **An IPv6 literal on `ip4`, or an IPv4 literal on `ip6`.** The refusal names the other field.
-   **An IPv6 address that is not compressed and lowercase**, such as `64:FF9B::A9FE:A9FE`. Write `64:ff9b::a9fe:a9fe`. An IPv4-mapped form keeps its dotted quad, so `::ffff:a9fe:a9fe` is written `::ffff:169.254.169.254`.
-   **An address that carries a port**, such as `169.254.169.254:80` or `[2001:db8::1]:443`. Write the address alone, and compare `context.input.port` for the port.
-   **An address in brackets**, such as `[2001:db8::1]`. Write it without them.
-   **Anything that is no IP address**, such as `metadata.example` or `169.254.169.254/32`. These fields hold the address the gateway pinned; compare `context.input.host` to pin a name.

A `like` pattern that holds a wildcard is not held to a whole address, because the addresses a wildcard admits cannot be listed. So `context.input.ip4 like "169.254.*"` loads as written, and so does `context.input.ip6 like "64:ff9b::*"`. A wildcard pattern reaches whatever its own field holds: `ip6 like "fe8*"` reaches an `fe80::` link-local address, and `ip6 like "64:ff9b::*"` reaches every address on the well-known translator prefix and also an address outside it whose spelling starts the same way, such as `64:ff9b::1:a9fe:a9fe`.

Each piece of the pattern between the wildcards is still held to the characters its field holds. `ip4` holds digits and `.`, and `ip6` holds digits, `a` to `f`, `:`, and `.`. So two more mistakes refuse to load:

-   **A pattern with an uppercase letter**, such as `ip6 like "64:FF9B::*"`. `like` is case-sensitive and `ip6` is always lowercase, so that `forbid` could never fire. Write `64:ff9b::*`.
-   **A pattern of the other family**, such as `ip4 like "fd00:ec2:*"`. The refusal names `ip6`.
-   **An `ip6` pattern with a dotted quad anywhere but in `::ffff:` and the quad**, such as `ip6 like "64:ff9b::169.254.*"`, `ip6 like "::169.254.*"`, or `ip6 like "::ffff:0:169.254.*"`. The IPv4-mapped form is the one wire form written with a dotted quad, and it is exactly `::ffff:` and the quad. So each of those could never fire. RFC 6052 writes a NAT64 address that way and RFC 6145 writes a translated one as `::ffff:0:` and a quad, which is why this mistake is easy to reach for. Write the hexadecimal groups, as `64:ff9b::a9fe:*`, or compare `ip4` to name the address it carries. A pattern whose wildcard could cover the rest of `::ffff:` is not refused, such as `ip6 like "::*169.254.*"`, because what that wildcard admits cannot be listed.

What this does not catch is a wildcard pattern whose pieces are all plausible but whose prefix no address takes, such as `ip6 like "::ffff:a9fe:*"`. A mapped address is written with a dotted quad, so that pattern misses the mapped addresses it looks aimed at — but `::ffff:a9fe:a9fe:0` is a real address it does match, so the load cannot prove it inert. Check an `ip6` pattern against the table above.

A `when temporal` clause is not judged either. History keeps the spelling each event was recorded with, so a temporal clause can still need an older one. Earlier shell events can carry an absolute `cwd` below the operator’s home. A predicate on `~/project` does not match those events, and Box does not translate their stored values.

An absolute `cwd` predicate below the operator home can match older events but misses new `shell:exec` and `shell:spawn` events. A `forbid` that depends on those matches can stop denying commands. The loader accepts these temporal predicates without a warning.

Editing a history rule starts it with empty state, including edits that match both spellings. Plan how to preserve active budgets before upgrading a box with these predicates.

**A box can hold address events that this vocabulary cannot read.** An event recorded by an earlier build carries one address field, and a predicate on `ip4` or `ip6` does not match it. There is no rewind, so a counting rule that spans such a build starts its count again.

Two spellings load with a warning. The first compares `program` with a path. `program` holds the name the first word resolved to; a binary of the surrounding OS is a `shell:spawn`, and its resolved path is in `program_path`:

```text
@id("no_bin_rm")
forbid (principal, action == Box::Action::"shell:exec", resource)
when { context.input.program == "/bin/rm" };
```

```text
rule @id("no_bin_rm") compares context.input.program with "/bin/rm", which matches only a first word spelled that way; compare context.input.program_path to match the resolved binary
```

A pattern that names the operator’s home after a wildcard may match nothing:

```text
@id("later_home")
permit (principal, action == Box::Action::"fs:read", resource)
when { context.input.path like "*/Users/dev/project/*" };
```

```text
rule @id("later_home") compares context.input.path with the pattern "*/Users/dev/project/*", which names the operator home after a wildcard; a path under the operator home is spelled ~/…, so the pattern may match nothing
```

### A rule that checks `context.input` for two kinds of action

The same field name can mean different things on different actions. On `fs:read`, `path` is a file. On `http:request`, `path` is the path part of a URL. So a rule that checks `context.input` covers one kind of action, and the error calls that kind a family. This rule checks `path` for a file read and for an HTTP request, and it refuses to load:

```text
@id("no_secrets")
forbid (principal, action in [Box::Action::"fs:read", Box::Action::"http:request"], resource)
when { context.input.path like "*/secrets.env" };
```

```text
policy reads the input without one action family: rule @id("no_secrets") reads context.input.path under actions of more than one family, and an input attribute means what the action makes it mean; write one rule for each family: [Box::Action::"fs:read"] and [Box::Action::"http:request"]
```

To fix it, write one rule for each family:

```text
@id("no_secrets_file")
forbid (principal, action == Box::Action::"fs:read", resource)
when { context.input.path like "*/secrets.env" };

@id("no_secrets_url")
forbid (principal, action == Box::Action::"http:request", resource)
when { context.input.path like "*/secrets.env" };
```

Actions are in the same family when their names start the same way before the `:`. So `fs:read`, `fs:write`, and `fs:delete` can share one rule, and `net:connect` and `http:request` can’t. Each MCP tool action is a family of its own.

A rule that checks `context.input` and names no action gets the same error. Name the action the rule is for in its scope, as `action == Box::Action::"fs:read"`. A test such as `action == Box::Action::"fs:read"` inside `when` doesn’t count, so this rule still gets the error:

```text
forbid(principal, action, resource)
when { action == Box::Action::"fs:read" && context.input.path like "*/secrets.env" };
```

### One `@id` on two rules

The duplicate check covers each rule that carries an `@id`:

```text
@id("project_read")
permit (principal, action == Box::Action::"fs:read", resource)
when { context.input.path like "~/project/*" };
@id("project_read")
permit (principal, action == Box::Action::"fs:write", resource)
when { context.input.path like "~/project/*" };
```

```text
policy gives one @id to more than one rule: @id("project_read") is on rules 1, 2; a denial and a telemetry record name a rule by its @id, so give each rule its own @id
```

### A rule that names only the reserved action

`fs:other` loads beside an action that some operation raises, as `action in [Box::Action::"fs:read", Box::Action::"fs:other"]`:

```text
@id("other_only")
permit (principal, action == Box::Action::"fs:other", resource);
```

```text
policy names only a reserved action: rule @id("other_only") (rule 1) names only the reserved action "fs:other"; no operation raises it, so the rule cannot match; name fs:read, fs:write, fs:delete, or fs:move, alone or beside fs:other
```

### A cap written as a permit

A permit cannot narrow another permit. Write a cap as a `forbid`, as in [a budget over time](#a-budget-over-time) and [a rate limit on one host](#a-rate-limit-on-one-host). A cap written as a `permit` with a `when temporal` clause has one of three outcomes, decided by the other permits for the same action.

**Refused**, when another permit for the action has no condition. The refusal names both rules, and the box does not start:

```text
@id("writes")
permit (principal, action == Box::Action::"fs:write", resource);

@id("write_budget")
permit (principal, action == Box::Action::"fs:write", resource)
when temporal { … };
```

```text
policy writes a cap as a permit: rule @id("write_budget") (rule 2) carries a temporal clause beside rule @id("writes") (rule 1), which permits the same action with no condition; a permit cannot narrow another permit, so write the cap as a forbid
```

**Warned**, when the other permit has a `when` condition. The box starts, and prints this at startup:

```text
strands-box: warning: rule @id("write_budget") (rule 2) carries a temporal clause beside rule @id("project_writes") (rule 1), which also permits that action; the budget is inert for every request the other rule admits, so write a cap as a forbid
```

**Loads**, with no warning, when the temporal `permit` is the only permit for its action, or when every other permit for the action is temporal too. Alone, it admits the action whenever its clause holds.

The check reads only whether the other permit has a condition. Whether two conditions overlap is outside it, and [Policy limitations](../../security/index.md#policy-limitations) states what this means for a cap.

### A rule that loads and never matches

The box refuses what it can prove inert. Two shapes load and decide nothing:

-   `context.input.operation == Box::FsWriteOperation::"write_content"` on `fs:read`. Each action has its own set of operation values, and a value from another action’s set never matches.
-   `context has output && context.output.status == 200` outside `when temporal`. A decision carries no `output`; only a `::response` event does.

### A reused box whose history and record disagree

A box keeps its decision history in `<box_dir>/private/dogwood.redb`. The box record, a file under `<box_dir>/private` that says whether this box has run, must agree with the history file. The run refuses when the record says the box has run but the history is missing or empty, and when the record says it has not run but the history holds events:

```text
strands-box: error: policy staging failed: the box record is committed, but the history /Users/dev/.box/<name>/private/dogwood.redb is absent. Wipe the box directory to start again.
```

The text varies: the record `is committed` or `is not committed`, and the history `is absent`, `is empty`, or `holds <n> bytes`. The run also refuses when the engine cannot read the history file, with `policy staging failed:` and the engine’s own reason, and the file is left as found. Remove the box directory to start again, as [getting started](../../quickstart/index.md#clean-up) describes.

The run also refuses history stamped more than five minutes ahead of the system clock. This happens when the clock moved back after the box last ran, or when someone edited the history file:

```text
strands-box: error: policy staging failed: policy staging history failure: durable timestamp <t> is <n> ns ahead of the current clock <now>, exceeding the maximum allowed future skew of 300000000000 ns; refusing the operation rather than issuing future-dated timestamps
```

If the clock moves back more than five minutes during a run, the box denies each request and prints `policy: warn: durable timestamp ...; denying` on stderr. Requests are decided again once the clock is within five minutes of the newest history timestamp. If an action finished while the clock was that far back, the box keeps its record and prints `policy: warn: an earlier outcome is not recorded yet: ...; denying` for each request until the record is saved. Once the clock is within five minutes again, the box saves it at the next request, or when the run shuts down, and then requests are decided normally. If the run ends while the clock is still more than five minutes behind, or the process is killed, that action doesn’t count toward any limit after a restart. A time-zone change does not move this clock. Correct the system clock, or remove the box directory to start again, as [getting started](../../quickstart/index.md#clean-up) describes.

## See also

-   [Write a policy and read what it decided](../../guides/write-a-policy/index.md): a first policy, a denial, and the decision log.
-   [The action vocabulary](../policy-actions/index.md): every action, its fields, and which part of the box raises it.
-   [Security](../../security/index.md): what `box.toml` governs, what `policy.dw` governs, and what a policy cannot do today.
-   [Policy in the design guide](https://github.com/strands-agents/box/blob/a2cf46ed6a9ea0a8144101bfdef3f2406390952b/docs/design/policy.md): how one engine per box decides, and why.