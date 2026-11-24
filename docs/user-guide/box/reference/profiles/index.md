This page lists every key that a `profile.toml` can hold, and what each one does. Packs write many of the same tables, such as `[agent]`, routes, and `[mcp.<name>]`, so they’re here too, along with the rules that both follow. The keys that only a pack writes are in the [pack reference](/docs/user-guide/box/packs/index.md). For a task, start with [Profiles](/docs/user-guide/box/profiles/index.md). For a fix after an error, see [Troubleshooting](/docs/user-guide/box/troubleshooting/index.md).

## What a profile holds

A profile is `~/.strands/box/profiles/<name>/profile.toml`, and `box run <name>` runs it. A profile file elsewhere, such as one a project keeps, runs by its path ([Run a profile file](/docs/user-guide/box/reference/cli/index.md#run-a-profile-file)). The rules for a profile name are in [`box profile create`](/docs/user-guide/box/reference/cli/index.md#box-profile-create). [What’s in a profile](/docs/user-guide/box/profiles/index.md#whats-in-a-profile) shows the file that `box profile create` writes. `packs`, `plugins`, `policies`, `agent-args`, and `file-attributes` go above the first `[table]`.

| Key | What it does |
| --- | --- |
| `[requires]` | What the profile needs of the `box` that runs it, such as its oldest version. See [`[requires]`](#requires). |
| `[profile] name` | The profile’s name, for a profile file that you run by its path ([Run a profile file](/docs/user-guide/box/reference/cli/index.md#run-a-profile-file)). A profile in `~/.strands/box/profiles/` can leave it out, and if it sets it, it matches the folder name. |
| `packs` | The packs to use, as a list of names, in [merge order](#merge-order). `@box/<name>` is a pack that ships with `box`, and a plain name is a folder in `~/.strands/box/packs/`. |
| `plugins` | The [plugins](/docs/user-guide/box/plugins/index.md) to use, as a list of names, such as `plugins = ["@box/1password"]`. `@box/<name>` is a plugin that ships with `box`, and a plain name is a folder in `~/.strands/box/plugins/`. |
| `policies` | Your [rule files](/docs/user-guide/box/policies/index.md#write-custom-rules), as a list of paths. A relative path starts from the profile’s folder, and every path, and every link target, stays inside that folder. A path holds no placeholder. `box profile create` writes `["policy.dw"]`, a copy of the policy you picked ([Pick the agent’s policy](/docs/user-guide/box/starters/index.md#pick-the-agents-policy)). Without the key, the run has no policy file of yours. [The run’s policy](/docs/user-guide/box/policies/index.md#the-runs-policy) says how `box` joins them. |
| `agent-args` | Arguments for the agent, as a list of strings. They go where the agent pack’s `command` has its `agent-args` slot, and anything after `--` on `box run` still comes last. An element can hold a placeholder, checked as one in `command`, and takes no `when`. |
| `file-attributes` | `false` stops the agent and its tools from setting file times in the folders they write on macOS. It is `true` unless you run `box` as root, so `touch`, `cp -p`, and lock files work. See [File times on macOS](/docs/user-guide/box/limitations/index.md#file-times-on-macos). |
| `[options]` | Sets an [input](/docs/user-guide/box/packs/index.md#inputs) that a pack in `packs` declares, by the input’s full name, such as `bedrock.region = "eu-west-1"`. A value is a string, a whole number, or `true` or `false`, and holds no placeholder. An option that is on or off takes `true` or `false` with or without quotes, so `"false"`, as `box profile create` writes it, works too. |
| `[project] access` | How much of your project the agent, its tools, and its MCP servers reach. See [Project access](#project-access). |
| `[filesystem] deny_write` | Folders that no process in the box can change, such as `${{ workspace }}/.venv`. `box` adds each one to the agent, each tool, and each MCP server that can write it. See [Protect a folder the agent runs from](/docs/user-guide/box/profiles/index.md#protect-a-folder-the-agent-runs-from). |
| `[filesystem] deny` | Paths that no process in the box can reach, such as a folder of keys. `box` adds each one to the agent, each tool, and each MCP server, and refuses the box’s shell and Python a read or change there. `[filesystem]` holds no other key but a `when` for the whole table. See [Keep a folder away from every process](/docs/user-guide/box/profiles/index.md#keep-a-folder-away-from-every-process). |
| `[banner] enabled` | `false` turns off the activity banner for this profile, and `true` turns it on. [`[banner]`](/docs/user-guide/box/reference/box-config/index.md#banner) says which setting wins. See [The activity banner](/docs/user-guide/box/reference/cli/index.md#the-activity-banner). |
| `[limits]` | Limits of the box’s shell. See [Limits](#limits). |
| `[experimental-features]` | See [Experimental native filesystem policy](#experimental-native-filesystem-policy). |
| `[agent]`, `[tool.<name>]`, `[egress.<name>]`, `[mcp.<name>]`, [`[storage]`](/docs/user-guide/box/packs/index.md#storage) | Additions to what the packs say, such as a second project folder in `[agent.filesystem]` or your own credential in `[egress.bedrock.secret]`. They merge over the packs, as [Merge order](#merge-order) states. |
| `[telemetry]` | Where the box exports its records, such as to an OTLP collector. Box’s [`[telemetry.<label>]` reference](/docs/user-guide/box/reference/configuration/index.md#telemetrylabel) lists the keys. A target’s `project`, `region`, `log_group`, and `log_stream` can hold [placeholders](#which-fields-take-a-placeholder), so a target can read them from your machine. So can its `destination`, unless it’s a `file` target. |
| `[secret-source.<scheme>]` | A [secret source](/docs/user-guide/box/plugins/index.md) of your own, with the full path of its program as the first element of `command`. It reads no input of a pack or a plugin, and no `${{ root }}` or `${{ tool.<name>.root }}`, so you write each value of `command` yourself. A program, the interpreter that its `#!` line starts, or a path that its `command` names in full, such as the path in `-config=<path>`, that sits in your project, in `~/.strands/box`, or in a folder the agent can write, even through a link, stops the run, whatever the project access, and a `deny_write` doesn’t change that. The path can be a file, a folder, or a path where nothing is yet, and a folder in `command` that holds a folder the agent can write stops the run too. `box` doesn’t check a path that `{ref}` completes. Use a plugin instead when more than one profile needs it. A profile file that you run by its path can’t hold one ([Rules](/docs/user-guide/box/plugins/index.md#a-profile-file-that-runs-by-its-path)). Its keys are Box’s: Box’s [`[secret-source.<scheme>]` reference](/docs/user-guide/box/reference/configuration/index.md#secret-sourcescheme) lists them, and [A message from Box Core](/docs/user-guide/box/plugins/index.md#a-message-from-box-core) maps them to the keys of a plugin. |

A profile holds no `extend`, `[inputs]`, `[pack]`, or `[[mcp-servers]]`, and `box` stops at any other key it does not know. `box run` sets a few keys for each run, so `box` refuses a profile that holds one of them:

| Key | What `box run` does instead |
| --- | --- |
| `name`, `box_dir` | Gives each run its own name and folder in `~/.strands/box/r/`. |
| `workspace`, at the top, in `[agent]`, or in a `[tool.<name>]` | Uses your project. |
| `policy` | Sets the run’s generated `policy.dw` file. |
| `[telemetry.records]` | Writes the run’s decisions to `records.jsonl` in the run folder. |

## `file-watching`

`file-watching = true` lets one process watch files through macOS FSEvents, which also shows it the names of files that it cannot read. It is `false` unless a table sets it, each table decides for its own process, and Linux ignores the key. [File watching on macOS](/docs/user-guide/box/limitations/index.md#file-watching-on-macos) describes the risk and a polling alternative.

| Table | Process | File that holds it |
| --- | --- | --- |
| [An agent pack’s `[run]`](/docs/user-guide/box/packs/index.md#an-agent-packs-run) | The agent. | An agent pack. |
| A [tool pack’s](/docs/user-guide/box/packs/index.md#tool-packs) `[run]` | The pack’s tool. | A tool pack. |
| [`[agent]`](#the-agent-table) | The agent. | A profile, or a support pack. |
| `[tool.<name>]` | The tool `<name>`. | A profile, or an agent or support pack. |
| [`[mcp.<name>]`](#mcpname-in-a-profile) with `type = "stdio"` | The MCP server `<name>`. | A profile. |

A profile’s table replaces a pack’s value, so `file-watching = false` in a profile’s `[tool.<name>]` turns off what the tool pack’s `[run]` sets.

## Limits

`[limits]` holds the limits of the box’s shell. Only a profile holds it.

| Key | What it limits |
| --- | --- |
| `shell.timeout` | How long one command that the agent sends to the box’s shell may run, in seconds, from 1 to 31536000 (one year), or `false` for no limit. The default is `false`: `box` sets no Shell timeout, so the agent’s own tool timeout applies, as it does outside a box. Set `[limits] shell.timeout = <seconds>`, such as `shell.timeout = 600`, to stop a command that runs longer. Box Core’s own limits for Python still apply to `python` and `python3`, whatever this value is. See [Box Core’s Shell page](/docs/user-guide/box/reference/shell/index.md#limitsshelltimeout). |
| `shell.max_input` | The command text that the agent sends to the shell at once, in bytes, or `0` for no limit. The default is `262144` (256 KiB). Longer text is refused with `input too large`. |
| `shell.max_stdin` | The standard input that one command run through the box’s `zsh`, `bash`, or `sh` receives, in bytes. The default is `1048576` (1 MiB), and it cannot be turned off. Past the limit, a command that reads all of its input waits until `shell.timeout`, or until its caller stops it when `shell.timeout` is `false`, the default. |
| `shell.max_output` | Each output buffer of the shell, in bytes, or `0` for no limit. The default is `1048576` (1 MiB). A command that holds its input, such as `x=$(cat)` or `jq`, or a group with a redirect, such as `{ cat; } > file`, needs this raised beside `shell.max_stdin`. |

A larger limit lets the shell hold more data in the box’s trusted process. Box’s [`[limits]` reference](/docs/user-guide/box/reference/configuration/index.md#limits) has the details.

## The `[agent]` table

An agent pack writes these keys in `[run]`, `[env]`, and `[filesystem]`. A support pack and your profile write them in `[agent]`, `[agent.env]`, and `[agent.filesystem]`, and they merge over the agent pack’s.

| Key | What it does |
| --- | --- |
| `command` | The agent’s program and its arguments, as in [An agent pack’s `[run]`](/docs/user-guide/box/packs/index.md#an-agent-packs-run). |
| `dependency` | A list of other tables. It changes nothing about the run. |
| `env` | The agent’s variables, by name. A value is a string, a `{ value = ..., when = ... }` table, or a `{ from = "env:<NAME>" }` table ([A variable from the shell](#a-variable-from-the-shell)). |
| `filesystem` | The paths the agent reaches, in the lists below. Each entry is a [path](#paths) or an [entry table](#entry-tables). |
| `file-watching` | See [`file-watching`](#file-watching). |
| `ingress` | Only in `[agent]`, so not in an agent pack. A port where the box takes callers and relays them to a server that the agent runs in the box, written as one `[[agent.ingress]]` table for each port, up to five. `listen` is the address that `box` binds, such as `"127.0.0.1:8080"`, and `workload_port` is the port of the agent’s server, such as `8081`. A profile’s tables add to the packs’. A profile table whose `when` holds replaces the packs’ tables for its `workload_port`, such as to listen on `127.0.0.1` instead of `0.0.0.0`. The values hold no placeholder. Ingress is experimental in Box Core, so `box` turns it on for the run. Box’s [`[[agent.ingress]]` reference](/docs/user-guide/box/reference/configuration/index.md#agentingress) has the rules. |
| `native-filesystem-policy` | Only in a profile. See [Experimental native filesystem policy](#experimental-native-filesystem-policy). |
| `when` | A condition that keeps the table. See [`when`](#when). |

| List | What an entry does |
| --- | --- |
| `read`, `write` | Grants reading or writing the path, and everything below a folder. Pair a `write` entry with a `read` entry for the same path. |
| `read_file`, `write_file` | Grants reading or writing one file. |
| `list` | Grants listing a folder without reading its files, on macOS. Linux refuses this list. |
| `metadata` | Grants reading file properties below a folder, on macOS. Linux ignores it. Not in a tool table. |
| `exec` | Grants running the path, or the programs below a folder. Not in a tool table. |
| `deny` | Refuses the path, even when another list grants it. On Linux, the path must exist when the run starts. To refuse it to every process, list it once in the profile’s `[filesystem] deny`. |
| `deny_write` | Keeps a folder that a `write` entry holds read-only for this process: it can read and run the folder, and cannot change it. The entry names an existing folder, not a file. Every process whose write grant reaches the folder must hold it, or `box` refuses to run a program from it, so list it once in the profile’s `[filesystem] deny_write`. [Protect a folder the agent runs from](/docs/user-guide/box/profiles/index.md#protect-a-folder-the-agent-runs-from) shows how. |

Box’s [filesystem reference](/docs/user-guide/box/reference/configuration/index.md#agentfilesystem-and-toolnamefilesystem) has the details of each list. The agent never gets your shell’s environment, and `box` gives it read and write on its storage and, with [Project access](#project-access), your project. Add only what else the agent needs.

### Entry tables

Each entry of a filesystem list is a path string. To give an entry a condition, write it as a table:

```toml
[agent.filesystem]
read_file = [
    "${{ pack }}/settings.json",
    { path = "/opt/homebrew/etc/openssl@3/openssl.cnf", optional = true, when = "macos" },
]
```

| Key | What it does |
| --- | --- |
| `path` | Required. A [path](#paths). |
| `optional` | `true` drops the entry when the path does not exist, or is a link to something that does not exist. Without it, a missing path stops the run. A `deny` entry can be `optional` too, and then it refuses nothing when the run starts without the path, even if the path appears later. |
| `when` | A condition that keeps the entry. See [`when`](#when). |

An entry table holds no other key.

### A variable from the shell

An `env` value of `{ from = "env:<NAME>" }` passes one variable of the shell where you type `box run`, by name. When the shell sets it, the program gets its value, as written, with no placeholders filled in. When the shell does not set it, the program gets no such variable.

```toml
[agent.env]
MAX_THINKING_TOKENS = { from = "env:MAX_THINKING_TOKENS" }
```

A `from` works only in the `env` table of `[agent]`, a tool, or an MCP server, and the table holds only `from` and `when`. The agent can read a value passed this way, so don’t pass a key: give it to a [route](#routes-and-other-hosts) instead. `box` refuses a `from` for a variable that a route reads as a credential. A value that your profile sets in its own `env` replaces the pack’s `from`. `box profile show` lists each variable it passes, with its value.

## Placeholders

Every value that `box` fills in is a TOML string. `${{ name }}` in a string is a placeholder, and `box` replaces it with the value of `name` when the run starts. The rest of the string stays as written.

| Name | Value |
| --- | --- |
| `workspace` | Your project, as a full path with links resolved. |
| `workspace.dashed` | That path with each character other than an ASCII letter or digit replaced by `-`, such as `-Users-you-src-my-app`: the name Claude Code gives a project’s folder. |
| `workspace.parent` | The folder that holds your project, such as `/Users/you/src`. Repeat the step to go further up, as `workspace.parent.parent`. `dashed` goes only right after `workspace`, so `workspace.parent.dashed` is an error. |
| `home` | Your home directory. |
| `pack` | The folder of the file that holds the placeholder. In a pack, it is that pack’s folder, wherever the profile that uses it lives. |
| `profile` | The folder of the profile you run: `~/.strands/box/profiles/<name>`, or the folder of a profile file. |
| `profile.file` | The profile’s own file: `~/.strands/box/profiles/<name>/profile.toml`, or the profile file you ran. |
| `box` | The run’s own box folder. The box’s shell is in `${{ box }}/bin`. |
| `storage.<dir>` | A storage directory that `[storage] directories` names. In a tool table, a directory of the tool’s [own storage](/docs/user-guide/box/packs/index.md#give-a-tool-its-own-storage) comes first. |
| `inputs.<name>` | The value of an [input](/docs/user-guide/box/packs/index.md#inputs). |
| `root` | The folder that holds the real file of a program, after links. In a tool pack, it is the pack’s own tool, the same as `tool.<name>.root`. In an `[agent]` table, it is the program that `[agent] command` runs. Anywhere else, it is an error. See [Root and its steps](/docs/user-guide/box/packs/index.md#root-and-its-steps). |
| `tool.<name>.root` | `root` for the program that `[tool.<name>]` runs, such as `/opt/homebrew/Cellar/git/2.56.0_1/bin`. |
| `cache` | In a tool table, the tool’s cache at `${{ workspace }}/.cache/<name>`, which the tool creates when needed. When an MCP server uses the tool’s pack, it is the server’s cache in profile storage. Anywhere else, it is an error. |
| `macos.developer_dir` | The Apple developer folder that `xcode-select -p` reports, such as `/Library/Developer/CommandLineTools`. Only in a value under `when = "macos"`. If `xcode-select` fails, the tool that names it is skipped. |
| `macos.toolchain` | The folder in the developer folder that holds `cc`, such as `/Library/Developer/CommandLineTools/usr/bin`. The same rules as `macos.developer_dir`. |
| `macos.sdk_root` | The macOS SDK in the developer folder, such as `/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk`. The same rules as `macos.developer_dir`. |

`box` refuses any other name.

| Rule | Detail |
| --- | --- |
| Spaces | `${{ home }}` and `${{home}}` are the same. |
| Escape | `$${{` writes a literal `${{`. |
| Other syntax | `box` leaves `$HOME`, `${HOME}`, and `{{ home }}` as written. But the box reads `${NAME}` in a `command` argument itself: it fills in its own telemetry variables, such as `${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT}`, and refuses to start the run for any other name. |
| One pass | `box` fills in each value once. A value that holds `${{` after that stays as it is. |
| Keys | A table key holds no placeholder. |

### Which fields take a placeholder

| Field | Tables |
| --- | --- |
| Each element of `command` | `[agent]`, `[tool.<name>]`, `[mcp.<name>]`, `[secret-source.<scheme>]`, and the `[run]` of a [plugin](/docs/user-guide/box/plugins/index.md#run) |
| Each element of `agent-args` | A profile |
| Each value in `env` | `[agent.env]`, `[tool.<name>.env]`, `[mcp.<name>.env]`, and `[env]` in a tool pack |
| Each entry of a filesystem list: `read`, `write`, `read_file`, `write_file`, `list`, `metadata`, `exec`, `deny`, `deny_write` | The `filesystem` table of `[agent]`, `[tool.<name>]`, and `[mcp.<name>]`, `[filesystem]` in a tool pack, and `[filesystem] deny` and `deny_write` in a profile. A tool table takes no `metadata` or `exec`. |
| Each entry of `destinations` | `[egress.<name>]`, `[mcp.<name>]` |
| `url` | Each `[[egress.<name>.backends]]` or `[[mcp.<name>.backends]]` row |
| `auth.aws.region` | Each `[[egress.<name>.backends]]` or `[[mcp.<name>.backends]]` row |
| `project`, `region`, `log_group`, `log_stream` | Each `[telemetry.<label>]` target, of any `kind` |
| `destination` | Each `[telemetry.<label>]` target whose `kind` isn’t `file` |
| `when` | Any table or entry that takes [`when`](#when) |
| `default`, and each folder of `search` | `[inputs.<name>]` |
| `source`, and each key in `keep` | Each `[[storage.files]]` row |
| `value`, and each key in `key` | Each `[[storage.files.set]]` row |
| `file`, and each element of `key` | Each `[[mcp-servers]]` row |

A placeholder in any other field is an error. That includes `packs`, `plugins`, `extend`, the `secret` keys of a route or a telemetry target, a telemetry target’s `kind`, `include`, `accepts`, and `headers`, the `destination` of a `file` target, the `[pack]` header, and each `[options]` value. So write out a `file` target’s path, such as `/var/log/box/records.jsonl`.

To send telemetry to a log group that only the machine knows when the run starts, declare an input in a pack that reads the name from a variable:

```toml
[inputs.runtime.log_group]
from = "env:RUNTIME_LOG_GROUP"

[telemetry.runtime]
kind = "cloudwatch_logs"
region = "us-west-2"
log_group = "${{ inputs.runtime.log_group }}"
log_stream = "box"
secret.ref = "aws://"
```

Box checks each value that `box` fills in when the run starts, the same way it checks the ones you write out. One check is extra: a `project` value that comes from a variable or a `default` can’t start or end with white space.

### Paths

A filesystem list entry is a path. So is a `command` element that is the program (the first element) or that starts with a path name, such as `${{ home }}` or a `program` input, and an `agent-args` element that starts with a path name. In a path:

1.  If the path holds a placeholder, one comes first: `"${{ home }}/.config"`, not `"/Users/${{ home }}"`.
2.  Each later placeholder fills one folder or file name. Its value holds no `/`, and it is not `.` or `..`.
3.  The result is an absolute path, or a path that starts with `~/` for your home directory, and it holds no `..`.

`box` refuses a path that goes through a link inside a folder the box can write, because the agent could change that link. Those folders are your project, the run’s storage, `~/.strands/box`, and each folder that a `write` entry names. Name the real path instead. A link above such a folder is fine, such as `/tmp` on macOS. An entry whose path does not exist stops the run, so mark an entry that some machines lack `optional = true`. [Values](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/design/cli/profile-language.md#values) says how `box` writes each value safely into the run’s files.

## `when`

`when` keeps an entry, a table, or one value only when its condition holds. It goes on:

-   An [entry table](#entry-tables) in a filesystem list.
-   A table inside another table, such as `[egress.<name>]`, `[tool.<name>]`, or `[mcp.<name>]`.
-   One value, written as `{ value = ..., when = ... }`: a key in a table, such as one variable in `[agent.env]`, or one element of `command`.

| Condition | Holds when |
| --- | --- |
| `"macos"`, `"linux"` | The run is on that operating system. |
| `"${{ inputs.<name> }}"` | The `bool` input is `true`. `when` has no `not`, so declare the `bool` so that `true` turns the entry on. |
| `{ variable = "inputs.<name>", equals = "<text>" }` | The input, named without `${{ }}`, has that value. The table holds only `variable` and `equals`. |

When the condition on a `command` element does not hold, the element is gone. So a flag and the value after it each need the same `when`:

```toml
[run]
command = [
    "${{ inputs.team.program }}",
    { value = "--provider", when = { variable = "inputs.team.host", equals = "bedrock" } },
    { value = "bedrock", when = { variable = "inputs.team.host", equals = "bedrock" } },
]
```

The first element of a `command` is the program, and it takes no `when`. Use an input such as `${{ inputs.team.program }}` to choose the program. A route’s `secret` takes no `when` either. A placeholder in `when` that gives anything other than `true` or `false` is an error.

`box` applies `when` after the merge, so a table that drops out takes with it what every pack and your profile put there. A `when` on `[agent.env]` removes all of the agent’s variables, for example.

## `[requires]`

`[requires]` says what a file needs of the `box` that reads it. A profile, a pack, and a plugin each can hold one, and `box` checks each file’s own table when it reads the file, before the merge. When a requirement does not hold, `box` refuses the file and names it. `[requires]` only checks: it loads nothing, and it is not merged into the profile.

```toml
[requires]
box = ">=0.3.0"
```

| Key | What it does |
| --- | --- |
| `box` | The oldest version of `box` that reads this file, as `>=X.Y.Z`. An older `box` refuses the file with `this pack needs box >=0.3.0, and this is box 0.2.3`. A preview build of `box`, such as `0.3.0-preview.1` or `0.3.0-linux-preview.1`, counts as its release, `0.3.0`. |

`box` checks `box` first. So when a later `box` adds a requirement, an older `box` that reads it names the version to update to. A requirement that this `box` does not know is refused.

## Merge order

`box` merges each name in `packs` after its own `extend`, left to right, each pack once, then each [plugin](/docs/user-guide/box/plugins/index.md) in `plugins`, and your profile last, so the profile wins. Tables merge key by key, and a later file can change a key but cannot remove one. These lists join: the filesystem lists, `dependency`, `[storage] directories`, the `[[storage.files]]` and `[[storage.hooks]]` rows, the `[[mcp-servers]]` rows, and a tool’s own `directories` and `files` in `[tool.<name>.storage]`. Every other list is replaced, `command` included, so add arguments to the agent with `agent-args`.

Each route and each `env://` variable a route reads comes from one pack, though your profile can change a route’s keys. To replace a tool that `box` finds, write its `[tool.<name>]` in your profile, or in your own pack, with a `command` and no `program`, as [A tool table in the full form](#a-tool-table-in-the-full-form) says. [Composition](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/design/cli/profile-language.md#composition) has the full rules.

## Routes and other hosts

A route lets the box reach its hosts, and `box` writes the permits for them, so a route needs no policy file. With `secret.ref = "env://GITHUB_TOKEN"`, the agent’s `GITHUB_TOKEN` holds a placeholder, and you write nothing in `[agent.env]` for it. [Credentials](/docs/user-guide/box/how-box-works/index.md#credentials) says how the real token reaches the host.

```toml
[egress.github]
destinations = ["api.github.com"]
secret.ref = "env://GITHUB_TOKEN"
```

| Key | What it does |
| --- | --- |
| `destinations` | Required. Up to 100 hosts, each with an optional `:port`, such as `api.github.com`. Not a URL. On a route with a credential, an entry can also hold a path, such as `api.example.com/v1`, and `*.example.com` matches every host below `example.com`, but not `example.com` itself. A route with no credential takes neither, as the list below says. |
| `secret.ref` | Where the credential comes from: `env://<NAME>` for a variable in the shell where you run `box run`, `aws://<profile>` for an AWS profile, `aws://` with no profile to sign with your default AWS identity, or a reference in a scheme that a [plugin](/docs/user-guide/box/plugins/index.md) or your profile declares, such as `op://`, which that source’s program reads when the box starts. An input’s `from` spells a variable `env:<NAME>`, with no `//`. Without it, the route has no credential. |
| `secret.header` | The request header that carries the credential, such as `x-api-key`. The default is `Authorization`. |
| `secret.prefix` | The text before the credential in the header, such as `"token "` for `gh`. The default is `Bearer` on `Authorization`, and nothing on another header. |
| `secret.phantom_prefix` | The start of the placeholder key, such as `sk-ant-`, for an agent that checks the format of its key. The default is `strands_box_`. |

For the other `secret` keys and `[[egress.<name>.backends]]`, see Box’s [`[egress.<name>]` reference](/docs/user-guide/box/reference/configuration/index.md#egressname).

With an `env://` reference, the agent gets one placeholder key for all the route’s hosts. Two routes in one pack, or in your profile, can read the same variable if they have the same `secret.phantom_prefix`, or none on both. Two packs cannot read one variable, because the placeholder works at every host that reads it.

A route that holds only `destinations` is a route with no credential, such as the login service an agent signs in to:

```toml
[egress.login]
destinations = ["oidc.us-east-1.amazonaws.com"]
```

-   The box reaches each host on port 443 unless you write another, such as `builds.example.com:8443`. Write host names in lowercase, with no `https://`. A route with no credential takes no path and no `*`.
-   Every program in the box can reach these hosts, not only the agent, so list only hosts you trust. `box profile show` lists such a route with “no credential”.
-   If the agent signs in through one of these hosts inside the box, its login stays in the box’s storage, where every program in the box can read it.

A route with any other key is a route with a credential, so a typo such as `secrets.ref` stops the run instead of opening the hosts. For the same reason, a route’s `secret` takes no `when`: to use a credential on one system only, write two routes, each with its own `when`. Your profile can replace a pack’s `destinations`, or add `secret.ref` to give a route a credential.

### `aws://` credentials

A provider pack’s route names where its key comes from. Your profile can point it elsewhere with `[egress.<route>.secret] ref`, and `box profile show --full` names the routes.

`aws://<PROFILE>` works only on a route that takes a signed request. It signs with the profile’s static keys, `credential_process`, assume-role, or web identity. `aws://` with no profile name signs with the first credentials that the AWS SDK finds outside the box, in this order:

1.  The `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` variables in the shell where you run `box run`.
2.  The profile in `~/.aws/config` and `~/.aws/credentials` that `AWS_PROFILE` names, or `default`.
3.  Web identity, such as an EKS service account.
4.  The ECS or EKS container credentials endpoint.
5.  EC2 instance metadata.

So on a cloud machine, `aws://` can sign as the machine’s own role. The box prints a [warning](/docs/user-guide/box/guides/network-and-credentials/index.md#credential-sources) about it.

Neither form signs with an AWS SSO or `aws login` profile ([AWS credentials resolve to nothing](/docs/user-guide/box/troubleshooting/index.md#aws-credentials-resolve-to-nothing)).

Both `aws://` forms run any `credential_process` in your AWS configuration outside the box. The box can’t write `~/.aws`, but if you move that configuration with `AWS_CONFIG_FILE` or `AWS_SHARED_CREDENTIALS_FILE`, keep the new place out of your project and every other folder the box can write.

## Project access

`[project] access` sets how much of your project `box` gives the agent. It covers the agent, each tool a pack names, and each MCP server on your machine that `box` finds in the agent’s settings. Only a profile holds `[project]`.

| `access` | The agent and its tools can |
| --- | --- |
| `"write"` | Read, change, delete, and move files in your project. |
| `"read"` | Read your project, and change nothing in it. |
| `"none"` | Neither read nor change your project. They still start in it. |

`box profile create` writes the value that the policy you picked gives ([Pick the agent’s policy](/docs/user-guide/box/starters/index.md#pick-the-agents-policy)). A profile without `[project]` gets no access to your project, and `box run` says what to add:

```text
box: profile claude gives the agent no access to this project; to allow it, add `[project] access = "write"` to ~/.strands/box/profiles/claude/profile.toml
```

With `"read"` or `"none"`, `box run` prints one line that says so when the run starts. `access` sets what `box` adds by default. A filesystem entry in a pack or in your profile that names a folder in your project still applies on top of it, so a pack can give the agent more of your project than `access` says. `box profile show --full` prints every entry a run gets.

## MCP servers

[MCP servers in the box](/docs/user-guide/box/limitations/index.md#mcp-servers-in-the-box) says what importing them lets the agent do, and [An MCP server has no automatic declaration](/docs/user-guide/box/troubleshooting/index.md#an-mcp-server-has-no-automatic-declaration) says what to change when `box` declares no server. A pack names the files that hold the agent’s servers in [`[[mcp-servers]]`](/docs/user-guide/box/packs/index.md#mcp-servers-in-a-pack).

### `[mcp.<name>]` in a profile

An `[mcp.<name>]` table names a server by its name in the agent’s settings. That name uses only letters, digits, `.`, `_`, and `-`, or `box` declares no server for it.

| Table | Who holds it | What it does |
| --- | --- | --- |
| With a `type` (`"stdio"` or `"http"`) | Only a profile. | Declares the server yourself, with Box’s [`[mcp.<name>]`](/docs/user-guide/box/reference/configuration/index.md#mcpname) keys. It takes the place of the server `box` would declare. |
| Without a `type` | A profile, or a pack (only `filesystem` and `network`). | Adds to a server that `box` declares: grants in `filesystem`, and `destinations` for a server at a URL. The packs’ tables apply first, then your profile’s. If `box` declares no server of that name, it leaves the table out and says so. It gives the server no key: a `secret` that adds to or changes the server’s own key leaves the server out. To give a server a key, declare it with a `type` and its own `destinations`. |

```toml
[mcp.fetch.filesystem]
read = ["${{ home }}/notes"]

[mcp.docs]
destinations = ["cdn.example.com"]
```

-   With a `type`, the agent still starts the server from its entry in the agent’s settings. When your table’s command has the entry’s program name and arguments, `box` writes the entry with the program name alone, without its folder, and leaves out its environment fields. The agent then starts your server, and can’t read the keys that entry held. Otherwise the entry stays as it was imported, keys included, and the `no automatic MCP declaration` line for the server says so. One case differs: an entry whose `env` sets a variable that a [secret source](/docs/user-guide/box/plugins/index.md) passes to its program as a credential, or holds your value of one, loses its `env` too. It keeps its command, and the line for the server has no such note. An entry whose arguments hold your value of one loses its arguments, whether or not your table matches it, so the agent can’t pass that value to a server. The same name alone is not enough. So keep the entry’s program name and arguments the same as your table’s, and after you change them, update the entry and follow the [refresh steps](/docs/user-guide/box/troubleshooting/index.md#box-lists-an-mcp-server-but-my-agent-doesnt-show-it).
-   `destinations` adds hosts that the agent can reach for that server, and the server keeps its own host. If the server takes a key, the box sends that key to these hosts too. A host that another server or a route uses stops the run, and a `*.` wildcard that overlaps the server’s own host and port declares no server.
-   When you add to a server, `box` checks its fixed file arguments. If one names an existing file that a program in the box can write, such as `--db-path=data.sqlite` in your project, the run stops. The arguments the agent supplies are not checked, so give the server only the grants those calls need.
-   In a pack, a `when` goes on one filesystem entry, not on the table.

### Install an MCP server from a private npm registry

A local server that installs from a private npm registry needs your `.npmrc` and a route to the registry. npm takes the credential from `.npmrc`, so the route needs no `secret`:

```toml
[mcp.tickets.filesystem]
read_file = ["${{ home }}/.npmrc"]

[egress.npm-private]
destinations = ["npm.example.com"]
```

The server can read every credential in that file, though the agent can’t, and every program in the box can reach the registry. If the server runs with a `HOME` of its own, also set `npm_config_userconfig = "${{ home }}/.npmrc"` under `[mcp.tickets.env]`.

## Tools

A tool is a program that the agent runs from its shell, such as `git` or `npm`. A [tool pack](/docs/user-guide/box/packs/index.md#tool-packs) writes one tool, and a `[tool.<name>]` table in a profile or a pack adds to a tool or writes one. [Add or remove a toolchain](/docs/user-guide/box/profiles/index.md#add-or-remove-a-toolchain) shows how a profile picks its tools. Local MCP servers reuse the launcher packs, such as `@box/npx`, without the pack in `packs`.

When a run starts, `box` finds each tool’s `program` on your `PATH`, the same one the agent gets when it types the name. It skips a tool whose program is missing, or is in your project, the run’s storage, `~/.strands/box`, or a folder the agent can write, and prints a line such as `box: skipped tool cargo (@box/cargo): cargo is not on PATH`. In a tool table with a `program`, a grant whose path is not on your machine is dropped, and a `*` in one part of a path matches each name that is there, so `${{ root.parent }}/share/node-*` finds `share/node-20`. A `deny` entry stays as written and holds no `*`. `box profile show` lists each skipped tool and each path it dropped. [Resolution](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/design/cli/profile-language.md#resolution) has the background, including scripts whose `#!` line names another tool.

Each tool with a `program` gets `PATH = "/usr/bin:/bin"` and its own empty `TMPDIR`, unless its table sets them, and reads and writes your project as [Project access](#project-access) says.

### A tool table in the full form

A profile’s `[tool.<name>]` merges onto the tool of that name, as [Change a toolchain’s settings](/docs/user-guide/box/profiles/index.md#change-a-toolchains-settings) shows. A pack of your own can also hold a whole tool table, such as `[tool.rt]` with `program = "rt"`. Then it is not a tool pack, and it names `tool.rt.root`, not `root`. A table in the full form takes the keys of a tool pack’s `[run]` other than `command`, the tool pack’s tables under the tool’s name, such as `[tool.rt.env]`, and these keys:

| Key | What it does |
| --- | --- |
| `program` | The name the agent types, such as `rt`. `box` finds the first one on your `PATH`. A table with `program` holds no `command`. |
| `command` | In place of `program`: the program and its arguments, as in `[agent]`. `box` then adds no project access, `PATH`, `TMPDIR`, or installation files, so declare what the command needs, and add a `shell:spawn` permit to a file that the profile’s `policies` lists. A pack can hold the table, but not the permit. |
| `grammar` | The program’s tool grammar, as `[tool.<name>.grammar]` in a profile or a pack that is not a tool pack. See [Tool grammars](/docs/user-guide/box/packs/index.md#tool-grammars). |
| `dependency` | A list of other tables. It changes nothing about the run. |
| `network` | Only in a profile: `[tool.<name>.network] contain_egress = false` lets the tool connect outside the box’s gateway. See [Let a tool connect directly](#let-a-tool-connect-directly) for the risk. The table takes no `when`, but the value does. |
| `native-filesystem-policy` | Only in a profile. See [Experimental native filesystem policy](#experimental-native-filesystem-policy). |

A tool with an explicit `command`, and the permit it needs in a policy file:

```toml
[tool.jq]
command = ["/usr/bin/jq"]

[tool.jq.filesystem]
read = ["${{ workspace }}"]
```

```text
@id("spawn_my_jq")
permit (principal, action == Box::Action::"shell:spawn", resource)
when { context.input.program_path == "/usr/bin/jq" };
```

### Let a tool connect directly

A tool’s connections go through the box’s gateway, where your policy decides each one, and the gateway carries only HTTP and HTTPS. So a tool that connects another way, such as a database client that reaches its host over plain TCP, can’t connect from the box. To let it, turn the gateway off for that one tool:

```toml
[tool.psql.network]
contain_egress = false
```

This doesn’t make SSH work for git: the box has no `ssh`, as the [`@box/git` README](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/resources/packs/git/README.md#limitations) says.

Know what that gives away. The tool, and every program it starts, can then connect to any host, outside your policy, and no credential from a route reaches it. The agent picks the tool’s arguments, so it can aim those connections wherever it likes. Don’t set it on a general client such as `curl`, or on an interpreter. The tool still reaches only the files it’s granted, so a client such as `ssh` needs grants for its program and for what it reads, such as an SSH agent socket, and the box refuses a grant in `~/.ssh`.

To turn the gateway off on one system only, put `when` on the value: `contain_egress = { value = false, when = "macos" }`. Only your profile can hold this table, not a pack.

## Experimental native filesystem policy

With native filesystem policy, your policy also decides the file operations that the agent, its tools, and its local MCP servers make directly, on top of their filesystem grants. It needs a `box` built with the `native-filesystem-policy` Cargo feature, and:

-   On macOS: macOS 27 or later, and a `box` built with the macOS 27 SDK or later, with a valid signature and Apple’s Endpoint Security entitlement.
-   On Linux: an ARM64 machine with the required kernel support, and the `CAP_BPF` and `CAP_PERFMON` capabilities for `box`, which a normal install does not give it. Linux x86-64 refuses selection.

See the [prerequisites in Box’s own guide](/docs/user-guide/box/security/native-filesystem-policy/index.md) and the [build instructions](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/dev/manual-testing.md#build-the-native-filesystem-policy-experiment).

Turn it on in `profile.toml`. Only a profile holds this table:

```toml
[experimental-features]
native-filesystem-policy = true
```

| Key | What it does |
| --- | --- |
| `[experimental-features] native-filesystem-policy` | `true` turns it on for every process. It is `false` unless you set it. Write `true` or `false` without quotes, or `{ value = true, when = "macos" }`. The condition tests the operating system, not its version or build. |
| `native-filesystem-policy` in `[agent]`, `[tool.<name>]`, or a local `[mcp.<name>]` | `false` opts that process out. `true` is refused while the global value is `false`. Without it, the process takes the global value. |

An `[agent]` opt-out does not change the default for tools or servers. Remote MCP servers take no setting. A pack that sets `[experimental-features]` or `native-filesystem-policy` anywhere, even to `false`, is refused, and the error names the pack and the field.

A local MCP server that a launcher pack such as `@box/npx` starts writes its cache in the profile’s storage. With this feature on, your policy would decide those writes, and the [`box_home_write`](/docs/user-guide/box/policies/index.md#generated-policy) rule would refuse them, because your policy can’t tell the server from the agent. So `box` doesn’t start such a server, and prints `no permit to start MCP server <name>` with the fix: `native-filesystem-policy = false` in its `[mcp.<name>]` table.

The box refuses to start a run that turns it on when it cannot check, so a `box` without support never runs the profile unchecked. `box profile show --full` prints each process’s setting, but it starts no box and does not prove the checks run. The checks do not cover every file operation, and they do not take back access through a file that is already open.

On macOS, native policy checks need the `box` process to stay alive. If an uncatchable signal such as `SIGKILL` terminates it, programs in the box can survive. Those programs can then perform new file operations within their existing filesystem grants without native policy checks, so previously denied operations can succeed. Because `box` cannot catch that signal, it cannot run its normal shutdown cleanup.

[Experimental native filesystem policy](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/design/cli/profile-language.md#experimental-native-filesystem-policy) has the background.

## Errors

A misspelled key or option names its file and line, and ends with `did you mean` and the name you probably meant. Other errors name the file and the field, and most say what to do. [A profile has a mistake](/docs/user-guide/box/troubleshooting/index.md#a-profile-has-a-mistake) covers the messages that do not.