A pack holds what one program needs in a box: how to start it, the files and hosts it reaches, and the values a profile can set. A profile lists its packs, and `box` puts them together for each run.

This page explains what a pack is, where it’s defined, and what’s in its file, then shows how to write each kind. Every key a pack can hold is in the [pack reference](/docs/user-guide/box/reference/packs/index.md).

## What a pack is

A pack knows the details of one program, so a profile doesn’t have to. `@box/claude` knows how to start Claude Code and which files it reads, and `@box/bedrock` knows the host and the key for Amazon Bedrock. A profile only names them.

Every pack has a kind:

-   **An agent pack** runs the agent. A profile runs exactly one agent.
-   **A tool pack** runs one program that the agent calls from its shell, such as `git`.
-   **A support pack** adds a route and its credential, storage, or settings, for the agent or its tools. A model provider is a support pack.

`box` trusts every pack a profile uses as much as the profile itself, because a pack can change the agent’s command, its grants, and its [routes](/docs/user-guide/box/how-box-works/index.md#credentials). Read a pack before you use it.

## Where packs are defined

There are three places a pack can be defined:

1.  **In Box**, for the packs that ship with it. Each is named `@box/<name>`, such as `@box/claude`, and [the pack list](https://github.com/strands-agents/box/blob/7c4ea75ff509e54298e8a077f6c8e0dae1e8e216/docs/cli/README.md#packs) links each one’s README.
    
2.  **In your Box folder**, for a pack of your own. It’s a folder in `~/.strands/box/packs/`, and the folder’s name is the pack’s name, so `~/.strands/box/packs/team-agent/pack.toml` is the pack `team-agent`.
    
3.  **In a collection**, for packs that a team shares. A [collection](/docs/user-guide/box/reference/files/index.md#collections) is the team’s repository, cloned into a folder in `~/.strands/box/external/`. The folder’s name is the scope, and each pack in its `packs/` folder is named `@<scope>/<folder>`:
    
    ```text
    ~/.strands/box/external/acme/      # git clone https://github.com/acme/acme-box ~/.strands/box/external/acme
      packs/team-agent/pack.toml       # the pack @acme/team-agent
    ```
    

A profile names a pack of yours by its plain name, such as `team-agent`, and a collection’s pack by its full name, such as `@acme/team-agent`. A plain name never reaches a collection. `box profile create --with` takes a short name, such as `claude`, and uses your own pack of that name when you have one, else the one that ships with Box. For a collection’s pack, give the full name: `--with @acme/team-agent`.

## What’s in a pack

A pack is a folder with a `pack.toml` in it. The folder can hold other files beside it, such as a script the agent loads, and the pack names them with `${{ pack }}`. This pack runs a team’s own agent, from `~/.strands/box/packs/team-agent/pack.toml`:

```toml
[pack]
name = "team-agent"
version = 1              # raise it when the pack changes
kind = "agent"           # a profile that uses it names one model provider and no other agent
extend = ["@box/base"]   # the settings and tools that every shipped agent pack uses

[requires]
box = ">=0.1.0"          # the oldest box that reads this pack

[run]
command = [
    "${{ inputs.team.program }}",
    "--mode",
    "${{ inputs.team.mode }}",
    { slot = "agent-args" },     # where a profile's agent-args go
]

[inputs.team.program]
description = "The team's agent."
type = "program"
program = "team-agent"   # found on PATH, or a path that a profile sets in [options]

[inputs.team.mode]
description = "How the agent asks before it acts."
type = "string"
values = ["ask", "auto"] # required, because the value reaches command
default = "ask"

[storage]
directories = ["config", "tmp"]   # the agent's settings and temporary files, outside the project

[env]                             # the agent's variables
TEAM_AGENT_HOME = "${{ storage.config }}"
TMPDIR = "${{ storage.tmp }}"

[filesystem]                      # the files the agent reaches
read = ["${{ inputs.team.program }}"]
exec = ["${{ inputs.team.program }}"]
```

`[pack]` comes first, and every other key is in a table. `kind` decides which tables the pack can hold and which packs it can extend, and `box` refuses a pack that doesn’t match its kind ([What a pack holds](/docs/user-guide/box/reference/packs/index.md#what-a-pack-holds)). A profile that uses this pack sets `team.mode` under `[options]`.

The sections below each show one part of a pack.

## Inputs

An input is a value that a profile can set, or that `box` reads from your machine when a run starts. A profile sets it under `[options]`, by its full name:

```toml
# From @box/bedrock: a string input that a route uses.
[inputs.bedrock.region]
description = "The AWS region that serves the model."   # box profile create shows it
type = "string"
pattern = "[a-z]{2}(-[a-z]+)?-(central|north|south|east|west)+-[0-9]+"   # required: it reaches a route
default = "us-west-2"

[egress.bedrock]
destinations = ["bedrock-runtime.${{ inputs.bedrock.region }}.amazonaws.com"]
```

```toml
# From @box/claude: a program input.
[inputs.claude.path]
type = "program"                                       # a program box finds when a run starts
program = "claude"
search = [{ env = "PATH" }, "${{ home }}/.local/bin"]  # the folders to look in, in order
```

### Declare an input

Declare one only when it changes what the box allows or how the box is set up. The model region is an input, because it decides which host the box allows. The model isn’t, because the agent chooses it. When an input’s value lands in `command` or in a route’s hosts, give it a `pattern` or `values` ([why](/docs/user-guide/box/reference/packs/index.md#inputs-that-reach-command-or-a-route)).

Name a setting that most agents share under `agent.`, such as `agent.skip-permissions`, a `bool` that tells the agent never to ask before it acts. A profile then sets it the same way for each agent that offers it. [Inputs](/docs/user-guide/box/reference/packs/index.md#inputs) lists every key of a declaration.

## Placeholders and conditions

`${{ name }}` in a string is filled in when the run starts, and `when` keeps an entry, a table, or one value only when its condition holds:

```toml
[env]
TEAM_AGENT_HOME = "${{ storage.config }}"     # a storage directory the pack names

[filesystem]
read_file = [
    "${{ pack }}/defaults.json",              # a file beside pack.toml
    { path = "/opt/homebrew/etc/openssl@3/openssl.cnf", optional = true, when = "macos" },
]

[inputs.gh.enabled]
type = "bool"
default = false                               # off, so the operator turns it on

[egress.github]
when = "${{ inputs.gh.enabled }}"             # the route exists only when the input is on
destinations = ["api.github.com"]
secret.ref = "env://GITHUB_TOKEN"
```

The placeholders you’ll use most are `${{ home }}`, `${{ workspace }}` for the project, `${{ storage.<dir> }}`, `${{ inputs.<name> }}`, and `${{ pack }}`. [Placeholders](/docs/user-guide/box/reference/profiles/index.md#placeholders) lists every name and where each works.

Put `when` on a table your pack owns, such as a route or a tool, not on one that other packs add to, such as `[agent.env]`. [`when`](/docs/user-guide/box/reference/profiles/index.md#when) says why, and lists the conditions.

### Keep settings files out of a write grant

`box profile create` reads the agent’s settings files, such as `~/.claude/settings.json`, to answer a starter’s questions. It skips a file that a box could write, so a box can’t plant a setting that picks your next profile’s provider. To find those files, it reads each `write` grant before the profile has its answers. It still reads a file under some grants:

```toml
[filesystem]
write = [
    "${{ home }}/.config/team",   # understood: box skips files here
    "${{ inputs.team.home }}",    # a placeholder that box can't fill yet
    "${{ home }}/.team-*",        # a *, in a tool pack
]
```

A whole list written as `write = { value = [...], when = "macos" }` isn’t understood either.

When a grant like these could reach an agent’s settings folder, keep that folder read-only with [`deny_write`](/docs/user-guide/box/reference/profiles/index.md#the-agent-table):

```toml
[filesystem]
write = ["${{ inputs.team.home }}"]
deny_write = ["${{ home }}/.claude"]   # the box can read it, and can't change it
```

## Agent packs

An agent pack either runs a new agent, as `team-agent` above does, or extends another agent pack and adds to it:

```toml
[pack]
name = "team-claude"
version = 1
kind = "agent"
extend = ["@box/claude"]              # Claude Code as Box ships it, plus what follows

[filesystem]
read = ["${{ home }}/team/handbook"]  # the agent's file tools can also read the team handbook
```

A profile then lists `team-claude` in place of `@box/claude`. Two packs that each extend `@box/claude` can’t both go in one profile, but a third pack can extend the two ([What a pack holds](/docs/user-guide/box/reference/packs/index.md#what-a-pack-holds)). An agent pack can also bring in the agent’s own MCP servers ([`[[mcp-servers]]` in a pack](/docs/user-guide/box/reference/packs/index.md#mcp-servers-in-a-pack)).

An agent pack can tell its agent how the box works and where your profile is, each time the agent starts. Then, when the box blocks something, the agent should say so, name the path, program, or host, and show the change to make in `profile.toml`. It can’t make that change itself.

## Tool packs

A tool pack runs one program. At each run, `box` finds the program on your `PATH`, the same one the agent gets when it types the name:

```toml
[pack]
name = "rg"                          # the tool's name is the last part of the pack's name
version = 1
kind = "tool"

[inputs.rg.path]
type = "program"
program = "rg"                       # found on PATH

[run]
command = ["${{ inputs.rg.path }}"]  # the program input, and nothing else
installation = ["homebrew"]          # also reads the files a Homebrew install depends on
```

### Find the files a program needs

State the files relative to the program, so one pack works on every machine. `${{ root.parent }}` is one folder up from the program’s real file, so the grants follow it wherever it’s installed. A path that isn’t on the machine is dropped. `@box/git` grants `${{ root.parent }}/libexec/git-core` this way. For a program from Node, Python, or Homebrew, `installation` adds the runtime files it needs, so you don’t list them yourself. To reach a package registry, list it in `[run] hosts`. [Tool packs](/docs/user-guide/box/reference/packs/index.md#tool-packs) lists every `[run]` key, and [Root and its steps](/docs/user-guide/box/reference/packs/index.md#root-and-its-steps) explains `root`.

### Give a tool a credential

A tool pack can’t hold a route (`[egress]`). A tool that needs a credential for its host takes the route from a support pack, such as `team-api` in [Support packs](#support-packs), and extends it:

```toml
[pack]
name = "team-cli"
version = 1
kind = "tool"
extend = ["team-api"]   # the support pack that holds the route

[inputs.team-cli.path]
type = "program"
program = "team-cli"

[run]
command = ["${{ inputs.team-cli.path }}"]
```

The support pack can also name the tool pack in `include` instead, so a profile lists only the support pack.

## Support packs

A support pack adds to the agent, its tools, or the box. Write one for settings that several profiles share, whatever agent they run:

```toml
[pack]
name = "team-api"
version = 1
kind = "support"

[egress.team-api]
destinations = ["api.example.com"]   # the box can reach this host
secret.ref = "env://TEAM_API_TOKEN"  # the agent sees a placeholder key, not the token
```

### Write a provider pack

A provider pack is a support pack with the route to a model host and the credential for it. This is `@box/anthropic`:

```toml
[pack]
name = "@box/anthropic"
version = 1
kind = "support"

[egress.anthropic]
destinations = ["api.anthropic.com"]
secret.ref = "env://ANTHROPIC_API_KEY"
secret.header = "x-api-key"
secret.phantom_prefix = "sk-ant-"    # the placeholder key starts like a real one, for an agent that checks
```

`box` doesn’t check that a provider works with an agent, so an agent that needs a setting for one provider holds it in its own pack. Declare an input named `<agent>.host`, with the providers as its `values`, and test it with `when`, as `@box/claude` does:

```toml
[inputs.claude.host]
type = "string"
values = ["bedrock", "anthropic"]
default = "bedrock"

[agent.env]
CLAUDE_CODE_USE_BEDROCK = { value = "1", when = { variable = "inputs.claude.host", equals = "bedrock" } }
```

[Providers](/docs/user-guide/box/reference/packs/index.md#providers) says what fails when an agent and a provider don’t match.

## Commands for packs

| To | Run |
| --- | --- |
| Make a profile that uses a pack | `box profile create team --with team-agent,bedrock --option team.mode=auto --tools git` |
| Check what a run gets from it | [`box profile show`](/docs/user-guide/box/reference/cli/index.md#box-profile-show) |
| See what the box denied in a run | [`box runs history <box ID> --deny`](/docs/user-guide/box/reference/cli/index.md#box-runs-history) |

### Test a pack

Run `box profile show` in a project, with a profile that uses your pack. It starts no box, and if `box` would refuse the pack, it stops with the same error `box run` would print:

```sh
cd ~/src/my-app
box profile show team
```

```text
box: Profile team

✓ Resolves for this directory
  packs     team-agent 1, @box/base 1, @box/bedrock 1, @box/git 1
  policies  policy.dw
  storage   /Users/you/.strands/box/storage/team/default
  project   read and write

Options
  team.program        "/Users/you/bin/team-agent"  (search)
  team.mode           "auto"  (your profile)
  bedrock.region      "us-west-2"  (default)
  ...
```

Read the `!` notes: a tool your machine doesn’t have, a path it dropped, or a route that’s open to every program in the box. Add `--full` to see each grant your pack adds. Then run the agent and try what it does. If the box denies something your pack should allow, [The agent can’t reach a file or a host](/docs/user-guide/box/troubleshooting/index.md#the-agent-cant-reach-a-file-or-a-host) says what to change.