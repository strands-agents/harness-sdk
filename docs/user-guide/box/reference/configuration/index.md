`box.toml` is the complete run configuration for one box. Pass its path through `strands-box run --config FILE`; the tutorial’s download names the binary `box`. Box reads the selected file and its policy on every start.

Audience: an operator who runs an agent or another command under a box, and who declares the paths, hosts, credentials, MCP servers, and telemetry targets it can use. The example on this page is the box that [getting started](../../quickstart/index.md) builds: the Strands CLI on a Mac. Each section below annotates it. To write the policy the file points at, read [policy](../policy/index.md), and point a coding agent at [the policy-authoring skill](https://github.com/strands-agents/box/blob/f4180a035d2d164596135864604629529636bf1c/.agents/skills/authoring-box-policy/SKILL.md).

## Example

Getting started builds this macOS example one file at a time, and the block is the tutorial’s `my-box/box.toml`, with its one longer comment shortened to a line.

```toml
# To author or change the policy next to this file, point your coding agent at the skill:
#   https://raw.githubusercontent.com/strands-agents/box/f4180a035d2d164596135864604629529636bf1c/.agents/skills/authoring-box-policy/SKILL.md

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

The file carries eleven keys. `name` and `box_dir` are required.

| Key | Type | Meaning |
| --- | --- | --- |
| `name` | string | Which box this is. One path component of letters, digits, `.`, `_`, or `-`, at most 32 bytes. |
| `box_dir` | string | Where the box keeps its private state. Required, and absolute. |
| `policy` | string | The Dogwood policy, relative to this file’s directory unless absolute. Absent means no authored policy, and absent policy denies. |
| `[agent]` | table | The one process the box runs. |
| `[tool.<name>]` | tables | One process each, which the agent selects by invocation. The label takes the same characters as `name`. |
| `[egress.<name>]` | tables | Which secret attaches to which outbound destination. |
| `[mcp.<name>]` | tables | The MCP servers this box declares. |
| `[telemetry.<label>]` | tables | Where this box’s decision records and agent spans go. |
| `file-attributes` | boolean | Whether write folders on macOS may also set file times, and with them set-ID bits, the group, the owner, and access control lists. `false` by default. |
| `[experimental-features]` | table | Optional experimental features: native filesystem policy checks and tool grammars. Each is disabled by default. |
| `[limits]` | table | Execution limits for Strands Shell. |

The example uses five of the eleven: `name`, `box_dir`, `policy`, `[agent]`, and one `[egress.<name>]` table. It declares no tool, no MCP server, and no telemetry target.

`name` and `box_dir` are the two required keys. `name` labels the box in its record and its telemetry. `box_dir` selects the box: one directory is one box. A `name` outside its limits is refused with `box name "<name>" is invalid: <reason>; use one component of letters, digits, '.', '_', or '-'`.

Box creates the directory `box_dir` names, with mode `0700`, and creates **no** directory above it. Create the parent yourself, or the run is refused with ``the box directory's parent does not exist; create it, because Box creates no directory above the one `box_dir` names``. Everything Box writes for a box is under `box_dir`, or under a path the file names. The example’s `box_dir` is `my-box/state`, under the `my-box` directory the operator made for the two files.

`box_dir` may not be the agent’s workspace or lie below it, and neither `box.toml` nor `policy.dw` may lie inside it. Each is refused by name: `` `box_dir` <path> is equal to or below the agent's workspace <path> ``, ``configuration source <path> is inside `box_dir` <path>``, and ``policy source <path> is inside `box_dir` <path>``.

The directory holds `bin`, `run`, `trust`, and `private`. None of them is a home, and no box reaches its own private tree from inside. It stays until you delete it: end the `run` process to stop a box, and remove the directory after `run` has exited to delete one. Do not remove the directory while its `run` is alive: on macOS, the kernel kills a shell or Python call of that box whose program file loses a name during its security assessment.

### Keep other boxes’ configuration and state outside write access

Keep each box’s configuration, policy, and generated state in locations controlled by the operator. Do not grant a workload write access to another box’s `box_dir`, configuration file (`box.toml`), or policy file (`policy.dw`). Keep each policy file outside every other box’s filesystem grants. Review the filesystem lists for the agent, tools, and local MCP servers before starting a workload.

A directory grant can include another box’s files beneath that directory. For example, write access to `/work/projects` can include a second box’s configuration under `/work/projects/other-box`. Box protects the configuration and policy that the current run loaded. It does not automatically discover and protect every other box’s files. A directory name such as `.strands-box` alone provides no protection for another box. If a workload changes another box’s configuration or policy, that box reads the changes on its next run.

Write access that includes another running box’s `box_dir` can also expose its broker socket, `run/box.sock`. Requests through that socket use the receiving box’s policy.

If a filesystem grant must enclose another box, add native exclusions through `filesystem.deny`. Exclude that box’s `box_dir` and the directories that hold its configuration and policy. Apply these exclusions to the agent, each tool, and each local MCP server with the grant. These exclusions also block connections through the other box’s `run/box.sock` path. On Linux, these directories must exist before startup.

The startup output lists each filesystem grant, including a broad grant that encloses another box’s directory. Inspect these paths for access to other boxes’ files. The output reports the granted access and does not remove another box’s files from it. The workload starts without waiting for you to approve that output.

Restrict file operations through Strands Shell and Monty separately with [policy `forbid` rules](../policy/index.md#common-rules). Protect each other box’s `box_dir` and the directories that hold its configuration and policy. Cover each directory and its descendants for [`fs:read`, `fs:write`, `fs:delete`, and `fs:move`](../policy-actions/index.md#filesystem). Also forbid `fs:move` on enclosing directories that could relocate these protected paths.

A `forbid` overrides matching permits. Adding a narrower permit leaves any broader permit active. A native `filesystem.deny` entry does not restrict these requests through the box’s trusted process.

## `file-attributes`

On macOS, a write folder refuses most calls that set a file’s times: `utimensat`, which `touch` calls, and `setattrlist`, which `cp -p` and `rsync -t` use. Only `utimes` works. So `touch`, `cp -p`, and `rsync -t` fail with `Operation not permitted`. The `file-attributes` switch lets a write folder set them. The key goes at the top of the file, above the first table:

```toml
file-attributes = true
```

The default is `false`, and the switch applies to the agent, every tool, and every local MCP server in the box. It has no effect on Linux, which accepts the key. With the switch off, the box renders no rule for it. A box that sets it stores its record at version 25 or newer, depending on its [other configured features](../../security/native-filesystem-policy/index.md#stored-configuration-and-rollback). An older build refuses a version it does not support.

With the switch on, a process in a write folder can set the times of a file there. It can also set the file’s set-user-ID and set-group-ID bits, change its group, store an access control list on it, and, in a box that runs as root, give it to another user. macOS has no rule that allows the times and refuses these. See [file attributes on macOS](../../security/index.md#file-attributes-on-macos) for what that means and how to undo it. Flags such as `uchg`, ownership changes through `chown`, and `chmod` of the set-ID bits stay refused. A path outside the write folders, and a file the box protects, stay unwritable. `tar -x` restores times with the switch, but an archive that macOS `tar` made with its default metadata still fails to restore the owner and the flags. Extract it with `tar -x --no-mac-metadata`.

The box prints one line for each process the switch applies to, in the startup disclosure: `strands-box: [agent] file attributes: may set file times, set-user-ID and set-group-ID bits, the group, the owner, and access control lists on files in its writable grants`. Linux prints no line.

## `[limits]`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `shell.timeout` | positive integer or `false` | `30` | Seconds allowed for one submitted Strands Shell call, including its commands and pipelines. `false` disables the Shell and broker execution deadlines. |

To allow ten minutes, add `[limits]` with `shell.timeout = 600`. The equivalent nested table is `[limits.shell]` with `timeout = 600`. Output leaves the original deadline unchanged. Set `shell.timeout = false` to disable this limit, or omit the key for the 30-second default. Connection and write operations retain their transport timeouts. Configured-command [hard-link scans](#configured-command-integrity) retain their separate 30-second budget per tree, including when `shell.timeout` is `false`. Zero, negative numbers, fractions, strings, `true`, and values too large for the platform’s clock are load errors.

This setting applies to the calls forwarded by `zsh`, `bash`, and `sh`, including Python called inside the Shell. Python’s [own limits](../python/index.md#limits-and-exit-statuses) also apply, including with `shell.timeout = false`. Synchronous Python execution can delay timeout reporting. See [Shell timeouts](../shell/index.md#limitsshelltimeout) for the call scope and [stored configuration](../../security/native-filesystem-policy/index.md#stored-configuration-and-rollback) for rollback.

## `[experimental-features]`

Native filesystem policy checks require a compatible, signed build and explicit selection:

```toml
[experimental-features]
native-filesystem-policy = true
```

The default is `false`. Unknown feature names are errors. Signed macOS releases include the adapter, but leave it disabled until you select it. An unsupported build refuses `true` before the workload starts. See [native filesystem policy](../../security/native-filesystem-policy/index.md) for build requirements, coverage, and recovery behavior.

`tool-grammars = true` turns on [tool grammars](#toolnamegrammar), which are experimental and off by default.

## `[agent]` and `[tool.<name>]`

Both tables hold one process, in one shape:

| Key | Type | Meaning |
| --- | --- | --- |
| `command` | string array | The first entry is the program; the rest are its fixed leading arguments. Arguments passed to `run` come after them. |
| `workspace` | string | The process’s initial working directory. The box enters it; a `filesystem` list grants reach to it. |
| `env` | table | The literal environment. `HOME` and `PATH` default to the operator’s own; every other variable is present only when `env` names it. |
| `[<table>.filesystem]` | table | The path lists the process’s own system calls reach. Eight for `[agent]`; six for a `[tool.<name>]`, which has no `metadata` or `exec` list. |
| `native-filesystem-policy` | boolean | Optional override of the global experimental setting for this process and its descendants. See [workload selection](../../security/native-filesystem-policy/index.md#select-workloads). |
| `[tool.<name>.grammar]` | table | Experimental, and `[tool.<name>]` only. The tool grammar for the program this tool runs. See [`[tool.<name>.grammar]`](#toolnamegrammar). |

The box adds the runtime minimum to every process; see [the runtime minimum](https://github.com/strands-agents/box/blob/f4180a035d2d164596135864604629529636bf1c/docs/design/containment.md#the-runtime-minimum).

The program is a full path or a bare name. A bare name uses `env.PATH` when set. Otherwise, Box uses the operator’s `PATH`, or `/usr/bin:/bin` if it is absent. A relative path with more than one component is refused: `` `command` element 0 "<program>" is a relative path; write an absolute path, or a bare name that `env.PATH` resolves ``. Scripts on Linux require [interpreter grants](#script-commands-on-linux). The example’s `command` runs Homebrew’s `node`, which loads the preload file and then the CLI’s script; the arguments after the script are the CLI’s own.

`workspace` is absolute, and it is optional: when absent, the box uses the directory `run` was started from. The directory must exist, and it may not be the operator’s home. The box enters it. The process reads nothing in it until a list in `filesystem` names it: the example’s `workspace` is the project, and the `list` entry below is what lets the CLI see the names in it.

`env.PATH` contains full directory paths separated by `:`. Box uses these entries as written, so `~` stays literal. For example, use `/home/alex/.local/bin:/usr/bin:/bin` instead of `~/.local/bin:/usr/bin:/bin`.

When the box declares an MCP server, it also protects directories on the `PATH` of the shell that starts Box. Keep those directories and their parents outside filesystem write grants. For example, a search directory `/work/tools/bin` prevents a write grant for `/work/tools`. Changing `env.PATH` in `box.toml` does not change this protection.

`env` is literal. Four kinds of name have their own rule:

-   **Names Box sets itself, which a table cannot claim:** `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`, `NO_PROXY`, `no_proxy`, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY`, `CODEX_CA_CERTIFICATE`, `AWS_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PWD`, `USER`, and every name that starts with `OTEL_EXPORTER_OTLP_`.
-   **Names the dynamic loader reads, refused:** every name that starts with `LD_` or `DYLD_`. Box’s own aliases run in the box, so their loader would read the value too. A runtime’s own option variables, such as `NODE_OPTIONS`, `BASH_ENV`, `RUBYOPT`, `JAVA_TOOL_OPTIONS`, and `PYTHONPATH`, are the operator’s to set, and they reach only the process whose table names them. The `zsh`, `bash`, `sh`, `python3`, and `python` aliases run in Box and do not read them, so a shell or Python option variable reaches a real interpreter that the table runs or spawns, and not an alias call.
-   **`HOME`:** an absolute path. It stays the operator’s own home unless `[agent] env.HOME` names another directory; the example names `strands-home`, so the CLI reads its settings and writes its sessions there. A home inside `box_dir` is refused with `` `env.HOME` is <path>, which lies in trusted Box state. The box directory holds `bin`, `run`, `trust`, and `private`, and none of them is a home. Name a directory outside it, or omit `env.HOME` for the operator's own home ``, and a home that encloses `box_dir` is refused with `` `env.HOME` is <path>, which encloses the box directory <path>. A declared home is reachable, so a home above the box directory would put this box's own state, and any sibling box's, inside the reachable set. Name a home beside the box directory rather than above it, or omit `env.HOME` for the operator's own home ``.
-   **`TMPDIR`:** an absolute path.

A name Box sets is refused with `` `env` name "<name>" is set by the box itself, so a table cannot claim it ``. A dynamic-loader name is refused with `` `env` name "<name>" is read by the dynamic loader of every program in the box, Box's own aliases included, so a table cannot set it ``.

`TERM` and `COLORTERM` reach the process only when `env` names them, so a program that picks colors from them renders plain otherwise. The example names `TERM`; an operator who wants a program’s colors writes their own terminal’s values for both.

The agent reaches every `[egress.<name>]` route, every `[tool.<name>]`, and every `[mcp.<name>]` the file declares. A tool or MCP server reaches every egress route and starts no tool or MCP server of its own. All of them share one egress gateway, so the box is the credential boundary: a process that must not hold a credential goes in another box. Each tool and each `stdio` MCP server runs in its own separate sandbox (see [the sandboxes for tools and local MCP servers](https://github.com/strands-agents/box/blob/f4180a035d2d164596135864604629529636bf1c/docs/design/containment.md#the-agents-box-and-leaf-boxes)).

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

## `[agent.filesystem]` and `[tool.<name>.filesystem]`

Each list, and what one entry in it grants. `[agent.filesystem]` takes all eight; `[tool.<name>.filesystem]` takes six, and a `metadata` or `exec` list there is refused by name at load. [A tool’s sandbox](https://github.com/strands-agents/box/blob/f4180a035d2d164596135864604629529636bf1c/docs/design/containment.md#a-tools-leaf-box) states what a tool reaches in their place.

Every process’s writable grants must exclude the installed Box programs, their hard-link names, mounted aliases, and enclosing directories. [Installation integrity](#installation-integrity) describes the checks and refusals.

| List | What each entry grants |
| --- | --- |
| `read` | Read the path. A directory entry covers everything below it. |
| `write` | Write the path. On macOS, add `read` to permit reads, and setting a file’s times needs [`file-attributes`](#file-attributes). Linux requires explicit read access across the entire write scope. |
| `read_file` | Read one exact file. The entry names a file. |
| `write_file` | Write one exact file. Linux requires explicit read access to that file. The entry names an existing file. |
| `list` | List the directory without content access on macOS. Linux refuses this list. |
| `metadata` | Inspect file properties below a directory without content access on macOS. Linux omits this grant without an error. **`[agent.filesystem]` only.** |
| `exec` | Run the path. A file entry names an executable; a directory entry covers the binaries below it. **`[agent.filesystem]` only.** |
| `deny` | Refuse the path, even when another list grants it. Linux requires the target to exist. |

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

The example uses four lists. `read` covers the CLI’s install tree and `strands-home`, `read_file` names the preload file and Homebrew’s OpenSSL settings, `write` covers `strands-home`, and `list` names the project. `strands-home` is in both `read` and `write` to request read-write access explicitly. On macOS, the project is in `list` alone, so the CLI sees its names while policy decides each file its shell opens. Linux refuses this example’s `list` entry. See the [platform comparison](https://github.com/strands-agents/box/blob/f4180a035d2d164596135864604629529636bf1c/docs/design/platform-differences.md).

Each entry is absolute, or is `~` or starts with `~/`. An entry carries no pattern, no control character, and no `..` component. A directory entry that encloses this box’s `box.toml` and `policy.dw` grants everything below it except the directory that holds those two files.

**An entry names the file the kernel checks**, so an entry that is itself a symbolic link is refused, and the refusal names what the link points at. Whether a path such as `/bin/sh` is a link depends on the surrounding OS, so the same `exec = ["/bin/sh"]` entry loads under one and is refused under another. Write the target the refusal names.

**No policy decision covers a filesystem list**, so `run` discloses each entry on stderr before the workload starts, under `strands-box: [agent] runs <program> with no policy decision over these paths:`. Getting started shows the example’s disclosure. A credential store, such as `~/.aws` or `~/.ssh`, is disclosed by name as well, as `strands-box: [tool.<name>]: exposes ~/.ssh (read)` for a tool granted the operator’s SSH directory.

On Linux, preserved interpreter spellings appear in a separate section before the runtime minimum:

```text
strands-box: [tool.check] interpreter aliases for configured access:
  alias       /bin/sh -> /usr/bin/dash  (interpreter spelling)
```

The arrow maps the script’s spelling to the file its configured grants already authorize. The section appears only when Box preserves an interpreter spelling.

With no `filesystem` table, the process reaches its `command` and the runtime minimum. The command’s own exec grant is implicit: a process may always run its `command`, and the startup disclosure shows that grant as `exec <command> (command, implicit)`. So removing a directory from `exec` does not refuse the process’s own command. The controls on a host binary are the `shell:spawn` permit and the `[tool.<name>]` table; [shell policy](../../guides/write-shell-policy/index.md) states how a rule spells `program_path`.

### What is refused

Every refusal below names the table and the entry, as `` `[agent]` filesystem entry "<entry>" is refused: <reason> ``. `<path>` stands for the path the message names, and `filesystem.read` for whichever list holds the entry. Shape refusals happen at parse; existence and identity refusals happen after the box directory is created and before the workload starts.

| Entry | Refusal |
| --- | --- |
| A relative path | `` `filesystem.read` path "<entry>" must be absolute or start with `~/`, so a checked-in configuration holds in every clone `` |
| A pattern or a control character | `` `filesystem.read` path "<entry>" must be exact and contain no pattern or control character `` |
| A `..` component | `` `filesystem.read` path "<entry>" carries `..`; name the path it means `` |
| The same path twice in one list | `` `filesystem.read` path <path> is duplicated `` |
| A path that does not exist | `<path> is not there: No such file or directory (os error 2). A grant on a path that does not exist grants nothing and says so nowhere` |
| A symbolic link | `<path> is a symbolic link to <target>. A grant carries the identity the kernel checks, so a link renders a rule that matches nothing; name <target> instead` |
| A spelling the kernel resolves elsewhere | `<path> is not the path the kernel checks, which is <path>. A grant carries the identity it acts on, so name that path instead` |
| A directory in `read_file` or `write_file` | `` <path> is a directory; `read_file` names one file, and a tree belongs in `read` `` |
| A file in `list` | ``<path> is a file, and `list` enumerates a directory tree`` |
| A file in `metadata` | ``<path> is a file, and a file's metadata comes with the `read_file` or `exec` grant that names it`` |
| A file in `exec` that is not executable | `<path> is not an executable regular file` |
| Two grants of one operation that name one path, or that nest | ``<path> lies inside <path>, granted by `read`. The union is the wider grant, so the narrower one enforces nothing it appears to`` |
| A grant wholly inside a `deny` entry or the directory that holds `box.toml` and `policy.dw` | `<path> is at or inside <path>, which no grant reaches. The grant would render and reach nothing, so it is refused rather than left enforcing nothing` |
| A writable grant that reaches the policy file without subtracting it | `` `write` reaches this box's policy file, <path>. A grant may enclose it only when it is subtracted, and nothing subtracts it here `` |
| A writable grant at or above a directory on the operator’s `PATH` | `<path> is at or above <path>, which is on the search path this box resolves a bare-name MCP program against` (excerpt). Keep the directory and its parents outside write grants. |
| A writable grant can change an installed Box program, a hard-link name, or an enclosing directory | `this write grant can change trusted Box executable <path> or its path. Keep the Box installation outside every process's write grants` |
| A system directory or a credential store the box always refuses | `<path> is refused beneath every grant: <reason>` |

Create the path first, or name the existing directory above it. The same rule holds for a `[tool.<name>] command` that names a file the workload has not built yet, which is refused with `containment config failed: path does not exist: <path>`. In the example, the CLI install, `strands-home`, the preload file, and the project all exist before the first `run`, because the tutorial’s earlier steps made them.

**A `write` grant alone is not runnable.** The agent’s sandbox refuses to map code from a writable grant. When the agent’s `command` or one of its interpreters lies inside a writable grant, the startup disclosure carries a warning: `strands-box: warning: [agent] command <path> lies inside the writable grant <path>, so the process can replace the program it runs`.

On Linux, an agent also needs an explicit `exec` grant for an automatically discovered writable loader or shared library. Otherwise, startup fails with `writable dependency <path> needed by <program> has no explicit execution grant`. A `read` or `read_file` entry does not resolve this error. Remove write access to the library, or grant execution if the agent should run code it can change.

The same check covers writable symbolic-link paths and hard-link aliases. Immutable hard-linked libraries retain automatic execution access when Box can verify their ownership, permissions, and mount boundaries. A read-only file that the workload owns remains writable for this check because its owner can change its permissions. Ordinary local mounts can retain this exception when their ownership rules agree. Remapped ownership, nested mounts, unrecognized filesystem types, and inconclusive checks can still require explicit execution permission. Tools and local MCP servers retain their broader execution permission for their own filesystem grants. Their filesystem tables reject `exec`; only `[agent.filesystem]` accepts that list.

## `[tool.<name>]` selection

A tool table applies when a program the agent’s shell starts begins with the tool’s `command`: the same program, then the same fixed arguments. Box resolves each configured tool program before the workload starts and keeps that file identity for the run. The longest matching prefix wins. Every declared tool is selectable, and a program under one of the agent’s own `exec` entries needs no table of its own.

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

Each configured tool program must exist before the run starts. Box checks grants in `[agent]`, every `[tool.<name>]`, and every local `[mcp.<name>]` table against those programs.

| Condition | Refusal text | Next action |
| --- | --- | --- |
| A command file is absent, or a bare command name has no executable match on its search path. | `path does not exist` or `cannot resolve bare executable` | Install the command before startup, or correct its path or `env.PATH`. |
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

[Tool grammars](#toolnamegrammar) do not require a single hard link. They bind the executable file and the called name; other names follow the [`shell:spawn`](../shell/index.md#shellspawn) rules.

### Installation integrity

Before the workload starts, Box checks its installed executable, containment launcher, and socket-alias image against every process’s writable grants. The socket-alias image routes shell and Python commands to Box’s policy checks. The check covers `[agent]`, every `[tool.<name>]`, and every local `[mcp.<name>]` table.

For the macOS package layout, Box protects an executable regular file named `box` beside `Box.app` as the package launcher. A standalone application bundle does not require that wrapper. A nearby directory, symbolic link, or non-executable file named `box` does not prevent startup. Operator-created launch scripts and additional symbolic-link names are outside this installation inventory. Keep those launch paths and their containing directories outside workload write grants.

Box accepts hard links only when it finds every name in the installation directory or its immediate `deps` directory. This includes Cargo’s build layout. Before each contained launch, Box checks the original file identities and hard-link counts. Linux also checks the files through existing mounts. If permission checks hide a possible alias, Box protects that path without inspecting its identity. Unrelated grants remain usable. On macOS, Box checks verified Data-volume spellings. A writable grant must exclude these aliases and their enclosing directories.

| Condition | Refusal text | Next action |
| --- | --- | --- |
| Box cannot account for every hard-link name. | `has hard links outside the installation inventory. Install an independent copy` | Install independent copies of the Box programs. |
| Linux cannot read or finish a stable inventory of mounted aliases. | `cannot inventory mounted executable aliases: <reason>` | Restore access to the process mount table, resolve other inspection errors, then retry after mount changes finish. |
| A recorded file name points to another file, or the hard-link count changes during the run. | `changed after this run loaded it. Stop Box before updating its installation` | End the run before installation updates. |

Strands Shell and Monty also refuse changes to these files and their enclosing paths, even when policy permits the operation. Reads still require the applicable policy permission.

End every active run before installation updates. Update the installation from the surrounding OS. Start a new run to validate the updated files.

## `[tool.<name>.grammar]`

This table holds the tool grammar for the program its `[tool]` runs, and it loads only when `[experimental-features] tool-grammars = true`. The feature is experimental. A spawn of the program is decided as a grammar action in place of `shell:spawn`, as [`shell:spawn`](../shell/index.md#shellspawn) states. [Tool grammars](../../guides/tool-grammars/index.md) shows how to write one and the rules that use it. `run` prints one line for each `[tool]` and stdio `[mcp.<name>]` whose program a grammar decides, so you can move its `shell:spawn` rules. A `shell:spawn` rule still decides each other name of that program file, such as `make` through macOS `/usr/bin/git`, except in the cases that [`shell:spawn`](../shell/index.md#shellspawn) refuses:

```text
strands-box: [tool.git]: a spawn of `git` is decided by its tool grammar, and no `shell:spawn` rule applies to it
```

A copy of that program at another path is a different file, and `shell:spawn` still decides it. Keep `shell:spawn` permits narrow, or a copy gets past a forbid on the grammar’s actions.

Each of these is refused at startup, before any box state exists:

-   A grammar while `tool-grammars` is off: ``invalid `[tool.git]` table: `grammar` is experimental: set `tool-grammars = true` in `[experimental-features]` to load it``.
-   A grammar on `[agent]`: ``invalid `[agent]` table: `grammar` is refused on `[agent]`: ...``. A grammar on `[mcp.<name>]` is an unknown field there.
-   A `program` that the tool’s `command` doesn’t run, such as `[tool.gh] command = ["gh"]` with `program = "git"`: ``invalid `[tool.gh]` table: `tool.gh.grammar.program` is "git", but `command` runs "gh"; ...``.
-   Two grammars with one `program`: ``tool grammar refused: `tool.brew_git.grammar` and `tool.git.grammar` both have `program = "git"`; keep one grammar for each program``.
-   Two grammars with one `name`: ``tool grammar refused: `tool.git.grammar` and `tool.hub.grammar` both have `name = "git"`; give each grammar its own name``.
-   A grammar that breaks a rule of the grammar format. Each refusal names the key, as a path in `box.toml`: `` tool grammar refused: `tool.git.grammar.shell.push.usage` has a `[` with no `]` `` .
-   A policy that names a `Tool::` action that no grammar declares: ``policy file ... will not load: policy references unknown action: ... unrecognized action `Tool::git::Action::"push"` ...``.
-   An `[mcp.Tool]` table while `tool-grammars` is on, because `Tool` is the namespace of every grammar action: ``invalid MCP server "Tool": `Tool` is the namespace of every tool grammar action while `tool-grammars` is on; give the server another name``.

An older build refuses a box that uses a grammar, so before you go back to one, turn `tool-grammars` off, remove every `grammar` table, and start the box once with this build.

## `[egress.<name>]`

Each table binds one secret to a set of destinations, and its name is the operator’s own label. The example’s `[egress.model]` binds `AWS_BEARER_TOKEN_BEDROCK` to the Bedrock endpoint, and `run` reads the key from its own environment. The agent, and every tool or MCP server in the box, gets a placeholder in that variable, and the gateway swaps the key in on each request to the destination. A binding attaches a credential to a request the policy already permitted, and grants no network reach of its own: the example policy’s `net:connect` and `http:request` rules are what let the requests out. The current reference for this table is [`egress.md`](../../guides/network-and-credentials/index.md).

| Key | Type | Meaning |
| --- | --- | --- |
| `destinations` | string array | A host, `host:port`, a path prefix or `/*` suffix, or a `*.` wildcard. A pattern that matches every host is refused, and two entries may not overlap. |
| `protocol` | string | `http`, the default and the only accepted value. |
| `secret.ref` | string | `env://NAME` for a variable on the operator’s side, or `aws://PROFILE` for SigV4 signing. Required. A literal value is refused. |
| `secret.placement` | string | `header` (default), `basic_auth`, or `query_param`. |
| `secret.header` | string | The header the secret lands in. Defaults to `Authorization`. |
| `secret.prefix` | string | Text before the secret in the header value. Defaults to `Bearer` on `Authorization`, and empty elsewhere. |
| `secret.param` | string | The query-parameter name. Required by, and only valid for, `placement = "query_param"`. |
| `secret.inject` | string | `phantom` (default) or `always`. `phantom` attaches the real secret only to a request that presents the box’s placeholder, and rejects any other. `always` attaches the real secret to every request to the destinations, with or without a placeholder, and the decision record carries an advisory note. Valid only for an `env://` route. |
| `secret.phantom_prefix` | string | The literal prefix of the minted placeholder, before its random suffix. Defaults to `strands_box_`. Set it, such as `sk-ant-`, so a harness that checks its key format accepts the placeholder. At most 64 characters from `A-Z`, `a-z`, `0-9`, `-`, `_`, `.`, `~`. Valid only for an `env://` route. |

The example takes every default: the key lands in the `Authorization` header with a `Bearer` prefix, and only a request that carries the placeholder gets it.

An entry needs a `secret`. One without is refused: `an entry with no secret declares only a destination, which policy already decides; give it a secret, or set protocol = "mcp" for a remote MCP server`. `protocol` on this table takes `http` alone; declare a remote MCP server as `[mcp.<name>]` with `type = "http"`, which the next section describes.

An `aws://` route signs inside the box, so it takes no `header`, `prefix`, `placement`, `param`, `inject`, or `phantom_prefix`. Setting one is refused when the configuration loads.

## `[mcp.<name>]`

Each table declares one MCP server. `type` selects the transport. A `stdio` server is a local program that the box starts in its own separate sandbox. It starts only when a `shell:spawn` permit covers its `command`; [MCP policy](../../guides/write-mcp-policy/index.md) lists the fields that decision carries. When no permit covers it, the open fails with `MCP server "<name>" may not start: <decision>` and the server does not run. An `http` server is a remote server the workload reaches through the egress gateway. Each request is an `mcp:call` decision, and a rule reads the table’s name as `context.input.server`. The current reference for this table is [`mcp.md`](../../guides/add-an-mcp-server/index.md). The box adds the runtime minimum to the server’s process; see [the runtime minimum](https://github.com/strands-agents/box/blob/f4180a035d2d164596135864604629529636bf1c/docs/design/containment.md#the-runtime-minimum).

The example box declares no MCP server. To give the Strands CLI one, declare it here, and name the same full command under `mcpServers` in the file the CLI reads through its `--mcp-config` option: the same program and the same arguments, in the same order. The box places an alias with the program’s name on the agent’s `PATH`, so when the CLI starts `mcp-server-fetch`, the box runs this table’s `command` in a separate sandbox:

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
| `command` | string array | For `stdio`: what to start. The first entry is the program and names the alias in the box’s `bin/`; the rest are its arguments, fixed here. The harness runs the full command to reach the server. Two tables can share a program when their full commands differ. |
| `workspace` | string | For `stdio`: the server’s initial working directory. It grants nothing. |
| `env` | table | For `stdio`: the literal environment the server receives. `HOME` and `PATH` default to the operator’s own, as for `[agent]`. |
| `filesystem` | table | For `stdio`: the six lists the server’s own syscalls reach, the same six a `[tool.<name>.filesystem]` takes; a `metadata` or `exec` list is refused by name. An absent table grants nothing, so the server’s sandbox has the runtime minimum and the reach that [a local MCP server’s sandbox](https://github.com/strands-agents/box/blob/f4180a035d2d164596135864604629529636bf1c/docs/design/containment.md#local-mcp-servers) states. |
| `argument_wildcards` | bool | For `stdio`: `false` by default. `true` lets this server’s whole-argument `*` entries match and forward caller-supplied values. See [argument wildcards](../../guides/add-an-mcp-server/index.md#argument-wildcards). |
| `network.contain_egress` | bool | For `stdio`: `true` by default. `false` gives this one server direct network access, with no gateway, no policy decision per request, and no credential injection. |
| `native-filesystem-policy` | boolean | For `stdio`: override the global experimental filesystem policy setting. Remote `http` entries refuse this field. See [workload selection](../../security/native-filesystem-policy/index.md#select-workloads). |
| `destinations` | string array | For `http`: the hosts the server answers on. |
| `secret.ref` | string | For `http`: the credential the gateway attaches on the way out. |

Without native filesystem mediation, no `fs:*` decision covers a `stdio` server’s direct file operations. The experiment checks selected operations while retaining the server’s filesystem grants. The startup report lists the agent’s and each tool’s grants, and a `stdio` server’s grants are in its table alone, so read the table before you let the server start. See [the security page](../../security/index.md) for what `box.toml` grants directly.

## `[telemetry.<label>]`

Each table declares one export target. The label is your own, and a refusal names it. The example box declares none, so its decisions go to the default record file under `box_dir`, which getting started reads with `jq`.

| Key | Type | Meaning |
| --- | --- | --- |
| `kind` | string | `file` or `otlp`. |
| `destination` | string | For `file`, an absolute or `~/`\-relative path. Inside this box’s `box_dir` it must lie under `private/`; outside the box any path is accepted. For `otlp`, the collector endpoint. |
| `include` | string array | Which records reach this target: `deny`, `permit`, `trace`, `logs`, or `metrics`. `trace` names the agent’s own spans **and** the box’s own records together. **Absent means every one of them**, so write `include` only to narrow the target. An empty list is refused, and so is a repeated word. |
| `secret.ref` | string | `env://NAME` or `secret://NAME`, attached on the way out. |
| `secret.header` | string | Defaults to `Authorization` with a `Bearer` prefix. |

A file destination inside the box directory and outside `private/` is refused: `"<path>" is inside the box directory <path> but outside its private tree, where a process could truncate it; name a destination under` private/`, or outside the box, or declare no target and take the default`. An empty `include` is refused with `the target names no signal, so nothing would reach it; write one or more of: deny, permit, trace, logs, metrics`, and a repeated word with `the target names deny twice`.

### `logs` and `metrics` are unconditional

`logs` and `metrics` are accepted in `include` and change nothing: every target receives the agent’s log records and metrics. `include = ["deny"]` delivers the refusals, the log records, and the metrics.

`include` narrows `deny`, `permit`, and `trace`, where `trace` covers the agent’s spans and the box’s own records.

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

The shipped example under [`examples/strands-box/strands-sdk-agent/`](https://github.com/strands-agents/box/blob/f4180a035d2d164596135864604629529636bf1c/examples/strands-box/strands-sdk-agent/README.md) writes a `@description` on its rules. It runs a Strands Agents SDK agent written in Python, which is a different workload from the Strands CLI on this page.

The record omits `url.full` and `process.command_line`.

## Errors

A refusal of the file’s shape happens at parse, before any box state exists: an unknown key, an absent or invalid `name`, an absent or relative `box_dir`, an empty or relative `command` program, a relative `workspace`, an `env` name the box owns, a relative `env.HOME` or `env.TMPDIR`, a patterned or relative `filesystem` path, a `filesystem` path carrying `..`, a duplicated `filesystem` path, an overlapping or all-hosts egress destination, a secretless egress entry, a literal egress secret, and each [`[tool.<name>.grammar]`](#toolnamegrammar) refusal. An invalid `limits.shell.timeout` is also a parse error.

A `box_dir` whose parent does not exist is refused before anything is created. Every other refusal that needs the surrounding OS happens after `run` has created `box_dir`, and before the workload starts: a `workspace` that does not exist, an `env.HOME` inside or enclosing `box_dir`, a telemetry file destination inside the box directory and outside `private/`, a `filesystem` entry whose path does not exist or is a symbolic link, and a `[tool.<name>] command` that names a missing file. The box directory stays behind. It is empty when the refusal came before the record was written, and it holds the record when the refusal came after. The next `run` against it judges the file again and reports the same refusal until the file is fixed.

A stored record whose version is not the one this build writes is refused by its version. Remove that box’s `box_dir`, and the next `run` writes a new record into a fresh one.

## See also

-   [`getting-started.md`](../../quickstart/index.md): the tutorial that builds the example box on this page.
-   [`egress.md`](../../guides/network-and-credentials/index.md): the `[egress.<name>]` table in full.
-   [`mcp.md`](../../guides/add-an-mcp-server/index.md): the `[mcp.<name>]` table in full.
-   [`policy.md`](../policy/index.md): the policy the file points at.
-   [`security.md`](../../security/index.md): what `box.toml` grants directly, and what you own.