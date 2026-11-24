`box.toml` is the complete run configuration for one box. Pass its path through `strands-box run --config FILE`; the tutorial’s download names the binary `box`. Box reads the selected file and its policy on every start.

`box.toml` is Box Core’s stable interface. A program that runs Box Core, such as the `box` CLI, writes it, and each key keeps its meaning across releases. If you use the `box` CLI, you don’t write this file: the CLI builds it from your [profile](/docs/user-guide/box/profiles/index.md).

Audience: an operator who runs an agent or another command under a box, and who declares the paths, hosts, credentials, MCP servers, and telemetry targets it can use. The example on this page is the box that [getting started](/docs/user-guide/box/core/quickstart/index.md) builds: the Strands CLI on a Mac. Each section below annotates it. To write the policy the file points at, read [policy](/docs/user-guide/box/reference/policy/index.md), and point a coding agent at [the policy-authoring skill](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/.agents/skills/authoring-box-policy/SKILL.md).

## Example

Getting started builds this macOS example one file at a time, and the block is the tutorial’s `my-box/box.toml`, with its one longer comment shortened to a line.

```toml
# To author or change the policy next to this file, point your coding agent at the skill:
#   https://raw.githubusercontent.com/strands-agents/box/cfff47d5824aaa8de76c93011680f278de5e696b/.agents/skills/authoring-box-policy/SKILL.md

# The box's name, and where it keeps its own state. The agent can't reach box_dir.
name = "strands"
box_dir = "<HOME>/box-tutorial/my-box/state"
# The policy file, next to this one.
policy = "policy.dw"

[agent]
# The program the box starts. Node loads the preload file first, then runs the CLI.
command = [
  "/opt/homebrew/bin/node",
  "--import=<HOME>/box-tutorial/proxy-preload.mjs",
  "/opt/homebrew/lib/node_modules/@strands-agents/cli/bin/strands.js",
  # Give the agent its shell and web fetch, and no file tools, so the policy decides each file it works on.
  "--set", 'builtinTools={"*":false,"shell":true,"web_fetch":{"transport":"direct"}}',
  # Keep sessions and memory out of the project.
  "--set", 'session.dir="<HOME>/box-tutorial/strands-home/sessions"',
  "--set", 'memory.dir="<HOME>/box-tutorial/strands-home/memory"',
]
# The directory the agent starts in. This alone grants nothing.
workspace = "<HOME>/box-tutorial/my-project"
# The agent gets these variables, plus the ones the box adds. Nothing comes from your shell.
env = { AWS_REGION = "us-west-2", HOME = "<HOME>/box-tutorial/strands-home", PATH = "/usr/bin:/bin", TERM = "xterm-256color" }

# What the agent's own process can touch without asking the policy.
[agent.filesystem]
# Node loads the CLI, and the CLI reads its settings.
read = ["/opt/homebrew/lib/node_modules/@strands-agents/cli", "~/box-tutorial/strands-home"]
# Node loads the preload file, and reads Homebrew's OpenSSL settings when it starts.
read_file = ["~/box-tutorial/proxy-preload.mjs", "/opt/homebrew/etc/openssl@3/openssl.cnf"]
# The CLI writes its sessions and memory.
write = ["~/box-tutorial/strands-home"]
# The CLI lists the names in its working directory. It can't open the files itself.
list = ["~/box-tutorial/my-project"]

# The box adds your Bedrock API key to each Bedrock request; the agent gets a stand-in value.
[egress.model]
destinations = ["bedrock-runtime.us-west-2.amazonaws.com"]
secret.ref = "env://AWS_BEARER_TOKEN_BEDROCK"
```

`<HOME>` is a placeholder for your home directory. Getting started replaces it with `sed -i '' "s|<HOME>|$HOME|g" my-box/box.toml`. Use full paths for `box_dir`, `workspace`, and `env.HOME`. Filesystem list entries can start with `~`.

An unknown key at any level is a load error.

## Keys

The file carries fourteen keys. `name` and `box_dir` are required.

| Key | Type | Meaning |
| --- | --- | --- |
| `name` | string | Which box this is. One path component of letters, digits, `.`, `_`, or `-`, at most 32 bytes. |
| `box_dir` | string | Where the box keeps its private state. Required, and absolute. |
| `policy` | string or table | The Dogwood policy, relative to this file’s directory unless absolute. Absent means no authored policy, and absent policy denies. The table form, `[policy]`, takes `source` (the file, required) and `enforcement`: `enforce` (the default) or `log_only`. See [log-only mode](/docs/user-guide/box/reference/policy/index.md#log-only-mode). |
| `[agent]` | table | The one process the box runs. |
| `[tool.<name>]` | tables | One process each, which the agent selects by invocation. The label takes the same characters as `name`. |
| `[egress.<name>]` | tables | Which secret attaches to which outbound destination. |
| `[secret-source.<scheme>]` | tables | Experimental: the host program that reads the secret of a reference in `<scheme>://`. See [`[secret-source.<scheme>]`](#secret-sourcescheme). |
| `[mcp.<name>]` | tables | The MCP servers this box declares. |
| `[telemetry.<label>]` | tables | Where this box’s decision records and agent spans go. |
| `file-attributes` | boolean | Whether write folders on macOS may also set file times, and with them set-ID bits, the group, the owner, and access control lists. `false` by default. |
| `[experimental-features]` | table | Optional experimental features: native filesystem policy checks, tool grammars, ingress, and secret sources. Each is disabled by default. |
| `[limits]` | table | Execution limits for Strands Shell. |
| `monty` | boolean | Whether a bare `python3` or `python` in the Shell runs Monty, Box’s built-in Python subset. `true` by default. With `false`, both names resolve like any other program: a `[tool.python3]` or `[tool.python]`, else the host’s `PATH`. |
| `[gateway]` | table | Settings for every request through the egress gateway: `upgrade_http`, the hosts whose plain `http://` on port 80 the gateway sends as `https://` on port 443. See [`[gateway]`](#gateway). |

The example uses five of the fourteen: `name`, `box_dir`, `policy`, `[agent]`, and one `[egress.<name>]` table. It declares no tool, no MCP server, and no telemetry target.

`name` and `box_dir` are the two required keys. `name` labels the box in its record and its telemetry. `box_dir` selects the box: one directory is one box. A `name` outside its limits is refused with `box name "<name>" is invalid: <reason>; use one component of letters, digits, '.', '_', or '-'`.

If the directory named by `box_dir` does not exist, Box creates it with mode `0700` (owner-only access). Its parent must already exist and be writable. Box creates **no** directory above `box_dir`; a missing parent causes the run to fail with ``the box directory's parent does not exist; create it, because Box creates no directory above the one `box_dir` names``.

If `box_dir` already exists, it must be owned by the user running Box and have mode `0700`. Box refuses to use an existing directory with a different owner or permissions. These requirements apply on both Linux and macOS. Everything Box writes for a box is under `box_dir` or another path specified in `box.toml`. The example’s `box_dir` is `my-box/state`, under the `my-box` directory the operator made for the two files.

`box_dir` may not be the agent’s workspace or lie below it, and neither `box.toml` nor `policy.dw` may lie inside it. Each is refused by name: `` `box_dir` <path> is equal to or below the agent's workspace <path> ``, ``configuration source <path> is inside `box_dir` <path>``, and ``policy source <path> is inside `box_dir` <path>``.

The directory holds `bin`, `run`, `trust`, and `private`. None of them is a home, and no box reaches its own private tree from inside. It stays until you delete it: end the `run` process to stop a box, and remove the directory after `run` has exited to delete one. Do not remove the directory while its `run` is alive: on macOS, the kernel kills a shell or Python call of that box whose program file loses a name during its security assessment.

### Keep other boxes’ configuration and state outside write access

Keep each box’s configuration, policy, and generated state in locations controlled by the operator. Do not grant a workload write access to another box’s `box_dir`, configuration file (`box.toml`), or policy file (`policy.dw`). Keep each policy file outside every other box’s filesystem grants. Review the filesystem lists for the agent, tools, and local MCP servers before starting a workload.

A directory grant can include another box’s files beneath that directory. For example, write access to `/work/projects` can include a second box’s configuration under `/work/projects/other-box`. Box protects the configuration and policy that the current run loaded. It does not automatically discover and protect every other box’s files. A directory name such as `.strands-box` alone provides no protection for another box. If a workload changes another box’s configuration or policy, that box reads the changes on its next run.

Write access that includes another running box’s `box_dir` can also expose its broker socket, `run/box.sock`. Requests through that socket use the receiving box’s policy.

If a filesystem grant must enclose another box, add native exclusions through `filesystem.deny`. Exclude that box’s `box_dir` and the directories that hold its configuration and policy. Apply these exclusions to the agent, each tool, and each local MCP server with the grant. These exclusions also block connections through the other box’s `run/box.sock` path. On Linux, these directories must exist before startup.

The startup output lists each filesystem grant, including a broad grant that encloses another box’s directory. Inspect these paths for access to other boxes’ files. The output reports the granted access and does not remove another box’s files from it. The workload starts without waiting for you to approve that output.

Restrict file operations through Strands Shell and Monty separately with [policy `forbid` rules](/docs/user-guide/box/reference/policy/index.md#common-rules). Protect each other box’s `box_dir` and the directories that hold its configuration and policy. Cover each directory and its descendants for [`fs:read`, `fs:write`, `fs:delete`, and `fs:move`](/docs/user-guide/box/reference/policy-actions/index.md#filesystem). Also forbid `fs:move` on enclosing directories that could relocate these protected paths.

A `forbid` overrides matching permits. Adding a narrower permit leaves any broader permit active. A native `filesystem.deny` entry does not restrict these requests through the box’s trusted process.

## `file-attributes`

On macOS, a write folder refuses most calls that set a file’s times: `utimensat`, which `touch` calls, and `setattrlist`, which `cp -p` and `rsync -t` use. Only `utimes` works. So `touch`, `cp -p`, and `rsync -t` fail with `Operation not permitted`. The `file-attributes` switch lets a write folder set them. This applies to programs that run in a sandbox. The Shell’s built-in `touch` runs outside the sandbox and doesn’t need the switch. The key goes at the top of the file, above the first table:

```toml
file-attributes = true
```

The default is `false`, and the switch applies to the agent, every tool, and every local MCP server in the box. It has no effect on Linux, which accepts the key. With the switch off, the box renders no rule for it. A box that sets it stores its record at version 25 or newer, depending on its [other configured features](/docs/user-guide/box/security/native-filesystem-policy/index.md#stored-configuration-and-rollback). An older build refuses a version it does not support.

With the switch on, a process in a write folder can set the times of a file there. It can also set the file’s set-user-ID and set-group-ID bits, change its group, store an access control list on it, and, in a box that runs as root, give it to another user. macOS has no rule that allows the times and refuses these. See [file attributes on macOS](/docs/user-guide/box/security/index.md#file-attributes-on-macos) for what that means and how to undo it. Flags such as `uchg`, ownership changes through `chown`, and `chmod` of the set-ID bits stay refused. A path outside the write folders, and a file the box protects, stay unwritable. `tar -x` restores times with the switch, but an archive that macOS `tar` made with its default metadata still fails to restore the owner and the flags. Extract it with `tar -x --no-mac-metadata`.

The box prints one line for each process the switch applies to, in the startup disclosure: `strands-box: [agent] file attributes: may set file times, set-user-ID and set-group-ID bits, the group, the owner, and access control lists on files in its writable grants`. Linux prints no line.

## `[limits]`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `shell.timeout` | positive integer or `false` | `30` | Seconds allowed for one submitted Strands Shell call, including its commands and pipelines. `false` disables the Shell and broker execution deadlines. |
| `shell.max_input` | nonnegative integer | `262144` | Bytes of command text submitted to Strands Shell. `0` disables this limit. |
| `shell.max_output` | nonnegative integer | `1048576` | Bytes in each Shell output buffer, including command substitution. Shell also applies it to each input that a command reads whole, such as a script loaded with `source`, a `python3` or `lua` script, the standard input of `xargs`, the standard input or each file that `jq` reads, each file that `sed -i` edits, and the file of `curl --json @file`. `jq` applies the limit to each file separately, so it can hold more than `max_output` in total. Box applies it to each `curl` response body. `0` disables this limit. |
| `shell.max_stdin` | positive integer | `1048576` | Bytes of standard input that one command run through the `zsh`, `bash`, or `sh` alias receives from outside the Shell. Past it, the rest is discarded and the command gets no end of input, so a command that reads past it fails at the Shell timeout; a command that acts as its input arrives has acted on the first part by then. `0` is a load error. |

To allow ten minutes, add `[limits]` with `shell.timeout = 600`. The equivalent nested table is `[limits.shell]` with `timeout = 600`. Output leaves the original deadline unchanged. Set `shell.timeout = false` to disable this limit, or omit the key for the 30-second default. Connection and write operations retain their transport timeouts. Configured-command [hard-link scans](#configured-command-integrity) retain their separate 30-second budget per tree, including when `shell.timeout` is `false`. Timeout values of zero, negative numbers, fractions, strings, `true`, or values too large for the platform’s clock are load errors.

Size limits accept a positive integer byte count or `0` to disable that limit. Negative numbers, booleans (including `false`), strings, fractions, and values the platform cannot represent are load errors. Omission preserves each default independently. For a larger source file, set `[limits.shell] max_output = 4194304` to allow up to 4 MiB. This also enlarges Shell’s output buffers. A larger `max_input` alone does not enlarge source-file reads. Stdout and stderr captures have separate buffers; `max_output` is not a combined output or total memory budget. Oversized command text is refused with `input too large`, but the current Shell implementation bypasses this check for submissions that contain a newline. An oversized capture can produce incomplete or empty output. An oversized source file fails before execution with `output size limit exceeded`. Raising or disabling a size limit allows Shell to hold more data in the box’s trusted process; these settings do not bound the process’s total memory use.

`shell.max_stdin` cannot be disabled, because it bounds the standard input that the box’s trusted process holds for a command. Values of zero, negative numbers, fractions, strings, and booleans are load errors. One connection’s commands receive at most `shell.max_stdin` times the most programs a connection opens. A command that reads its input still holds at most `shell.max_output` bytes of it in one buffer, so raise `shell.max_output` too when a command such as `x=$(cat)` must keep a larger input.

Broker messages remain capped at 1 MiB, including encoding. Streamed stdout and stderr share an 8 MiB budget for the lifetime of one opened Shell program. These limits still apply when either Shell setting is increased or set to `0`. Positional script invocations such as `bash script.sh` retain the alias’s separate 64 KiB script limit.

The timeout setting applies to the calls forwarded by `zsh`, `bash`, `sh`, `python3`, and `python`, including Python called inside the Shell. Python’s [own limits](/docs/user-guide/box/reference/python/index.md#limits-and-exit-statuses) also apply, including with `shell.timeout = false`. Synchronous Python execution can delay timeout reporting. See [Shell timeouts](/docs/user-guide/box/reference/shell/index.md#limitsshelltimeout) for the call scope and [stored configuration](/docs/user-guide/box/security/native-filesystem-policy/index.md#stored-configuration-and-rollback) for rollback.

## `[gateway]`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `upgrade_http` | string array | empty | Host names whose plain `http://` request to port 80 the gateway decides and sends as `https://` on port 443. A host name alone: no scheme, port, path, `*` wildcard, or IP address. |

```toml
[gateway]
upgrade_http = ["static.rust-lang.org"]
```

The list is for a tool that can’t trust the box’s CA, such as rustup on macOS. Policy decides an upgraded request on port 443, as it decides HTTPS to that host, and a credential is never added to it. A box that sets the list stores its record at version 32, and an older build refuses it. [Upgrade plain HTTP to HTTPS](/docs/user-guide/box/guides/network-and-credentials/index.md#upgrade-plain-http-to-https) describes the behaviour and its limits.

## `monty`

`monty` decides what a bare `python3` or `python` in the Shell runs. It is `true` by default: both names run Monty, Box’s built-in Python subset ([Python in a box](/docs/user-guide/box/reference/python/index.md)), even when a `[tool.python3]` is declared or the host’s `PATH` has a Python. Startup names a Python table that Monty leaves unused.

```toml
monty = false
```

With `false`, Box installs no Monty, and both names resolve like any other program the Shell starts. A tool whose command file is named `python3` or `python` answers that name, and otherwise the host’s `PATH` decides. Each spawn needs a `shell:spawn` permit, and nothing falls back to Monty. Startup says which file each name runs, or that neither a tool nor `PATH` has it.

Box treats the Python tool like any other tool. It adds no grants and doesn’t inspect the install, so the tool’s table lists what Python reads and writes. Python’s own reads and writes take no `fs:read` or `fs:write` decision: they meet only these lists, which startup prints under `[tool.python3] runs <file> with no policy decision over these paths`. Policy still decides the spawn of `python3` itself, and each command the agent’s shell runs. A working setup:

```toml
monty = false

[tool.python3]
command = ["/opt/runtime/.venv/bin/python3"]

[tool.python3.filesystem]
read = ["/path/to/project", "/opt/runtime/.venv", "/opt/homebrew/Cellar", "/opt/homebrew/opt"]
write = ["/path/to/project"]
```

```text
permit (principal, action == Box::Action::"shell:spawn", resource)
when {
  context.input.program_path == "/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/bin/python3.14" &&
  ["python3", "python"].contains(context.input.program)
};
```

`program_path` is the file the venv’s `python3` resolves to, with every link followed. The `read` list covers the venv, Python’s own install, and the libraries its modules load; on macOS with Homebrew those are under `/opt/homebrew/Cellar`, reached through `/opt/homebrew/opt`. A bare `python` needs a `[tool.python]` too, and a versioned name such as `python3.14` is a separate program that needs its own permit.

Keep the venv and Python’s install out of every write grant and every `fs:write` rule. A file written into `site-packages`, such as a `.pth`, runs at every Python start, later also outside the box. Box refuses a write grant that can change the tool’s command or its path ([Configured command integrity](#configured-command-integrity)), but not one that reaches the rest of the venv. A program the Shell starts receives no standard input yet, so a piped `printf x | python3 -c '...'` reads an empty stdin. A `python3` that would read its program from stdin, such as `python3 <<'EOF'` or `printf 'print(1)' | python3`, exits 2 with `reading a program from stdin is not supported` instead of running an empty program.

A box that sets `monty = false` stores its record at version 37, and an older build refuses it.

## `[experimental-features]`

Native filesystem policy checks require a compatible, signed build and explicit selection:

```toml
[experimental-features]
native-filesystem-policy = true
```

The default is `false`. Unknown feature names are errors. Signed macOS releases include the adapter, but leave it disabled until you select it. An unsupported build refuses `true` before the workload starts. See [native filesystem policy](/docs/user-guide/box/security/native-filesystem-policy/index.md) for build requirements, coverage, and recovery behavior.

On Linux, startup can report `this kernel cannot transfer O_PATH handles; path-only opens are refused`. `O_PATH` handles identify a file or directory without granting content access. This warning disables path-only opens. Other supported native operations remain available. See [Linux coverage and limits](/docs/user-guide/box/security/native-filesystem-policy/index.md#linux-arm64) for the probe and its failure behavior.

`tool-grammars = true` turns on [tool grammars](#toolnamegrammar), which are experimental and off by default.

`ingress = true` turns on [`[[agent.ingress]]`](#agentingress), which is experimental and off by default.

`secret-sources = true` turns on [`[secret-source.<scheme>]`](#secret-sourcescheme) and the `secret.env` key of a route or a remote MCP server, which are experimental and off by default.

## `[agent]` and `[tool.<name>]`

Both tables hold one process, in one shape:

| Key | Type | Meaning |
| --- | --- | --- |
| `command` | string array | The first entry is the program; the rest are its fixed leading arguments. Arguments passed to `run` come after them. |
| `workspace` | string | The process’s initial working directory. The box enters it; a `filesystem` list grants reach to it. |
| `env` | table | The literal environment. `HOME` and `PATH` default to the operator’s own; every other variable is present only when `env` names it. |
| `[<table>.filesystem]` | table | The path lists the process’s own system calls reach. Eight for `[agent]`; six for a `[tool.<name>]`, which has no `metadata` or `exec` list. |
| `native-filesystem-policy` | boolean | Optional override of the global experimental setting for this process and its descendants. See [workload selection](/docs/user-guide/box/security/native-filesystem-policy/index.md#select-workloads). |
| `file-watching` | boolean | `false` by default. On macOS, permit FSEvents for this process and its descendants, with the [limitations](#file-watching). Linux ignores this setting. |
| `[tool.<name>.grammar]` | table | Experimental, and `[tool.<name>]` only. The tool grammar for the program this tool runs. See [`[tool.<name>.grammar]`](#toolnamegrammar). |
| `[[agent.ingress]]` | list of tables | `[agent]` only. Where callers reach the agent’s servers, one entry per port. See [`[[agent.ingress]]`](#agentingress). |

The box adds the runtime minimum to every process; see [the runtime minimum](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/design/containment.md#the-runtime-minimum).

The program is a full path or a bare name. A bare name uses `env.PATH` when set. Otherwise, Box uses the operator’s `PATH`, or `/usr/bin:/bin` if it is absent. In the Shell, the last part of a `[tool]`’s program is the name that runs it, before the operator’s `PATH`, and `run` prints ``strands-box: [tool.git]: a bare `git` in the Shell runs <file>`` for each. See [`PATH` in the Shell reference](/docs/user-guide/box/reference/shell/index.md#path). A relative path with more than one component is refused: `` `command` element 0 "<program>" is a relative path; write an absolute path, or a bare name that `env.PATH` resolves ``. Scripts on Linux require [interpreter grants](#script-commands-on-linux). The example’s `command` runs Homebrew’s `node`, which loads the preload file and then the CLI’s script; the arguments after the script are the CLI’s own.

`workspace` is absolute, and it is optional: when absent, the box uses the directory `run` was started from. The directory must exist, and it may not be the operator’s home. The box enters it. The process reads nothing in it until a list in `filesystem` names it: the example’s `workspace` is the project, and the `list` entry below is what lets the CLI see the names in it.

`env.PATH` contains full directory paths separated by `:`. Box uses these entries as written, so `~` stays literal. For example, use `/home/alex/.local/bin:/usr/bin:/bin` instead of `~/.local/bin:/usr/bin:/bin`.

When the box declares an MCP server, it also protects directories on the `PATH` of the shell that starts Box. Keep those directories and their parents outside filesystem write grants. For example, a search directory `/work/tools/bin` prevents a write grant for `/work/tools`. Changing `env.PATH` in `box.toml` does not change this protection.

`env` is literal. Four kinds of name have their own rule:

-   **Names Box sets itself, which a table cannot claim:** `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`, `NO_PROXY`, `no_proxy`, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY`, `CODEX_CA_CERTIFICATE`, `AWS_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PWD`, `USER`, and every name that starts with `OTEL_EXPORTER_OTLP_`. A `[tool.<name>]` or stdio `[mcp.<name>]` table with `contain_egress = false` may set the first thirteen, because Box sets none of them there; see [a native-egress process keeps its own proxy and trust settings](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/design/decisions.md#a-native-egress-process-keeps-its-own-proxy-and-trust-settings).
-   **Names the dynamic loader reads, refused:** every name that starts with `LD_` or `DYLD_`. Box’s own aliases run in the box, so their loader would read the value too. A runtime’s own option variables, such as `NODE_OPTIONS`, `BASH_ENV`, `RUBYOPT`, `JAVA_TOOL_OPTIONS`, and `PYTHONPATH`, are the operator’s to set, and they reach only the process whose table names them. The `zsh`, `bash`, `sh`, `python3`, and `python` aliases run in Box and do not read them, so a shell or Python option variable reaches a real interpreter that the table runs or spawns, and not an alias call.
-   **`HOME`:** an absolute path. It stays the operator’s own home unless `[agent] env.HOME` names another directory; the example names `strands-home`, so the CLI reads its settings and writes its sessions there. A home inside `box_dir` is refused with `` `env.HOME` is <path>, which lies in trusted Box state. The box directory holds `bin`, `run`, `trust`, and `private`, and none of them is a home. Name a directory outside it, or omit `env.HOME` for the operator's own home ``, and a home that encloses `box_dir` is refused with `` `env.HOME` is <path>, which encloses the box directory <path>. A declared home is reachable, so a home above the box directory would put this box's own state, and any sibling box's, inside the reachable set. Name a home beside the box directory rather than above it, or omit `env.HOME` for the operator's own home ``.
-   **`TMPDIR`:** an absolute path.

A name Box sets is refused with `` `env` name "<name>" is set by the box itself, so a table cannot claim it ``. A dynamic-loader name is refused with `` `env` name "<name>" is read by the dynamic loader of every program in the box, Box's own aliases included, so a table cannot set it ``.

`TERM` and `COLORTERM` reach the process only when `env` names them, so a program that picks colors from them renders plain otherwise. The example names `TERM`; an operator who wants a program’s colors writes their own terminal’s values for both.

The agent reaches every `[egress.<name>]` route, every `[tool.<name>]`, and every `[mcp.<name>]` the file declares. A tool or MCP server reaches every egress route and starts no tool or MCP server of its own. All of them share one egress gateway, so the box is the credential boundary: a process that must not hold a credential goes in another box. Each tool and each `stdio` MCP server runs in its own separate sandbox (see [the sandboxes for tools and local MCP servers](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/design/containment.md#the-agents-box-and-leaf-boxes)).

### File watching

`file-watching = true` permits macOS FSEvents for the selected process and its descendants. Set it on an existing `[agent]`, `[tool.<name>]`, or local stdio `[mcp.<name>]` table. Each table selects the setting independently; an agent’s selection does not enable its tools or MCP servers. Omission and `false` keep FSEvents unavailable. The setting has no effect on Linux, which accepts the key.

For a Node development server, add the setting to that tool’s table:

```toml
[tool.dev]
command = ["node", "/work/project/server.js"]
workspace = "/work/project"
file-watching = true

[tool.dev.filesystem]
read = ["/work/project"]
write = ["/work/project"]
deny = ["/work/project/private"]
```

The process still needs the filesystem grants required by its runtime and application. **FSEvents can disclose names and event metadata for denied paths.** This includes removed or renamed paths and some historical events. A subscription to an accessible ancestor can disclose paths outside the workspace. FSEvents also discloses the host-wide event count and each volume’s history identifier. Filesystem `deny` entries do not fully filter this event stream. Direct file-content access and write restrictions still apply, except that a root process can delete any volume’s event history. FSEvents events do not pass through `fs:*` policy decisions, including experimental native filesystem policy checks.

Use this option only when these limitations are acceptable. Keep it disabled when denied filenames or activity must remain confidential, and use the application’s polling mode if available. Node directory watchers can report `EMFILE` when FSEvents is unavailable; this error does not necessarily mean that file descriptors are exhausted.

On macOS, the startup disclosure names each selected process before the agent starts. This includes stdio MCP servers that remain unstarted; Box repeats their disclosure when they start.

```text
strands-box: [tool.dev] file watching: macOS FSEvents may disclose denied names and event metadata, including outside the workspace and from past events, as well as the host-wide event count and each volume's history identifier; file-content and write restrictions still apply, except that a root process can delete any volume's event history
```

A record with any selected process requires version 35. For rollback, remove the key from every process table, then follow the [rollback steps](/docs/user-guide/box/security/native-filesystem-policy/index.md#stored-configuration-and-rollback). Older builds do not recognize the key, even when its value is `false`.

### Executable memory

On Linux, every process in a box can write code into memory and run it. A JIT runtime such as Node, Java, or Bun needs this, and so does Python `ctypes` when libffi writes a callback into memory. There is no setting. macOS has no such restriction.

**A process can run any bytes it writes into memory**, not only the programs its grants let it start. `memfd_create`, `pkey_mprotect`, descriptor `execveat`, and the `noexec` mounts stay refused, so the kernel never maps or starts a file outside the process’s `exec` grants. But a runtime that calls native code, such as Python through `ctypes`, can copy a readable program into memory and run it. For such a runtime, a `read` grant on a program works like an `exec` grant. The system-call filter, filesystem grants, and network policy still apply to that code.

### Script commands on Linux

On Linux, a script in `command[0]` requires existing filesystem grants for every program in its `#!` interpreter chain. Missing coverage prevents the process from starting. The refusal identifies the canonical interpreter path to grant. This path can differ from the spelling in the script.

| Declared process | Required interpreter coverage in its own `filesystem` table |
| --- | --- |
| `[agent]` | `exec`, naming each interpreter file or a directory that covers it. |
| `[tool.<name>]` or local `[mcp.<name>]` | `read` or `read_file`. Existing writable grants also count where they permit execution and satisfy the [Linux read-write requirement](#direct-access-by-operating-system). |

Tool and local-server tables do not accept an `exec` list. System paths have no exemption. `#!/usr/bin/env python3` requires coverage for both `env` and the selected `python3`. If either program is itself a script, its interpreter also requires coverage. Denials and protected paths still restrict access.

These fragments assume `/opt/check/check.sh` starts with `#!/usr/bin/dash`, and `/usr/bin/dash` is an executable regular file. Use the canonical path when the interpreter is a symbolic link. An agent script uses:

```toml
[agent]
command = ["/opt/check/check.sh"]

[agent.filesystem]
exec = ["/usr/bin/dash"]
```

A declared tool script uses:

```toml
[tool.check]
command = ["/opt/check/check.sh"]

[tool.check.filesystem]
read_file = ["/usr/bin/dash"]
```

Apply the same interpreter grants under `[mcp.<name>.filesystem]` for a local server. A tool interpreter granted through `read` or `read_file` can still need separate read grants for non-system libraries. Interpreter discovery does not automatically grant those libraries.

Alternatively, put the native interpreter in `command[0]` and grant read access to the script:

```toml
[agent]
command = ["/usr/bin/dash", "/opt/check/check.sh"]

[agent.filesystem]
read_file = ["/opt/check/check.sh"]
```

The command has an implicit executable grant. The script is an argument that the interpreter reads. Other files the program needs still require their own coverage.

Box checks the original grants before preserving any additional path spelling needed to start the script. Preserving a spelling adds no authority over a different file. On macOS, Box grants a declared command’s interpreter chain automatically. A workload-selected program without a tool table requires its interpreter chain to have existing `exec` coverage on either platform.

A script that a process writes or downloads at run time, such as a `#!/bin/sh` command in `node_modules/.bin`, names its interpreter by the host’s spelling. On a Linux host where `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64` or `/libx32` is a link into `/usr`, as on Debian, Ubuntu, Fedora and Amazon Linux, each sandbox has the same link at its top level. With `read_file = ["/usr/bin/sh"]`, `/bin/sh` then resolves to the granted file, and the script starts. A link reaches only what the sandbox already shows, so it grants nothing. A grant or deny written with the link’s name, such as `/bin/bash`, applies to the same file, at `/usr/bin/bash`.

## `[[agent.ingress]]`

Each entry is one listener: the box listens on `listen` and relays each caller’s TCP connection to the port the agent’s server listens on. Add an entry for each port the agent serves, such as one for HTTP and one for MCP. An agent may declare up to five entries. The agent’s code does not change, and the agent gains no reach. Ingress is experimental, so `[experimental-features]` must set `ingress = true`.

```toml
[experimental-features]
ingress = true

[[agent.ingress]]
listen        = "0.0.0.0:8080"
workload_port = 8081

[[agent.ingress]]
listen        = "0.0.0.0:8000"
workload_port = 8001
```

| Key | Type | Meaning |
| --- | --- | --- |
| `listen` | string | The IP address and port the box binds for callers, such as `"0.0.0.0:8080"`. Required in each entry. |
| `workload_port` | integer | The port the agent’s server listens on in its sandbox. Required in each entry. |

The agent listens on `workload_port` on `127.0.0.1` or `0.0.0.0`, because the relay connects to `127.0.0.1` only. An agent that listens on `::1` alone gets no callers, and the box logs that nothing accepts on its port. On Linux the agent’s sandbox creates no IPv6 socket, so an agent that binds `::1` fails to start.

-   The box binds every `listen` before the agent starts, so a port in use refuses the run.
-   Each entry needs its own `listen` port and its own `workload_port`.
-   On macOS, no `listen` port may equal any entry’s `workload_port`, and the box refuses to start when another process already listens on a `workload_port`.
-   On macOS, the agent may listen only on its `workload_port`s, on any address of the Mac. A local process can also connect to those ports directly, and the network can when the agent listens on `0.0.0.0`.
-   No policy decision covers a caller. `listen` decides who can reach the agent.
-   `ingress` is refused on a `[tool.<name>]` and on an `[mcp.<name>]`.
-   Without `ingress = true`, `[[agent.ingress]]` is refused: ``invalid `[agent]` table: `ingress` is experimental: set `ingress = true` in `[experimental-features]` to load it``.

At startup the box prints each listener:

```text
strands-box: [ingress] 0.0.0.0:8080 is relayed to the agent's port 8081, at most 640 callers at once
strands-box: [ingress] 0.0.0.0:8000 is relayed to the agent's port 8001, at most 640 callers at once
```

On Linux, the box starts no listener’s relay until the agent’s sandbox reports that it is ready, and a caller that arrives earlier waits in the listen queue. A sandbox that does not report ready within 60 seconds refuses the run.

The box raises its own open-file limit as far as the system allows, and holds at most an eighth of it in callers at once, split evenly across the listeners; a further caller waits until one closes. The agent and every tool start with the open-file limit the box started with. When nothing accepts on `workload_port`, the box closes each caller and prints one line until a caller is served again.

## `[agent.filesystem]` and `[tool.<name>.filesystem]`

Each list, and what one entry in it grants. `[agent.filesystem]` takes all nine; `[tool.<name>.filesystem]` takes seven. A `metadata` or `exec` list there is refused by name at load. [A tool’s sandbox](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/design/containment.md#a-tools-leaf-box) states what a tool reaches in their place.

Every process’s writable grants must exclude the installed Box programs, their hard-link names, mounted aliases, and enclosing directories. [Installation integrity](#installation-integrity) describes the checks and refusals.

| List | What each entry grants |
| --- | --- |
| `read` | Read the path. A directory entry covers everything below it. |
| `write` | Write the path. On macOS, add `read` to permit reads, and a sandboxed program that sets a file’s times needs [`file-attributes`](#file-attributes). Linux requires explicit read access across the entire write scope. |
| `read_file` | Read one exact file. The entry names a file. |
| `write_file` | Write one exact file. Linux requires explicit read access to that file. The entry names an existing file. |
| `list` | List the directory without content access on macOS. Linux refuses this list. |
| `metadata` | Inspect file properties below a directory without content access on macOS. Linux omits this grant without an error. **`[agent.filesystem]` only.** |
| `exec` | Run the path. A file entry names an executable; a directory entry covers the binaries below it. **`[agent.filesystem]` only.** |
| `deny` | Refuse the path, even when another list grants it. Linux requires the target to exist. |
| `deny_write` | Refuse every write below an existing directory inside a `write` directory. Reads and `exec` grants there still apply. The box stores its record at version 38. The agent, a tool, and a local MCP server take it. |

Use `deny_write` for a directory that the agent runs code from, such as a Python virtual environment in a writable project. Create and fill the directory before the box starts. The agent can then run its programs but cannot change them:

```toml
[agent.filesystem]
read = ["/work/project"]
write = ["/work/project"]
exec = ["/work/project/.venv"]
deny_write = ["/work/project/.venv"]
```

The agent cannot create, change, rename, link, or remove anything below the directory. Like the other lists, `deny_write` governs the agent’s own processes. A Shell or Python request through Box is decided by policy, so pair the entry with `forbid` rules on `fs:write`, `fs:delete`, and `fs:move` for the directory. A file below it that also has a hard link in a writable directory can still be changed through that link. Install with copies, such as `UV_LINK_MODE=copy`, or keep the installer’s cache outside every write grant. The box does not warn that a program below a `deny_write` directory is writable. The startup disclosure lists each entry as `deny_write <path> (read-only)`. A `[tool.<name>] command` below a `deny_write` directory is still refused, as every tool command inside a write grant is.

A tool or a local MCP server that writes the directory’s parent can still change the directory unless its own `[tool.<name>.filesystem]` or `[mcp.<name>.filesystem]` also lists it in `deny_write`. A tool’s leaf box keeps the protection with broad exec: it can run programs from the directory but cannot change them.

On macOS, opting into [file watching](#file-watching) permits an event stream that can disclose denied names and activity despite these direct-access restrictions. A root process can also delete any volume’s event history.

On Linux, root and non-root launches support directory writes with explicit read and write grants. Permitted file creation retains the launcher’s underlying file identity. Existing-file write grants permit writes to their named files. Private `/tmp` storage remains writable and separate from the surrounding OS.

These filesystem lists govern sandbox access. Shell and Python requests through Box use separate policy and reach checks in the box’s trusted process. Permitted file creation retains that process’s file identity.

On Linux, write access permits ordinary file writes. Permission changes, including executable-bit changes, require a requested mode without set-user-ID or set-group-ID bits. Changing a file’s owner or group, or requesting either special bit during creation, remains forbidden. These requests fail with `EPERM` (operation not permitted). Opening an existing file without creation flags does not use its supplied creation mode. Existing shared-group directories retain Linux’s normal group inheritance for new subdirectories. A permission change also fails if its requested mode keeps a set-user-ID or set-group-ID bit that the file or directory already has. The request must clear both bits to succeed. This includes directories that inherited their group bit: GNU `chmod g+w` and even `chmod 755` preserve that bit and fail. A refused request leaves the existing permissions unchanged.

### Direct access by operating system

The read and write lists state separate permissions. These rules also apply to local servers under `[mcp.<name>.filesystem]`.

| Requested access | Settings | macOS | Linux |
| --- | --- | --- | --- |
| Read-only | `read` or `read_file` | Supported | Supported |
| Write-only | `write` or `write_file`, without covering read access | Supported | Startup refuses the configuration before any workload runs |
| Read-write | Explicit read and write grants | Supported | Supported |
| Read directory with writable child | Parent in `read`, child in `write` or `write_file` | Supported | Supported |
| Write directory with only a readable child | Parent in `write`, child in `read` or `read_file` | Supported | Startup refuses the uncovered write-only scope |

Linux writable mounts also allow reads. Box requires an explicit read grant that covers each entire write grant. An exact-file read covers only that file. A directory read covers that directory and its descendants. Execute grants do not satisfy this requirement.

For Linux read-write access, put a directory in both `read` and `write`. For one file, use `read_file` and `write_file`. To retain read-only access, remove the write grant.

An agent’s read grant on a recognized Linux loader directory also permits shared-library loading. If overlapping writes make that directory writable, startup refuses it without a directory `exec` grant. This includes writes granted through another spelling or an ancestor directory. Remove the write access, or explicitly grant execution where the existing path protections permit it. An `exec` entry for one file does not authorize the whole directory. Ordinary read-write data directories and the broader execution mode for tools remain unchanged.

Startup output states `read-only`, `write-only`, or `read-write` for each content-access grant. For partial overlaps, the parent entry also identifies the overlapping grants that allow both. Denials and protected paths still restrict access. Duplicate or nested grants of the same operation still cause startup refusal.

The example uses four lists. `read` covers the CLI’s install tree and `strands-home`, `read_file` names the preload file and Homebrew’s OpenSSL settings, `write` covers `strands-home`, and `list` names the project. `strands-home` is in both `read` and `write` to request read-write access explicitly. On macOS, the project is in `list` alone, so the CLI sees its names while policy decides each file its shell opens. Linux refuses this example’s `list` entry. See the [platform comparison](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/design/platform-differences.md).

Each entry is absolute, or is `~` or starts with `~/`. An entry carries no pattern, no control character, and no `..` component. A directory entry that encloses this box’s `box.toml` and `policy.dw` grants everything below it except the directory that holds those two files.

**An entry names the file the kernel checks**, so an entry that is itself a symbolic link is refused, and the refusal names what the link points at. Whether a path such as `/bin/sh` is a link depends on the surrounding OS, so the same `exec = ["/bin/sh"]` entry loads under one and is refused under another. Write the target the refusal names.

A `read` or `read_file` entry is the one exception: it may name a symbolic link to a file, such as `/usr/bin/cc`. A program often runs a helper by that name, so the name has to be there too.

-   The grant is the file the link resolves to, checked like any other entry.
-   The box shows that file at the link’s name as well, read-only.
-   The link must sit in its own real folder. A link reached through a linked folder is refused.
-   Two links to one file, such as `/usr/bin/cc` and `/usr/bin/gcc` on Ubuntu, are two entries. A link beside a `read` folder that holds its file is kept too, because the link’s name is outside that folder. A link listed next to its own file is refused as granted twice.
-   A link inside a credential store, such as `~/.ssh/config`, is refused. Name the file itself.
-   The links in between, such as `/etc/alternatives/cc`, and the folders that hold them are not granted.
-   A link to a directory, and a link in `write`, `write_file`, `exec`, `list` or `metadata`, is still refused.
-   The disclosure shows the entry as `read_file /usr/bin/cc -> /usr/bin/gcc`.

**No policy decision covers a filesystem list**, so `run` discloses each entry on stderr before the workload starts, under `strands-box: [agent] runs <program> with no policy decision over these paths:`. Getting started shows the example’s disclosure. A credential store, such as `~/.aws` or `~/.ssh`, is disclosed by name as well, as `strands-box: [tool.<name>]: exposes ~/.ssh (read)` for a tool granted the operator’s SSH directory.

On Linux, preserved interpreter spellings appear in a separate section before the runtime minimum:

```text
strands-box: [tool.check] interpreter aliases for configured access:
  alias       /bin/sh -> /usr/bin/dash  (interpreter spelling)
```

The arrow maps the script’s spelling to the file its configured grants already authorize. The section appears only when Box preserves an interpreter spelling.

With no `filesystem` table, the process reaches its `command` and the runtime minimum. The command’s own exec grant is implicit: a process may always run its `command`, and the startup disclosure shows that grant as `exec <command> (command, implicit)`. So removing a directory from `exec` does not refuse the process’s own command. The controls on a host binary are the `shell:spawn` permit and the `[tool.<name>]` table; [shell policy](/docs/user-guide/box/guides/write-shell-policy/index.md) states how a rule spells `program_path`.

### What is refused

Every refusal below names the table and the entry, as `` `[agent]` filesystem entry "<entry>" is refused: <reason> ``. `<path>` stands for the path the message names, and `filesystem.read` for whichever list holds the entry. Shape refusals happen at parse; existence and identity refusals happen after the box directory is created and before the workload starts.

| Entry | Refusal |
| --- | --- |
| A relative path | `` `filesystem.read` path "<entry>" must be absolute or start with `~/`, so a checked-in configuration holds in every clone `` |
| A pattern or a control character | `` `filesystem.read` path "<entry>" must be exact and contain no pattern or control character `` |
| A `..` component | `` `filesystem.read` path "<entry>" carries `..`; name the path it means `` |
| The same path twice in one list | `` `filesystem.read` path <path> is duplicated `` |
| A path that does not exist | `<path> is not there: No such file or directory (os error 2). A grant on a path that does not exist grants nothing and says so nowhere` |
| A symbolic link, except a link to a file in `read` or `read_file` | `<path> is a symbolic link to <target>. A grant carries the identity the kernel checks, so a link renders a rule that matches nothing; name <target> instead` |
| A spelling the kernel resolves elsewhere | `<path> is not the path the kernel checks, which is <path>. A grant carries the identity it acts on, so name that path instead` |
| A directory in `read_file` or `write_file` | `` <path> is a directory; `read_file` names one file, and a tree belongs in `read` `` |
| A file in `list` | ``<path> is a file, and `list` enumerates a directory tree`` |
| A file in `metadata` | ``<path> is a file, and a file's metadata comes with the `read_file` or `exec` grant that names it`` |
| A file in `exec` that is not executable | `<path> is not an executable regular file` |
| Two grants of one operation that name one path, or that nest | ``<path> lies inside <path>, granted by `read`. The union is the wider grant, so the narrower one enforces nothing it appears to`` |
| A grant wholly inside a `deny` entry or the directory that holds `box.toml` and `policy.dw` | `<path> is at or inside <path>, which no grant reaches. The grant would render and reach nothing, so it is refused rather than left enforcing nothing` |
| A writable grant that reaches the policy file without subtracting it | `` `write` reaches this box's policy file, <path>. A grant may enclose it only when it is subtracted, and nothing subtracts it here `` |
| A writable grant that reaches a file or directory that `SSL_CERT_FILE` or `SSL_CERT_DIR` names for `box run` | `` `write` reaches <path>, which `SSL_CERT_FILE` or `SSL_CERT_DIR` names, and the egress gateway trusts every root certificate there. Remove the write, subtract the path with `deny`, or run without that variable `` See [networks that re-sign TLS](/docs/user-guide/box/guides/network-and-credentials/index.md#networks-that-re-sign-tls). |
| A writable grant at or above a directory on the operator’s `PATH` | `<path> is at or above <path>, which is on the search path this box resolves a bare-name MCP program against` (excerpt). Keep the directory and its parents outside write grants. |
| A writable grant can change an installed Box program, a hard-link name, or an enclosing directory | `this write grant can change trusted Box executable <path> or its path. Keep the Box installation outside every process's write grants` |
| A system directory or a credential store the box always refuses | `<path> is refused beneath every grant: <reason>` |
| A path that a [`[secret-source.<scheme>]`](#what-box-protects) table lists in `reads` or `deny`, a path inside it, or a folder that holds it | `` this grant reaches <path>, which the secret source `<scheme>` keeps from each workload (its `reads` entry "<entry>"). Keep each grant outside the paths that a secret source names in `reads` and `deny` `` |

Create the path first, or name the existing directory above it. A `[tool.<name>] command` that names a file the workload has not built yet is not refused: Box [leaves that tool out](#a-tool-whose-program-is-not-installed) for the whole run, so build the file before `run`. In the example, the CLI install, `strands-home`, the preload file, and the project all exist before the first `run`, because the tutorial’s earlier steps made them.

On Linux, `filesystem grant object changed while loading config` means a granted path selected a different object during that launch’s preparation. Let the filesystem update finish, then retry the launch.

**A `write` grant alone is not runnable.** The agent’s sandbox refuses to map code from a writable grant. When the agent’s `command` or one of its interpreters lies inside a writable grant, the startup disclosure carries a warning: `strands-box: warning: [agent] command <path> lies inside the writable grant <path>, so the process can replace the program it runs`.

On Linux, an agent also needs an explicit `exec` grant for an automatically discovered writable loader or shared library. Otherwise, startup fails with `writable dependency <path> needed by <program> has no explicit execution grant`. A `read` or `read_file` entry does not resolve this error. Remove write access to the library, or grant execution if the agent should run code it can change.

The same check covers writable symbolic-link paths and hard-link aliases. Immutable hard-linked libraries retain automatic execution access when Box can verify their ownership, permissions, and mount boundaries. A read-only file that the workload owns remains writable for this check because its owner can change its permissions. Ordinary local mounts can retain this exception when their ownership rules agree. Remapped ownership, nested mounts, unrecognized filesystem types, and inconclusive checks can still require explicit execution permission. Tools and local MCP servers retain their broader execution permission for their own filesystem grants. Their filesystem tables reject `exec`; only `[agent.filesystem]` accepts that list.

## `[tool.<name>]` selection

A tool table applies when a program the agent’s shell starts begins with the tool’s `command`: the same program, then the same fixed arguments. Box resolves each configured tool program before the workload starts and keeps that file identity for the run. The longest matching prefix wins. Every declared tool is selectable, unless Box leaves it out, and a program under one of the agent’s own `exec` entries needs no table of its own.

### A tool whose program is not installed

When a tool’s program is not installed, Box leaves that tool out and the box still starts. The program is not installed when:

-   nothing with a bare name’s spelling exists in any directory on the tool’s search path, or
-   nothing exists at an absolute path.

A search-path entry that is a file, or that Box cannot search, holds nothing.

A symbolic link to a file that doesn’t exist counts as nothing. A symbolic link that loops does not count as nothing, so Box refuses to start.

`run` prints one line for each tool it leaves out, before the workload starts:

```text
strands-box: [tool.tsx] left out: tsx not found
```

A left-out tool gets no filesystem grants, and Box does not check its lists. It runs nothing for the agent. Its grammar stays, so a policy that names its actions still loads. A grammar decides spawns by program name, so it still decides another `[tool]` or stdio `[mcp.<name>]` with the same program name. The startup line for that table says so:

```text
strands-box: [tool.system_git]: a spawn of `git` is decided by its tool grammar, and no `shell:spawn` rule applies to it
```

The set of tools is fixed when the run starts. A program installed during the run, or a file that appears later at the tool’s path, does not run with the tool’s grants.

Box still refuses to start when the program exists and fails a check: it is not executable, it is not a regular file, or a write grant reaches it. A bare name counts as existing when any directory on the search path holds something with that name. Box also refuses a program that holds `${`, because a program is never expanded, and a `command` argument that names no value Box can expand in `${NAME}`. So a typo in a `command` path does not stop the box; check the `left out` lines.

The example box declares no tool, so a program its shell names is a `shell:spawn` decision with no table behind it, and the example policy permits none. A git tool for the CLI’s shell, with git from `brew install git`, needs `read` on the Homebrew trees git loads from, and `read` and `write` on the project:

```toml
[tool.git]
command = ["/opt/homebrew/bin/git"]
env     = { PATH = "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM = "1", GIT_CONFIG_GLOBAL = "/dev/null" }

[tool.git.filesystem]
read  = [
  "/opt/homebrew/Cellar", "/opt/homebrew/opt", "/opt/homebrew/etc", "/opt/homebrew/bin",
  "~/box-tutorial/my-project",
]
write = ["~/box-tutorial/my-project"]
```

A `shell:spawn` permit that admits `git` goes with the table, which by itself starts nothing.

A list entry that names a credential store gives the selected tool the operator’s long-lived credential bytes. To give a tool a secret, bind it with an `[egress.<name>] secret.ref`, and keep a tool’s `env` for non-secret literals.

### Configured command integrity

Box checks grants in `[agent]`, every `[tool.<name>]` it does not [leave out](#a-tool-whose-program-is-not-installed), and every local `[mcp.<name>]` table against those programs. The program of each [`[secret-source.<scheme>]`](#secret-sourcescheme) table gets the same checks. The write-grant refusal names that table. The hard-link refusals and the refusals through Strands Shell and Monty say `configured tool command` for it too.

| Condition | Refusal text | Next action |
| --- | --- | --- |
| A command path exists but is not an executable regular file. | `executable is not an executable regular file` | Correct the file’s mode or the command’s path. |
| A writable grant can overwrite the command or replace its path, including a symbolic-link route or enclosing directory. | `this write grant can change` the command `or its path` | Keep configured tools outside every process’s write grants. |
| A writable directory contains another name for an operator-writable configured command. | `this write grant contains a hard link to a configured tool command` | Narrow the writable directory to exclude the command’s hard-link names. |
| Box cannot finish scanning a writable directory for configured-command hard links. | `cannot be inspected for configured command hard links` | Restore access to the directory, or narrow the writable grant. |
| The command’s file identity changes during the run. A command with more than one hard link also counts as changed when its link count, owner, group, or mode changes. | `changed after this run loaded it` | Update the program between runs. |
| A change through Strands Shell or Monty reaches a configured command or its ancestor. | `is a configured tool command or its ancestor, which this run does not allow to change` | Select a path outside the configured command and its enclosing directories. |
| A directory change through Strands Shell or Monty reaches a hard-link alias for a configured command. | `contains a hard link to a configured tool command, so this mutation is not allowed` | Select a directory that excludes the command’s hard-link names. |
| Box cannot finish a directory scan for a change through Strands Shell or Monty. | `cannot finish checking for configured tool command hard links`, followed by the scan failure | Correct the reported access or inspection-limit problem, or select a smaller directory that Box can fully inspect. |

Box accepts a command with more than one hard link when ownership and access checks rule out writes by the operator through every name. The file belongs to another account, such as `root`, has no group or other write permission, and no access-control entry lets the operator write it. Most system programs are like this, such as `/usr/bin/git` on macOS and `/usr/bin/perl` on Ubuntu.

On macOS and Linux, a command with multiple hard links can remain writable by the operator. A startup scan must find none of its names in the declared writable directories of the agent, tools, or local MCP servers. The scan includes subdirectories excluded by `deny`. Each tree has a 30-second inspection budget and a depth limit of 128 directory levels. Box refuses an incomplete scan. It checks elapsed time between filesystem calls and before accepting a completed scan. This budget cannot interrupt a blocked filesystem call, and separate trees receive separate budgets. The command and its paths must still pass the writable-grant checks.

On Linux, Box can skip this scan for a configured program when it counts every hard-link name in the program’s own directory and verifies the mount layout for the directory being checked. The program and both directories must share one ext4, XFS, or tmpfs mount that exposes the filesystem’s root (`/`). No other mount may share its device or mount point, or sit at or below the program’s directory or the checked path. Box reads the mount table before and after counting and requires both results to match.

Box repeats this check for each writable directory and each directory changed through Strands Shell or Monty. Files and missing paths use the existing identity checks without this optional mount inspection. Each optional inspection has a separate 30-second budget, checked between filesystem calls; it cannot interrupt a blocked call. Directory targets use the recursive scan and its limits on macOS. Linux also uses that scan if any condition is unmet, an inspection error occurs, or the budget expires.

During the run, Strands Shell and Monty refuse changes to these programs and their enclosing paths, even when policy permits the operation. For operator-writable programs with multiple hard links, directory changes require a complete scan that finds none of their names, unless the Linux checks allow Box to skip it. The same inspection limits apply. Reads still require the applicable policy permission. Build output covered by the agent’s own grants remains writable when no tool table names it. On Linux, native programs can create hard links within one writable mount. Links across separate writable grants fail, even when their directories share a filesystem.

To update a configured tool, end the current run. Update the program from the surrounding OS. Start a new run to resolve and validate the updated program.

[Tool grammars](#toolnamegrammar) do not require a single hard link. They bind the executable file and the called name; other names follow the [`shell:spawn`](/docs/user-guide/box/reference/shell/index.md#shellspawn) rules.

### Installation integrity

Before the workload starts, Box checks its installed executable, containment launcher, and socket-alias image against every process’s writable grants. The socket-alias image routes shell and Python commands to Box’s policy checks. The check covers `[agent]`, every `[tool.<name>]`, and every local `[mcp.<name>]` table.

For the macOS package layout, Box protects an executable regular file named `box` beside `Box.app` as the package launcher. A standalone application bundle does not require that wrapper. A nearby directory, symbolic link, or non-executable file named `box` does not prevent startup. Operator-created launch scripts and additional symbolic-link names are outside this installation inventory. Keep those launch paths and their containing directories outside workload write grants.

Box accepts hard links only when it finds every name in the installation directory or its immediate `deps` directory. This includes Cargo’s build layout. Before each contained launch, Box checks the original file identities and hard-link counts. Linux also checks the files through existing mounts. If permission checks hide a possible alias, Box protects that path without inspecting its identity. A Linux namespace mount keeps a reference to an isolated operating-system resource, such as a network environment. During installation validation, Box accepts valid namespace mount records, including those created by Docker, when their device numbers differ from every protected Box executable. Invalid namespace records and other mount-table roots that are not filesystem paths still fail installation validation. Unrelated grants remain usable. On macOS, Box checks verified Data-volume spellings. A writable grant must exclude these aliases and their enclosing directories.

| Condition | Refusal text | Next action |
| --- | --- | --- |
| Box cannot account for every hard-link name. | `has hard links outside the installation inventory. Install an independent copy` | Install independent copies of the Box programs. |
| Linux cannot read or finish a stable inventory of mounted aliases. | `cannot inventory mounted executable aliases: <reason>` | Restore access to the process mount table, resolve other inspection errors, then retry after mount changes finish. |
| A recorded file name points to another file, or the hard-link count changes during the run. | `changed after this run loaded it. Stop Box before updating its installation` | End the run before installation updates. |

Strands Shell and Monty also refuse changes to these files and their enclosing paths, even when policy permits the operation. Reads still require the applicable policy permission.

End every active run before installation updates. Update the installation from the surrounding OS. Start a new run to validate the updated files.

## `[tool.<name>.grammar]`

This table holds the tool grammar for the program its `[tool]` runs, and it loads only when `[experimental-features] tool-grammars = true`. The feature is experimental. A spawn of the program is decided as a grammar action in place of `shell:spawn`, as [`shell:spawn`](/docs/user-guide/box/reference/shell/index.md#shellspawn) states. [Tool grammars](/docs/user-guide/box/guides/tool-grammars/index.md) shows how to write one and the rules that use it. `run` prints one line for each `[tool]` and stdio `[mcp.<name>]` whose program a grammar decides, so you can move its `shell:spawn` rules. A `shell:spawn` rule still decides each other name of that program file, such as `make` through macOS `/usr/bin/git`, except in the cases that [`shell:spawn`](/docs/user-guide/box/reference/shell/index.md#shellspawn) refuses:

```text
strands-box: [tool.git]: a spawn of `git` is decided by its tool grammar, and no `shell:spawn` rule applies to it
```

A copy of that program at another path is a different file, and `shell:spawn` still decides it. Keep `shell:spawn` permits narrow, or a copy gets past a forbid on the grammar’s actions.

Each of these is refused at startup, before any box state exists:

-   A grammar while `tool-grammars` is off: ``invalid `[tool.git]` table: `grammar` is experimental: set `tool-grammars = true` in `[experimental-features]` to load it``.
-   A grammar on `[agent]`: ``invalid `[agent]` table: `grammar` is refused on `[agent]`: ...``. A grammar on `[mcp.<name>]` is an unknown field there.
-   Two grammars with one `program`: ``tool grammar refused: `tool.brew_git.grammar` and `tool.git.grammar` both have `program = "git"`; keep one grammar for each program``.
-   Two grammars with one `name`: ``tool grammar refused: `tool.git.grammar` and `tool.hub.grammar` both have `name = "git"`; give each grammar its own name``.
-   A grammar that breaks a rule of the grammar format. Each refusal names the key, as a path in `box.toml`: `` tool grammar refused: `tool.git.grammar.shell.push.usage` has a `[` with no `]` `` .
-   A policy that names a `Tool::` action that no grammar declares: ``policy file ... will not load: policy references unknown action: ... unrecognized action `Tool::git::Action::"push"` ...``.
-   An `[mcp.Tool]` table while `tool-grammars` is on, because `Tool` is the namespace of every grammar action: ``invalid MCP server "Tool": `Tool` is the namespace of every tool grammar action while `tool-grammars` is on; give the server another name``.

A grammar binds under its `program`, the name the agent types, so `program` may differ from the last part of `command[0]`. Box CLI writes `npm` as the file its link leads to, such as `.../npm/bin/npm-cli.js`, and `program = "npm"` still binds under `npm`. When the last part of `command[0]` is the `program`, Box accepts the grammar. Otherwise, after it opens each tool’s program file and before the workload starts, Box finds `program` on the `PATH` that `run` was started with, which is the `PATH` the Shell searches. It refuses the grammar unless that file is the one `command[0]` names, such as `[tool.gh] command = ["gh"]` with `program = "git"`: ``invalid `[tool.gh]` table: `tool.gh.grammar.program` is "git", and `PATH` finds /usr/bin/git, but `command` runs /usr/bin/gh; ...``. When `PATH` finds nothing by that name, the message says `PATH` finds no program by that name.

An older build refuses a box that uses a grammar, so before you go back to one, turn `tool-grammars` off, remove every `grammar` table, and start the box once with this build.

## `[egress.<name>]`

Each table binds one secret to a set of destinations, and its name is the operator’s own label. The example’s `[egress.model]` binds `AWS_BEARER_TOKEN_BEDROCK` to the Bedrock endpoint, and `run` reads the key from its own environment. The agent, every tool or MCP server in the box, and the Shell get a placeholder in that variable, and the gateway swaps the key in on each request to the destination. A binding attaches a credential to a request the policy already permitted, and grants no network reach of its own: the example policy’s `net:connect` and `http:request` rules are what let the requests out. The current reference for this table is [`egress.md`](/docs/user-guide/box/guides/network-and-credentials/index.md).

| Key | Type | Meaning |
| --- | --- | --- |
| `destinations` | string array | A host, `host:port`, a path prefix or `/*` suffix, or a `*.` wildcard. A pattern that matches every host is refused, and two entries may not overlap. |
| `protocol` | string | `http`, the default and the only accepted value. |
| `secret.ref` | string | `env://NAME` for a variable on the operator’s side, `aws://PROFILE` to SigV4-sign as a named profile (resolved through the AWS SDK), a bare `aws://` to sign with the AWS SDK default credential provider chain (the host’s ambient identity), or a reference in a scheme that a [`[secret-source.<scheme>]`](#secret-sourcescheme) table declares, such as `op://Personal/GitHub/token`. Required. A literal value, or any other scheme, is refused. |
| `secret.env` | string | Experimental: needs `secret-sources = true` in [`[experimental-features]`](#experimental-features). The variable that holds the placeholder in the workload. Required with a reference in a declared scheme. Optional with `env://NAME`, where it must equal `NAME`. Refused with `aws://`. |
| `secret.placement` | string | `header` (default), `basic_auth`, or `query_param`. |
| `secret.header` | string | The header the secret lands in. Defaults to `Authorization`. |
| `secret.prefix` | string | Text before the secret in the header value. Defaults to `Bearer` on `Authorization`, and empty elsewhere. |
| `secret.param` | string | The query-parameter name. Required by, and only valid for, `placement = "query_param"`. |
| `secret.inject` | string | `phantom` (default) or `always`. `phantom` attaches the real secret only to a request that presents the box’s placeholder, and rejects any other. `always` attaches the real secret to every request to the destinations, with or without a placeholder, and the decision record carries an advisory note. Valid only for an `env://` route or a route in a declared scheme. |
| `secret.phantom_prefix` | string | The literal prefix of the minted placeholder, before its random suffix. Defaults to `strands_box_`. Set it, such as `sk-ant-`, so a harness that checks its key format accepts the placeholder. At most 64 characters from `A-Z`, `a-z`, `0-9`, `-`, `_`, `.`, `~`. Valid only for an `env://` route or a route in a declared scheme. |

The example takes every default: the key lands in the `Authorization` header with a `Bearer` prefix, and only a request that carries the placeholder gets it.

An entry needs a `secret` or a backend. One with neither is refused: `an entry with no secret declares only a destination, which policy already decides; give it a secret, add a backend, or set protocol = "mcp" for a remote MCP server`. `protocol` on this table takes `http` alone; declare a remote MCP server as `[mcp.<name>]` with `type = "http"`, which the next section describes.

An `aws://` route signs inside the box, so it takes no `header`, `prefix`, `placement`, `param`, `inject`, or `phantom_prefix`. Setting one is refused when the configuration loads. A bare `aws://` (no profile) signs with the host’s ambient identity; [Credential sources](/docs/user-guide/box/guides/network-and-credentials/index.md#credential-sources) describes the default chain, the profiles it does not resolve (AWS SSO), the warning and when it prints, and the writable-`~/.aws` rule.

An entry re-routes to a backend with one `[[egress.<name>.backends]]` table, holding a `url` (`scheme://host[:port][/prefix]`, `https` or `http`) and an optional `auth`, which is the backend’s own credential: an `env://` token, a token in a declared scheme, or an `aws://` profile SigV4-signed over the backend host (with an explicit `auth.aws.service` and `auth.aws.region`, since a gateway host carries no derivable scope). An `auth` takes no `env` key, because the workload holds no placeholder for it. The backend `url`’s path prefix joins in front of the agent’s request path. An entry may keep its own `env://` `secret` beside a backend, phantom-only: the box provisions the placeholder and strips it, never injecting the real destination credential, so the named variable need not be set. The loader refuses more than one backend, a destination that is not one exact host, a host with a backend that another entry also names (on any port), a `url` with a query, fragment, or a non-`http(s)` scheme, a `credsd://` `auth`, an `aws://` `auth` without a valid `auth.aws.service`/`auth.aws.region` (each non-empty and only lowercase `[a-z0-9-]`, or those keys on a non-`aws://` auth), a signed (`aws://` or `credsd://`) destination `secret`, a destination `secret` in a declared scheme, a destination `secret` beside an `http` backend, a destination `secret.inject` beside a backend (the re-routed secret is phantom-only, so `inject` has no effect), and an `auth` on an `http` backend. [The egress table](/docs/user-guide/box/guides/network-and-credentials/index.md#backends) describes the backend, and [egress design](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/design/egress.md) describes how the box dials it.

One placeholder variable holds one secret. Two entries that place a placeholder in one variable must name the same reference, and an `env://NAME` entry counts under `NAME`. Otherwise the load is refused, and the message names both tables: `` `[egress.b]` and `[egress.a]` both hold a placeholder in the variable TOKEN, and they name different secrets; one placeholder variable holds one secret, so give one of them another variable ``. An `aws://` route fills `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` with its own placeholders, so beside one, no other route can hold a placeholder in either variable. The own `secret` of an entry with a backend is not such a route, because Box strips that placeholder.

## `[secret-source.<scheme>]`

> **Status.** Experimental.

Each table declares one host program that reads a secret, and the table’s name is the scheme of the references that the program serves. Box runs the program itself, outside every sandbox, with your rights. A route, a remote MCP server, a backend `auth`, or a telemetry target then names a secret in that scheme, and the workload gets a placeholder. Set `secret-sources = true` in [`[experimental-features]`](#experimental-features) to load the table.

```toml
[experimental-features]
secret-sources = true

[secret-source.op]
protocol        = "box.secret-source.v1"
command         = ["/opt/homebrew/bin/op", "read", "op://{ref}"]
pass-env        = ["OP_ACCOUNT", "TMPDIR"]
pass-secret-env = ["OP_SERVICE_ACCOUNT_TOKEN", "OP_SESSION_*"]
reads           = ["~/.config/op"]

[egress.github]
destinations = ["api.github.com"]
secret.ref   = "op://Personal/GitHub/token"
secret.env   = "GH_TOKEN"
```

| Key | Type | Meaning |
| --- | --- | --- |
| `protocol` | string | The version of the contract between Box and the program. Required, and `box.secret-source.v1` is the only value. |
| `command` | string array | The program, then its arguments. Required. The program is an absolute path. One argument or more holds `{ref}`, which stands for the text after `<scheme>://` in a reference, without `#FIELD`. |
| `output` | string | How Box reads the program’s stdout: `text` (default) or `json`, where stdout is one JSON string. |
| `pass-env` | string array | Plain settings from your environment that the program receives when they are set, such as `AWS_REGION`. An entry that ends with `*` names each variable with that prefix. |
| `pass-secret-env` | string array | Credentials from your environment that the program receives when they are set, such as `OP_SERVICE_ACCOUNT_TOKEN`. An entry that ends with `*` names each variable with that prefix. No `env://` or `secret://` reference can read one of these variables. |
| `reads` | string array | The paths that the program reads, such as its configuration directory. Each is absolute, is `~`, or begins with `~/`. No grant can reach them, and each sandbox denies them. On Linux, a sandbox denies a path only when it exists as the box starts, and Box names each other entry on stderr. See [what Box protects](#what-box-protects). |
| `deny` | string array | Other paths to the vault, such as the directory of an authentication socket. Each is absolute, is `~`, or begins with `~/`. No grant can reach them, and each sandbox denies them. On Linux, a sandbox denies a path only when it exists as the box starts, and Box names each other entry on stderr. |

The scheme is a lowercase letter, then lowercase letters, digits, `+`, `.`, or `-`. A table can declare `op`, and no table can declare a scheme that Box reserves: `env`, `file`, `aws`, `credsd`, `secret`, `cmd`, `oauth2`, `aws-signed`, and `strip-phantom`.

A reference in a declared scheme can end with `#FIELD`, such as `aws-secretsmanager://box/telemetry#OTLP_KEY`, to name one field of a secret that is a JSON object.

Each of these is refused when the configuration loads:

-   A table while `secret-sources` is off: ``invalid `[secret-source.op]` table: a secret source is experimental: set `secret-sources = true` in `[experimental-features]` to load it``.
-   A reserved scheme, an absent `protocol`, another `protocol`, an empty `command`, a program that is not an absolute path, a `command` with no `{ref}` in its arguments, an `output` other than `text` or `json`, and an unknown key.
-   A `pass-env` or `pass-secret-env` entry that is empty, is `*`, is `PATH` or `HOME`, holds `=`, or holds a `*` before its end. The program always gets your `HOME` and a fixed `PATH`.
-   A `reads` or `deny` entry that is not absolute, is not `~`, and does not begin with `~/`.
-   A `reads` or `deny` entry that holds `..`, a control character, a second `/` after `~`, or one of the characters `*`, `?`, `[`, `]`, `{`, and `}`: `` invalid `[secret-source.op]` table: `reads` entry "~/.config/op*" is not a path that Box can protect; Box reads no pattern, so write each path without `*`, `?`, `[`, `]`, `{`, or `}` `` . Each entry names one path. This check doesn’t need the path to exist.
-   A reference in a scheme that no table declares: ``secret scheme "op" has no `[secret-source.op]` table``.
-   A reference in a scheme that a table can declare, with nothing after `://`, such as `op://`. A route, a remote MCP server, and a backend `auth` get `credential locator "op://" is invalid`, and a telemetry target gets `names no scheme this box reads`. Name the secret after `://`.
-   A route or a remote MCP server in a declared scheme with no `secret.env`.
-   A `secret.env` key while `secret-sources` is off. With `env://NAME` the key has no effect, so you can also remove it: ``secret.env is experimental: set `secret-sources = true` in `[experimental-features]` to load it, or remove secret.env, because an env:// reference already names its variable``.
-   An `env://NAME` or `secret://NAME` reference whose `NAME` a `pass-secret-env` entry names, on a route, a remote MCP server, a backend `auth`, or a telemetry target: ``the variable OP_SERVICE_ACCOUNT_TOKEN is a credential of the secret source `op` (its `pass-secret-env` names it), so no env:// or secret:// reference can read it``. A bare `aws://` route is not such a reference. It signs with the AWS identity of your environment, even when a `pass-secret-env` list names the AWS keys. So a request that policy permits to that route’s destinations is signed as the identity that reads the vault.

A box that declares a source stores its record at version 39, and so does a box with a `secret.env` key. An older build refuses that record.

### How a run reads the secrets

When the box starts, it checks the program file of each table and prints one line for each on stderr:

```text
strands-box: [secret-source.op]: reads each op:// secret with /opt/homebrew/bin/op, which runs outside every sandbox
```

Box then runs the program once for each secret that the configuration names, before the workload starts. Two references that differ only in `#FIELD` name one secret, so they share one run. Box reads the secrets of telemetry targets first and opens its records. Then it reads the others. It keeps each secret in memory for the run and writes none to disk. It reads no secret again during the run, so a secret that changes in the vault takes effect at the next start.

The program gets no stdin. Its environment is your `HOME`, the `PATH` `/usr/bin:/bin`, and each variable that `pass-env` and `pass-secret-env` name. It must exit with status 0 within 30 seconds and print at most 1 MiB. Box removes one trailing newline from what it prints.

A program that keeps a file under your temporary folder needs `TMPDIR` in `pass-env`, because it gets no other variable. The example passes it for `op`, which keeps the session of `eval "$(op signin)"` in `$TMPDIR/com.agilebits.op.<uid>`. Without `TMPDIR`, `op` says that no session is active. That folder is not in the `reads` of the example, so a workload with a grant on your temporary folder can reach it. To close that, add the full path of the folder to `deny`.

`policy generate-schema` reads the secret of a remote MCP server in the same way. It checks the program files and prints the lines only when a server names a secret in a declared scheme. It does both before it starts a stdio MCP server.

Each of these stops the box before the workload starts:

-   The program file is missing or is not an executable file: ``invalid `[secret-source.op]` table: its program cannot run: executable is not an executable regular file: /opt/homebrew/bin/op``.
    
-   The program returns no secret: it exits with another status, runs too long, or prints a value that Box can’t use. Box prints two lines. The first holds the reason and the last words of the program on its stderr. The second names the entry that holds the reference:
    
    ```text
    strands-box: [egress.github] secret.ref: credential error: the secret source "op" ("/opt/homebrew/bin/op") for op://[REDACTED] exited unsuccessfully (exit status: 1): [ERROR] "GitHub" isn't an item in the "Personal" vault
    strands-box: error: `[egress.github] secret.ref` names a secret that the secret source `op` (/opt/homebrew/bin/op) did not return, so the box does not start
    ```
    
    Sign in to the vault or correct the reference, then start the box again. When the entry is a `[telemetry.<name>]` target and the run is the first one of a new box directory, also remove the box directory before you start the box again. Box stores the box record before it reads that secret, so the next run otherwise stops and says that [the history is absent](/docs/user-guide/box/reference/policy/index.md#a-reused-box-whose-history-and-record-disagree).
    
-   A write grant covers the program, a symbolic link on the way to it, or a folder that holds one of them: `this write grant can change [secret-source.op] command /opt/homebrew/Caskroom/1password-cli/2.42.0/op or its path. Keep the program of each secret source outside every process's write grants`. Narrow the grant.
    
-   A `reads` or `deny` entry passes through symbolic links that don’t end, or through a folder that Box can’t search: ``invalid `[secret-source.op]` table: `deny` entry "~/.op/socket" cannot be inspected: the path passes through too many symbolic links``.
    
-   A write grant covers the folder that holds a symbolic link on the way to a `reads` or `deny` path, such as `~/dotfiles` when `~/.aws` names `~/dotfiles/aws`: `` this write grant can change /Users/me/dotfiles/aws, a symbolic link on the way to /Users/me/keys/aws, which the secret source `aws-secretsmanager` keeps from each workload (its `reads` entry "~/.aws"). Keep each write grant outside the folders that hold a link on the way to a path that a secret source names in `reads` and `deny` `` . Narrow the grant.
    
-   A grant reaches a `reads` or `deny` path: `` this grant reaches /Users/me/.aws, which the secret source `aws-secretsmanager` keeps from each workload (its `reads` entry "~/.aws"). Keep each grant outside the paths that a secret source names in `reads` and `deny` `` . Remove the grant.
    
-   On Linux, a `reads` or `deny` entry names a socket or another path that is not a folder or a regular file: ``invalid `[secret-source.op]` table: `deny` entry "~/.op/agent.sock" names /home/me/.op/agent.sock, which is not a folder or a regular file. On Linux, Box protects only a folder or a regular file: name the folder that holds it, or remove the entry``. Name the folder that holds the socket. Don’t make a folder at the path of a socket, because the vault’s app can’t make its socket there.
    
-   A reference that the program can’t take: the text after `<scheme>://` starts with `-`, names no secret, or ends with an empty `#FIELD`. Box starts no program for it.
    
-   A secret that is a JSON object, on a reference with no `#FIELD`. Name one field.
    
-   The program path names another file than the one Box checked when the run started: `did not start: its program file changed after the box checked it`. Start the box again.
    

### What Box protects

A workload must not go around Box to the vault. So Box protects the files and the paths that the table names, in `[agent]`, each `[tool.<name>]` table that the run does not [leave out](#a-tool-whose-program-is-not-installed), and each local `[mcp.<name>]` table. It checks each one before it starts a program for the first time, in `box run` and in `policy generate-schema`, so a box that fails a check never runs the program. `policy generate-schema` leaves no tool out, so it checks each `[tool.<name>]` table.

**The program file.** Box keeps the program file away from the workload as it does for a [configured tool program](#configured-command-integrity). The program file is element 0 of `command`. A write grant can’t cover that path, the file that it resolves to, a symbolic link on the way, or a folder that holds one of them. The Shell and Monty can’t change them.

**The arguments.** The program file is the one file of `command` that Box protects. Box doesn’t protect a file that a later element names, such as the script in `command = ["/bin/sh", "/Users/me/tools/vault.sh", "{ref}"]`. A workload that can write that script changes what runs outside the sandbox. So make a script the program: give it a `#!` line and the execute bit, and write `command = ["/Users/me/tools/vault.sh", "{ref}"]`. Box also doesn’t know about a file that the program loads by itself, such as a library, a module, or a settings file. Keep each of those outside every write grant yourself, or list it in `reads`.

**The `reads` and `deny` paths.** No grant can reach one of these paths. Box refuses a filesystem entry in any list except `deny` and `deny_write` that names the path, a path inside it, or a folder that holds it. That includes a credential store that a grant can otherwise name exactly: with `reads = ["~/.aws"]`, a tool can’t take `read = ["~/.aws"]`. A `deny_write` entry at such a path grants nothing, and Box refuses the `write` entry that it needs around it. Each sandbox also denies these paths, as it denies an entry of its own `deny` list. An entry that is a symbolic link protects the link and the path that it names. On macOS, a path that is absent when the box starts stays closed if it appears later. That includes a path behind a link, such as a socket that an app makes when it starts. On Linux, a sandbox gets an empty, read-only folder or an empty file in place of each path that exists when the box starts. Box skips an entry whose path doesn’t exist then, or whose symbolic link names a target that doesn’t exist: the box starts, and no sandbox denies that path in this run. No grant can reach it, as on macOS. Box prints one line for the entry after the line of its source:

```text
strands-box: [secret-source.op]: `reads` entry "~/.op" names /home/me/.op, which does not exist when the box starts, so no sandbox denies it in this run
```

So one table can name each place that a vault can have, and a box starts on a machine that has only some of them. `policy generate-schema` prints the same line when a remote MCP server names a secret in that scheme. Read these lines when you write a table: on Linux a path with a typing error doesn’t stop the box, and the line is how you see it. No write grant can reach the folder that holds a symbolic link on the way to the path, because a change to the link writes that folder. This protection is for the sandboxes. Strands Shell and Monty run outside every sandbox, and the first limit below is about them.

**The `pass-secret-env` variables.** Box gives your value of each of these variables to the program, and to no workload. The environment of a workload holds what the `env` of its table states and what Box adds. But for `HOME` and `PATH`, nothing comes from your shell. No `env://` or `secret://` reference can read one of these variables, so no route and no telemetry target can send the credential out. An entry that ends with `*` covers each of your variables with that prefix. A `pass-env` variable has no such rule.

These limits remain:

-   Strands Shell and Monty don’t protect a `reads` or `deny` path, or a symbolic link on the way to one. Policy alone decides a read or a change there. A rule that permits `fs:read` on such a path lets the workload read the vault’s files through the Shell or Python. A rule that permits `fs:write`, `fs:delete`, or `fs:move` there lets it change them, and a changed settings file can change what the program of the source runs. So give each `fs:*` permit a path condition that holds no path of the vault, and add a `forbid` for those paths:
    
    ```text
    @id("vault_files")
    forbid (
      principal,
      action in [
        Box::Action::"fs:read", Box::Action::"fs:write",
        Box::Action::"fs:delete", Box::Action::"fs:move"
      ],
      resource
    )
    when { context.input.path == "~/.config/op" || context.input.path like "~/.config/op/*" };
    ```
    
    The rule names the path and each path inside it. It compares each letter exactly, so it doesn’t match another case of a name. The path conditions of your `fs:*` permits protect the vault, and this rule is a second check. From Strands Shell, [policy reads a path](/docs/user-guide/box/reference/policy-actions/index.md#filesystem) with each symbolic link resolved. So when the path is a symbolic link or passes through one, write the rule for the path that it resolves to, and for each link on the way. The rule doesn’t match a move or a deletion of a folder above the path or above a link on the way, so don’t permit those on your home, on `~/.config`, or on a folder that holds such a link. No check beneath policy refuses these paths in the Shell or Monty. The [limits page](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/design/limitations.md#a-secret-source-runs-outside-every-sandbox) says more.
    
-   Box doesn’t compare the `env` or the `command` of a table with your values of the `pass-secret-env` variables. A workload holds one of those values only when you write the value in a table of `box.toml` or type it after `box run`. Don’t do either. A workload can use the same name for a value of its own, such as the placeholder of a signed `aws://` route in `AWS_ACCESS_KEY_ID`.
    
-   Each check covers one box. Keep each program and each `reads` path outside every folder that any other box can write.
    
-   On Linux, no sandbox denies a `reads` or `deny` path that is made after the box starts, until the next start. No grant reaches such a path, so a sandbox can see it only inside a system folder that Box adds to each sandbox itself. One exception: Box makes the sandboxes after it reads the secrets. So each sandbox denies a path that appears during that read, such as a folder that the program of the source makes on its first run, though the line says that no sandbox denies it. A path that goes away during that read gets no line, and no sandbox denies it. Start the vault’s app before the box, or name a folder that exists.
    
-   On Linux, keep each `reads` and `deny` path in place while the box runs. If one goes away, a tool or a stdio MCP server whose program is a script doesn’t start until the path is back: `interpreter /bin/bash cannot resolve denied path /home/me/.config/op`. Box adds a few system folders to each sandbox itself, and the startup lines list them under `runtime minimum, added by Core`. If a protected path inside one of those folders goes away and comes back, a sandbox that already runs can read the new path. The agent can also read a protected file through `/etc/localtime` when that name is a link to the file.
    

## `[mcp.<name>]`

Each table declares one MCP server. `type` selects the transport. A `stdio` server is a local program that the box starts in its own separate sandbox. It starts only when a `shell:spawn` permit covers its `command`; [MCP policy](/docs/user-guide/box/guides/write-mcp-policy/index.md) lists the fields that decision carries. When no permit covers it, the open fails with `MCP server "<name>" may not start: <decision>` and the server does not run. An `http` server is a remote server the workload reaches through the egress gateway. Each request is an `mcp:call` decision, and a rule reads the table’s name as `context.input.server`. The current reference for this table is [`mcp.md`](/docs/user-guide/box/guides/add-an-mcp-server/index.md). The box adds the runtime minimum to the server’s process; see [the runtime minimum](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/design/containment.md#the-runtime-minimum).

The example box declares no MCP server. To give the Strands CLI one, declare it here, and add it under `mcpServers` in the file the CLI reads through its `--mcp-config` option. Use the executable’s filename and the same arguments, in the same order. The box places an alias with that filename on the agent’s `PATH`, so when the CLI starts `mcp-server-fetch`, the box runs this table’s `command` in a separate sandbox:

```toml
[mcp.fetch]
type    = "stdio"
command = ["mcp-server-fetch"]

[mcp.fetch.filesystem]
read = ["~/.local/share/uv/tools/mcp-server-fetch", "~/.local/share/uv/python"]
```

| Key | Type | Meaning |
| --- | --- | --- |
| `type` | string | `stdio` or `http`. |
| `command` | string array | For `stdio`: a bare program name or absolute executable path, followed by its arguments. The executable’s filename names the alias in the box’s `bin/`. The harness runs that alias with the arguments. Two tables can share an alias when their arguments distinguish them. See [executable paths](/docs/user-guide/box/guides/add-an-mcp-server/index.md#select-an-executable-by-path). |
| `workspace` | string | For `stdio`: the server’s initial working directory. It grants nothing. |
| `env` | table | For `stdio`: the literal environment the server receives. `HOME` and `PATH` default to the operator’s own, as for `[agent]`. |
| `filesystem` | table | For `stdio`: the six lists the server’s own syscalls reach, the same six a `[tool.<name>.filesystem]` takes; a `metadata` or `exec` list is refused by name. An absent table grants nothing, so the server’s sandbox has the runtime minimum and the reach that [a local MCP server’s sandbox](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/design/containment.md#local-mcp-servers) states. |
| `argument_wildcards` | bool | For `stdio`: `false` by default. `true` lets this server’s whole-argument `*` entries match and forward caller-supplied values. See [argument wildcards](/docs/user-guide/box/guides/add-an-mcp-server/index.md#argument-wildcards). |
| `network.contain_egress` | bool | For `stdio`: `true` by default. `false` gives this one server direct network access, with no gateway, no policy decision per request, and no credential injection. |
| `native-filesystem-policy` | boolean | For `stdio`: override the global experimental filesystem policy setting. Remote `http` entries refuse this field. See [workload selection](/docs/user-guide/box/security/native-filesystem-policy/index.md#select-workloads). |
| `file-watching` | boolean | For `stdio`: `false` by default. Permit macOS FSEvents with the [limitations](#file-watching). Linux ignores this setting. Remote `http` entries refuse this field. |
| `destinations` | string array | For `http`: the hosts the server answers on. |
| `secret.ref` | string | For `http`: the credential the gateway attaches on the way out. |
| `secret.env` | string | For `http`, and experimental: needs `secret-sources = true` in [`[experimental-features]`](#experimental-features). The variable that holds the placeholder in the workload. Required with a reference in a [declared scheme](#secret-sourcescheme). |
| `backends` | table array | For `http`: a backend to re-route the server’s requests to, at most one. The same shape and rules as an `[egress.<name>]` backend; a `stdio` table refuses it. See [Backends](/docs/user-guide/box/guides/add-an-mcp-server/index.md#backends). |

Without native filesystem mediation, no `fs:*` decision covers a `stdio` server’s direct file operations. The experiment checks selected operations while retaining the server’s filesystem grants. The startup report lists the agent’s and each tool’s grants, and a `stdio` server’s grants are in its table alone, so read the table before you let the server start. See [the security page](/docs/user-guide/box/security/index.md) for what `box.toml` grants directly.

## `[telemetry.<label>]`

Each table declares one export target. The label is your own, and a refusal names it. The example box declares none, so its decisions go to the default record file under `box_dir`, which getting started reads with `jq`.

| Key | Type | Meaning |
| --- | --- | --- |
| `kind` | string | `file`, `otlp`, or a vendor: `langfuse`, `langsmith`, `cloudwatch_logs`, or `cloudwatch_traces`. Required. |
| `destination` | string | For `file`, an absolute or `~/`\-relative path. Inside this box’s `box_dir` it must lie under `private/`; outside the box any path is accepted. For `otlp`, the collector endpoint. For `langfuse` and `langsmith`, the base address, which defaults to the vendor’s cloud. A CloudWatch kind takes `region` instead, and refuses `destination`. |
| `include` | string array | Which records reach this target: `deny`, `permit`, `trace`, `logs`, `metrics`, or `mcp_tool_calls`. `trace` names the agent’s own spans and the box’s control-plane records. `logs` includes unmatched MCP routing diagnostics. `mcp_tool_calls` names each MCP tool call’s arguments and output in clear text, and how it ended. **Absent means every signal except `mcp_tool_calls`**, which a target receives only when it names it. An empty list is refused, and so is a repeated word. |
| `accepts` | string array | For `otlp`: which OTLP payloads the endpoint takes, from `traces`, `logs`, and `metrics`. Absent means all three. The box sends no batch of a payload the list leaves out. |
| `headers` | table | For `otlp`: fixed headers sent on every request. A header that carries a credential or a signature is refused here. |
| `secret.ref` | string | `env://NAME`, `secret://NAME`, `aws://PROFILE`, `credsd://ENVIRONMENT`, or a reference in a [declared scheme](#secret-sourcescheme). `aws://` and `credsd://` sign each request with SigV4. A literal value is refused. The box attaches this secret itself, so the target takes no `secret.env`. |
| `secret.placement` | string | For `otlp`: `header` (default) or `basic_auth`. `basic_auth` sends a `user:password` secret as `Authorization: Basic`. |
| `secret.header` | string | For `otlp`: the header the secret lands in. Defaults to `Authorization`. |
| `secret.prefix` | string | For `otlp`: text before the secret in the header. Defaults to `Bearer` on `Authorization`, and empty elsewhere. |
| `project` | string | For `langsmith`: the project the spans go to. |
| `region` | string | For a CloudWatch kind: the AWS region, such as `us-west-2`. Required. |
| `log_group`, `log_stream` | string | For `cloudwatch_logs`: where the log records go. Both are required. For `cloudwatch_traces`: the log group and stream the spans go to. Write both or neither. Absent, CloudWatch puts the spans in its default `aws/spans` log group. |

A vendor kind sets the vendor’s path, headers, payloads, and credential placement itself. Write only what is yours:

```toml
[telemetry.langfuse]
kind = "langfuse"
destination = "https://us.cloud.langfuse.com"
secret.ref = "env://LANGFUSE_AUTH"            # public-key:secret-key

[telemetry.langsmith]
kind = "langsmith"
project = "my-project"
secret.ref = "env://LANGSMITH_API_KEY"

[telemetry.cloudwatch_logs]
kind = "cloudwatch_logs"
region = "us-west-2"
log_group = "my-group"
log_stream = "my-stream"
secret.ref = "aws://my-profile"

[telemetry.cloudwatch_traces]
kind = "cloudwatch_traces"
region = "us-west-2"
secret.ref = "aws://my-profile"
```

| Kind | Sends | Credential |
| --- | --- | --- |
| `langfuse` | spans, to `<destination>/api/public/otel`, with `x-langfuse-ingestion-version: 4` | Basic auth, from a `public-key:secret-key` secret |
| `langsmith` | spans, to `<destination>/otel`, with `Langsmith-Project` when `project` is set | `x-api-key` |
| `cloudwatch_logs` | log records, to `https://logs.<region>.amazonaws.com`, with `x-aws-log-group` and `x-aws-log-stream` | SigV4 for `logs`, from `aws://` or `credsd://` |
| `cloudwatch_traces` | spans, to `https://xray.<region>.amazonaws.com`, with `x-aws-log-group` and `x-aws-log-stream` when `log_group` and `log_stream` are set | SigV4 for `xray`, from `aws://` or `credsd://` |

A `langfuse` or `langsmith` target also takes a reference in a [declared scheme](#secret-sourcescheme), such as `secret.ref = "aws-secretsmanager://box/telemetry#LANGSMITH_API_KEY"`. A CloudWatch kind takes only `aws://` or `credsd://`.

A vendor kind refuses each key it sets itself: `headers`, `accepts`, `secret.header`, `secret.prefix`, and `secret.placement`. The message is ``a `<kind>` target sets `<key>` itself, so leave it out``. A key that belongs to another kind is refused with `` `<key>` does not apply to a `<kind>` target ``. Box stores each vendor target as the `otlp` target it stands for. For a vendor Box does not know, write `kind = "otlp"` with `accepts`, `headers`, and `secret` yourself.

A secret needs an `https://` destination unless the destination is loopback. Box checks each `aws://` and `credsd://` telemetry credential before the workload starts, so a profile that cannot sign or a daemon that does not answer stops the run.

When the run ends, Box prints one stderr line if an export to a configured target failed, or if the final export did not finish in time. Set `STRANDS_BOX_TELEMETRY_DEBUG` to any non-empty value in the environment of `strands-box run` to also print each failed export as it happens, with its full cause and the start of the endpoint’s answer, with each credential Box attached redacted.

A file destination inside the box directory and outside `private/` is refused: `"<path>" is inside the box directory <path> but outside its private tree, where a process could truncate it; name a destination under` private/`, or outside the box, or declare no target and take the default`. An empty `include` is refused with `the target names no signal, so nothing would reach it; write one or more of: deny, permit, trace, logs, metrics, mcp_tool_calls`, and a repeated word with `the target names deny twice`.

A box with no `[telemetry]` table writes its default file with every signal except `mcp_tool_calls`. See [a tool call](/docs/user-guide/box/guides/record-telemetry/index.md#a-tool-call).

### Agent logs and metrics are unconditional

Every target receives the agent’s log records and metrics. `include = ["deny"]` delivers the refusals, the agent’s log records, and the agent’s metrics. `accepts` is the exception: an endpoint that takes only `traces`, such as a `langfuse` target, is sent no log or metric batch.

`logs` also selects the box’s unmatched MCP routing diagnostics. A target with an explicit `include` list receives these diagnostics only when the list names `logs`.

### Agent spans, logs, and metrics need the agent’s exporter

A target receives an agent span, log record, or metric only when the agent exports it. These three `env` variables turn the OpenTelemetry exporters on. The example writes `env` as an inline table; they go in it, or in an `[agent.env]` table, which is the same key:

```toml
[agent.env]
OTEL_TRACES_EXPORTER = "otlp"
OTEL_LOGS_EXPORTER = "otlp"
OTEL_METRICS_EXPORTER = "otlp"
```

The box sets `OTEL_EXPORTER_OTLP_ENDPOINT` to its own loopback receiver, and the OpenTelemetry SDK appends `/v1/traces`, `/v1/logs`, or `/v1/metrics`. The box owns every `OTEL_EXPORTER_OTLP_*` name, so `[agent.env]` may not set one. A switch left at `none` means that signal never arrives, whatever `include` says.

Each decision exports one span of kind INTERNAL and one log record that share a trace ID and a span ID. When the request carries a `traceparent`, the span joins that trace; otherwise it is a root span. Each `run` adds `strands.box.run.id` to its own records and to the agent resources it relays.

### Which trace variables the box reads

The box reads `TRACEPARENT` and `TRACESTATE` from the shell or Python child’s own environment, because every harness spells those two the same way. The box reads no other variable, and it names no harness. So a shell or Python decision reports no conversation identifier. Correlate one by `strands.box.run.id`, or by the trace ID when the agent sets `TRACEPARENT`.

An MCP frame carries `params._meta.threadId` or `sessionId`, and an HTTP egress request carries a `thread-id` or `session-id` header. Both lanes still report a conversation, because each reads the identifier from its own request.

A conversation identifier is a correlation hint and never an authorization. A workload can set the value, so no decision depends on one.

Policy spans mark the decision instant; their start and end times are equal. Normal denials have UNSET status. Evaluator faults have ERROR status. A policy target receives both `/v1/logs` and `/v1/traces`. Use the OTLP base URL in `destination`, and select `resourceLogs` or `resourceSpans` when reading a file target. The scope for policy decisions is `strands-box.policy`.

Select decisions by the `strands-box.policy` scope, or by `strands.box.source == "box"`. The agent’s own log records share the `resourceLogs` key, and severity numbers do not separate the two.

### What a decision carries

A value never carries the policy engine’s own spelling: read `fs:read`, not `Box::Action::"fs:read"`. Each log record’s `event_name` field is `strands.box.policy.decision`.

| Group | Keys |
| --- | --- |
| The decision | `strands.box.policy.action`, `.resource`, `.verdict`, `.cause`, `.reason`, `.principal`, and `error.type` on an evaluator fault |
| The governing rule | `strands.box.policy.rule` (your `@id`, else the rule reached), `strands.box.policy.description` (your `@description`), `strands.box.policy.category`, plus `strands.box.policy.determining.ids` for audit |
| Correlation | `strands.box.request.id` (egress only), `jsonrpc.request.id` (an MCP request), and `strands.box.trace.parent_span_id`, `.parent_sampled`, `.state` on the log record |
| What it was about | `server.address` and `server.port` on a `net:*` decision, `http.request.method` on a request, `file.path` on `fs:*` |

The shipped example under [`examples/strands-box/strands-sdk-agent/`](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/examples/strands-box/strands-sdk-agent/README.md) writes a `@description` on its rules. It runs a Strands Agents SDK agent written in Python, which is a different workload from the Strands CLI on this page.

The record omits `url.full` and `process.command_line`.

## Errors

A refusal of the file’s shape happens at parse, before any box state exists: an unknown key, an absent or invalid `name`, an absent or relative `box_dir`, an empty or relative `command` program, a relative `workspace`, an `env` name the box owns, a relative `env.HOME` or `env.TMPDIR`, a patterned or relative `filesystem` path, a `filesystem` path carrying `..`, a duplicated `filesystem` path, an overlapping or all-hosts egress destination, a secretless egress entry, a literal egress secret, each [`[secret-source.<scheme>]`](#secret-sourcescheme) refusal, each [`[tool.<name>.grammar]`](#toolnamegrammar) refusal, an `ingress` outside `[agent]`, an `[[agent.ingress]]` while `ingress` is off in `[experimental-features]`, more than five `[[agent.ingress]]` entries, an `[[agent.ingress]] listen` that is not an IP address and port, a port of 0, two entries with one `listen` port or one `workload_port`, and on macOS a `listen` port equal to any entry’s `workload_port`. An invalid `limits.shell.timeout`, `limits.shell.max_input`, `limits.shell.max_output`, or `limits.shell.max_stdin` is also a parse error.

A `box_dir` whose parent does not exist is refused before anything is created. Every other refusal that needs the surrounding OS happens after `run` has created `box_dir`, and before the workload starts: a `workspace` that does not exist, an `env.HOME` inside or enclosing `box_dir`, a telemetry file destination inside the box directory and outside `private/`, a `filesystem` entry whose path does not exist or is a symbolic link, a `deny_write` entry that is not a directory inside a `write` directory, an `[[agent.ingress]] listen` address that cannot be bound, and on macOS a `workload_port` that another process already listens on. A `[tool.<name>]` whose program is not installed is [left out](#a-tool-whose-program-is-not-installed) rather than refused. The box directory stays behind. It is empty when the refusal came before the record was written, and it holds the record when the refusal came after. The next `run` against it judges the file again and reports the same refusal until the file is fixed.

A stored record whose version is not the one this build writes is refused by its version. Remove that box’s `box_dir`, and the next `run` writes a new record into a fresh one.

## See also

-   [`getting-started.md`](/docs/user-guide/box/core/quickstart/index.md): the tutorial that builds the example box on this page.
-   [`egress.md`](/docs/user-guide/box/guides/network-and-credentials/index.md): the `[egress.<name>]` table in full.
-   [`mcp.md`](/docs/user-guide/box/guides/add-an-mcp-server/index.md): the `[mcp.<name>]` table in full.
-   [`policy.md`](/docs/user-guide/box/reference/policy/index.md): the policy the file points at.
-   [`security.md`](/docs/user-guide/box/security/index.md): what `box.toml` grants directly, and what you own.