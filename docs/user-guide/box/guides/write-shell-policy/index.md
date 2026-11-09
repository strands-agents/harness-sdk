Policy decides each command the agent runs in Strands Shell, and each file operation the command makes. This page builds a policy for an agent that works in `~/src/project`, runs `git` and the programs it builds, and stays out of the project’s `.env` file.

Audience: an operator with a working box from [getting started](../../quickstart/index.md). For every field a rule can read, see the [Strands Shell reference](../../reference/shell/index.md).

## Before you start

-   A box whose `[agent] workspace` is `~/src/project`. Use your own project’s path in its place.
-   Its `policy.dw`, which gets each rule below.

## Step 1. Allow the Shell’s commands

To let the agent run every command the Shell implements, permit `shell:exec`:

```text
@id("shell_commands")
permit (principal, action == Box::Action::"shell:exec", resource);
```

This covers `cat`, `grep`, `sed`, `ls`, `cp`, `jq`, `curl`, and the Shell’s other commands. Each file a command touches is still its own `fs:*` decision (step 2), and each program outside the Shell is a `shell:spawn` decision (steps 4 and 5).

To allow only some commands, name them:

```text
@id("read_only_commands")
permit (principal, action == Box::Action::"shell:exec", resource)
when { ["cd", "pwd", "ls", "cat", "grep", "head", "tail", "wc"].contains(context.input.program) };
```

## Step 2. Scope file reads and writes to the workspace

Permit `fs:read` on the project and everything under it, and `fs:write`, `fs:delete`, and `fs:move` under it. A path under your home starts with `~` in a rule.

```text
@id("project_read")
permit (principal, action == Box::Action::"fs:read", resource)
when { context.input.path == "~/src/project" || context.input.path like "~/src/project/*" };

@id("project_write")
permit (
  principal,
  action in [Box::Action::"fs:write", Box::Action::"fs:delete", Box::Action::"fs:move"],
  resource
)
when { context.input.path like "~/src/project/*" };

@id("dev_null")
permit (principal, action in [Box::Action::"fs:read", Box::Action::"fs:write"], resource)
when { context.input.path == "/dev/null" };
```

Keep every `fs:read` permit scoped to a path. A permit with no path condition reads `~/.ssh` and `~/.aws` too.

The Shell’s `/tmp` exists only for one command, and policy decides it like any other path. To let a command use it as scratch space, permit it:

```text
@id("scratch")
permit (
  principal,
  action in [Box::Action::"fs:read", Box::Action::"fs:write", Box::Action::"fs:delete"],
  resource
)
when { context.input.path == "/tmp" || context.input.path like "/tmp/*" };
```

## Step 3. Keep a path out

A `forbid` beats every `permit`. To keep the agent’s commands away from `.env` files in the project:

```text
@id("no_env_files")
forbid (
  principal,
  action in [
    Box::Action::"fs:read", Box::Action::"fs:write",
    Box::Action::"fs:delete", Box::Action::"fs:move"
  ],
  resource
)
when { context.input.path like "~/src/project/.env*" };
```

`cat .env` now fails:

```text
strands-shell: cat: policy denied this operation on '~/src/project/.env' [policy: no_env_files].
```

A program outside the Shell, such as `git` in the next step, reaches what its `[tool.<name>]` lists name, so put the path in that table’s `deny` list too.

## Step 4. Allow a program on your `PATH`

A program the Shell does not implement needs a `[tool.<name>]` table in `box.toml` and a `shell:spawn` permit. For `git`, add the table:

```toml
[tool.git]
command = ["git"]

[tool.git.filesystem]
read  = ["~/src/project", "/Library/Developer/CommandLineTools"]
write = ["~/src/project/.git"]
deny  = ["~/src/project/.env"]
```

Then permit the `git` subcommands the agent may run:

```text
@id("git_local")
permit (principal, action == Box::Action::"shell:spawn", resource)
when {
  context.input.program == "git" &&
  context.input has arg1 &&
  ["status", "diff", "log", "add", "commit"].contains(context.input.arg1)
};
```

The box’s shell finds `git` on the `PATH` of the host OS’s shell that runs `box run`. On macOS, `/usr/bin/git` hands off to the Command Line Tools’ `git`, and that hand-off fails in the program’s sandbox. Put the Command Line Tools first on the `PATH` when you start the box:

```sh
PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH ./box-core/box run --config my-box/box.toml
```

`git status` now runs, and `git push` is refused with status `126`, because `push` is not in the list. So is `git -C . push`, because its first argument is `-C`.

## Step 5. Allow a program the agent built

A program the agent built runs under the agent’s own filesystem lists when an `exec` entry covers it. Add the build output directory to `[agent.filesystem]`:

```toml
[agent.filesystem]
exec = ["~/src/project/target/debug"]
```

Then permit `shell:spawn` on the programs in it, by `program_path`, the file that runs:

```text
@id("built_programs")
permit (principal, action == Box::Action::"shell:spawn", resource)
when { context.input.program_path like "~/src/project/target/debug/*" };
```

## Step 6. Cap a command with a history rule

A `forbid` with a `when temporal` clause counts earlier decisions. This rule lets the agent run `git commit` five times an hour, and refuses the sixth:

```text
@id("cap_git_commits")
forbid (principal, action == Box::Action::"shell:spawn", resource)
when { context.input.program == "git" && context.input has arg1 && context.input.arg1 == "commit" }
when temporal {
  exists (n: Long). (
    (count for (t: Timepoint). where (
      formerly within 3600s (
        Box::Action::"shell:spawn"::request{ input.program: "git", input.arg1: "commit" } && tp(t)
      )
    )) == n
    && n > 5
  )
};
```

`::request` counts every attempt in the window, including the one being decided and each refused one. `::response` counts only commands that ran, and carries the exit status as `output.status`. A new or changed history rule starts counting when the box restarts with it.

## Result

Restart the box with the command from step 4. The decision log has one line for each command and each file operation; [read the decision log](../../quickstart/index.md#step-7-read-the-decision-log) prints it. For `grep -n TODO src/main.rs > todo.txt && git add todo.txt`:

```text
permit  shell:exec   grep -n TODO src/main.rs
permit  fs:write     ~/src/project/todo.txt
permit  fs:read      ~/src/project/src/main.rs
permit  shell:spawn  /Library/Developer/CommandLineTools/usr/bin/git add todo.txt
```

## Troubleshooting

| What the agent sees | Cause | Fix |
| --- | --- | --- |
| `strands-shell: effect denied: policy denied this operation on '<program>'`, then `[policy: <id>]` or `[default-deny]`, status `126` | No `shell:exec` or `shell:spawn` permit matches the command. | Add a permit, as in step 1, 4, or 5. |
| ``strands-shell: <program>: no tool runs <path>: no `[tool.<name>] command` matches this program and its leading arguments``, status `126` | Policy permits the program, and no `[tool.<name>]` table or `exec` entry covers the file at `<path>`. | Add a `[tool.<name>]` table whose `command` resolves to `<path>`, or an `exec` entry that covers it. When a table names the program, make its fixed arguments match the command. |
| `strands-shell: <program>: command not found`, status `127` | The program is not in the box’s shell, and not on the `PATH` of the host OS’s shell that runs `box run`. | Install it, or start `box run` with its directory on the `PATH`. |
| `policy denied this operation on '<path>'`, and the command exits `1` | No `fs:*` permit matches the path, or a `forbid` names it. | Read the `@id` in the message. Widen the permit, as in step 2, or narrow the `forbid`. |
| `xcode-select: error: unable to read data link at '/var/db/xcode_select_link'` | `git` resolved to `/usr/bin/git` on macOS. | Start `box run` with `/Library/Developer/CommandLineTools/usr/bin` first on the `PATH`, as in step 4. |
| A file written to `/tmp` is missing in the next command | The Shell’s `/tmp` lasts one command. | Write the file in the workspace. |
| `curl` fails, and prints `http:request gate: policy denied this operation` | The gateway refused the request. | Permit `net:connect` and `http:request` for the host, as in [the `[egress.<name>]` table](../network-and-credentials/index.md#example). |
| A `shell:spawn` rule on `program_path` never matches | `program_path` is the file with every link resolved, under `~/` when it is in your home. | Read the path in the refusal, and write the rule on that spelling. |

## See also

-   [Strands Shell reference](../../reference/shell/index.md): every field, action, and exit status.
-   [How Box runs shell commands and programs](https://github.com/strands-agents/box/blob/04fa0ac1e23aea9a7e077298c6de763875b76a36/docs/design/shell.md): the order of the checks.
-   [Policy in the design guide](https://github.com/strands-agents/box/blob/04fa0ac1e23aea9a7e077298c6de763875b76a36/docs/design/policy.md): how the engine decides, and what refuses to load.