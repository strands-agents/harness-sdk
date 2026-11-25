A profile is one agent persona. It decides how the box is set up: which agent runs, which model provider it talks to, which toolchains it can use, which files and hosts it can reach, and which policy it runs under. You pick one each time you start a box, such as `box run claude`.

This page explains what a profile is, where it’s defined, and what’s in its file, then shows how to change it. Every key a profile can hold is in the [profile reference](/docs/user-guide/box/reference/profiles/index.md).

## What a profile is

A profile names packs, such as `@box/claude` and `@box/bedrock`, and the packs know how to run Claude Code or reach Bedrock. The profile holds only your choices: the packs, your values for their options, and anything you add or take away. So it stays short.

Each persona gets its own profile, such as one for everyday coding and a stricter one for looking at a production account. The agent’s storage, where it keeps its settings, sessions, and memory, belongs to the profile, and two profiles never see each other’s. Every project you run a profile in shares its storage ([Profile storage and runs](/docs/user-guide/box/reference/files/index.md#profile-storage-and-runs)).

## Where profiles are defined

There are two places a profile can be defined:

1.  **In your Box folder**, for a profile you use in every project. It’s a folder in `~/.strands/box/profiles/<name>/`, and you run it by name: `box run claude`.
2.  **In a project**, for a profile that belongs to that project and lives beside it in source control, so everyone who works on the project runs the same setup. You run it by its path, such as `box run ../box/profile.toml`, and the file names itself in a `[profile]` table.

A project’s profile file has to be somewhere the agent can’t change it, such as outside the project you run in or in the project’s `.box` folder. [Run a profile file](/docs/user-guide/box/reference/cli/index.md#run-a-profile-file) says where `box` allows it.

## What’s in a profile

A profile in `~/.strands/box/profiles/claude/` holds two files:

-   `profile.toml`, the profile itself.
-   `policy.dw`, the profile’s rules: a copy of the policy you picked when you made it, yours to edit. You can add more rule files beside it ([Write custom rules](#write-custom-rules)).

This is a `profile.toml` for Claude Code on Amazon Bedrock with git, with a note added on each line. The file that `box profile create` writes also starts with a few comment lines of its own:

```toml
packs = ["@box/claude", "@box/bedrock", "@box/git"]  # the agent, its model provider, and its tools
policies = ["policy.dw"]                          # the profile's rule files, beside this one

# How much of your project the agent reaches: "none", "read", "write".
[project]
access = "write"

[options]
claude.host = "bedrock"        # the provider Claude Code talks to
bedrock.region = "us-east-1"   # the Bedrock region
claude.import-mcp = "false"    # leave Claude Code's MCP servers out of the box
claude.import-hooks = "false"  # leave Claude Code's hooks out of the box
```

`packs` and `policies` come first, above every `[table]`. Each table you add, such as `[tool.git]` or `[egress.docs]`, merges over what the packs say, so you write only the part you change. An edit takes effect on the next run. A project’s profile file looks the same, with a `[profile]` table that holds its `name`.

The sections below each show one part of the file.

## The agent and its provider

The agent and its model provider are packs in `packs`, and their settings go in `[options]`, by the name that `box profile show` prints:

```toml
packs = ["@box/claude", "@box/bedrock", "@box/git"]  # one agent pack and one provider pack

[options]
claude.host = "bedrock"         # the provider the agent pack talks to; match it to the provider pack
bedrock.region = "eu-west-1"    # the provider's setting
agent.skip-permissions = true   # the agent never asks before it acts
```

A run always uses what the profile says: there’s no way to change an option for one run. `box` checks each value when a run starts, so a value the pack doesn’t allow stops the run before the box starts.

### Switch to another provider

For an agent that reaches its model through a provider pack, change the provider pack in `packs`, such as `@box/bedrock` to `@box/anthropic`, and set the agent pack’s provider option to match, such as `claude.host = "anthropic"`. Keep one agent pack and one provider pack in the list. Then export the provider’s key in the shell where you run `box run`. `box profile show --full` names the variable in the provider’s route. Some agents, such as Kiro CLI, sign in on their own and use no provider pack.

### Turn off the agent’s permission prompts

An agent pack can offer `agent.skip-permissions`. Set to `true`, it has the agent never ask before it acts. A profile whose agent pack doesn’t offer it stops with `sets an input that no pack declares`. The agent’s own prompt is then no longer an extra check, but the box’s checks stay in force: the sandbox still limits the agent to the files and programs it was granted, and the policy still decides each shell command, network request, and MCP call. Read [Before turning permission prompts off](/docs/user-guide/box/limitations/index.md#before-turning-permission-prompts-off) first. The agent’s README says what the option changes, and when the agent still asks.

## Toolchains

Each toolchain is a tool pack in `packs`, and a table named after the pack changes what it gets:

```toml
packs = ["@box/claude", "@box/bedrock", "@box/git", "@box/cargo"]  # add or delete a tool pack

[tool.git.env]
GIT_AUTHOR_NAME = "Your Name"   # a variable for git only

[tool.git.filesystem]
read = ["${{ tool.git.root.parent }}/share/doc/git"]   # a folder next to where git is installed
```

### Add or remove a toolchain

Add its pack to `packs`, or delete it. `@box/npm` brings `@box/node` with it, because node runs npm. At each run, `box` finds the program on your `PATH` and gives the box what it needs, including its public package hosts, such as `index.crates.io` for `cargo`, so a private registry is out of reach. A run leaves out a toolchain your machine doesn’t have, and says why:

```text
box: skipped tool cargo (@box/cargo): cargo is not on PATH
```

Be choosy. A toolchain runs code from your project (git hooks, `build.rs`, npm scripts) that the agent can write, so whatever a toolchain can reach, the agent can too. [Packs](https://github.com/strands-agents/box/blob/28071d0dad40cbd428ffb920adbb1a4920c252b4/docs/cli/README.md#packs) lists the tool packs that Box ships.

### Change a toolchain’s settings

Add to its table: `@box/git` is `[tool.git]`, and your table merges onto the pack’s. `${{ tool.git.root.parent }}` is the folder that your git is installed in, so a grant follows git when it moves. The [reference](/docs/user-guide/box/reference/profiles/index.md#a-tool-table-in-the-full-form) lists every key a tool table takes.

## Hosts and credentials

A route, `[egress.<name>]`, lets the box reach a host and can carry a credential for it:

```toml
[egress.docs]
destinations = ["docs.rs"]      # reach one more host, with no credential

[egress.github-api]
destinations = ["api.github.com"]
secret.ref = "env://GH_TOKEN"   # the variable that holds your token, outside the box
secret.prefix = "token "        # sent as `Authorization: token <token>`; leave out for Bearer

[agent.env]
MY_TOOL_LOG = { from = "env:MY_TOOL_LOG" }  # pass one shell variable to the agent
```

The agent never gets your shell’s environment, and it never sees a route’s credential: inside the box, `GH_TOKEN` holds a placeholder, and the box puts the real token in its place as a request leaves. Don’t pass a key with `from`, because the agent can read it. Give it to a route instead.

### Let the agent reach another host

Which hosts the agent reaches before you add one depends on the policy the profile started from ([Pick the agent’s policy](/docs/user-guide/box/starters/index.md#pick-the-agents-policy)). A route that lists only a host, such as `[egress.docs]` above, lets every program in the box reach it on port 443. `box profile show` lists the route:

```text
  ! route docs: docs.rs (no credential, open to every program in the box)
```

### Give the agent a token for another service

A route with a `secret`, such as `[egress.github-api]` above, also lets the requests out, so you need no policy rule and nothing in `[agent.env]`. Export `GH_TOKEN` before `box run`. The token works for every program in the box that sends the placeholder, such as `gh` or `curl -H "Authorization: token $GH_TOKEN"`.

### Push to GitHub with git

git sends a token as the password of a user name and password pair, and only after `github.com` asks for one, so this route adds the token to every request to `github.com`:

```toml
[egress.github]
destinations = ["github.com"]
secret.ref = "env://GIT_GITHUB"
secret.placement = "basic_auth"   # sent as `Authorization: Basic` of the user name and password
secret.inject = "always"          # on every request, so git needs no credential set up in the box
```

Before `box run`, export the pair. The user name is `x-access-token`, and the password is a GitHub token you create, such as a fine-grained personal access token for the repositories the agent works on:

```sh
export GIT_GITHUB="x-access-token:$GH_TOKEN"
```

Then `git push` and `git pull` work in the box, over HTTPS and for a `git@github.com:` remote too. Every program in the box can do whatever the token can at `github.com`, so give the token access to only the repositories the agent works on.

### Read a token from your vault

If the token lives in a password manager, the box can read it for you when it starts, so there’s nothing to export. A plugin does the reading: it runs your vault’s own command-line program on your machine, outside the box, with your sign-in. [Use a plugin](/docs/user-guide/box/plugins/index.md#use-a-plugin) shows how to list one and name the item on a route, and [Plugins](https://github.com/strands-agents/box/blob/28071d0dad40cbd428ffb920adbb1a4920c252b4/docs/cli/README.md#plugins) lists the ones that `box` ships. You sign in to your vault before `box run`, and the plugin’s README says how.

## Files and folders

The agent reaches your project, which is the folder you start `box` from, and the profile’s storage. `[project]` sets how much of the project, and `[agent.filesystem]` adds other folders:

```toml
policies = ["policy.dw", "shared-lib.dw"]   # a rule file for the agent's shell commands

[project]
access = "read"                  # "write", "read", or "none"

[agent.filesystem]
read = ["~/src/shared-lib"]      # read another folder
write = ["~/src/shared-lib"]     # and change it
```

### Give the agent read-only access to the project

Set `access` to `"read"`. The agent, its toolchains, and its MCP servers can then read every file in your project and change none. Each run says so when it starts. A toolchain that writes into your project then fails, such as `cargo build` writing `target`. The `locked` policy starts a profile this way, and `"write"` gives the access back.

### Give the agent another directory

The agent’s own file tools follow `[agent.filesystem]`, and its shell commands follow the policy, so a folder outside the project needs both. Add the folder to `read`, and to `write` if the agent should change it, as above. Then create `shared-lib.dw` beside `profile.toml`, list it in `policies`, and leave out the `write` rule for read-only access:

```text
@id("shared_lib_read")
permit (principal, action == Box::Action::"fs:read", resource)
when { context.input.path == "~/src/shared-lib" || context.input.path like "~/src/shared-lib/*" };

@id("shared_lib_write")
permit (principal, action == Box::Action::"fs:write", resource)
when { context.input.path == "~/src/shared-lib" || context.input.path like "~/src/shared-lib/*" };
```

In both, `~` means your home directory. Toolchains still see only your project: if `cargo` or `npm` must read the other folder, run `box` from a folder that holds both projects instead, and the agent can then change everything in it. `box` won’t let the agent write `~/.strands/box` or any folder above it, such as your home directory.

### Protect a folder the agent runs from

When the agent runs a program from your project, such as a Python `.venv`, the agent could replace that program, because it can write the project, so `box` refuses the run. List the folder once in `[filesystem] deny_write`, and no process in the box can change it:

```toml
[agent]
command = ["${{ workspace }}/.venv/bin/python", "-m", "app"]

[agent.filesystem]
exec = ["${{ workspace }}/.venv"]

[filesystem]
deny_write = [{ path = "${{ workspace }}/.venv", optional = true }]
```

`box` adds the folder to the agent and to each tool and MCP server that can write it, such as git from `@box/git`. `optional = true` lets the profile run in a project with no such folder. Fill the folder before `box run`, with copies rather than links to a shared cache (for uv, `UV_LINK_MODE=copy`), because a file with a link in a writable folder can be changed through that link.

### Keep a folder away from every process

List the folder in `[filesystem] deny`, and nothing in the box can read, list, or change it, even when a pack grants it. A `forbid` rule in your policy can’t do this, because it decides only the box’s shell and Python ([Where file rules apply](/docs/user-guide/box/file-rules/index.md)):

```toml
[filesystem]
deny = ["${{ workspace }}/secrets"]
```

When the shell refuses a path there, its message names the list:

```text
strands-shell: cat: policy denied this operation on '~/src/my-app/secrets/key' [policy: filesystem_deny_read_0]: The profile's [filesystem] deny keeps this path out of the box.
```

To give one process the folder, leave it out of `[filesystem]` and put `deny` on the other processes’ own tables. On Linux the folder must exist, so add `optional = true` for a profile you run in many projects. On macOS, a process with `file-watching = true` can still see the names of files there ([File watching on macOS](/docs/user-guide/box/limitations/index.md#file-watching-on-macos)).

## MCP servers

When a profile brings in your MCP servers ([MCP servers in the box](/docs/user-guide/box/limitations/index.md#mcp-servers-in-the-box)), a local server gets its own install files, your project, and its launcher’s package registry, and a remote server gets its own host and, if its settings take one, its key. To give one more, add to its table, under the server’s name in your agent’s settings:

```toml
[mcp.fetch.filesystem]
read = ["${{ home }}/notes"]            # a local server reads one more folder

[mcp.docs]
destinations = ["cdn.example.com"]      # a remote server reaches one more host
```

The agent picks the arguments of each call, and they can name anything the server can reach, so give a server only what its calls need. [`[mcp.<name>]` in a profile](/docs/user-guide/box/reference/profiles/index.md#mcpname-in-a-profile) is the reference.

## Write custom rules

Your own rules go in a file beside `profile.toml`, which you list in `policies`:

```toml
policies = ["policy.dw", "no-dynamodb.dw"]   # every file in the list applies
```

The box refuses anything no rule allows, and your packs and profile settings already write the rules for what they declare. [Write custom rules](/docs/user-guide/box/policies/index.md#write-custom-rules) shows how to add a rule or block something a pack allows, and [Policies](/docs/user-guide/box/policies/index.md) explains where each of a run’s rules comes from.

## Commands for profiles

| To | Run |
| --- | --- |
| Make a profile by answering a few questions | [`box profile create`](/docs/user-guide/box/reference/cli/index.md#box-profile-create) |
| Check what a run will get, before you run it | [`box profile show`](/docs/user-guide/box/reference/cli/index.md#box-profile-show) |
| Start the agent in a box | [`box run`](/docs/user-guide/box/reference/cli/index.md#box-run) |
| Change the answers you gave when you made it | [`box profile edit`](/docs/user-guide/box/reference/cli/index.md#box-profile-edit) |
| Have a coding agent make or change one | [`box help agent`](/docs/user-guide/box/reference/cli/index.md#box-help-agent) |

### Make a profile for another agent or provider

Name the agent and its provider in `--with`, and give the profile a name that says what it is:

```sh
box profile create claude-work --with claude,bedrock --option bedrock.region=us-east-1
box profile create claude-api --with claude,anthropic --option claude.host=anthropic
box profile create claude-max --with claude,claude-subscription --option claude.host=anthropic
```

When it saves, **Before running** names the variable that holds the provider’s key. Export it in the shell where you run `box run`. [Starters](/docs/user-guide/box/starters/index.md) covers the questions.

### Check a profile

Run `box profile show` in your project, because some values depend on the folder you’re in. It starts no box, but it checks the profile and its whole policy the way a run does, so a profile a run would refuse fails here with the same error. A `warning` line names a rule of yours that the box accepts but that may not do what you meant. Before your first real run, add `--full` and read every folder the agent can read and write and every host it can reach.

### Get help from a coding agent

A coding agent on your host can make or change a profile for you. Tell it to run `box help agent`, then say what you want:

```text
Run box help agent and follow it to update profile claude. Let the agent read
~/src/shared-lib, read-only.
```

Less often, you may want to start a profile over (`box profile create --force`), start its agent fresh (`box profile reset`), or delete it (`box profile delete`). [`cli.md`](/docs/user-guide/box/reference/cli/index.md) covers each.