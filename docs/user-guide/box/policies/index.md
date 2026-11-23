A policy is the set of rules the box checks before the agent runs a command, reaches a host, or calls an MCP tool. Your [packs](/docs/user-guide/box/how-box-works/index.md#packs) and your profile settings write many of those rules for you, so to change what the agent can do, it helps to know where each rule comes from.

This page explains what a policy checks, where a run’s rules come from, what’s in a profile’s `policy.dw`, and which rules your packs and settings write. Then it shows how to write rules of your own and switch a profile to another policy. The [policy reference](/docs/user-guide/box/reference/policies/index.md) lists each rule that `box` writes.

## What a policy is

A policy is a list of rules, each of which permits or forbids one kind of action. The box checks these actions against it:

-   Each command the box’s shell runs, and each file that command reads or changes.
-   Each connection to a host, and each HTTP request on it, from anything in the box, the agent included. The one exception is a tool you let [connect directly](/docs/user-guide/box/reference/profiles/index.md#let-a-tool-connect-directly).
-   Each call to an MCP tool.

The box refuses anything no rule permits, and a `forbid` always wins over a `permit`, so you can block something a pack allows. The rules are written in [Dogwood](/docs/user-guide/box/how-box-works/index.md#policy).

> \[!WARNING\] A file rule decides only the files that the box’s shell and Python touch. The agent’s own file tools, such as Claude Code’s Read and Edit, the tools the box starts, such as `git` and `node`, and local MCP servers open files directly. Only the profile’s [filesystem lists](/docs/user-guide/box/profiles/index.md#files-and-folders) limit them, and the sandbox enforces those ([The box](/docs/user-guide/box/how-box-works/index.md#the-box)). So a rule that forbids reading `.env` stops `cat .env`, but not the agent’s Read tool or `git diff`, and a rule that forbids deletes stops `rm`, but not `git rm`. [Where file rules apply](/docs/user-guide/box/file-rules/index.md) shows what to write instead, and how this changes with native filesystem policy.

## Where a run’s policy comes from

Each run’s policy comes from three places:

1.  **Your rule files.** These are the files in the profile’s `policies` list, in the profile’s folder. A new profile’s list holds `policy.dw`, which `box profile create` copied from the policy you picked ([Pick the agent’s policy](/docs/user-guide/box/starters/index.md#pick-the-agents-policy)). It’s your file from then on, and neither a later change to that policy nor a later Box release changes it. [Switching to another policy](#switch-a-profile-to-another-policy) lists a new `policy-<n>.dw` in its place.
2.  **Rules that `box` writes from your packs and profile.** Configuration creates policy. A [route](/docs/user-guide/box/profiles/index.md#hosts-and-credentials) that names a host, a [toolchain](/docs/user-guide/box/profiles/index.md#toolchains), an MCP server, and the project access each come with the rules they need, written again on every run ([Rules from packs and profiles](#rules-from-packs-and-profiles)).
3.  **Box Core’s own checks.** Box Core runs the box. Whatever your rules permit, no request reaches the box’s own folder or the configuration and policy the run loaded.

So even when `policy.dw` names no host, the agent reaches its model and its toolchains’ package hosts: the agent’s packs and its tool packs ask for them.

## What’s in `policy.dw`

A profile’s `policy.dw` starts as a copy of the policy starter you picked, with a comment at the top that names it. Most start like this:

```text
// Let the box's shell run each command the agent gives it. Each file a command touches is still
// its own decision.
@id("shell_commands")
permit (principal, action == Box::Action::"shell:exec", resource);

// Let programs read and write /dev/null, which they redirect output to all the time.
@id("dev_null")
permit (principal, action in [Box::Action::"fs:read", Box::Action::"fs:write"], resource)
when { context.input.path == "/dev/null" };
```

Each rule there has an `@id`, its name, which the run history shows when the rule decides a request. The rest of the file depends on the starter, and the comments in it say what each rule does. To start new profiles from rules of your own, write a policy starter ([Policy starters](/docs/user-guide/box/starters/index.md#policy-starters)).

## Rules from packs and profiles

Here’s a route in `profile.toml`, and the two rules `box` writes for it at each run:

```toml
[egress.docs]
destinations = ["docs.rs"]       # reach one host, with no credential
```

```text
@id("route_docs_connect") permit (principal, action == Box::Action::"net:connect", resource) when { (context.input.host == "docs.rs" && context.input.port == 443) };
@id("route_docs_request") permit (principal, action == Box::Action::"http:request", resource) when { context.input.host == "docs.rs" };
```

A route in a pack works the same way. That’s how `@box/anthropic` lets the agent reach `api.anthropic.com`. A tool, an MCP server, `[project] access`, `[storage]`, `[filesystem] deny`, and `deny_write` also write the rules they need, in a pack or the profile, and `box` always forbids changes to `~/.strands/box` outside the run’s storage directories and its tools’ storage, to `~/.local/bin`, and to the profile’s own files. [Generated policy](/docs/user-guide/box/reference/policies/index.md#generated-policy) lists each rule, what it allows or forbids, and the setting that writes it.

The box’s shell runs two kinds of command, and each has its own rule. A program on your machine that a tool declares, such as `git`, starts through the `spawn_<tool>` rule that `box` writes. The commands the shell has built in, such as `cd`, `echo`, and `cat`, run through the `shell_commands` rule in your `policy.dw`, so keep that rule, or narrow it to the commands you want.

To find which setting lets the agent reach a host, look at the `RULE` column of [`box runs history`](/docs/user-guide/box/reference/cli/index.md#box-runs-history) for a request to it. `route_anthropic_request` comes from the route `[egress.anthropic]`, and `package_hosts_request` from the `hosts` of a tool pack.

## Filesystem grants and policy

The agent’s own file tools and its shell are checked in different places: the sandbox checks the file tools against the profile’s filesystem grants, and the policy checks the shell and Python. So a folder the agent uses through both needs a grant and a rule. Some settings write both for you, and some write only the grant:

```toml
[project]
access = "write"     # grant: the agent's tools read and change the project
                     # rules: project_read, project_write, project_delete, project_move for the shell

[storage]
directories = ["notes"]       # grant: read and write for the agent's tools
                              # rules: storage_0_read, storage_0_write, ... for the shell

[agent.filesystem]
read = ["~/src/shared-lib"]   # grant only: the shell reads it once a rule of yours permits it

[filesystem]
deny_write = ["${{ workspace }}/.venv"]   # grant: read-only for every process that can write it
                                          # rules: deny_write_write_0, ... forbid the shell to change it
deny = ["${{ workspace }}/secrets"]       # grant: no process reaches it
                                          # rules: filesystem_deny_read_0, ... forbid the shell to touch it
```

For a folder in `read` or `write`, add the rule yourself, as [Give the agent another directory](/docs/user-guide/box/profiles/index.md#give-the-agent-another-directory) shows. A `deny_write` folder needs a `write` entry that holds it, such as the project, or `box` drops it with its rules.

## Write custom rules

To add a rule, put it in a file of its own beside `profile.toml`, and add the file to the `policies` list near the top of `profile.toml`. That keeps your change apart from the copied `policy.dw`:

```toml
policies = ["policy.dw", "no-dynamodb.dw"]   # every file in the list applies, so keep policy.dw
```

Give each rule an `@id` that no other rule has, in your files or among the ones `box` writes. In a rule, a path in your home directory starts with `~/`, such as `~/src/shared-lib`.

### Keep write rules narrow

`box` keeps the agent away from the files a later run or your own programs trust, but it does that by checking filesystem grants, not your rules. It refuses a profile or pack whose `write` entry reaches `~/.strands/box`, `~/.local/bin`, the folders `box` and its packs are installed in, or a program the box runs. The rules it writes forbid the shell to change `~/.strands/box`, `~/.local/bin`, the profile’s files, and each `deny_write` folder, but nothing else in your home. `box` doesn’t read the rules you write, so a broad write rule opens the rest, and the run starts with no warning:

policy-home.dw

```text
@id("home_write")
permit (principal, action == Box::Action::"fs:write", resource)
when { context.input.path like "~/*" };
```

With this rule, the box’s shell can change another folder on your `PATH`, such as `~/bin`, or an agent’s settings in your home, such as `~/.claude.json`, and a program you run later outside the box then runs what it wrote. Permit the folders the agent needs by name instead, as [Give the agent another directory](/docs/user-guide/box/profiles/index.md#give-the-agent-another-directory) shows. If a rule must stay broad, add a `forbid` for each place it must not reach, because a `forbid` wins over every `permit`:

```text
@id("no_home_bin")
forbid (principal, action in [Box::Action::"fs:write", Box::Action::"fs:delete", Box::Action::"fs:move"], resource)
when { context.input.path like "~/bin/*" };
```

### Block a host

Say you want the agent to stay away from DynamoDB, whichever policy you picked. Create `no-dynamodb.dw`:

```text
@id("no_dynamodb")
forbid (principal, action == Box::Action::"net:connect", resource)
when { context.input.host like "*dynamodb*" || context.input.host like "*ddb.*" };
```

The rule matches any host with `dynamodb` or `ddb.` in its name, and `*` matches any text, dots included. Forbidding the connection is enough, because each HTTP request needs one first. And because a `forbid` wins, it blocks the host even when a pack or a route allows it, so a tool or an MCP server that needs a matching host then fails. The rule limits the box, not your credentials: to be sure a role never touches DynamoDB anywhere, narrow the role too.

### Allow a host

There are two ways to let the agent reach one more host: a route in `profile.toml` or a pack, or two rules in a rule file. Use a route. `box` writes both rules for it (`route_<name>_connect` and `route_<name>_request`), `box profile show` lists it, and a route can carry a credential that the agent sees only as a placeholder ([Credentials](/docs/user-guide/box/how-box-works/index.md#credentials)). A pack’s route also travels with the pack to every profile that uses it. [Let the agent reach another host](/docs/user-guide/box/profiles/index.md#let-the-agent-reach-another-host) shows a route, and [Routes and other hosts](/docs/user-guide/box/reference/profiles/index.md#routes-and-other-hosts) has its keys.

Write the rules yourself when the host needs a condition that a route can’t state, such as only `GET` requests, or one URL path on a host with no credential. A policy starter holds only rules, so it also allows a host this way. The two rules look like this:

```text
@id("docs_connect")
permit (principal, action == Box::Action::"net:connect", resource)
when { context.input.host == "docs.example.com" && context.input.port == 443 };

@id("docs_request")
permit (principal, action == Box::Action::"http:request", resource)
when { context.input.host == "docs.example.com" && context.input.method == "GET" };
```

The first opens the connection and the second allows each request on it, so a host needs both.

### Learn more about the language

Box Core’s [policy guide](/docs/user-guide/box/reference/policy/index.md) covers every action and field a rule can check, and rules that depend on what happened earlier in the run, such as at most 60 calls to a server in an hour. To have a coding agent outside the box write the rules for you, use [`box help agent`](/docs/user-guide/box/reference/cli/index.md#box-help-agent).

## Switch a profile to another policy

Run `box profile edit claude` and pick the policy. Enter keeps the current one. A new pick doesn’t touch `policy.dw`: `box` copies the new policy into the next free name, such as `policy-1.dw`, and makes that file the whole `policies` list. So add back any rule file of your own that you still want. The new policy’s project access applies only when the profile has no `[project]` table, so check `access` too.

`box profile edit` needs a terminal. Without one, copy the policy’s `policy.dw`, such as `~/.strands/box/packages/current/resources/policies/scoped/policy.dw`, into the profile’s folder under a new name, and list it in `policies` in place of `policy.dw`.

## Commands for policies

| To | Run |
| --- | --- |
| Check your rules, and see the whole policy a run gets | [`box profile show claude --full`](/docs/user-guide/box/reference/cli/index.md#box-profile-show) |
| See which rule decided each request | [`box runs history b-5b8e3d70c92f14ab`](/docs/user-guide/box/reference/cli/index.md#box-runs-history) |
| Have a coding agent write rules for you | [`box help agent`](/docs/user-guide/box/reference/cli/index.md#box-help-agent) |
| Start a profile from a different policy | [`box profile edit claude`](/docs/user-guide/box/reference/cli/index.md#box-profile-edit) |

`box profile show` checks the whole policy as `box run` does, so a broken rule or a clashing `@id` fails there, before a box starts. [A profile has a mistake](/docs/user-guide/box/troubleshooting/index.md#a-profile-has-a-mistake) explains the message. With `--full`, it prints the run’s policy: your rule files, then the rules `box` writes.

In the run history, the `RULE` column holds the `@id` of the rule that decided each request, and `<default-deny>` when no rule permitted it.