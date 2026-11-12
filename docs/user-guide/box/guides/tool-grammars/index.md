A tool grammar describes one program, such as `git`, as a set of actions and effects. With a grammar in place, Box reads each command line the agent runs with that program as one action, such as `Tool::git::Action::"push"`, and your policy decides that action. You write one rule against the action and its effects, and the rule covers every spelling the grammar reads.

Without a grammar, a rule about `git` reads the raw words of a `shell:spawn` request, such as `context.input.arg1 == "push"`. The same force push can be written as `git push -f`, `git push --force-with-lease`, or `git push origin +main`, and a rule over raw words must list each spelling. A grammar lists the spellings once, as data. Each of them becomes the action `push` with the effect `force_push`, and one rule refuses all of them.

This page adds a grammar for `git`, writes rules against it, and then states what a grammar governs and what it doesn’t. For every key and every startup refusal, see [`[tool.<name>.grammar]`](../../reference/configuration/index.md#toolnamegrammar) in the configuration reference.

> **Status.** Tool grammars are experimental. They load only when `box.toml` sets `[experimental-features] tool-grammars = true`, and the format can change before 1.0.0.

## Before you start

-   A box with a working policy for Strands Shell commands, and a `[tool.git]` table that runs, as in [Write policy for shell commands](../write-shell-policy/index.md). This page adds rules to that policy.

## Step 1. Turn on tool grammars

Add the switch to `box.toml`:

```toml
[experimental-features]
tool-grammars = true
```

Without it, `run` refuses any `grammar` table and starts nothing.

## Step 2. Add a grammar to the tool

A grammar is a `grammar` table inside the `[tool.<name>]` table for the program. This one reads `git push` and `git status`, and the `-c` and `-C` options that `git` accepts before either:

```toml
[tool.git]
command = ["git"]

[tool.git.filesystem]
read  = ["~/src/project"]
write = ["~/src/project/.git"]

[tool.git.grammar]
format  = 1
version = 1
name    = "git"
program = "git"

[tool.git.grammar.effects]
force_push      = "Replaces commits on a remote branch"
network         = "Contacts a remote repository"
override_config = "Overrides git configuration for this one command"

[tool.git.grammar.global]
options.config    = { flag = "-c", value = "required", repeated = true, adds = ["override_config"] }
options.directory = { flag = "-C", value = "required" }

[tool.git.grammar.shell.push]
usage = "git [global options] push [options] [<remote> [<refspec>...]]"
adds  = ["network"]
options.force            = { flag = ["-f", "--force"], adds = ["force_push"] }
options.force_with_lease = { flag = ["--force-with-lease"], value = "optional", adds = ["force_push"] }
options.dry_run          = { flag = ["-n", "--dry-run"], removes = ["force_push", "network"] }
operands.refspec         = { like = "+*", adds = ["force_push"] }

[tool.git.grammar.shell.status]
usage = "git [global options] status [options]"
options.short = { flag = ["-s", "--short"] }
```

The keys:

| Key | What it holds |
| --- | --- |
| `format` | The version of the grammar format. Write `1`. A grammar without it is refused. |
| `version` | The version of this grammar’s own content. Version 1 gives the namespace `Tool::git`, and version 2 gives `Tool::git::v2`. |
| `name` | The name in the policy namespace, so `name = "git"` gives `Tool::git::Action::"push"`. |
| `program` | The program name the grammar reads, which is the name the agent types. When it isn’t the last part of `command[0]` in its own `[tool]`, `program` on `PATH` must reach the same file as `command[0]`. |
| `effects` | Each effect a command can have, with a one-line description. |
| `global.options` | Options that come before the action’s words. Only an action whose `usage` has `[global options]` accepts them. |
| `shell.<action>` | One action, such as `shell.push`. |
| `shell.<action>.usage` | The action’s command line. Each `<name>` is an operand, and `<name>...` takes more than one word. |
| `shell.<action>.adds` | The effects that every spelling of the action has. |
| `shell.<action>.options` | The options the action accepts, each with its `flag` spellings. An option with no `value` is a flag. |
| `shell.<action>.operands` | Effects for an operand that `usage` names. `like` is a pattern: `like = "+*"` matches a refspec that starts with `+`. |

An option or an operand adds effects with `adds`, and takes them away with `removes`.

A command line that matches no `usage` is the action `unmodeled`. So is one with an option that its action doesn’t declare. [A command the grammar can’t read](#a-command-the-grammar-cant-read-is-unmodeled) says how policy decides it.

`name` and `program` are separate. `program` is what the agent types, and it decides which `[tool]` tables the grammar covers. `name` is what your rules spell. Two grammars can’t share a `name`, and two grammars can’t share a `program`.

## Step 3. Write the rules

Add these rules to `policy.dw`:

```text
@id("git")
permit (principal, action in Tool::git::Action::"*", resource);

@id("no_force_push")
@description("Force pushes are not allowed.")
forbid (principal, action == Tool::git::Action::"push", resource)
when { context.input.effects.contains(Tool::git::Effect::"force_push") };
```

`Tool::git::Action::"*"` is the group of every action the grammar declares, so the permit allows `git push` and `git status`. The forbid refuses every push that has the `force_push` effect, including `git -C ~/src/project push -f`. The command exits with status `126`:

```text
strands-shell: effect denied: policy denied this operation on '/usr/bin/git' [policy: no_force_push]: Force pushes are not allowed.
```

`git push --dry-run -f` doesn’t have the effect, because `--dry-run` removes it, so the forbid doesn’t refuse it.

A rule reads the command through `context.input`: the effects, one field for each option and operand, such as `force`, and the fields that every grammar action has, such as `cwd`. [Tool grammar actions](../../reference/policy-actions/index.md#tool-grammar-actions) lists each field and its type.

## Step 4. Start the box

Start the box as you do now, for example:

```sh
./box-core/box run --config my-box/box.toml
```

`run` prints one line for each `[tool]` and each stdio `[mcp.<name>]` whose program a grammar decides:

```text
strands-box: [tool.git]: a spawn of `git` is decided by its tool grammar, and no `shell:spawn` rule applies to it
```

Read these lines when you add a grammar to a box you already run. Every `shell:spawn` rule about that program stops applying to it, as [A grammar action replaces `shell:spawn`](#a-grammar-action-replaces-shellspawn) explains.

## Step 5. Allow a push only after the tests pass

A rule can permit `git push` only after a `cargo test` exited `0`. Add a cargo grammar beside the git grammar:

```toml
[tool.cargo]
command = ["cargo"]

[tool.cargo.filesystem]
read  = ["~/src/project", "~/.cargo", "~/.rustup"]
write = ["~/src/project/target"]

[tool.cargo.grammar]
format  = 1
version = 1
name    = "cargo"
program = "cargo"

[tool.cargo.grammar.shell.test]
usage = "cargo test"
```

With rustup, `~/.cargo/bin/cargo` is a link to `rustup`, and so are `rustc` and `cargo-clippy`. The cargo grammar decides only the name `cargo`. A spawn of `rustc` or `cargo-clippy` is still a `shell:spawn`.

Then add the rules. Replace `/home/alice/src/project` with the absolute path of your project:

```text
@id("cargo")
permit (principal, action in Tool::cargo::Action::"*", resource);

@id("push_after_project_tests")
@description("Run the project's tests before you push.")
forbid (principal, action == Tool::git::Action::"push", resource)
unless temporal {
  formerly within 1h Tool::cargo::Action::"test"::response{ input.cwd: "/home/alice/src/project", output.status: 0 }
};
```

The `input.cwd` condition is required. A `Tool::cargo::Action::"test"::response` records only that a command the grammar read as `cargo test` exited `0`, in a working directory and with arguments the agent chose. Without `input.cwd`, a passing `cargo test` in a scratch crate would allow the push.

The rule proves that a command read as `cargo test` exited `0` in that directory, not that the project’s tests ran. If the agent can write the project, it can change what `cargo test` does, for example with a `runner` in `.cargo/config.toml` or an `#[ignore]` on every test. Then treat the rule as a guard against mistakes, not as an enforcement boundary.

Pin the arguments through the grammar. `args` is a set, and a temporal predicate can’t compare a field to a set, so `input.args: ["test"]` is refused at startup. Here the `test` action’s `usage` is `cargo test` and nothing more. A command such as `cargo test --manifest-path ~/scratch/Cargo.toml` has an option the action doesn’t declare, so it reads as `unmodeled` and records no `test` response. Add an option to the `test` action only when the option can’t point the tests at another crate.

History is durable for each box. A test that passed before you restart the box still allows a push after the restart, within the hour.

A temporal predicate names one action, and never a group. A predicate such as `Tool::git::Action::"*"::response{}` is refused at startup, because history records each action and never the group. Name the action, such as `Tool::cargo::Action::"test"`. A rule whose scope is the group, such as `forbid (principal, action in Tool::git::Action::"*", resource)`, can still have a temporal predicate over one action.

## How a grammar decides a command

A grammar binds a program: it decides each spawn of the file its `[tool]` runs, under the grammar’s `program`, the name the agent types.

### A grammar action replaces `shell:spawn`

Once a grammar binds `git`, Box decides each spawn of `git` as the grammar action alone, and not as `shell:spawn`. A `shell:spawn` permit no longer admits `git`, and a `shell:spawn` forbid no longer refuses it. Move each `git` rule you had on `shell:spawn` to the grammar’s actions. A `when temporal` rule that reads `shell:spawn` history also stops seeing `git`, because each spawn of it enters history as its grammar action.

### A command the grammar can’t read is `unmodeled`

When no `usage` matches a command, such as `git frobnicate`, or a command has an option the grammar doesn’t declare, such as `--delete` in `git push --delete origin main`, Box decides it as `Tool::git::Action::"unmodeled"`. `unmodeled` isn’t in the `"*"` group, so the permit over `"*"` doesn’t allow it. With no rule that names it, it’s denied:

```text
strands-shell: effect denied: policy denied this operation on '/usr/bin/git' [default-deny]: No permit policy matched this request.
```

To allow commands the grammar doesn’t model, permit `unmodeled` by name. That permit allows every spelling the grammar can’t read, so give it a `when` condition.

A forbid over `"*"` skips `unmodeled` the same way. If any rule permits `unmodeled`, a rule that denies all of `git` must name both:

```text
forbid (principal, action in [Tool::git::Action::"*", Tool::git::Action::"unmodeled"], resource);
```

### A rule covers one grammar

A rule over `Tool::cargo::Action::"*"` can test `context.input.effects` for a cargo effect, and it then covers every cargo action. A rule can’t test a git action for a cargo effect, and Box refuses it at startup. Box also refuses a rule that reads `context.input` over a grammar action and a `Box::` action together. Write one rule for each grammar.

### One grammar covers every tool that runs its program

A grammar names one `program`, and it binds its own `[tool]` under that name. It also binds every other `[tool]` and every stdio `[mcp.<name>]` whose `command[0]` ends in that name. A grammar on `[tool.git]` with `program = "git"` also covers a `[tool.brew_git]` with `command = ["/opt/homebrew/bin/git"]`, and `run` prints a startup line for each. A second grammar with the same `program` is refused.

The grammar’s own `[tool]` may name the file that a link leads to. With `command = [".../npm/bin/npm-cli.js"]` and `program = "npm"`, the grammar binds that file under `npm`, the name the agent types. When the last part of `command[0]` is the `program`, as with `git`, the Shell runs that tool’s file for the bare name, whatever `PATH` finds first. When it isn’t, `run` finds `program` on its own `PATH` and starts only when that is the same file. The Shell then finds the bare name on that `PATH` too. If another `[tool]` whose file name is the `program` runs a different file, the Shell still uses `PATH` for that name, so the grammar keeps deciding it. To make the bare name run the grammar’s file whatever `PATH` finds, spell `command[0]` as a link whose name is the `program`, such as `.../v20/bin/npm`. Otherwise it refuses the grammar, so a `git` grammar can’t sit on a `[tool.gh]`. Another `[tool]` or `[mcp.<name>]` whose command names `npm-cli.js` calls the program by another name, so the npm grammar doesn’t bind it.

## Which program files a grammar binds

Links, other names, and copies are decided as follows:

-   **A link called by the bound name is that file.** A hard link or a symbolic link to the bound `git`, called as `git`, is decided by the grammar.
-   **Another name of a bound file is a `shell:spawn`.** One file can have several names. On macOS, `/usr/bin/git` is one launcher file that is also `make`, `clang`, and many other developer tools. A grammar for `git` decides only the name `git`, so a spawn of `make` is decided as `shell:spawn`. So is a link that the workload makes to the bound file under another name, such as `g`. This holds whether or not a `[tool]` declares the other name. The one exception is a name that only a stdio server declares, in the next item.
-   **A name that only a stdio server declares is for that server’s start alone.** When a stdio `[mcp.<name>]` runs a bound file under a name that no `[tool]` declares, `shell:spawn` decides the server’s start. If the agent calls the file by that name, Box refuses the spawn, and no policy can permit it, because the server’s start and the agent’s spawn would otherwise make the same `shell:spawn` request. This restriction on agent commands does not apply when no grammar binds the file. Server starts still follow the required-binding check below.
-   **A replaced file is refused.** If the file at a bound path changes while the box runs, for example after an update, its bound names stay refused until the box restarts. Box also refuses a bare name, such as `git`, when the file bound under that name is gone or replaced. The denial has `[tool-grammar]` where a rule `@id` would be, and ends with `No policy can permit it.`
-   **A local server must satisfy its required grammar binding.** When a stdio server’s configured program name matches an installed grammar, its start must use a file Box bound under that name before the workload started. A missing or unreadable server program does not prevent Box startup. When the server is requested, Box refuses its start if that binding is unavailable. A general `shell:spawn` permit cannot replace this check. The rest of Box keeps running. A later link to an already-bound file can satisfy the same file-and-name check on a retry. To use a new or previously unreadable executable, make it readable and executable by the user running Box, then restart Box.
-   **A copy at another path is a different file.** For an ordinary agent command, when no `[tool]` runs a copy of `git` at another path, Box decides that copy as `shell:spawn`. A local server whose program name requires a grammar must satisfy the binding check above.

For ordinary agent commands, a broad `shell:spawn` permit lets another name or a copy of `git` past a `Tool::git` forbid. A link such as `g` resolves to the bound file, so a permit that matches only the bound file’s `context.input.program_path` admits every other name of it. Pin each `shell:spawn` permit on both `context.input.program` and `context.input.program_path`, such as `program == "make"` with `program_path == "/usr/bin/make"`.

## What a grammar governs

A grammar decides a spawn that reaches Strands Shell. That covers a command the agent runs directly, and one the Shell runs for it through `sh -c`, `xargs`, or `$(...)`.

A grammar doesn’t decide a program that another program starts. Once Box runs `git`, `git` runs in its own sandbox, and neither the grammar nor `shell:spawn` decides the programs it starts. They stay inside `git`’s sandbox. Some examples:

-   A git hook in `.git/hooks`, an alias that starts with `!`, `core.fsmonitor`, `core.sshCommand`, and `GIT_SSH_COMMAND`.
-   `git rebase -x <command>`, which runs `<command>` after each commit.
-   `make`, `cargo`, or a script that runs `git` itself.
-   The `env` of the surrounding OS, as in `/usr/bin/env git push`, where `env` is the program the Shell spawns.

To keep these routes closed:

-   Keep `.git/hooks` and `.git/config` out of every `write` list in `[agent.filesystem]` and out of every `fs:write` permit, so the agent can’t add a hook or a command to the configuration. The `write` grant on `.git` in `[tool.git.filesystem]` is the `git` tool’s own, and it’s expected.
    
-   Treat the `override_config` effect as running a program. `git -c core.sshCommand=<program> push` runs `<program>`. Forbid `override_config` unless you need it:
    
    ```text
    @id("no_git_config_override")
    forbid (principal, action in Tool::git::Action::"*", resource)
    when { context.input.effects.contains(Tool::git::Effect::"override_config") };
    ```
    

## What a grammar can’t see

A grammar reads the command line, and nothing else. It doesn’t see:

-   **Environment variables.** A variable in the tool’s own `env`, such as `GIT_SSH_COMMAND`, changes what `git` does, and the grammar reads the same action and effects.
-   **Configuration files.** `.git/config` can set `core.sshCommand` or `core.hooksPath`, and an `[alias]` entry in `.cargo/config.toml` can make `cargo t` run another cargo command.
-   **Child processes**, as in [What a grammar governs](#what-a-grammar-governs), and **another name or a copy of the program**, as in [Which program files a grammar binds](#which-program-files-a-grammar-binds).

The effects are what the command line states, not what the program does. Write rules that stay safe when a command does more than its words say.

## Startup refusals

`run` refuses invalid grammar definitions and tool configuration before the workload starts. Each message says what is wrong. Most of these refusals come before it writes any box state. The check that `program` on `PATH` reaches the tool’s file comes after `run` opens each tool’s program file. [`[tool.<name>.grammar]`](../../reference/configuration/index.md#toolnamegrammar) lists each refusal with its message.

An unavailable server program does not stop startup. A later server-start request can be refused when its required grammar binding is unavailable, as described in [which program files a grammar binds](#which-program-files-a-grammar-binds).

## See also

-   [`[tool.<name>.grammar]`](../../reference/configuration/index.md#toolnamegrammar): the configuration reference and every startup refusal.
-   [Tool grammar actions](../../reference/policy-actions/index.md#tool-grammar-actions): every field a rule can read.
-   [`shell:spawn`](../../reference/shell/index.md#shellspawn): how the Shell decides a program of the surrounding OS, and when a grammar decides it instead.
-   [What a temporal rule observes](../../reference/policy-actions/index.md#what-a-temporal-rule-observes): the events a grammar action records.