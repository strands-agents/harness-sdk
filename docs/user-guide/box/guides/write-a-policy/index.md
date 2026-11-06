A policy is a `policy.dw` file of `permit` and `forbid` rules. The box reads it when it starts, and asks it about each command, file operation, network request, and MCP call that goes through the box. By the end of this page you have a policy that permits the project and the model, one `forbid` on a file, and a decision log you can read with `jq`.

Audience: an operator who has run [getting started](../../quickstart/index.md) and wants to write a policy by hand. [Policy](../../reference/policy/index.md) names each part of a rule and the ten actions, and [the action vocabulary](../../reference/policy-actions/index.md) lists every field a rule can read.

> **Status.** The action vocabulary and the context fields can change before 1.0.0. Pin the Box build you install (`./box-core/box --version`), and read [troubleshooting load failures](../../reference/policy/index.md#troubleshooting-load-failures) after an upgrade.

## Before you start

-   The box from [getting started](../../quickstart/index.md): `my-box/box.toml` and `my-box/policy.dw` under `~/box-tutorial`, with your Bedrock key in `AWS_BEARER_TOKEN_BEDROCK`. Run every command in this guide from `~/box-tutorial`.
-   `jq`, for the decision log.
-   A harmless sample file to deny: from your own terminal, `printf 'SECRET=placeholder\n' > ~/box-tutorial/my-project/.env`.
-   The agent’s shell tool, which the getting-started box turns on with `"shell":true` in `builtinTools`. Every exercise below runs a command through it.

## Step 1. Write the policy

The `policy` key in `my-box/box.toml` names `my-box/policy.dw`. Replace the content of that file with this policy. It keeps the rules from getting started, widens `project_write` to the project directory itself, and denies one file.

```text
// The model. One request to Bedrock is two decisions: the connection, then the request.
@id("model_connect")
permit (principal, action == Box::Action::"net:connect", resource)
when { context.input.host == "bedrock-runtime.us-west-2.amazonaws.com" && context.input.port == 443 };

@id("model_request")
permit (principal, action == Box::Action::"http:request", resource)
when { context.input.host == "bedrock-runtime.us-west-2.amazonaws.com" };

// Commands the box's own shell implements.
@id("shell_commands")
permit (principal, action == Box::Action::"shell:exec", resource);

// The project: the directory itself, and everything below it.
@id("project_read")
permit (principal, action == Box::Action::"fs:read", resource)
when {
  context.input.path == "~/box-tutorial/my-project" ||
  context.input.path like "~/box-tutorial/my-project/*"
};

@id("project_write")
permit (principal, action == Box::Action::"fs:write", resource)
when {
  context.input.path == "~/box-tutorial/my-project" ||
  context.input.path like "~/box-tutorial/my-project/*"
};

// /dev/null, which agents redirect output to.
@id("dev_null")
permit (principal, action in [Box::Action::"fs:read", Box::Action::"fs:write"], resource)
when { context.input.path == "/dev/null" };

// One file inside the project stays unread, whatever the permit above says.
@id("no_env")
@description("The .env file holds credentials the agent must not read.")
forbid (principal, action == Box::Action::"fs:read", resource)
when { context.input.path == "~/box-tutorial/my-project/.env" };
```

What the rules do, beyond what their comments say:

-   **`model_connect` and `model_request`.** The connection is `net:connect` with the host and port. The request is `http:request` with the host. Both need a permit.
-   **`shell_commands`.** The agent’s commands run in the box’s own shell. This rule covers the commands that shell implements, such as `cat`, `grep`, and `ls`. A program of the surrounding OS, such as `git`, runs only under a `shell:spawn` permit; [commit only after the tests passed](../../reference/policy/index.md#commit-only-after-the-tests-passed) shows one.
-   **`project_read` and `project_write`.** Write a path under your home as `~/...`. A directory takes two clauses: `==` matches the directory itself, and `like ".../*"` matches everything below it. `fs:read` and `fs:write` are separate actions, so each has its own rule.

## Step 2. Run the box

```sh
./box-core/box run --config my-box/box.toml
```

The box validates the policy before it starts. When the policy loads, the box prints `strands-box: starting workload` and the paths the agent reaches, as in getting started. A policy that cannot load stops the run, with the file and the reason on stderr. For example, when the file holds only this rule, which names the action `fs:raed`:

```text
permit (principal, action == Box::Action::"fs:raed", resource);
```

the box prints:

```text
strands-box: error: policy file /Users/you/box-tutorial/my-box/policy.dw will not load: policy references unknown action: for policy `policy_0`, unrecognized action `Box::Action::"fs:raed"` at line 1, column 30 (did you mean `Box::Action::"fs:read"`?); for policy `policy_0`, unable to find an applicable action given the policy scope constraints
```

[Troubleshooting load failures](../../reference/policy/index.md#troubleshooting-load-failures) lists each refusal.

## Step 3. Read a denial

Ask the agent to run `cat .env` with its shell tool. The command runs in Strands Shell, the box’s own shell, which asks policy before the read. `cat` exits `1` with this line on stderr:

```text
strands-shell: cat: policy denied this operation on '~/box-tutorial/my-project/.env' [policy: no_env]: The .env file holds credentials the agent must not read.
```

The line names the file as the rule spells it, the rule by its `@id`, and the `@description`. The agent reads the same text, so write the description for the agent. Then ask the agent to run `cat README.md` the same way, so the decision log holds one permit beside the denial.

Policy decides the reads that go through the agent’s shell tool. The agent’s own process reaches only the paths in `[agent.filesystem]`, and the getting-started box puts the project there under `list` only. Keep it that way: a `read` grant over the project would let a native file tool open `.env` with no decision and no record. [The two tiers](../../security/index.md#the-two-tiers) says which file governs what.

Ask the agent to run `git status`. `git` is a program of the surrounding OS, and only a `shell:spawn` permit admits one, so the shell refuses the command with status `126`:

```text
strands-shell: effect denied: policy denied this operation on '/usr/bin/git' [default-deny]: No permit policy matched this request.
```

`[default-deny]` means no `permit` matched. The path is the binary the command resolved to. [How a denial reads](../../reference/policy/index.md#how-a-denial-reads) lists every shape and how each caller shows it.

## Step 4. Read the decision log

The decision log is `my-box/state/private/telemetry/records.jsonl`.

The log is diagnostic. Records arrive in batches, a moment after the decision, and a failed batch is lost, so a decision can be missing from the log. A rule that counts past decisions, written with `when temporal`, reads the box’s own history, which is a separate store.

Each line is one OpenTelemetry batch. The decisions are the records in scope `strands-box.policy`. This command prints the verdict, action, resource, and rule of each one:

```sh
jq -r '
  .resourceLogs[]?.scopeLogs[]
  | select(.scope.name == "strands-box.policy")
  | .logRecords[]
  | [.attributes[] | select(.key | startswith("strands.box.policy."))
     | {(.key | ltrimstr("strands.box.policy.")): .value.stringValue}]
  | add
  | "\(.verdict)\t\(.action)\t\(.resource)\t\(.rule)"
' my-box/state/private/telemetry/records.jsonl
```

Among the lines the command prints, the two reads from step 3:

```text
deny  fs:read  ~/box-tutorial/my-project/.env  no_env
permit  fs:read  ~/box-tutorial/my-project/README.md  project_read
```

These two sit among the model decisions, the `shell:exec` permits for the commands, and the `shell:spawn` denial for `git`.

The record of the denied read, with only its policy attributes:

```json
{
  "eventName": "strands.box.policy.decision",
  "severityText": "deny",
  "attributes": [
    {"key": "strands.box.policy.action",      "value": {"stringValue": "fs:read"}},
    {"key": "strands.box.policy.resource",    "value": {"stringValue": "~/box-tutorial/my-project/.env"}},
    {"key": "strands.box.policy.verdict",     "value": {"stringValue": "deny"}},
    {"key": "strands.box.policy.cause",       "value": {"stringValue": "forbidden"}},
    {"key": "strands.box.policy.reason",      "value": {"stringValue": "policy denied this operation on '~/box-tutorial/my-project/.env' [policy: no_env]: The .env file holds credentials the agent must not read."}},
    {"key": "strands.box.policy.rule",        "value": {"stringValue": "no_env"}},
    {"key": "strands.box.policy.category",    "value": {"stringValue": "fs"}},
    {"key": "strands.box.policy.description", "value": {"stringValue": "The .env file holds credentials the agent must not read."}},
    {"key": "file.path",                      "value": {"stringValue": "~/box-tutorial/my-project/.env"}}
  ]
}
```

| Attribute | Value |
| --- | --- |
| `strands.box.policy.action` | The action, as `fs:read`. |
| `strands.box.policy.resource` | The path, program, `host:port`, or `server/tool` the rule saw. |
| `strands.box.policy.verdict` | `permit` or `deny`. |
| `strands.box.policy.cause` | `permitted`, `forbidden`, or `no_match` for the decisions in this guide. [What Box always enforces](../../security/index.md#what-box-always-enforces) covers `enforcement`. |
| `strands.box.policy.rule` | The `@id` of the governing rule; `<default-deny>` when no permit matched, which the denial text spells `[default-deny]`; or `enforcement:<gate>` when Box decided on its own. |
| `strands.box.policy.description` | The governing rule’s `@description`. |
| `strands.box.policy.reason` | The denial text the agent saw. |
| `file.path` | The path again, under its OpenTelemetry name. |

The record holds the action and the path, so a `cat` and an `ls` of the same path write the same record. The verb each one used is `context.input.operation`, which [the action vocabulary](../../reference/policy-actions/index.md#filesystem) lists.

## Step 5. Change a rule

Edit `policy.dw` and run the box again. A running box keeps the policy it loaded until it ends.

A policy edit keeps the recorded history. An unchanged `when temporal` clause keeps its count across the edit and across a restart. [Policy limitations](../../security/index.md#policy-limitations) says what resets it.

## What you have

A policy that permits the project and the model, one `forbid` the agent saw as a denial, and a log line for each decision. [Common rules](../../reference/policy/index.md#common-rules) has six complete rules to add next, starting with a budget and a rate limit.

## See also

-   [Policy](../../reference/policy/index.md): what a policy is, six common rules, and troubleshooting load failures.
-   [The action vocabulary](../../reference/policy-actions/index.md): every action, its fields, and which part of the box raises it.
-   [Security](../../security/index.md): what `box.toml` governs, what `policy.dw` governs, and what a policy cannot do today.