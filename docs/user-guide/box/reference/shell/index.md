Strands Shell is the shell that runs each command the agent sends to `zsh`, `bash`, or `sh` in a box. Policy decides each command, and each file operation the command makes. A program outside the Shell runs in its own sandbox, separate from the agent’s.

Audience: an operator with a working box from [getting started](../../quickstart/index.md). For the steps, read [write policy for shell commands](../../guides/write-shell-policy/index.md).

## Invocation

On the agent’s `PATH`, `zsh`, `bash`, and `sh` are each the alias, a client program that sends one command to the Shell. Each accepts one of these forms:

| Form | The Shell runs |
| --- | --- |
| `zsh -c COMMAND`, `-lc COMMAND`, `-c -l COMMAND`, `-l -c COMMAND` | `COMMAND` |
| `zsh SCRIPT` | The text of `SCRIPT`. The alias reads the file in the agent’s sandbox, so `[agent.filesystem]` must grant the agent a read of it. |

Any other form is refused with `Shell alias accepts only -c COMMAND, -lc COMMAND, -c -l COMMAND, or SCRIPT`.

Each invocation is one command. A variable exported in one invocation is unset in the next. The Shell starts each command with `HOME` set to the agent’s `HOME`, and with the workspace as its working directory.

## What runs where

The reachable paths check is deny-only and runs after policy. It refuses a path outside the operator’s home, the agent’s home, and the workspace, a path inside the box directory, and the `box.toml` and `policy.dw` the run loaded, whatever a `permit` says.

Once the alias hands a command to the Shell, each command in it runs as follows:

| Inside a command, the agent runs | Action | Where it runs | What bounds its reach |
| --- | --- | --- | --- |
| A builtin or a command the Shell implements | `shell:exec`, then one `fs:*` action for each file operation | In the Shell | Policy, then the reachable paths check |
| A program on the `PATH` of `box run`, such as `git` | `shell:spawn` on the program’s resolved path, or the grammar action when a tool grammar binds the program | Its own sandbox | Its `[tool.<name>]` table or `exec` entry. See [Configuration](#configuration). |
| A program named by a path, such as `./target/debug/app` | `shell:spawn` on the program’s resolved path, or the grammar action when a tool grammar binds the program | Its own sandbox | Its `[tool.<name>]` table or `exec` entry |

The Shell implements these, each in place of a program of the same name on the `PATH`:

-   Builtins: `cd`, `export`, `set`, `alias`, `trap`, `test`, `printf`, `echo`, `read`, `find`, `xargs`, and others.
-   Text: `cat`, `grep`, `sed`, `head`, `tail`, `sort`, `uniq`, `cut`, `tr`, `wc`, `tee`.
-   Files: `ls`, `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `ln`, `chmod`, `touch`, `mktemp`, `readlink`.
-   Data and network: `jq`, `curl`.
-   Interpreters: `lua`, and `python` and `python3`, which run in Monty, Box’s Python interpreter.

Paths outside the operator’s home, the agent’s home, and the workspace, such as `/tmp`, exist only in the Shell’s memory, for one command. A file written to `/tmp` is gone when the command ends.

## `shell:exec`

Decided once for each command the Shell implements, after expansion, including each command that command substitution, `eval`, `source`, `find -exec`, `xargs`, or Lua’s `io.popen` runs.

| Field | Type | Present | Value |
| --- | --- | --- | --- |
| `context.input.command` | String | Always | The command line, rebuilt from the expanded words. |
| `context.input.program` | String | Always | The first word after expansion, such as `grep`. |
| `context.input.arg1`, `arg2` | String | When the command has that many arguments | The first and second arguments. Test each with `has` first. |
| `context.input.arg_count` | Long | Always | The number of arguments. |
| `context.input.cwd` | String | Always | The Shell’s working directory. |
| `context.output.status` | Long | On a `::response` event | The command’s exit status. A program that a signal ends records 128 plus the signal number. |

```text
@id("read_only_commands")
permit (principal, action == Box::Action::"shell:exec", resource)
when { ["cd", "pwd", "ls", "cat", "grep", "head", "tail", "wc"].contains(context.input.program) };
```

## `shell:spawn`

Decided once for each program the Shell does not implement, before Box starts it. A permit starts the program only under the rule in [Configuration](#configuration). `shell:spawn` has every field of `shell:exec`, with these differences:

| Field | Type | Present | Value |
| --- | --- | --- | --- |
| `context.input.program` | String | Always | The first word after expansion, such as `git` or `./target/debug/app`. |
| `context.input.program_path` | String | Always | The file that runs, with every link resolved. A path under the operator’s home starts with `~/`. |
| `context.input.credential_reads` | Set of String | When the matching `[tool.<name>]` lists name a credential store | Each credential store those lists name, such as `~/.aws`. Test it with `has` first. |

```text
@id("built_programs")
permit (principal, action == Box::Action::"shell:spawn", resource)
when { context.input.program_path like "~/src/project/target/debug/*" };
```

A program’s filesystem lists bound its own file operations.

When an experimental [tool grammar](../configuration/index.md#toolnamegrammar) binds the program, Box decides the spawn as the grammar’s action, such as `Tool::git::Action::"push"`, or as `unmodeled` when the grammar can’t read the command, and `shell:spawn` doesn’t decide it. A grammar binds the program file of each `[tool]` and each stdio `[mcp.<name>]` whose command runs its `program`, under that name. A spawn of a bound file by any other name is a `shell:spawn`, except in the refused cases below. For example, macOS `/usr/bin/git` is one file with many names, so with a git grammar on it, `git` is decided by the grammar and `make` is decided by `shell:spawn`. The agent may be able to make a link to a bound file under a name that no grammar binds, and `shell:spawn` decides that spawn too. So pin each `shell:spawn` permit on both `context.input.program` and `context.input.program_path`, such as `program == "make"` with `program_path == "/usr/bin/make"`.

Box refuses a spawn of a bound file before any rule decides it, and no rule can permit it, in these cases:

-   The agent called the file by a name that only a stdio `[mcp.<name>]` declares for it. That name is for the start of that server alone, because the server’s start and the agent’s spawn would otherwise make the same `shell:spawn` request.
-   The file at a bound path is no longer the file that the run bound.
-   The agent called a bound name with no path, and the file bound under that name is gone or replaced, so `PATH` would find another file.

A refused spawn enters history as a `shell:spawn` request. After a bound file is replaced or removed, its bound names stay refused until the box restarts.

## `fs:*`

Decided once for each file operation that one of the Shell’s commands makes, on the path with every link resolved.

| Action | `context.input.operation` |
| --- | --- |
| `fs:read` | `Box::FsReadOperation::"read_content"`, `"read_metadata"`, `"enumerate"`, `"read_link"`, `"change_dir"`, `"exec"` |
| `fs:write` | `Box::FsWriteOperation::"write_content"`, `"create_dir"`, `"set_permissions"`, `"symlink"` |
| `fs:delete` | `Box::FsDeleteOperation::"remove_file"`, `"remove_dir"` |
| `fs:move` | `Box::FsMoveOperation::"rename"` |

| Field | Type | Present | Value |
| --- | --- | --- | --- |
| `context.input.path` | String | Always | The resolved path. A path under the operator’s home starts with `~/`, and the home itself is `~`. |
| `context.input.operation` | Enum | Always | One value from the table above. |
| `context.output.result` | Enum | On a `::response` event | `Box::FsResponseResult::"completed"`, `"descriptor_issued"`, or `"indeterminate"`. |

```text
@id("project_read")
permit (principal, action == Box::Action::"fs:read", resource)
when { context.input.path == "~/src/project" || context.input.path like "~/src/project/*" };
```

To print the whole action schema:

```sh
./box-core/box policy generate-schema --config my-box/box.toml --output-dir /tmp/schema
```

`/tmp/schema/actions.cedarschema` holds every action and field.

## Configuration

Policy decides whether a program outside the Shell runs. These `box.toml` keys decide where. After a `shell:spawn` permit, the program runs under the first of these that covers it:

1.  A [`[tool.<name>]`](#toolname) table that matches it.
2.  An [`[agent.filesystem] exec`](#agentfilesystem-exec) entry.
3.  Neither: the program is refused with status `126`.

### `limits.shell.timeout`

Each submitted Shell call has a 30-second timeout by default. Set `shell.timeout = 600` under `[limits]` to allow ten minutes, or `shell.timeout = false` to disable this limit. See [`[limits]`](../configuration/index.md#limits) for the accepted values.

The allowance covers the full text sent in one call, including multiple commands, pipelines, Python called inside the Shell, and programs the Shell starts. Each new call receives a fresh allowance. Output leaves its deadline unchanged. The Shell alias waits for the broker’s result.

With `false`, both the Shell execution deadline and the broker’s backup deadline are disabled. Calls remain cancellable, and connection and write operations retain their transport timeouts.

Monty’s 120-second active execution limit and 180-second cumulative sleep limit also apply to Python called inside the Shell, including with `shell.timeout = false`. Synchronous Python execution can delay timeout reporting. The direct `python` and `python3` aliases use their [own limits](../python/index.md#limits-and-exit-statuses).

### `[tool.<name>]`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `command` | string array | required | Element 0 is the program, and the rest are fixed leading arguments. A bare name resolves on the table’s `env.PATH`, else on the `PATH` of `box run`. |
| `workspace` | path | the Shell’s working directory when it is inside the agent’s workspace or a path the tool’s lists name, else the agent’s workspace | The program’s initial working directory. |
| `env` | table | empty | Variables the program receives. |
| `filesystem` | table | empty | `read`, `write`, `read_file`, `write_file`, `list`, and `deny`: the paths the program’s own system calls reach. |
| `network.contain_egress` | bool | `true` | How the program reaches the network. See [`[tool.<name>.network]`](#toolnamenetwork). |
| `grammar` | table | none | Experimental. The tool grammar for the program. See [`[tool.<name>.grammar]`](../configuration/index.md#toolnamegrammar). |

A table matches a `shell:spawn` when `program_path` names the command file that Box resolved at startup, and its fixed arguments match the leading arguments of the command. When several tables match, the one with the longest `command` is used. When a table names the file and none matches the arguments, the program is refused.

Configured tool programs remain protected from writes and replacement for the run. Box checks direct writable grants before startup and refuses changes through the Shell after policy permits them. [Configured command integrity](../configuration/index.md#configured-command-integrity) lists the startup constraints and the procedure for operator updates.

```toml
[tool.git]
command = ["git"]

[tool.git.filesystem]
read  = ["~/src/project", "/Library/Developer/CommandLineTools"]
write = ["~/src/project/.git"]
deny  = ["~/src/project/.env"]
```

### `[tool.<name>.network]`

`[tool.<name>.network]` holds one key, `contain_egress`. It works the same as a stdio MCP server’s [`[mcp.<name>.network]`](../../guides/add-an-mcp-server/index.md#network), with one difference: with `false`, the decision log records one `egress:native` entry each time the program runs, not once at startup.

`false` applies to a program whose client does not read `HTTPS_PROXY`, such as a client that signs in through single sign-on:

```toml
[tool.sso-cli]
command = ["sso-cli"]

[tool.sso-cli.network]
contain_egress = false
```

The agent picks a tool’s arguments, so with `false` the agent can aim the program’s connections. Don’t set it on a general client such as `curl`, or on an interpreter. A program that runs under an `exec` entry, and not a tool table, always goes through the gateway.

### `[agent.filesystem] exec`

A program that no `[tool.<name>]` table names runs with the agent’s own filesystem lists when an `exec` entry covers it and no `deny` entry covers it. An entry is a file, or a directory that covers every file under it.

```toml
[agent.filesystem]
exec = ["~/src/project/target/debug"]
```

## `PATH`

A bare program name in a command resolves on the `PATH` of the host OS’s shell that runs `box run`, else on `/usr/bin:/bin`.

## `curl`

`curl` sends each request through the egress gateway, which decides `net:connect` and `http:request` ([how Box controls outbound traffic](https://github.com/strands-agents/box/blob/fbe415cbdfec284bf608a46f125ff8e437a99bda/docs/design/egress.md)). A request the gateway refuses makes `curl` exit non-zero.

## Exit statuses

| Status | Meaning | stderr |
| --- | --- | --- |
| `1` | The Shell call exceeded its execution allowance. | `strands-shell: execution timeout exceeded` |
| `125` | Box failed to serve the command. | The failure |
| `125` | The call exceeded the broker’s backup deadline, five seconds after its finite Shell allowance. | `strands-box: the call exceeded its deadline` |
| `125` | The deadline exceeds the platform’s clock range. Reduce `limits.shell.timeout`. | `strands-box: the call deadline exceeds this platform's clock range` |
| `126` | Policy refused the command. | `strands-shell: effect denied: policy denied this operation on '<program>'`, then `[policy: <id>]` or `[default-deny]`. A tool grammar action reads the same way. |
| `126` | A tool grammar binds the program file, and Box refused the spawn before any rule decided it. | `strands-shell: effect denied: policy denied this operation on '<program>' [tool-grammar]: <reason>. No policy can permit it.` |
| `126` | Policy permitted a program, and nothing in [Configuration](#configuration) covers it. | ``strands-shell: <program>: no tool runs <path>: no `[tool.<name>] command` matches this program and its leading arguments`` |
| `127` | The program is not in the Shell, and not on the `PATH`. | `strands-shell: <program>: command not found` |
| Any other | The command’s own status. A refused file operation fails the command that made it, for example `cat` with `1`. | `policy denied this operation on '<path>'`, then `[policy: <id>]` or `[default-deny]` |
| Any other | The path changed between the check and the operation, for example a directory was swapped for a symlink. The Shell refuses rather than act on a file policy didn’t judge. Run the command again. | `strands-shell: <command>: filesystem identity changed during effect admission` |
| Any other | The operation reaches a configured tool command or its ancestor. Select another path. | `<path>: is a configured tool command or its ancestor, which this run does not allow to change` |
| Any other | The directory contains a hard-link alias for a configured command. Select a directory without the alias. | `<path>: contains a hard link to a configured tool command, so this mutation is not allowed` |
| Any other | Box cannot complete its directory scan. [Check the reported cause and scan constraints](../configuration/index.md#configured-command-integrity). | `<path>: cannot finish checking for configured tool command hard links: <cause>` |
| Any other | The operation would change an installed Box program or an enclosing path. [Update the installation between runs](../configuration/index.md#installation-integrity). | `<path>: cannot change a trusted Box executable or its path` |

## See also

-   [Write policy for shell commands](../../guides/write-shell-policy/index.md): rules for commands, programs, and paths.
-   [How Box runs shell commands and programs](https://github.com/strands-agents/box/blob/fbe415cbdfec284bf608a46f125ff8e437a99bda/docs/design/shell.md): how the Shell decides each command, and the order of the checks.
-   [A tool’s sandbox](https://github.com/strands-agents/box/blob/fbe415cbdfec284bf608a46f125ff8e437a99bda/docs/design/containment.md#a-tools-leaf-box): what a tool such as `git` can reach.
-   [The `[egress.<name>]` table](../../guides/network-and-credentials/index.md): credentials for the requests `curl` sends.