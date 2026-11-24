This page lists every key that only a pack writes, and `[storage]`, which a profile can also write, and what each one does. The keys that a profile and a pack share, such as `[agent]`, routes, and `[mcp.<name>]`, and the rules for placeholders, `when`, and the merge, are in the [profile reference](/docs/user-guide/box/profiles/index.md). To write a pack, start with [Packs](/docs/user-guide/box/packs/index.md).

## What a pack holds

A pack is a `pack.toml` in the pack’s folder, and a profile or another pack imports it by name. A pack runs only through a profile. The folder can hold other files beside `pack.toml`, such as a script the agent loads, and the pack names them through [`${{ pack }}`](/docs/user-guide/box/profiles/index.md#placeholders). Every key of a pack is in a table, and the file starts with `[pack]`.

| Key | Kinds | What it holds |
| --- | --- | --- |
| `[pack]` | Every pack. Required, and first. | The [header](#pack): name, version, kind, and the packs it extends or includes. |
| `[requires]` | Every pack. | What the pack needs of the `box` that reads it, such as its oldest version. See [`[requires]`](/docs/user-guide/box/profiles/index.md#requires). |
| `[inputs.<name>]` | Every pack. | The [inputs](#inputs) the pack declares. |
| `[run]` | Agent and tool packs. | How the program starts: an [agent pack’s](#an-agent-packs-run) or a [tool pack’s](#tool-packs) keys. |
| `[env]`, `[filesystem]` | Agent and tool packs. | The program’s variables and the files it can reach, as in [The `[agent]` table](/docs/user-guide/box/profiles/index.md#the-agent-table). |
| `[storage]`, `[[storage.files]]` | Every pack. In a tool pack, the tool’s own storage. | The agent’s [storage](#storage), or a [tool’s](#give-a-tool-its-own-storage). |
| `[[storage.hooks]]` | Agent and support packs. | Your hooks, [imported](#import-hooks-storagehooks) into a copy in storage. |
| `[[mcp-servers]]` | Agent and support packs. | The files on your machine that hold the agent’s [MCP servers](#mcp-servers-in-a-pack). |
| `[mcp.<name>]` | Agent and support packs. | Only `filesystem` and `network` grants for one of your servers. See [MCP servers](/docs/user-guide/box/profiles/index.md#mcp-servers). |
| `[agent]` | Support packs. | Agent settings, as in [The `[agent]` table](/docs/user-guide/box/profiles/index.md#the-agent-table). |
| `[tool.<name>]` | Agent and support packs. | A [tool table](/docs/user-guide/box/profiles/index.md#a-tool-table-in-the-full-form), or additions to a tool. |
| `[egress.<name>]`, `[telemetry]` | Agent and support packs. | [Routes](/docs/user-guide/box/profiles/index.md#routes-and-other-hosts) and telemetry, with [placeholders](/docs/user-guide/box/profiles/index.md#placeholders) where a value depends on your machine. |

`[pack] kind` decides the rest:

| Kind | What it is | It can extend |
| --- | --- | --- |
| `agent` | It runs an agent. Its `[run]` sets `command`, or it extends an agent pack and adds to that agent. It names a tool pack in `include`, not `extend`. | Agent and support packs. |
| `tool` | It runs one tool. Its `[run]` sets `command` to its program input (see [Tool packs](#tool-packs)). | Tool and support packs, such as a pack that holds the route the tool needs. |
| `support` | Any other pack, such as shared settings or a model provider. It has no `[run]`, `[env]`, or `[filesystem]`. | Support packs. |

`box` stops with an error when a pack does not match its kind, such as a `support` pack with a `[run]`, a `[run]` key that the kind does not take, or a `support` or `tool` pack that extends an agent pack. A profile runs one agent, so one agent pack in it extends every other agent pack in it. So `@box/claude` and `@box/kiro` in one profile stop with an error, and so does a pack that extends both. Two of your own packs that each extend `@box/claude` also stop with an error, because neither extends the other. To use both, write a third pack that extends the two, and name it instead.

A pack holds none of the profile’s keys: no `packs`, `policies`, `[options]`, `agent-args`, `file-attributes`, `[limits]`, `[banner]`, `[project]`, `[profile]`, or `[experimental-features]`, and no `native-filesystem-policy` for any process. It also holds none of the keys that `box run` sets. A tool table that a pack writes with a `command` and no `program` still needs a `shell:spawn` permit in a file that the profile’s `policies` lists (see [Tools](/docs/user-guide/box/profiles/index.md#tools)).

The packs that ship with `box` are in `resources/packs/`. `box profile show <name>` lists the packs a profile uses and each option they read, and `--full` shows everything they add.

### An agent pack’s `[run]`

`box` moves these keys, and the pack’s `[env]` and `[filesystem]`, into the agent’s [`[agent]` table](/docs/user-guide/box/profiles/index.md#the-agent-table). `[run]` takes no other key.

| Key | What it does |
| --- | --- |
| `command` | Required, here or in an agent pack it extends. The agent’s program and its arguments, one string for each. The first element is the program, usually a `program` input. One element after the program can be `{ slot = "agent-args" }`, where a profile’s `agent-args` go, and the slot can give `default = [...]` for a profile that sets none. Without a slot, a profile that sets `agent-args` stops with an error. |
| `dependency` | A list of other tables, such as `["egress.model"]`. It changes nothing about the run. |
| `file-watching` | See [`file-watching`](/docs/user-guide/box/profiles/index.md#file-watching). |
| `when` | A condition that keeps the agent’s `[agent]` table. See [`when`](/docs/user-guide/box/profiles/index.md#when). |

## `[pack]`

| Key | What it does |
| --- | --- |
| `name` | Required. The name that profiles and packs import it by: `@box/<folder>` for a pack that ships with `box`, such as `@box/claude`, the folder name for a pack in `~/.strands/box/packs/`, such as `team-agent` for `~/.strands/box/packs/team-agent/`, or `@<scope>/<folder>` for a pack in a [collection](/docs/user-guide/box/reference/files/index.md#collections), such as `@acme/team-agent` for `~/.strands/box/external/acme/packs/team-agent/`. A folder name uses letters, digits, `.`, `_`, and `-`, and does not start with `.`. A name that does not match the folder is an error. |
| `version` | Required. A whole number, such as `1`. Raise it when the pack changes. |
| `kind` | Required. `"agent"`, `"tool"`, or `"support"`, as [What a pack holds](#what-a-pack-holds) states. [Pack kinds](/docs/user-guide/box/packs/index.md#what-a-pack-is) says what each kind is for. |
| `extend` | The packs this one builds on, merged before it. An agent pack extends agent and support packs, a tool pack extends tool and support packs, and a support pack extends only support packs. |
| `include` | Tool packs to load as tools of their own beside this one, as a profile’s `packs` does. Nothing of them is merged into this pack. A support pack includes a tool pack to add to its tool, such as more `hosts` in `[tool.npm]`. |

The header holds no other key, and `box` refuses a pack that has no header.

When a tool pack extends another tool pack, it takes that pack’s tool in, and the base is not a tool of its own. `@box/go` extends `@box/git`, so go gets git’s settings and the agent gets no `git` tool, unless the profile or a support pack sets `[tool.git] program`. To keep both tools, use `include` too: `@box/npm` extends and includes `@box/node`, so npm gets node’s settings and the agent keeps a `node` tool. [Pack kinds](https://github.com/strands-agents/box/blob/2762080a7a4c65fd7e777646a8fd79706aebd66a/docs/design/cli/profile-language.md#pack-kinds) has the background.

## Inputs

An input is one value that a profile can set, or that `box` reads from your machine when a run starts. A pack declares it as `[inputs.<name>]` under its full name, such as `[inputs.bedrock.region]`, and the profile’s `[options]` and every placeholder use that same name. [Declare an input](/docs/user-guide/box/packs/index.md#declare-an-input) shows one.

| Key | What it does |
| --- | --- |
| `description` | Text for a person who reads the pack. |
| `type` | `string` (the default), `bool`, or `program`. |
| `program` | For a `program` input: the file name to look for, such as `team-agent`. One name, with no `/`. |
| `search` | For a `program` input with `program`: the folders to look in, in order. A folder can hold placeholders and a `*`, which matches every version folder, newest first. `{ env = "PATH" }` stands for the folders on your `PATH`. Without it, `box` looks on your `PATH` only. |
| `from` | `env:<NAME>`: a variable in the shell where you run `box`. |
| `key` | With `from`: one key of a variable that holds a list of `key=value` items separated by commas. The value is that key’s value, with spaces at either end removed and each `%XX` escape decoded. A list that names the key twice is an error, and so is a value with a bad `%XX` escape, a value that isn’t UTF-8 once decoded, or a value that decodes to a NUL. |
| `default` | The value when neither your profile nor `from` gives one. A string, or `true` or `false`. It can hold placeholders. A `program` input with `program` has no `default`. |
| `pattern` | A regular expression, in the syntax of the Rust `regex` crate, that the whole value must match. |
| `values` | The list of allowed values. |
| `warning` | What picking a value lets the box do. `box profile create` asks for every input that has one, shows the warning under the question, and saves the answer in the profile, even when it is the default. An input with `from` or `program` has none. |

`description`, `type`, `pattern`, `from`, `key`, `program`, and `warning` are literal and hold no placeholder. An input’s table holds only these keys, so `[inputs.team]` cannot declare an input and also hold `[inputs.team.mode]`. Each part of an input’s name uses letters, digits, `_`, and `-`, and the parts are joined with `.`. The name need not match the pack’s folder.

A `program` input names a program on your machine. `box` tries each `search` folder in order, skips a copy that is not a program the box can run (such as a Node.js script, or one inside your project), and uses the first one left. A path that a profile sets in `[options]` is used without a search.

Some programs put several settings in one variable, such as `LOG_HEADERS=x-log-group=/my/logs,x-log-stream=box`. To read one of them, name its key:

```toml
[inputs.team.log_group]
from = "env:LOG_HEADERS"
key = "x-log-group"
```

Here the input’s value is `/my/logs`.

### Where the value comes from

`box` takes the first of these that gives a value:

1.  Your profile’s `[options]` entry for the input.
2.  The `from` source: the variable, if your shell sets it to a nonempty value. With `key`, the value of that key, if the list holds one and it isn’t empty.
3.  For a `program` input with `program`, the first copy that `box` finds. Otherwise, the `default`.

`box` stops with an error when an input has none of the three. `box profile show` names the source of each value as `your profile`, `env:<NAME>`, `search`, or `default`, and lists only the inputs that a placeholder reads. It prints every value as text, so a `bool` shows as `"true"` or `"false"`.

Then `box` checks the value, whatever its source. A `bool` is `true` or `false`. The value matches every `pattern` and is in every `values` list. A `program` is an executable file, given as an absolute path that is not in your project, the run’s storage, `~/.strands/box`, or a folder the profile lets the agent write, even through a link, so the agent cannot plant a program for your next run. The agent’s program is not a script that runs on node, because the box cannot start one.

### Inputs that reach `command` or a route

Five kinds of input must declare `pattern` or `values`, so that `box` can check what the value holds:

-   **An input that reaches `command` or `agent-args`.** A program can parse an argument: a shell’s `-c`, a TOML or JSON setting. In `'--config=region="${{ inputs.team.region }}"'`, a value that held a `"` could change the setting. A `bool` input is exempt, and so is a `program` input that is the first element of `command`. An element of `agent-args` is never the program, so it gets no such exemption. To pass free text to the agent, put it in `[agent.env]`, where the program reads it as data.
-   **An input that reaches a route’s `destinations`,** so that its value names only the hosts you expect. A `bool` input is exempt.
-   **An input that reaches a route’s backend `url`,** such as a gateway URL that `box` reads from the environment. A `bool` input is exempt.
-   **An input that reaches a backend’s `auth.aws.region`,** such as `bedrock.region`, the input `@box/bedrock` declares, when `box` reads it from `AWS_REGION`. A `bool` input is exempt.
-   **An input that reaches a telemetry target’s `destination`,** because the box sends its records and the target’s credential there. A `bool` input is exempt.

The built-in names, such as `${{ home }}` and `${{ storage.tmp }}`, are exempt.

A route’s credential never reaches the agent through an input. If `from = "env:<NAME>"` names a variable that a route’s `secret.ref` reads, such as `AWS_BEARER_TOKEN_BEDROCK`, `box` refuses the profile.

### Two packs that declare one input

Two packs can declare the same name, and then it is one input. The declarations agree on `type`, and the value satisfies every `pattern` and `values` list. When the packs give different defaults or sources, `box` picks neither and the error names each pack: set the input in your profile’s `[options]`. [One input in two packs](https://github.com/strands-agents/box/blob/2762080a7a4c65fd7e777646a8fd79706aebd66a/docs/design/cli/profile-language.md#one-input-in-two-packs) has the full rules.

## Providers

A provider pack is a support pack with the `[egress.<name>]` route to a model host and the `secret.ref` for its key, such as `@box/bedrock`. It declares nothing else to say that it is one. [Write a provider pack](/docs/user-guide/box/packs/index.md#write-a-provider-pack) shows one.

A profile names one provider beside its agent pack. `box` adds no check that the two work together, and `box profile create` never picks a provider. A profile still fails to resolve when a pack reads an input that no pack declares, when two packs declare one route, or when two packs’ routes read one key. Any other mismatch fails when the agent runs, for example when the agent sends its model requests to a host that the profile does not route.

## `[[mcp-servers]]` in a pack

An `[[mcp-servers]]` row names a file where the agent keeps its MCP servers. When the row applies, `box run` declares each server it can in the box, which gives the server its own permissions and keys, and writes the servers into the agent’s settings in storage. This row from `@box/claude`, shortened, reads the servers in `~/.claude.json`:

```toml
[inputs.claude.import-mcp]
description = "Import your MCP servers from ~/.claude.json?"
type = "bool"
default = false     # off, so the operator chooses whether servers come in
warning = "Local servers run in the box with keys from their settings and your environment."

[[mcp-servers]]
file = "${{ home }}/.claude.json"   # the file that holds the servers,
kind = "json"                       # its format,
key = ["mcpServers"]                # and the key the servers are under
target = "config/.claude.json"      # where they go in the agent's settings in storage
target-key = "mcpServers"
env-var-locations = { command = "references", args = "references", env = "references", headers = "header-references" }
env-var-syntax = "${NAME}"
when = { variable = "inputs.claude.import-mcp", equals = "true" }   # only when the operator says yes
```

| Key | What it does |
| --- | --- |
| `file` | Required. The file that holds the servers. It is a [path](/docs/user-guide/box/profiles/index.md#paths), and its name does not matter. |
| `kind` | Required. `"json"` or `"toml"`. |
| `key` | Required. The keys that lead to the table of servers, one for each level, such as `["mcp_servers"]`. A key can hold a placeholder. |
| `env-var-locations` | Which server settings hold a variable, and how: each setting gets one of the roles below. `references` goes only on `command`, `args`, or `env`. |
| `env-var-syntax` | How the agent writes a variable, with `NAME` where the name goes, such as `"${NAME}"`, or a list of forms, such as `["${NAME}", "$NAME"]`. A form like `$NAME`, with nothing after the name, takes no `:-default`. Required by `header-references` and `references`. With it, `box` also reads a key in the URL’s query, such as `?api_key=${NAME}`. |
| `command-prefix` | The text that starts a setting the agent runs as a command, such as `"!"`. `box` declares no server with such a setting. Needs `env-var-syntax`. |
| `target` | A file below a storage directory, such as `config/.claude.json`. Without it, the row declares servers but writes nothing into the agent’s settings. |
| `target-key` | Required with `target`. The key in `target` that holds the servers: a top-level key, such as `mcpServers`, or a list of keys, one for each level, such as `["projects", "${{ workspace }}", "mcpServers"]`. |
| `when` | Read the file only when the condition holds, as in [`when`](/docs/user-guide/box/profiles/index.md#when). When it does not hold, the row adds nothing and leaves the stored file alone. |

| Role | The setting holds | Example |
| --- | --- | --- |
| `bearer-variable` | The variable that holds the server’s token. | `"DOCS_TOKEN"` |
| `header-variables` | Headers, each with the variable that holds its value. | `{ "X-Api-Key" = "DOCS_TOKEN" }` |
| `header-references` | Headers, each ending in one variable written in `env-var-syntax`, such as `Bearer ${NAME}` or `Bearer ${NAME:-default}`. | Claude Code’s `headers` |
| `references` | A server’s `command`, `args`, or `env`, with variables in `env-var-syntax`, such as `${GITHUB_TOKEN}` or `${LOG_LEVEL:-info}`. `box` fills in `command` and `env` from your shell. | Claude Code’s `command`, `args`, and `env` |
| `variable-names` | Variables to forward when set, as strings or `{ name = "TOKEN", source = "local" }` tables. | `["GITHUB_TOKEN"]` |

The first three roles are for a server at a URL, and the last two for a server on your machine.

-   `box` writes into `target` only while `target-key` is missing there, or is empty below the top level. After that it leaves the section alone, so a later change reaches the agent only after the [refresh steps](/docs/user-guide/box/troubleshooting/index.md#box-lists-an-mcp-server-but-my-agent-doesnt-show-it).
-   A `target` cannot overlap a `[[storage.files]]` target, except a `fill` row. Rows that share a target use the same `kind`, and one row’s section is not inside another’s.
-   `box` reads no file in your project, in `~/.strands/box`, in a folder the agent can write, or in a folder that a [plugin](/docs/user-guide/box/plugins/index.md) keeps on your machine. A file or a key your machine does not have reads as no servers.

[MCP servers](https://github.com/strands-agents/box/blob/2762080a7a4c65fd7e777646a8fd79706aebd66a/docs/design/cli/profiles.md#mcp-servers) says how `box` declares a server, fills in its variables, and why it declares none for some, and [An MCP server has no automatic declaration](/docs/user-guide/box/troubleshooting/index.md#an-mcp-server-has-no-automatic-declaration) has the fixes.

## Storage

Storage is where an agent keeps its settings, sessions, and temporary files between runs, outside your project. Each profile gets one storage folder, which every project it runs in shares.

| Key | What it does |
| --- | --- |
| `[storage] directories` | The names of the storage directories. Each name is one folder name, with no `/`. |

-   Each directory is `~/.strands/box/storage/<profile>/default/agent/<dir>/`, and `${{ storage.<dir> }}` names it. `box profile show` prints the folder on its `storage` line.
-   `box run` creates each directory and gives the agent read and write on it, so do not add that access yourself.

### Copy files into storage

A `[[storage.files]]` row copies a file or a folder of yours into storage on the profile’s first run, or on the first run in each project when its `target` names the project:

```toml
[[storage.files]]
source = "${{ home }}/.claude/skills"
target = "config/skills"
optional = true
```

| Key | What it does |
| --- | --- |
| `source` | Required. The file or folder to copy. It is a [path](/docs/user-guide/box/profiles/index.md#paths). |
| `target` | Required. A storage directory, then a path below it, such as `config/CLAUDE.md`. A placeholder can fill one name below the storage directory, such as `config/projects/${{ workspace.dashed }}/memory`, so each project gets its own copy. |
| `optional` | `true` copies nothing when your machine does not have the source. A row with `set` then writes a new file that holds only the values it sets. Without it, a missing source stops the run. |
| `when` | Copy only when the condition holds, as in [`when`](/docs/user-guide/box/profiles/index.md#when). |
| `sync` | `true` brings the copy up to date with your file on each run. Without it, the copy is made once. Not on a row with `kind`, `keep`, `set`, or `fill`. |
| `exclude` | Names that a folder copy leaves out, such as `["mcp.json"]`. Each is one file or folder name, with no `/` and no `*`, `?`, or `[`: a name is matched whole, not as a pattern, and without regard to case. The copy leaves out every entry of that name at any depth, on the first copy and on each `sync`. An `exclude` added to a row whose copy is already in storage does not delete what it names from the box: each `box run` and `box profile show` name the file it kept until you delete it in storage. Only on a row with `sync = true`, and not on a row with `kind`, `keep`, `set`, or `fill`. A source that is one file stops the run. |
| `kind` | `"json"` or `"toml"`. Required with `keep`, `set`, or `fill`, and refused without them. |
| `keep` | The values to copy, as a list of key lists. Without it, the whole file is copied. See [Copy only part of a settings file](#copy-only-part-of-a-settings-file). |
| `fill` | `true` adds each `keep` value that the copy lacks, on every run. See [Add missing values on every run](#add-missing-values-on-every-run). |
| `[[storage.files.set]]` | Rows of `key` and `value` that write a value into the copy on every run. See [Set a value in the copy on every run](#set-a-value-in-the-copy-on-every-run). |
| `mode` | `"copy"`, the default. A tool’s own storage also takes `"link"` and `"link-children"`. See [Give a tool its own storage](#give-a-tool-its-own-storage). |

-   **Once, or with `sync`.** `box run` copies only when the target is not there yet. After that, the copy is the agent’s, apart from `set` values, and your edits to the source do not reach it. Delete the copy to take a fresh one. With `sync = true`, each run copies in each file of yours that changed since the last copy: your change replaces an agent edit to the same file, and other agent edits stay. Do not use `sync` on a copy the agent adds to, such as Claude Code’s memory.
    
-   **One row per target.** Rows from every pack and your profile add up. Two rows that both apply, with the same `target` or one target inside the other, stop the run. A pack that lets you turn a copy off gives it a `when` on an input, such as `claude.import-skills` in `@box/claude`. Turn the pack’s copy off, and your own row for that target applies.
    
-   **What it copies.** `box` does not judge whether a file is safe to copy, so a row must never name a sensitive file whole, such as `~/.claude/settings.json`, or a folder that holds one, such as all of `~/.claude`. Use `keep` to bring in the safe part. `box` copies nothing from your project, from `~/.strands/box`, or from a folder the agent can write, except a shipped pack’s own files. It copies nothing from a path that a [plugin](/docs/user-guide/box/plugins/index.md) keeps on your machine, a shipped pack’s files included.
    
-   **Links.** `box profile show` lists each link in a copied folder that it follows and each entry it leaves out, including each one that `exclude` names. `box run` prints each entry it leaves out.
    
-   **A file that changes during the copy.** A first copy reaches storage only when none of its files changed while `box` copied them, so a database and its journal come from one moment. When one changes, `box` tries again, three times in all. When it keeps changing, the run stops before the box starts, and storage gets no copy:
    
    ```text
    box: error: cannot copy /Users/you/.claude/skills into storage: /Users/you/.claude/skills/review/SKILL.md changed each time box copied it (3 tries); stop the program that writes it, then start the run again
    ```
    
    Quit the program that writes the file, such as the agent on your machine, then run again. A `sync` update does not make this check, so a file written during an update can come in part written, and the next update brings it up to date.
    

[Copies](https://github.com/strands-agents/box/blob/2762080a7a4c65fd7e777646a8fd79706aebd66a/docs/design/cli/profile-language.md#copies) has the full steps, including `sync`.

### Copy only part of a settings file

A `keep` list copies only the values it names. `@box/claude` brings in your Claude Code display preferences with a row like this one:

```toml
[[storage.files]]
source = "${{ home }}/.claude/settings.json"
target = "config/settings.json"
kind = "json"
optional = true
keep = [["theme"], ["outputStyle"], ["editorMode"]]
```

Each entry is a list of keys, one for each level of the file, so `["spinnerVerbs", "mode"]` is the `mode` value inside `spinnerVerbs`. Every other value stays out, including one the agent adds to its settings later. A TOML file loses its comments in the copy, so a key you commented out stays out too.

`keep` applies once, when the run first copies the file. `box profile show` lists what the copy keeps, what it drops, and what your file does not have, by name only:

```text
  copy     ~/.claude/settings.json -> agent/config/settings.json (will copy)
  keeps    theme, editorMode in agent/config/settings.json
  drops    env, apiKeyHelper, model in agent/config/settings.json
  missing  outputStyle in agent/config/settings.json
```

### Add missing values on every run

With `fill = true`, each run adds each `keep` value that the copy does not have yet, and never changes one that is there. Use it for a file that the agent writes itself on its first run, such as `~/.claude.json`, where a copy made once would never bring your values in:

```toml
[[storage.files]]
source = "${{ home }}/.claude.json"
target = "config/.claude.json"
kind = "json"
optional = true
fill = true
keep = [["hasCompletedOnboarding"], ["projects", "${{ workspace }}", "hasTrustDialogAccepted"]]
```

A row with `fill` needs `keep` and `kind`, and has no `set` rows. It can share its target with an `[[mcp-servers]]` row of the same format, as long as its `keep` paths do not overlap that row’s `target-key`. `box profile show` prints a `fills` line with the names it would add. When the copy is a link, a hard link, or not a file, `box run` leaves it alone and prints a `did not copy` line.

### Set a value in the copy on every run

A `[[storage.files.set]]` row writes a value into the copy before each run starts, for a setting that must differ in the box, such as the path to a program the agent starts:

```toml
[[storage.files]]
source = "${{ home }}/.pi/agent/settings.json"
target = "agent/settings.json"
kind = "json"
optional = true

[[storage.files.set]]
key = ["shellPath"]
value = "${{ box }}/bin/bash"
```

| Key | What it does |
| --- | --- |
| `key` | Names the value to write, as a list of keys, as in a `keep` entry. A key can hold a placeholder, so `["projects", "${{ workspace }}", "trust"]` sets `trust` for this project only. |
| `value` | The value: a string, a number, `true` or `false`, or a list of those. Only a string holds a placeholder. A list replaces the whole list in the copy. |
| `when` | Write the value only when the condition holds, as in [`when`](/docs/user-guide/box/profiles/index.md#when). When it does not hold, the row writes nothing and the copy keeps its value. |

The rest of the copy stays as the agent left it. `box profile show` prints a `sets` line for each key, without its value. Two runs of one profile share the copy, and the run you started last wins.

A run stops, naming the row, when the copy no longer reads as its `kind` (fix the copy, or delete it so that the next run copies your file again), when the copy or a folder on the way to it is a link, when a key holds a table or a level on the way to it is not a table, and when the source is a folder.

### Copy status

`box profile show` prints one `copy` line for each `[[storage.files]]` row that applies, with the row’s status in parentheses:

```text
  copy     ~/.claude/CLAUDE.md -> agent/config/CLAUDE.md (will update agent/config/CLAUDE.md from the host)
  copy     ~/.claude/settings.json -> agent/config/settings.json (already in storage)
```

`box profile show` reads each copy only to compare it with your file, and changes none. A row with `sync = true` can print more than one status, joined by `;`, and each one names a path in storage, such as `agent/config/skills/review.md`.

| Status | What it means | What to do |
| --- | --- | --- |
| `will copy` | The copy is not in storage yet, so the next run makes it. | Nothing. |
| `already in storage` | The copy exists and the row has no `sync`, so the next run leaves it as it is. A `fill` row still adds the values that its `fills` line names. | To take a fresh copy, delete the copy from storage. |
| `absent on this host` | The row is `optional` and your machine does not have the source, so the run copies nothing. | Nothing, unless you expected the file. |
| `absent on this host, so it will hold only what it sets` | The row is `optional` and has `set` rows, and your machine does not have the source. The run writes a new file that holds only the values that the row sets. | Nothing. |
| `holds none of the settings it keeps` | A `fill` row’s source holds none of its `keep` values, so the run adds nothing. | Nothing. |
| `in sync with the host` | A `sync` row’s copy matches your file. | Nothing. |
| `will update <path> from the host` | You changed or added the file, and the box did not change its copy, so the next run copies your version. | Nothing. |
| `the host's edit will replace the box's edit of <path>` | You changed the file, and the box also changed or deleted its copy. The next run replaces the box’s edit with your version. | To keep the box’s edit, copy it out of storage before the run. |
| `keeps the box's edit of <path>` | The box changed or deleted its copy, and you did not change the file, so the next run keeps the box’s edit. | To take your version, delete the copy from storage, or edit your file. |
| `keeps the box's copy of <path>, which differs from the host` | `box` has no record of an earlier copy of the row, and the copy differs from your file. The next run keeps the copy, and your next edit of the file replaces it. | To take your version now, delete the copy from storage. |
| `keeps <path>, which the host no longer has` | You deleted the file, and the copy keeps it. | To remove it from the box, delete it from storage. |
| `cannot update <path>: <why>` | `box` cannot bring the file up to date, for the reason that `<why>` gives, and leaves the copy as it is. | Fix what `<why>` names. |

When a run brings a `sync` copy up to date, it prints what it did, such as `updated agent/config/CLAUDE.md from ~/.claude/CLAUDE.md`.

### Import hooks: `[[storage.hooks]]`

A `[[storage.hooks]]` row makes the hooks in a JSON copy in storage follow the hooks in a file of yours, on each run. `box` keeps each hook that runs one shell script, and lets the box read that script. The row says where the file keeps its hooks and what a kept hook looks like. [Hooks](https://github.com/strands-agents/box/blob/2762080a7a4c65fd7e777646a8fd79706aebd66a/docs/design/cli/profile-language.md#hooks) shows `@box/claude`’s row and the checks each hook and script pass. An agent pack that imports hooks says in its README how the [`[limits]`](/docs/user-guide/box/profiles/index.md#what-a-profile-holds) apply to a hook.

| Key | What it does |
| --- | --- |
| `source` | Required. Your file, as a full path. |
| `target` | Required. A storage path: a file of its own, or the target of a `[[storage.files]]` row. No other hooks row has it. |
| `kind` | Required. `"json"`. |
| `when` | The row imports only when the condition holds. When it does not hold, the run still removes the hooks from the copy. |
| `key` | Required. The key path from the top of the file to each hook. `"*"` is each key of an object or each item of a list. The first key is a top-level key, which the row owns in the copy, and the last is `"*"`. |
| `keep-above` | Keys with string values that an object on the way to a hook can hold beside the next key of `key`, which the copy keeps, such as `["matcher"]`. Such an object with any other key is refused. |
| `only` | A `{ key, equals }` table: the key path in a hook, and the value that marks a hook that runs a command. A hook with another value is not imported. |
| `command` | Required. The key path in a hook to its command string. |
| `args` | The key path in a hook to its list of arguments. |
| `keep` | Key paths in a hook whose values the copy keeps unchanged. |
| `drop` | Fields that a hook can hold and the copy leaves out: a key path, or a `{ key, equals }` table with the one value the field may hold. A hook with another value there is not imported, and `box run` prints the field and the value the row accepts. |
| `[[storage.hooks.set]]` | Required. Rows of `key` (a key path in a hook) and `value` (a string, a number, a boolean, or a list of those), written into each kept hook. `${{ script }}` in a string is the real path of the hook’s script, and the rows hold it exactly once. A value holds no other placeholder, so no input reaches the command. |
| `disable-key` | A top-level key. When your file holds `true` there, no hook is imported, and the copy holds `true` there too. |

A hook that holds a field that `only`, `command`, `args`, `keep`, and `drop` do not name is not imported, so every field reaches the copy only by the row’s choice. The paths that these keys name do not overlap, and a row that breaks a rule stops the load.

## Tool packs

A tool pack names one program, and states what it needs relative to where the program is installed. [Tool packs](/docs/user-guide/box/packs/index.md#tool-packs) shows one.

The file is one tool table. `box` puts `[run]` and the tables after it under `[tool.<name>]`, where `<name>` is the last part of the pack’s name: `@box/git` becomes `[tool.git]`, and your own pack `rt` becomes `[tool.rt]`. That name is letters, digits, `_`, and `-`. `[pack]` and `[inputs.<name>]` stay out of the tool table, and every other table, such as `[env]`, `[filesystem]`, and `[storage]`, is the tool’s.

| `[run]` key | What it does |
| --- | --- |
| `command` | Required. One element: the pack’s `program` input, such as `["${{ inputs.git.path }}"]`. |
| `installation` | The installation types the program can have, from the table below. `box` adds the runtime files each one needs. Each value is a literal name. |
| `helpers` | Other programs the tool starts, such as `cc` for cargo. `box` finds each one on your `PATH`, lets the tool read it and its runtime files, and puts its folder on the tool’s `PATH`. A helper that is not on your machine is dropped. |
| `hosts` | Package hostnames, such as `["registry.npmjs.org"]`. The whole box can connect to them on port 443 and send them HTTP requests. Another port needs a permit in a file that the profile’s `policies` lists. |
| `upgrade_http` | Hosts from `hosts` that the tool asks over plain `http://`, such as `["static.rust-lang.org"]`. The box’s gateway makes the `https://` call itself. Use it for a tool that cannot trust the box’s certificate, such as rustup on macOS, and only for a host that needs no login. It applies to the whole box. |
| `file-watching` | See [`file-watching`](/docs/user-guide/box/profiles/index.md#file-watching). |
| `when` | A condition that keeps the whole tool. See [`when`](/docs/user-guide/box/profiles/index.md#when). |

| `installation` | Use for |
| --- | --- |
| `node` | A Node runtime. |
| `npm` | An npm entry point or a program installed in `node_modules`. It grants read on the outermost `node_modules` folder that holds the program, every other package in it included, so keep unrelated packages out of that tree. |
| `python` | Python and programs in virtual environments, including pipx and uv. |
| `homebrew` | A program installed through Homebrew: its own files, its dependencies, and their configuration folders. |
| `directory` | A standalone program that reads files beside it, when nothing else in the list fits. |

List every type the program can have. A type that does not fit adds nothing, so `["node", "homebrew"]` works for Node from nvm and Node from Homebrew. For another layout, leave out `installation` and list the paths in `[filesystem]`. The `# installation` comments in `box profile show --full` name each type that applied. [Installation layouts](https://github.com/strands-agents/box/blob/2762080a7a4c65fd7e777646a8fd79706aebd66a/docs/design/cli/profile-language.md#installation-layouts) says what each type matches and reads.

A tool pack’s program input finds the program on your `PATH` only, because the agent types the bare name and the box finds it on the agent’s `PATH`. Leave out `search`, or write exactly `[{ env = "PATH" }]`. Only `[run] command` names the input, and a profile cannot set it in `[options]`. Another pack that needs the program’s folder uses `${{ tool.git.root }}`.

A tool pack writes one tool, so `box` refuses `program` in `[run]`, `workspace`, and the `[agent]`, `[tool]`, `[egress]`, `[mcp]`, `[telemetry]`, and `[experimental-features]` tables. Put those in another pack. No pack can change how a tool connects: only a profile holds `[tool.<name>.network]`.

### Root and its steps

A program’s other files sit at a fixed place next to it, so a pack names them from the program’s own folder. `${{ root }}` is the folder that holds the program’s real file. Add steps to move up from it:

| Name | Value | git from Homebrew | Claude Code from its own installer |
| --- | --- | --- | --- |
| `root` | The folder that holds the real file. | `.../Cellar/git/2.56.0_1/bin` | `~/.local/share/claude/versions` |
| `root.parent` | One folder up. Repeat it to go further, as `root.parent.parent`. | `.../Cellar/git/2.56.0_1` | `~/.local/share/claude` |

A step other than `parent` is an error: `` `up` is not a step of `root`; use `parent` ``. In a tool pack, `${{ root }}` is `${{ tool.<name>.root }}` for the pack’s own tool, and the long name takes the same steps, such as `${{ tool.git.root.parent }}`.

In an agent pack, or in the `[agent]` table of your profile, `${{ root }}` is the folder of the program that the agent’s `command` runs, so the agent can read files installed beside it. The first element of that `command` must then be a full path or a `program` input, and it cannot name `root` itself:

```toml
[filesystem]
read = ["${{ root }}/helper"]
```

### Give a tool its own storage

A `[storage]` table in a tool pack, or a `[tool.<name>.storage]` table in the full form, gives the tool storage that the agent cannot reach, for a tool with one home folder, such as rustup. `@box/cargo` links your installed toolchains into it:

```toml
[storage]
directories = ["rustup"]

[[storage.files]]
source = "${{ inputs.rust.home }}/toolchains"
target = "rustup/toolchains"
mode = "link-children"

[filesystem]
write = ["${{ storage.rustup }}"]   # the tool's own grant, so the agent gets no access
```

-   Each directory is `~/.strands/box/storage/<profile>/default/tool/<tool>/<dir>/`, and `${{ storage.<dir> }}` in the tool’s table names it.
-   `box run` creates it but grants nothing, so the tool reaches it only through its own `read` and `write` entries.
-   Every project of the profile shares a tool’s storage, and `box` takes no lock for it, so two boxes that run the tool at once rely on the tool’s own locking.

Each `[[storage.files]]` row in a tool’s storage names its `mode`:

| `mode` | What the target is |
| --- | --- |
| `"copy"` | A copy of the source, with the keys of [Copy files into storage](#copy-files-into-storage). |
| `"link"` | One read-only link to the source file or folder. |
| `"link-children"` | A folder of the tool’s own with one read-only link for each entry in the source folder, so the tool can add its own entries beside them. A source that is a file stops the run. |

A link row holds only `source`, `target`, and `mode`, and its `target` holds no placeholder. Each run brings the links up to date with their sources, and leaves what the tool put at a target in place of a link. A link grants nothing, so the tool still needs a `read` entry for its source. Two rows of one tool cannot have the same target, or one inside the other. [Tool storage](https://github.com/strands-agents/box/blob/2762080a7a4c65fd7e777646a8fd79706aebd66a/docs/design/cli/profile-language.md#tool-storage) has the background.

### Tool grammars

A tool grammar describes one program as a set of actions and effects, so that your policy decides each command of that program as an action, such as `Tool::<name>::Action::"<action>"`. Grammars are experimental, and no pack that ships with `box` has one. Box’s [tool grammars guide](/docs/user-guide/box/guides/tool-grammars/index.md) explains the grammar format and the rules you can write.

-   A tool pack keeps its grammar in `grammar.toml` beside its `pack.toml`, never in `pack.toml`. A `grammar.toml` beside any other pack is an error. A tool table in the full form takes a `[tool.<name>.grammar]` table in a profile or in a pack that is not a tool pack.
-   A tool with a grammar has a name of letters, digits, and `_` that does not start with a digit, and the grammar’s `name` and `program` are the tool’s. One tool has one grammar, from one file.
-   `box` writes `tool_<name>`, a permit for every command of that program, including the ones the grammar cannot read (`unmodeled`). So pair each forbid on an action or an effect with an unconditional forbid on `unmodeled`, or one extra option lets the command through:

```text
@id("no_loud")
forbid (principal, action == Tool::greet::Action::"hello", resource)
when { context.input.effects.contains(Tool::greet::Effect::"loud") };

@id("no_unmodeled_greet")
forbid (principal, action == Tool::greet::Action::"unmodeled", resource);
```

A `shell:spawn` rule no longer applies to a program that a grammar reads. Write each rule about it against its grammar’s actions instead.