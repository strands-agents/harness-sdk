A box records every policy decision it makes, every change to its own authority, each unmatched MCP route, and every span, log record, and metric the workload exports. A `[telemetry.*]` table in `box.toml` declares the target those records reach, and `include` states which records that target receives.

This page covers a `file` target, which appends records to a path the operator names, and the endpoints a box sends to directly: an `otlp` endpoint, Langfuse, LangSmith, and CloudWatch. A box that declares no table writes to a default target. See [The default target](#the-default-target).

## The default target

A box with no `[telemetry]` table writes one file inside its own box directory:

```text
<box_dir>/private/telemetry/records.jsonl
```

That target receives every record except tool calls: each effective denial, each effective permit, the box’s own control-plane records and MCP routing diagnostics, and the workload’s relayed spans, log records, and metrics. The workload cannot reach the file.

The file grows for as long as the box is used. Rotate or remove it as the operator’s own task.

The file is not tamper evident. Box signs no record and chains no record to the next, so anything running under the operator’s own account can edit it afterwards. What the box keeps out is the workload.

A declared target replaces this default rather than adding to it, so a box that declares a file of its own writes no record to `private/telemetry/records.jsonl`.

## `[telemetry.decisions]`

`[telemetry.decisions]` is the target a box declares:

```toml
[telemetry.decisions]                  # every decision this box takes, recorded
kind        = "file"
destination = "~/boxes/codex/records.jsonl"
include     = ["deny", "permit", "trace", "logs", "metrics"]
```

A `file` table takes three keys. An unknown key is refused.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `kind` | string | none, required | `file`. [Endpoints](#endpoints) lists the other kinds. |
| `destination` | string | none, required | The file the records go to, as stated below. |
| `include` | array of strings | every record except tool calls | Which records reach this target: `deny`, `permit`, `trace`, `logs`, `metrics`, or `mcp_tool_calls`. |

## `kind = "file"`

A file target receives one OTLP-JSON request per line, appended. Each line is a complete `resourceLogs`, `resourceSpans`, or `resourceMetrics` request.

The destination is an absolute path, `~`, or a path that begins with `~/`. Box expands a leading `~` to the operator’s home. These destinations are refused:

| Destination | Message |
| --- | --- |
| A relative path, such as `records.jsonl` | `` a file destination must be absolute or begin with `~/` `` |
| A path that carries a `..` component | ``carries a `..` component`` |
| A path inside `box_dir` and outside `private/` | `is inside the box directory ... but outside its private tree` |

**Name a destination outside every path the agent may write.** Box does not compare the destination against `[agent.filesystem]`, so a file inside a granted directory is a file the agent can truncate. The default destination needs no such care, because it sits in the box directory, which the agent cannot reach.

Declare one target per file. Two boxes that append to one file can tear a line.

## `include`

Omit `include` and the target receives every record except tool calls. Write `include` and the target receives only the records the words in the list name:

| Word | The target then receives |
| --- | --- |
| `deny` | Every effective denial. |
| `permit` | Every effective permit. |
| `trace` | The workload’s own spans, and this box’s control-plane records. |
| `logs` | Box’s unmatched MCP routing diagnostics and the workload’s log records. |
| `metrics` | The workload’s metrics. |
| `mcp_tool_calls` | Each MCP tool call’s arguments and output in clear text, and how it ended. A target receives these only when it names `mcp_tool_calls`. |

A tool-call record is a log record, so Box refuses `mcp_tool_calls` at startup on a target that accepts no logs, such as a `langfuse`, `langsmith`, or `cloudwatch_traces` target.

So `include = ["deny"]` writes a file of refusals, and leaves out the permits, control-plane records, and MCP routing diagnostics.

**The workload’s log records and metrics are on by default.** They reach every target, and no value of `include` keeps them out. The word `logs` selects Box’s MCP routing diagnostics; the workload’s own logs arrive even without it. The word `metrics` is optional. The file `include = ["deny"]` writes therefore holds the denials, plus whatever log records and metrics the workload itself exported.

`trace` names two things at once. A target that omits `trace` receives no control-plane record, so this box’s `box_started`, `policy_installed`, and `box_stopped` records are absent from it.

An empty list is refused, and so is a repeated word.

## Endpoints

An endpoint target sends each batch from the box itself, over OTLP/HTTP with protobuf. The batch does not go through the egress gateway, and policy makes no decision for it. The workload never holds the target’s credential.

Write the vendor’s kind, and Box sets the vendor’s path, headers, and credential placement:

```toml
[telemetry.langfuse]
kind        = "langfuse"
destination = "https://us.cloud.langfuse.com"
secret.ref  = "env://LANGFUSE_AUTH"      # public-key:secret-key

[telemetry.cloudwatch_logs]
kind       = "cloudwatch_logs"
region     = "us-west-2"
log_group  = "my-group"
log_stream = "my-stream"
secret.ref = "aws://my-profile"
```

| Kind | What it receives | What the operator writes |
| --- | --- | --- |
| `otlp` | every payload, or the payloads `accepts` names | `destination`, and optionally `accepts`, `headers`, and `secret` |
| `langfuse` | spans | `secret.ref`, and `destination` for a region or a self-hosted Langfuse |
| `langsmith` | spans | `secret.ref`, and optionally `project` and `destination` |
| `cloudwatch_logs` | log records | `region`, `log_group`, `log_stream`, and an `aws://` or `credsd://` `secret.ref` |
| `cloudwatch_traces` | spans | `region`, an `aws://` or `credsd://` `secret.ref`, and optionally `log_group` and `log_stream` together |

A vendor that takes only spans is sent no log or metric batch. That is the one exception to the rule that the workload’s log records and metrics reach every target.

[`config.md`](/docs/user-guide/box/reference/configuration/index.md#telemetrylabel) lists every key, and what each kind sets.

### The credential

`secret.ref` names where the box reads the key: `env://NAME` or `secret://NAME` for a variable in the environment of `strands-box run`, `aws://PROFILE` or `credsd://ENVIRONMENT` for a SigV4 signature, or a reference in a scheme that a [`[secret-source.<scheme>]`](/docs/user-guide/box/reference/configuration/index.md#secret-sourcescheme) table declares. The box holds the key in a vault of its own for each target, and attaches it on each request. A literal key is refused, and so is a `file://` reference. An `op://` reference is refused unless a table declares `op`.

A credential needs an `https://` destination, unless the destination is loopback.

### Failed sends

Box sends each batch once, with one four-second deadline that covers the credential lookup and the send. A batch that fails is counted, and the box does not retry it. When the run ends, Box prints one line on stderr with the count (see [Errors and exit codes](#errors-and-exit-codes)). To see why a send failed, set `STRANDS_BOX_TELEMETRY_DEBUG` to any non-empty value in the environment of `strands-box run`. Box then also prints each failure on stderr as it happens, with its full cause and the start of the endpoint’s answer. Box redacts each credential it attached from that answer, so an endpoint that echoes a refused key does not put the key in your logs:

```text
strands-box: telemetry export failed: https://cloud.langfuse.com/api/public/otel/v1/traces answered 401 Unauthorized: ...
```

## The workload’s own signals

OpenTelemetry calls each kind of telemetry a signal. Three of them apply here: traces, logs, and metrics.

Box relays the workload’s spans, log records, and metrics. These records exist only when the workload exports them, so two settings apply: the workload’s own exporter setting, and a target that accepts the signal.

Box binds one loopback port for the workload and sets three variables in its environment:

| Variable | Value |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://127.0.0.1:<port>`, where the port is this box’s own |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | the same address with `/v1/traces` appended |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` |

Box owns every name that begins with `OTEL_EXPORTER_OTLP_`, so `[agent] env` may not set one. The receiver answers `/v1/traces`, `/v1/logs`, and `/v1/metrics`, and answers `404` on every other route.

The exporter switches belong to the workload, so write them in `[agent] env`:

```toml
[agent.env]
OTEL_TRACES_EXPORTER = "otlp"
OTEL_LOGS_EXPORTER = "otlp"
OTEL_METRICS_EXPORTER = "otlp"
```

A switch left at `none` means that signal never arrives, whatever `include` names. The OpenTelemetry default metric interval is 60 seconds, so a short run ends before the first metric leaves. Set `OTEL_METRIC_EXPORT_INTERVAL` in `[agent] env` for a short run.

## What a record carries

Each box record names its origin on its resource:

| Key | Value |
| --- | --- |
| `service.name` | `strands-box` |
| `strands.box.name` | this box’s ID: the one the library caller supplied, or a generated `box-` and 16 hexadecimal characters |
| `strands.box.source` | `box` for a record the box wrote, and `agent` for a relayed payload |
| `strands.box.run.id` | one identifier per `strands-box run` invocation |

### A decision

Each effective decision produces one log record and one span that share a trace ID and a span ID. The log record’s `event_name` field is `strands.box.policy.decision`, and the scope is `strands-box.policy`.

| Group | Keys |
| --- | --- |
| The decision | `strands.box.policy.action`, `.resource`, `.verdict`, `.cause`, `.reason` on a denial, and `.principal` |
| The governing rule | `strands.box.policy.rule`, `.description`, `.category`, and `.determining.ids`, which lists every policy that determined the decision |
| Correlation | `strands.box.request.id` on an egress decision, `jsonrpc.request.id` on an MCP request, and `strands.box.trace.parent_span_id` on the log record |
| What it was about | `server.address` and `server.port` on a network decision, `http.request.method` on a request, `file.path` on an `fs:*` decision, and `process.command`, `process.command_args`, and `process.working_directory` on a shell decision |

`strands.box.policy.verdict` holds `deny` or `permit`. `strands.box.policy.cause` holds one of six values: `permitted`, `forbidden`, `no_match`, `policy_pending`, `internal_fault`, and `enforcement`.

A record whose cause is `internal_fault` also carries the key `error.type`, with the value `strands.box.policy.evaluation_error`.

The action value carries the vocabulary term alone, so a reader sees `fs:read` rather than `Box::Action::"fs:read"`. Every other value is reported as the enforcement point holds it. A spawn that a tool grammar decides reports the grammar action, so `Tool::git::Action::"push"` reads as the action `push` in the category `Tool::git`.

Two keys are excluded: `url.full` and `process.command_line`.

`process.command_args` reports each argument after expansion, because the Shell does not say which words the script stated literally. For each argument, the record reports:

| The expanded argument | What the record carries |
| --- | --- |
| A short flag, such as `-l` | the flag |
| A long flag of at most 32 lowercase letters and dashes, such as `--verbose` | the flag |
| A long flag with a value, such as `--output=secret` | the name, and `<redacted>` for the value |
| Anything else | `<redacted>` |

At most 64 arguments are reported. One attribute carries at most 4 KiB, and a longer value is cut on a character boundary and ends with `… (truncated)`.

### An unmatched MCP route

When an MCP alias invocation matches no declared command, Box writes an informational log record with event name `strands.box.mcp.unmatched` in the `strands-box.mcp` scope. `process.command` names the received program, and `process.command_args` follows the expanded-argument redaction rules above. The record includes request identifiers and parent trace context when available.

The diagnostic carries no policy verdict, action, or rule. Box writes it before replying to the alias, so it does not say whether ordinary execution starts or succeeds. It produces no span. Targets receive it when `include` is omitted or contains `logs`.

### A tool call

Each MCP tool call produces up to two log records in the `strands-box.mcp` scope, over a stdio or an http server alike:

| Event name | Written when | Keys |
| --- | --- | --- |
| `strands.box.mcp.tool.call` | the call is decided, whether it is allowed or refused | `strands.box.mcp.tool.server`, `.name`, and `.arguments` |
| `strands.box.mcp.tool.completion` | the call ends | `strands.box.mcp.tool.server`, `.name`, `.reply`, and `.output` when the reply carried `structuredContent` |

`strands.box.mcp.tool.reply` holds one of `result`, `tool_error`, `protocol_error`, `cancelled`, or `indeterminate`, as [`output.reply`](/docs/user-guide/box/reference/policy-actions/index.md) defines them. A refused call has no completion. Both records carry `jsonrpc.request.id`, which joins them to each other and to the call’s decision.

`.arguments` and `.output` are maps of the call’s fields, flattened into the paths a rule writes after `context.input.` or `output.structured.`: an object’s member is `parent.member`, and an array’s element is `parent.N`. So `{"profile": {"email": "a@b"}}` becomes the field `profile.email`.

**Tool-call values are in clear text, so a target receives them only when it names `mcp_tool_calls`.** A target with no `include`, and the box’s own default file, receives none. An argument or an output can hold anything a tool takes or returns, including a password, a token, or a customer’s data, and Box can’t tell which field does. So name `mcp_tool_calls` only on a target whose readers may see all of it, such as a file on your own machine, and not on a vendor’s endpoint you wouldn’t trust with those values:

```toml
[telemetry.local]
kind        = "file"
destination = "~/boxes/helpdesk/records.jsonl"
include     = ["deny", "permit", "trace", "logs", "metrics", "mcp_tool_calls"]
```

A declared target replaces the default file, and a written `include` names everything the target receives, so list the other signals you still want beside `mcp_tool_calls`. At startup, Box prints one line on stderr for each target that receives tool calls, naming where they go.

A tool-call record is a log record, so a target that accepts no logs can’t name `mcp_tool_calls`: Box refuses it with a message that says `tool-call records are logs and it accepts no logs`. That covers `langfuse`, `langsmith`, `cloudwatch_traces`, and an `otlp` target whose `accepts` leaves out `logs`.

Keys arrive as the tool wrote them. When two keys flatten to one path, such as `"a.b"` and `{"a": {"b": …}}`, the first is kept and the second is counted as left out. At most 64 fields are reported per record, each value at most 4 KiB; when a call has more, the record also carries `strands.box.mcp.tool.arguments_omitted` or `strands.box.mcp.tool.output_omitted` with the count left out.

A value keeps its JSON type: a string, `true` or `false`, or a number, so `true` and `"true"` stay apart. An integer too large for 64 bits arrives as its digits in a string, and a JSON `null` arrives as an empty array, which no flattened value can otherwise be.

A call refused before it reaches the server, by the coarse `mcp:call` check or because the tool isn’t listed, is recorded too, because it shows what the agent tried.

A tool-call record produces no span.

**Over http, a target that takes tool calls makes Box read every tool reply.** Reading a reply copies it through the gateway’s budget, which every reply being read at once shares (64 MiB). The policy already reads the reply of every tool in the server’s tool list once Box has read that list, so the extra copies are for replies the policy doesn’t read.

### A control-plane record

A control-plane record states one change to the authority this box holds. The scope is `strands-box.control`, and each operation also produces a span named `control <operation>`.

| Key | Value |
| --- | --- |
| `strands.box.control.operation` | `policy_installed`, `policy_refused`, `schema_installed`, `discovery_complete`, `box_started`, `workload_started`, `box_stopped`, or `secret_fetched` |
| `strands.box.control.outcome` | `ok`, or `refused` |
| `strands.box.control.subject` | what the operation was about |
| `strands.box.control.reason` | why a refusal happened |
| `strands.box.control.detail` | further text the operation carries |

A `workload_started` record states that the box finished its setup and the workload is running inside its containment. The box writes `box_started` before it installs the policy and builds the sandbox, and `workload_started` once the workload’s `exec` succeeds. The subject is the box’s name. A run whose containment or `exec` fails has no `workload_started` record, and its `box_stopped` is `refused`.

A `secret_fetched` record states one read of a secret through a [declared secret source](/docs/user-guide/box/reference/configuration/index.md#secret-sourcescheme), when the box starts. The subject is the entry that names the secret, such as `[egress.github] secret.ref`. The detail names the source, its program, and the reference with its name removed: ``source `op`, program /opt/homebrew/bin/op, reference op://[REDACTED]``. The outcome is `refused` when the program returned no secret. The reason then says only that, because the program’s own words go to stderr alone. Box reads the secret of a telemetry target before it opens its records, so a read that fails there is on stderr and in no record.

## Reading a records file

A records file can hold several scopes, so a query selects one. A box records that it started before it decides anything, so the first record in the file is a control-plane record.

Every denial, one per line:

```sh
jq -r 'select(.resourceLogs)
       | .resourceLogs[].scopeLogs[]
       | select(.scope.name == "strands-box.policy")
       | .logRecords[].attributes
       | map({(.key): .value.stringValue}) | add
       | select(.["strands.box.policy.verdict"] == "deny")
       | "\(.["strands.box.policy.action"]) \(.["strands.box.policy.resource"])"' \
  ~/boxes/codex/records.jsonl
```

Example output:

```text
fs:read ~/.ssh/id_rsa
```

What this box did to its own authority:

```sh
jq -r 'select(.resourceLogs)
       | .resourceLogs[].scopeLogs[]
       | select(.scope.name == "strands-box.control")
       | .logRecords[].attributes
       | map({(.key): .value.stringValue}) | add
       | "\(.["strands.box.control.operation"]) \(.["strands.box.control.outcome"])"' \
  ~/boxes/codex/records.jsonl
```

Example output:

```text
box_started ok
policy_installed ok
workload_started ok
discovery_complete ok
box_stopped ok
```

Select on `strands.box.source` to tell a box record from a relayed one. A severity number is the box’s own routing, and it is not a filter for a reader.

The file needs no conversion, so any viewer that reads OTLP-JSON opens it directly. `otel-tui` is one such tool:

```sh
otel-tui --from-json-file ~/boxes/codex/records.jsonl
```

## Errors and exit codes

A telemetry error stops the run before the workload starts, so the agent never runs. `strands-box` prints the reason on stderr and exits `1`.

Exit `1` alone does not prove that Box refused, because a workload is free to exit `1` as well. The message does: Box prefixes every line it prints with `strands-box:`.

| What the operator sees | Cause |
| --- | --- |
| `names no signal, so nothing would reach it` | `include` is an empty list. |
| `names <word> twice` | `include` repeats a word. |
| `` a file destination must be absolute or begin with `~/` `` | A file destination is relative. |
| ``carries a `..` component`` | A destination carries `..`. |
| `is inside the box directory ... but outside its private tree` | A file destination sits where a process could truncate it. |
| ``a `<kind>` target sets `<key>` itself, so leave it out`` | A vendor kind names a key it sets. |
| `` `<key>` does not apply to a `<kind>` target `` | A key belongs to another kind. |
| `` a `cloudwatch_logs` target needs `log_group` and `log_stream` `` | A CloudWatch Logs target names no group or stream. |
| ``a `cloudwatch_traces` target names `log_group` and `log_stream` together, or neither`` | A CloudWatch traces target names one of the two without the other. |
| `` needs `region`, an AWS region such as `us-west-2` `` | A CloudWatch target names no region, or an invalid one. |
| `` `secret.ref` names no scheme this box reads `` | The reference is a literal value, or its scheme is not `env://`, `secret://`, `aws://`, `credsd://`, or a [declared scheme](/docs/user-guide/box/reference/configuration/index.md#secret-sourcescheme). A declared scheme with nothing after `://` is refused in the same way. |
| `its destination is neither https nor loopback` | A credential would cross the network in the clear. |
| ``the `aws://` credential cannot sign`` | The profile is missing, or holds no static keys. The run stops before the workload starts. |
| `` `[telemetry.<name>] secret.ref` names a secret that the secret source `<scheme>` (<program>) did not return `` | The program of a declared secret source returned no secret for this target. The line before it on stderr holds the reason. No record holds this failure, because Box reads the secret before it opens its records. See [how a run reads the secrets](/docs/user-guide/box/reference/configuration/index.md#how-a-run-reads-the-secrets). |

Each message names the table it came from.

A target that fails while the box runs loses the record, and Box does not retry. When the run ends, Box prints one line on stderr if an export to a configured target failed, or if the final export did not finish in time:

```text
strands-box: warning: telemetry records were lost: 2 exports to the configured targets failed
```

The count is exports, not records: one export can carry many records. The run’s exit code does not change. The line does not cover everything that can be lost: a record that the telemetry queue refuses when it is full, an agent payload that Box refuses, a batch that a slow target does not accept before its export deadline while the box runs, and a relayed payload still in flight at shutdown are not counted. So the absence of this line does not prove that nothing was lost.

Set `STRANDS_BOX_TELEMETRY_DEBUG` to also print each failed export as it happens, with its cause. See [Failed sends](#failed-sends).

## See also

-   [Getting started](/docs/user-guide/box/core/quickstart/index.md): install Box, then run Claude Code or Codex in a box.
-   [How telemetry works](https://github.com/strands-agents/box/blob/a2a97eede44b01f536faa4ada8c3085f97634681/docs/design/telemetry.md): which process records, what a workload cannot forge, and where a record can be lost.