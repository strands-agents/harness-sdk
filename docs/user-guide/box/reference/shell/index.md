Strands Shell is the shell that runs each command the agent sends to `zsh`, `bash`, or `sh` in a box. Policy decides each command, and each file operation the command makes. A program outside the Shell runs in its own sandbox, separate from the agent’s.

Audience: an operator with a working box from [getting started](/docs/user-guide/box/core/quickstart/index.md). For the steps, read [write policy for shell commands](/docs/user-guide/box/guides/write-shell-policy/index.md).

## Invocation

On the agent’s `PATH`, `zsh`, `bash`, and `sh` are each the alias, a client program that sends one command to the Shell. Each accepts one of these forms:

| Form | The Shell runs |
| --- | --- |
| `zsh -c COMMAND`, `-lc COMMAND`, `-c -l COMMAND`, `-l -c COMMAND` | `COMMAND` |
| `zsh SCRIPT` | The text of `SCRIPT`. The alias reads the file in the agent’s sandbox, so `[agent.filesystem]` must grant the agent a read of it. |

Any other form is refused with `Shell alias accepts only -c COMMAND, -lc COMMAND, -c -l COMMAND, or SCRIPT`.

### Standard input

When the alias’s standard input is a pipe, a file, or a socket, the command reads it as its standard input while it runs. Bytes arrive unchanged. A terminal or `/dev/null` gives the command no input. A command that does not read its input is not held by it: the alias returns when the command exits, even when the writer keeps the pipe open. A command that does read such an input waits for it until the Shell’s timeout, or, with `shell.timeout = false`, until its caller stops it.

A command receives at most `[limits.shell] max_stdin` bytes of this input, 1 MiB by default. Past that, the box discards the rest, so the limit never blocks the writer. Forwarding ends when the command exits, so a writer that is still writing then can get a broken pipe. A command that does not read its input is not affected. A command that reads past the limit gets no end of input: it waits until the Shell’s timeout and then fails, and it prints on standard error that its input was cut. A command that waits for the end of its input before it acts, such as `x=$(cat)` or `jq`, never acts on part of it. A command that acts as its input arrives, such as `while read -r line` or `cat > file`, has already acted on the first part when it fails. With `shell.timeout = false`, a command that reads past the limit waits until its caller stops it, like any blocked read. If reading the input fails, the alias stops the command and exits with status `125`.

This limit applies only to input piped into the alias from outside the Shell, such as a hook’s event or a program that starts `bash` with input. A pipe inside a command, such as `cat big.json | jq .`, is not affected.

Commands that the Shell runs itself, such as `cat`, `read`, or `jq`, receive the input. So does a program that the Shell starts in its own sandbox, such as a hook binary run as `zsh -c ~/src/project/hooks/pre-tool-use`. The box copies the input to the program while it runs. When the command has no input, as when the alias gets a terminal or `/dev/null`, the program gets `/dev/null`, so a tool such as `rg` searches its folder rather than an empty input. Input that the program does not read is dropped when it exits. The commands after it in the same invocation read no input.

Text that a command reads from its input is still data: when a command runs it, as in `eval "$(cat)"`, or opens a file it names, policy decides that command or file.

A Lua script that the Shell runs does not read the input piped into the alias: it reads it as empty and never waits for it. A pipe inside one command, such as `echo x | lua -e 'print(io.read())'`, still reaches the script.

Each invocation is one command. A variable exported in one invocation is unset in the next. The Shell starts each command with `HOME` set to the agent’s `HOME`, in the directory the alias was run from. It also gets the placeholder of each [credential route](/docs/user-guide/box/guides/network-and-credentials/index.md), in the same variable as the agent. So `curl -H "Authorization: Bearer $GITHUB_TOKEN" ...` sends the placeholder. On a request to the route’s destination that policy permits, the gateway puts the real token in its place.

Shell accesses host files only within the [hosted filesystem roots](/docs/user-guide/box/reference/configuration/index.md#hosted-filesystem-roots). That section defines the selected storage paths and the spelling to use in commands and policy.

The alias takes the directory it was run from from `PWD` when `PWD` names it, and otherwise asks the operating system. A directory other than the workspace takes the same `fs:read` decision, with operation `change_dir`, that `cd` takes. The command doesn’t run, and the alias exits `126`, if policy refuses that decision, if the directory isn’t a directory, or if it is outside the hosted filesystem roots. The last case covers `/` and `/tmp`, which the Shell holds only in memory. If the alias can’t tell which directory it was run from, or the directory’s name isn’t valid UTF-8, it exits `125` and runs nothing.

The `python3` and `python` aliases send their arguments to the Shell’s own `python3` and `python` commands, as [Python in a box](/docs/user-guide/box/reference/python/index.md#running-a-script) describes. They forward no standard input: the command reads its input as empty.

## What runs where

The reachable paths check is deny-only and runs after policy. It refuses host filesystem access outside the hosted roots, inside the box directory, and to the `box.toml` and `policy.dw` the run loaded, whatever a `permit` says.

Once the alias hands a command to the Shell, each command in it runs as follows:

| Inside a command, the agent runs | Action | Where it runs | What bounds its reach |
| --- | --- | --- | --- |
| A builtin or a command the Shell implements | `shell:exec`, then one `fs:*` action for each file operation | In the Shell | Policy, then the reachable paths check |
| A program named without a path, such as `git`, which runs a `[tool]`’s file or the first match on the `PATH` of `box run` (see [`PATH`](#path)) | `shell:spawn` on the program’s resolved path, or the grammar action when a tool grammar binds the program | Its own sandbox | Its `[tool.<name>]` table or `exec` entry. See [Configuration](#configuration). |
| A program named by a path, such as `./target/debug/app` | `shell:spawn` on the program’s resolved path, or the grammar action when a tool grammar binds the program | Its own sandbox | Its `[tool.<name>]` table or `exec` entry |

The Shell implements these, each in place of a program of the same name on the `PATH`:

-   Builtins: `cd`, `export`, `set`, `alias`, `trap`, `test`, `printf`, `echo`, `read`, `find`, `xargs`, and others.
-   Text: `cat`, `grep`, `sed`, `head`, `tail`, `sort`, `uniq`, `cut`, `tr`, `wc`, `tee`.
-   Files: `ls`, `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `ln`, `chmod`, `touch`, `mktemp`, `readlink`.
-   Data and network: `jq`, `base64`, `curl`.
-   System: `uname`, which prints the host’s values, except that `-p` and `-i` print `unknown`; `whoami`, which prints `$USER`; and `id`, which prints `$USER` with the Shell’s own IDs. A program path such as `/usr/bin/uname -p` runs the host program instead, as a `shell:spawn`.
-   Interpreters: `sh` and `lash`, which run a script in the Shell; `lua`; and `python` and `python3`, which run in Monty, Box’s Python interpreter. With [`monty = false`](/docs/user-guide/box/reference/configuration/index.md#monty), `python` and `python3` are external programs instead. Policy sees `sh` and `lash` as two programs. `sh FILE` and `/bin/sh FILE` are both decided as `program == "sh"`, and `lash FILE` and `/bin/lash FILE` as `program == "lash"`, so a rule meant for the Shell’s script interpreter must name both. `.` and `source` also run a file.

Paths outside the hosted filesystem roots, such as `/tmp`, exist only in the Shell’s memory, for one command. A file written to `/tmp` is gone when the command ends.

## `shell:exec`

Decided once for each command the Shell implements, after expansion, including each command that command substitution, `eval`, `source`, `find -exec`, `xargs`, or Lua’s `io.popen` runs.

| Field | Type | Present | Value |
| --- | --- | --- | --- |
| `context.input.command` | String | Always | The command line, rebuilt from the expanded words. |
| `context.input.program` | String | Always | The first word after expansion, such as `grep`. A command the Shell implements appears by its name, also when it is called by its `/bin/` path, so `/bin/sh` appears as `sh` and `/bin/cat` as `cat`. Another path, such as `/usr/bin/grep`, names a host program and is decided as `shell:spawn`. |
| `context.input.arg1`, `arg2` | String | When the command has that many arguments | The first and second arguments. Test each with `has` first. |
| `context.input.arg_count` | Long | Always | The number of arguments. |
| `context.input.cwd` | String | Always | The Shell’s working directory: `~` for the operator’s home, `~/…` below it, and an absolute path elsewhere. |
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
| `context.input.cwd` | String | Always | The program’s launch directory, with the same home-relative spelling as `shell:exec`. |

Box selects this directory before policy decides, following the `workspace` rule in [Configuration](#configuration). The decision, request, and outcome use the same `cwd` spelling. The program starts in the corresponding absolute directory. If Box cannot select or resolve a launch directory, `cwd` names the Shell’s original directory. A program starts only when its resolved launch directory matches the directory policy checked.

A tool grammar maps a command line to a policy action for that tool. A program with a tool grammar uses that action. Its `cwd` names the same selected launch directory and stays absolute in decisions and history.

```text
@id("built_programs")
permit (principal, action == Box::Action::"shell:spawn", resource)
when { context.input.program_path like "~/src/project/target/debug/*" };
```

A program’s filesystem lists bound its own file operations.

When an experimental [tool grammar](/docs/user-guide/box/reference/configuration/index.md#toolnamegrammar) binds the program, Box decides the spawn as the grammar’s action, such as `Tool::git::Action::"push"`, or as `unmodeled` when the grammar can’t read the command, and `shell:spawn` doesn’t decide it. A grammar binds the program file of its own `[tool]` under its `program`, the name the agent types, and the file of each other `[tool]` and each stdio `[mcp.<name>]` whose command ends in that name. A spawn of a bound file by any other name is a `shell:spawn`, except in the refused cases below. For example, macOS `/usr/bin/git` is one file with many names, so with a git grammar on it, `git` is decided by the grammar and `make` is decided by `shell:spawn`. The agent may be able to make a link to a bound file under a name that no grammar binds, and `shell:spawn` decides that spawn too. So pin each `shell:spawn` permit on both `context.input.program` and `context.input.program_path`, such as `program == "make"` with `program_path == "/usr/bin/make"`.

Box refuses a spawn of a bound file before any rule decides it, and no rule can permit it, in these cases:

-   The agent called the file by a name that only a stdio `[mcp.<name>]` declares for it. That name is for the start of that server alone, because the server’s start and the agent’s spawn would otherwise make the same `shell:spawn` request.
-   The file at a bound path is no longer the file that the run bound.
-   The agent called a bound name with no path, and the file bound under that name is gone or replaced, so another file would run.

A refused spawn enters history as a `shell:spawn` request. After a bound file is replaced or removed, its bound names stay refused until the box restarts.

## `fs:*`

Decided once for each file operation that one of the Shell’s commands makes, on the path with every link resolved.

| Action | `context.input.operation` |
| --- | --- |
| `fs:read` | `Box::FsReadOperation::"read_content"`, `"read_metadata"`, `"enumerate"`, `"read_link"`, `"change_dir"`, `"exec"` |
| `fs:write` | `Box::FsWriteOperation::"write_content"`, `"create_dir"`, `"set_permissions"`, `"symlink"` |
| `fs:delete` | `Box::FsDeleteOperation::"remove_file"`, `"remove_dir"` |
| `fs:move` | `Box::FsMoveOperation::"rename"` |

`touch` changes a file’s times as a `write_content` write. It first reads the file’s metadata to see whether the file exists, so it also needs `fs:read` with `read_metadata`. Without that, a plain `touch` on an existing file in a host folder exits `0` and changes nothing. The macOS [`file-attributes`](/docs/user-guide/box/reference/configuration/index.md#file-attributes) switch doesn’t apply to the Shell’s built-in `touch`, because the Shell runs outside the agent’s sandbox. A `touch` program that runs in a sandbox still needs it.

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

`limits.shell.max_input` bounds submitted command text, and `limits.shell.max_output` bounds output buffers, script files loaded with `source`, and each `curl` response body. Set either size to `0` to disable that Shell limit. The [limits reference](/docs/user-guide/box/reference/configuration/index.md#limits) gives their defaults, byte units, and the separate limits on transport and positional script invocation.

### `limits.shell.timeout`

Each submitted Shell call has a 30-second timeout by default. Set `shell.timeout = 600` under `[limits]` to allow ten minutes, or `shell.timeout = false` to disable this limit. See [`[limits]`](/docs/user-guide/box/reference/configuration/index.md#limits) for the accepted values.

The allowance covers the full text sent in one call, including multiple commands, pipelines, Python called inside the Shell, and programs the Shell starts. Each new call receives a fresh allowance. Output leaves its deadline unchanged. The Shell alias waits for the broker’s result.

With `false`, both the Shell execution deadline and the broker’s backup deadline are disabled. Calls remain cancellable, and connection and write operations retain their transport timeouts.

Monty’s 120-second active execution limit and 180-second cumulative sleep limit also apply to Python called inside the Shell, including with `shell.timeout = false`. Synchronous Python execution can delay timeout reporting. The `python` and `python3` aliases reach Python through the Shell, so these limits apply to them too.

### `[tool.<name>]`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `command` | string array | required | Element 0 is the program, and the rest are fixed leading arguments. A bare name resolves on the table’s `env.PATH`, else on the `PATH` of `box run`. The last part of element 0 is the name the agent types to run it in the Shell, as [`PATH`](#path) states. |
| `workspace` | path | the Shell’s resolved working directory inside the agent’s workspace or the tool’s `read`, `write`, `list`, or `metadata` trees, else the agent’s workspace | The program’s initial working directory. An explicit value takes precedence. |
| `env` | table | empty | Variables the program receives. |
| `filesystem` | table | empty | `read`, `write`, `read_file`, `write_file`, `list`, and `deny`: the paths the program’s own system calls reach. |
| `network.contain_egress` | bool | `true` | How the program reaches the network. See [`[tool.<name>.network]`](#toolnamenetwork). |
| `grammar` | table | none | Experimental. The tool grammar for the program. See [`[tool.<name>.grammar]`](/docs/user-guide/box/reference/configuration/index.md#toolnamegrammar). |

A table matches a `shell:spawn` when `program_path` names the command file that Box resolved at startup, and its fixed arguments match the leading arguments of the command. When several tables match, the one with the longest `command` is used. When a table names the file and none matches the arguments, the program is refused.

Configured tool programs and the programs of declared secret sources remain protected from writes and replacement for the run. Box checks direct writable grants before startup and refuses changes through the Shell after policy permits them. [Configured command integrity](/docs/user-guide/box/reference/configuration/index.md#configured-command-integrity) lists the startup constraints and the procedure for operator updates.

```toml
[tool.git]
command = ["git"]

[tool.git.filesystem]
read  = ["~/src/project", "/Library/Developer/CommandLineTools"]
write = ["~/src/project/.git"]
deny  = ["~/src/project/.env"]
```

### `[tool.<name>.network]`

`[tool.<name>.network]` holds one key, `contain_egress`. It works the same as a stdio MCP server’s [`[mcp.<name>.network]`](/docs/user-guide/box/guides/add-an-mcp-server/index.md#network), with one difference: with `false`, the decision log records one `egress:native` entry each time the program runs, not once at startup.

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

The agent’s explicit `workspace` selects the program’s launch directory. Otherwise, Box applies the tool `workspace` default with the agent’s filesystem lists.

```toml
[agent.filesystem]
exec = ["~/src/project/target/debug"]
```

## `PATH`

A program name with no `/` in a command runs the file of the `[tool.<name>]` that answers to that name. A `[tool]` answers to the last part of its `command` element 0, whatever its label, so `[tool.git]` with `command = ["/Applications/Xcode.app/Contents/Developer/usr/bin/git"]` makes `git` run that file, even when `/usr/bin/git` comes first on `PATH`. A `[tool]` with a grammar answers only when the grammar’s `program` is that same name. The Shell’s own builtins, commands, and functions come first, so a `[tool.cat]` doesn’t replace the Shell’s `cat`, and Box prints no line for it. The same holds for `sh`, which the Shell runs as a script.

A `[tool]` claims its name even when its `command` has fixed leading arguments. With `[tool.cargo_fmt] command = ["/usr/bin/cargo", "fmt"]`, a bare `cargo build` runs `/usr/bin/cargo`, where no table matches `build`, so it is refused. It no longer reaches a `cargo` that `PATH` finds under an `[agent.filesystem] exec` entry. Give that program its own `[tool]`, or call it by its path.

When `[tool]` tables whose commands resolve to different paths answer to one name, `PATH` decides if it finds one of those paths. Two hard links to one file at two paths count as two paths, because Box selects a tool by the path that runs. If `PATH` finds none, such as the `/usr/bin/git` stub with `[tool.git]` and `[tool.brew_git]`, the table whose label is the name runs.

Any other name resolves on the `PATH` of the host OS’s shell that runs `box run`, else on `/usr/bin:/bin`. When the file of a `[tool]` is gone, its name is not found, and the Shell doesn’t look for another file on `PATH`. `run` prints the file each name runs:

```text
strands-box: note[B0208]: [tool.git]: a bare `git` in the Shell runs /Applications/Xcode.app/Contents/Developer/usr/bin/git
strands-box: note[B0208]: [tool.brew_git]: runs another program path, so a bare `git` in the Shell runs the file of `[tool.git]`, whose label is that name
strands-box: note[B0208]: [tool.brew_node], [tool.node]: these tables run different program paths, so a bare `node` in the Shell runs the file that `PATH` finds
```

A name changes only which file runs. The spawn still needs a `shell:spawn` permit, or a grammar action permit when a tool grammar binds the file, and `program` is still the name the agent typed.

## `curl`

`curl` sends each request through the egress gateway, which decides `net:connect` and `http:request` ([how Box controls outbound traffic](https://github.com/strands-agents/box/blob/b4e3d3999d0df8d3b916dfc081868c451b7bbfe9/docs/design/egress.md)). A request the gateway refuses makes `curl` exit `1` and print the reason, even with `-s`. A request the gateway doesn’t refuse but can’t complete makes `curl` exit `6` and print `curl: (6)` and the reason, unless `-s` hides errors.

A response body is at most [`limits.shell.max_output`](/docs/user-guide/box/reference/configuration/index.md#limits) bytes, 1 MiB by default. Past it, `curl` exits with status `6`, writes none of the body, and prints `curl: (6) response body too large` unless `-s` hides errors. The request was already sent, so its effect at the server stays.

## Exit statuses

| Status | Meaning | stderr |
| --- | --- | --- |
| `1` | Submitted command text exceeds 256 KiB, including text with line breaks. Split the text across several calls, for example by appending to a file. | `strands-shell: input too large` |
| `1` | The Shell call exceeded its execution allowance. | `strands-shell: execution timeout exceeded` |
| `125` | Box failed to serve the command. | The failure |
| `125` | The alias can’t tell which directory it was run from. Set `PWD` to it. | `strands-box-sock-alias: error[H0203]: read the working directory: <error>; set PWD to it` |
| `125` | The name of the directory the alias was run from isn’t valid UTF-8. Run the command from another directory. | `strands-box-sock-alias: error[H0203]: the working directory is not valid UTF-8` |
| `125` | The call exceeded the broker’s backup deadline, five seconds after its finite Shell allowance. | `strands-box-sock-alias: error[H0105]: the call exceeded its deadline` |
| `125` | The deadline exceeds the platform’s clock range. Reduce `limits.shell.timeout`. | `strands-box-sock-alias: error[H0106]: the call deadline exceeds this platform's clock range` |
| `126` | Policy refused the directory the alias was run from, it isn’t a directory, or it is outside the hosted filesystem roots. Nothing ran. | `strands-box: error[B1202]: cannot start in <directory>: <error>` |
| `126` | Policy refused the command. | `strands-shell: effect denied: policy denied this operation on '<program>'`, then `[policy: <id>]` or `[default-deny]`. A tool grammar action reads the same way. |
| `126` | A tool grammar binds the program file, and Box refused the spawn before any rule decided it. | `strands-shell: effect denied: policy denied this operation on '<program>' [tool-grammar]: <reason>. No policy can permit it.` |
| `126` | Policy permitted a program that a `[tool.<name>]` table names, and its arguments match no table’s fixed arguments. | ``strands-shell: <program>: no tool runs <path>: no `[tool.<name>] command` matches this program and its leading arguments`` |
| `126` | Policy permitted a program that no `[tool.<name>]` table names, and no `exec` entry covers it, for example a program the agent installed during the run. | ``strands-shell: <program>: no tool runs <path>: no `[tool.<name>] command` matches this program and its leading arguments. The `[tool.<name>]` tables are fixed when the box starts, so a program created during the run runs only under an `[agent.filesystem] exec` entry`` |
| `126` | The launch directory differs from the directory policy checked. Run the command again. | `strands-shell: <program>: the tool working directory does not match the policy-approved directory` |
| `127` | The program is not in the Shell, and not on the `PATH`. A `PATH` set inside the box does not change where the box looks. | `strands-shell: <program>: command not found`. For a bare name, then ``strands-shell: <program>: no tool in this box has this name, and no file of this name is on the PATH that `box run` started with. A PATH set inside the box does not change where the box looks`` |
| Any other | The command’s own status. A refused file operation fails the command that made it, for example `cat` with `1`. | `policy denied this operation on '<path>'`, then `[policy: <id>]` or `[default-deny]` |
| Any other | The path changed between the check and the operation, for example a directory was swapped for a symlink. The Shell refuses rather than act on a file policy didn’t judge. Run the command again. | `strands-shell: <command>: filesystem identity changed during effect admission` |
| Any other | The operation reaches a configured tool command or its ancestor. Select another path. | `<path>: is a configured tool command or its ancestor, which this run does not allow to change` |
| Any other | The directory contains a hard-link alias for a configured command. Select a directory without the alias. | `<path>: contains a hard link to a configured tool command, so this mutation is not allowed` |
| Any other | Box cannot complete its directory scan. [Check the reported cause and scan constraints](/docs/user-guide/box/reference/configuration/index.md#configured-command-integrity). | `<path>: cannot finish checking for configured tool command hard links: <cause>` |
| Any other | The operation would change an installed Box program or an enclosing path. [Update the installation between runs](/docs/user-guide/box/reference/configuration/index.md#installation-integrity). | `<path>: cannot change a trusted Box executable or its path` |

## See also

-   [Write policy for shell commands](/docs/user-guide/box/guides/write-shell-policy/index.md): rules for commands, programs, and paths.
-   [How Box runs shell commands and programs](https://github.com/strands-agents/box/blob/b4e3d3999d0df8d3b916dfc081868c451b7bbfe9/docs/design/shell.md): how the Shell decides each command, and the order of the checks.
-   [A tool’s sandbox](https://github.com/strands-agents/box/blob/b4e3d3999d0df8d3b916dfc081868c451b7bbfe9/docs/design/containment.md#a-tools-leaf-box): what a tool such as `git` can reach.
-   [The `[egress.<name>]` table](/docs/user-guide/box/guides/network-and-credentials/index.md): credentials for the requests `curl` sends.