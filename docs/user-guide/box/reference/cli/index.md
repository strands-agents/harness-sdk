This page lists every `box` command, its flags, and the output you use. `box <command> --help`, or `box help <command>`, prints the same flags in short form. For what profiles, packs, and policies are, see [How Box works](/docs/user-guide/box/how-box-works/index.md).

```sh
box run claude
```

## Commands

| Command | Use it to |
| --- | --- |
| [`box run`](#box-run) | Start an agent in a box, in the current folder. |
| [`box profile create`](#box-profile-create) | Make a profile for an agent. |
| [`box profile edit`](#box-profile-edit) | Change the answers you gave when you made a profile. |
| [`box profile show`](#box-profile-show) | Check what a run will get, before you run it. |
| [`box profile list`](#box-profile-list) | See your profiles, and the starters you can make one from. |
| [`box profile clean`](#box-profile-clean) | Remove the boxes a profile owns. |
| [`box profile reset`](#box-profile-reset) | Start a profile’s agent fresh, without its settings and sessions. |
| [`box profile delete`](#box-profile-delete) | Delete a profile, with its boxes and storage. |
| [`box runs list`](#box-runs-list) | Find an earlier run and its box ID. |
| [`box runs history`](#box-runs-history) | See what the box allowed and denied in a run. |
| [`box telemetry`](#box-telemetry) | Turn usage telemetry on or off. |
| [`box help agent`](#box-help-agent) | Give a coding agent on your host the guide to make or change a profile. |

The [environment variables](#environment-variables) and [exit status](#exit-status) are at the end.

## box run

Start an agent in a box. It works on the project in the folder you run it from, and each run gets a box of its own, so you can run one profile in several terminals at once.

```sh
cd ~/src/my-app
box run claude
```

Set up the model’s sign-in in the same shell first, such as your AWS credentials or a key. `box profile create` told you which when you made the profile.

```text
box run [<profile>] [--box-id <box ID>] [--banner | --no-banner] [-- <agent arguments>...]
```

| Flag | What it does |
| --- | --- |
| `<profile>` | The profile to run: a name, or the path of a profile file, such as `../box/profile.toml` ([Run a profile file](#run-a-profile-file)). Leave it out at a terminal to pick one. If you have no profile with that name but `box` has a starter for it, such as `claude`, `box` makes the profile first. |
| `--box-id <box ID>` | Run in an earlier run’s box, so rules that count over time keep counting ([Run in the same box again](#run-in-the-same-box-again)). |
| `--no-banner` | Give the agent the whole terminal, without the [activity banner](#the-activity-banner). |
| `--banner` | Show the banner, even when the profile or `~/.strands/box/config.toml` turns it off. |
| `-- <agent arguments>` | Pass the rest of the line to the agent. `box run claude -- --continue` continues Claude Code’s last conversation. |

Once the terminal session starts, with or without the banner, `box` shows recent Box errors on exit, then a short summary of the run:

```text
box: run b-5b8e3d70c92f14ab ended
  startup disclosure · 0 more messages
  log      /Users/you/.strands/box/r/b-5b8e3d70c92f14ab/box.log
  history  box runs history b-5b8e3d70c92f14ab
  reuse    box run claude --box-id b-5b8e3d70c92f14ab
```

Box Core’s startup disclosure, which names every grant the box gives the agent and its tools, is in the [log](/docs/user-guide/box/reference/files/index.md#profile-storage-and-runs). The messages are the other Box lines in the log that the summary didn’t show. A new run that fails before its box starts shows only the errors.

If input or output is redirected, including stderr, or `TERM=dumb`, `box` prints the box ID and these commands at startup:

```text
box: running profile claude with box ID b-5b8e3d70c92f14ab (records: /Users/you/.strands/box/r/b-5b8e3d70c92f14ab/records.jsonl)
box: to reuse this box run: box run claude --box-id b-5b8e3d70c92f14ab
box: policy history: box runs history b-5b8e3d70c92f14ab
```

The `box:` lines before these are notes about something the run leaves out, such as `box: skipped tool pnpm (@box/pnpm): pnpm is not on PATH`. [`box profile show`](#box-profile-show) prints the same notes, with `!`, before you run.

### The activity banner

While the agent runs, a one-line banner below it shows the profile, your project, and what the box just allowed or denied. A new denial stays highlighted for five seconds.

| Press | To |
| --- | --- |
| **Ctrl+\]** | Open or close the banner’s full view, with the latest denials and operations. |
| **Ctrl+Alt+R** | Apply a policy edit you just saved, without restarting the agent. The banner says **UPDATE READY** when one is waiting. |
| **Ctrl+\\** | Turn policy off or on, without restarting the agent. [What a box does not protect](/docs/user-guide/box/limitations/index.md#before-turning-permission-prompts-off) says what policy off still limits. |

Click **Config File** or **Policy File** in the banner to copy that file’s path. An edit to a folder or a program the agent can use takes effect on the next run.

The full view’s table shortens long reasons and shows only the latest rows. Its bottom edge shows the [`box runs history`](#box-runs-history) command for this run, which lists every decision in full, even while the run goes on. Click the command to copy it, and run it in another terminal. When `BOX_HOME` moves the box home, the command starts with `BOX_HOME=<path>`, so it works in a terminal that doesn’t set it.

The banner’s display doesn’t pass through clipboard reads or terminal graphics, so turn it off for an agent that needs them: add `--no-banner` for one run, set [`[banner] enabled = false`](/docs/user-guide/box/profiles/index.md#what-a-profile-holds) in a profile for its runs, or set it in [`config.toml`](/docs/user-guide/box/reference/box-config/index.md#banner) for every profile.

### Run a profile file

A project can keep its profile beside its source. Give `box run` the file’s path: a value that holds `/` or ends in `.toml` is a path.

```sh
cd ~/src/my-agent/app
box run ../box/profile.toml
```

The file names its profile in a `[profile]` table:

```toml
packs = ["@box/base", "@box/bedrock"]

[profile]
name = "weather-agent"
```

Keep the file, and its `policies` files, where the agent can’t change them: outside the project you run in, or in the project’s `.box` folder, and outside every write grant.

The file can list a [plugin](/docs/user-guide/box/plugins/index.md), but it can’t declare a secret source of its own, and [the plugin reference](/docs/user-guide/box/plugins/index.md#a-profile-file-that-runs-by-its-path) says which plugins it can list and which of their inputs it can set. It still chooses which secret goes to which host ([Packs get the same trust as the profile](/docs/user-guide/box/limitations/index.md#packs-get-the-same-trust-as-the-profile)).

### Run in the same box again

Each run gets a new box, so a rule such as “at most 50 model calls an hour” starts counting from zero. To keep counting, pass the box ID of an earlier run of the same profile, from the run’s output or [`box runs list`](#box-runs-list). A box ID doesn’t name its profile, so match the `PROFILE` column before you copy the `BOX ID`:

```sh
box run claude --box-id b-5b8e3d70c92f14ab
```

This doesn’t resume the agent’s conversation. To do that too, pass the agent’s own flag, such as `-- --resume <session ID>` for Claude Code. Only one run can use a box ID at a time. A box ID also works from another project: its history counts across both, and the run gets the files of the folder you run it from.

## box profile create

Make a [profile](/docs/user-guide/box/profiles/index.md) for an agent. `box` asks a few questions, such as the model provider’s region and which policy the agent starts with, and writes the profile to `~/.strands/box/profiles/<name>/`.

```sh
box profile create claude --with claude,bedrock
```

```text
box profile create [<name>] [--with <packs>] [--option <name>=<value>]... [--policy <policy>]
    [--tools <list>] [--force]
```

| Flag | What it does |
| --- | --- |
| `<name>` | The profile name: 1 to 64 letters, digits, `.`, `_`, and `-`, not starting with `.` or `-`, not ending in `.toml`, and not `base` or `box`. When it’s a starter’s name, such as `claude`, that starter asks what the profile needs. Leave it out at a terminal to pick an agent. |
| `--with <packs>` | The starter and packs to use, separated by commas, such as `claude,bedrock`. A short name such as `claude` means your own starter or pack of that name when you have one, else the one that comes with `box`. Write `@box/claude` for the one that comes with `box`. |
| `--option <name>=<value>` | Answer a question ahead of time, such as `--option bedrock.region=us-east-1`. Repeat it for more. |
| `--policy <policy>` | The policy the agent starts with, such as `open` or `scoped` ([Pick the agent’s policy](/docs/user-guide/box/starters/index.md#pick-the-agents-policy)). |
| `--tools <list>` | The toolchains the agent can use, such as `git,cargo`. Without it, a profile gets `cargo`, `git`, `node`, `npm`, `pnpm`, and `yarn`, and a run skips any your machine doesn’t have. |
| `--force` | Replace a profile that already exists. Your edits to `profile.toml` and `policy.dw` are lost, and `policies` lists only `policy.dw` again, so put back any rule file you added and any `[agent] command` you wrote. |

[Starters](/docs/user-guide/box/starters/index.md#create-a-profile) walks through the questions, and [Answer the questions without a prompt](/docs/user-guide/box/starters/index.md#answer-the-questions-without-a-prompt) shows a command for a script.

## box profile edit

Change the answers you gave when you made a profile. `box` asks the questions again, with your saved answers picked, and keeps your other edits to `profile.toml`.

```sh
box profile edit claude
```

```text
box profile edit <name>
```

| Flag | What it does |
| --- | --- |
| `<name>` | The profile to change. |

## box profile show

Check what a run will get, before you run it: the packs, each option and where its value came from, and notes about anything the run leaves out. Run it in your project folder, not your home folder, because some values depend on the folder you’re in. It starts no box and changes nothing in storage.

```sh
cd ~/src/my-app
box profile show claude
```

```text
box profile show <profile> [--full] [--format <text|json>]
```

| Flag | What it does |
| --- | --- |
| `<profile>` | The profile to check: a name, or the path of a profile file. |
| `--full` | Also print the whole configuration and policy the run gets. It includes any key your profile passes to an MCP server, so be careful where you paste it. |
| `--format <text|json>` | Print the text report, or the same report as one JSON document ([JSON output](#json-output)). |

Example output, shortened:

```text
box: Profile claude

✓ Resolves for this directory
  packs     @box/claude 1, @box/base 1, @box/bedrock 1, @box/git 1, @box/pnpm 1
  policies  policy.dw
  storage   /Users/you/.strands/box/storage/claude/default
  project   read and write

Options
  claude.host              "bedrock"  (your profile)
  bedrock.region           "us-east-1"  (your profile)
  ...
  ! skipped tool pnpm (@box/pnpm): pnpm is not on PATH
  copy ~/.claude/CLAUDE.md -> agent/config/CLAUDE.md (will copy)
  mcp      fetch declared from ~/.claude.json
```

A line that starts with `!` is a note: the run goes on without what it names, and the note says why. Each option shows its source: `your profile`, `default`, `env:<NAME>` for a variable in your shell, or `search` for a program `box` found. A profile that lists a [plugin](/docs/user-guide/box/plugins/index.md) also gets a `plugins` line. Each secret source, from a plugin or the profile, gets a `source` line: its scheme, such as `op://`, the program that runs on your machine, outside the box, and the plugin that declares it, or `your profile`. A `copy` line is a file of yours that comes into the profile’s storage, and [Copy status](/docs/user-guide/box/packs/index.md#copy-status) explains each status.

### JSON output

With `--format json`, standard output holds one JSON document on one line and nothing else. An error goes to standard error as `box: error: <reason>`, with status `1`, and standard output stays empty.

```sh
box profile show claude --format json --full
```

```text
{"profile":"claude","packs":[{"name":"@box/claude","version":"1"},...],"policies":["policy.dw"],"storage":"/Users/you/.strands/box/storage/claude/default","project":{"access":"write"},"inputs":[{"name":"agent.skip-permissions","value":"false","source":"default"},...],...,"box_toml":{"name":"claude-preview","box_dir":"/Users/you/.strands/box/r/claude-preview/box","policy":"policy.dw",...},"policy":"..."}
```

The document holds what the text report prints, and `--full` adds `box_toml` and `policy`.

| Key | What it holds |
| --- | --- |
| `profile` | The profile name, as you typed it. |
| `packs` | `name` and `version` of each pack on the `packs` line, in the same order. |
| `plugins` | `name` and `version` of each plugin on the `plugins` line, in the same order. |
| `sources` | `scheme` (such as `op`), `program`, and `plugin` of each `source` line. `plugin` is `null` for a source that your profile declares. |
| `policies` | Each file on the `policies` line. |
| `storage` | The `storage` folder. |
| `project` | `access` from `[project]`: `none`, `read`, or `write`. It’s `null` when the profile has no `[project]`. |
| `inputs` | `name`, `value`, and `source` of each option and variable. |
| `skipped` | `tool` (the toolchain and its pack) and `reason` of each `skipped tool` line. |
| `dropped` | `tool` and `path` of each folder or helper program that a toolchain’s pack names and this machine lacks. |
| `open_routes` | `route` and `destinations` (a list of its hosts) of each `route` line. |
| `copies` | `source`, `target`, and `action` (such as `will copy`) of each `copy` line. |
| `links` | `link` and `action` of each `link` line. |
| `parts` | `what` (`keeps`, `drops`, `missing`, `sets`, or `fills`), `target`, and `names` (a list with each name as a list of keys, as in a `keep` entry, such as `[["env", "GITHUB_TOKEN"], ["model"]]`). |
| `mcp.unstarted` | `server` and `reason` of each `no permit to start MCP server` line. |
| `mcp.servers` | `server`, `file`, and `detail` (the end of the `mcp` line, such as `, with the key in GITHUB_TOKEN`, or empty). |
| `mcp.dropped` | `variable`, `server`, `file`, and `reason` of each variable that an MCP server goes without. |
| `mcp.unchecked` | `variable`, `server`, and `file` of each `did not check` line: a variable of a declared MCP server whose value opens as options do, which `box` doesn’t read. |
| `mcp.path_dropped` | The text after `dropped` for each folder on your `PATH` that isn’t a full path. |
| `mcp.skipped` | `server`, `file`, and `reason` of each `no automatic MCP declaration for` line. |
| `mcp.unread` | `file` and `reason` of each `did not read` line. |
| `warnings` | Each `warning`, in Box Core’s words. |
| `box_toml` | Only with `--full`. The `box.toml` as a JSON object, with its keys in the order of the file. A TOML date or time is a string. |
| `policy` | Only with `--full`. The `policy.dw` text. |

## box profile list

See your profiles and their packs, and the starters you can make a profile from.

```text
box profile list
```

It takes no flags.

```text
box: Profiles

  claude
    packs @box/claude, @box/bedrock, @box/cargo, @box/git, @box/node, @box/npm, @box/pnpm, @box/yarn

Starters:
  claude  Claude Code
  codex   Codex
  kiro    Kiro CLI
  pi      pi
```

A profile that `box` can’t read shows `! invalid:` and the reason. The list doesn’t read the packs, so check a profile with [`box profile show`](#box-profile-show) before you run it.

## box profile clean

Remove the boxes of one or more profiles’ earlier runs, and their records. A run’s box stays after the agent exits, so this clears out a profile’s old runs. `box` asks first, and removes nothing while one of those boxes is still running. The profiles and their storage stay, so the agent keeps its settings and sessions.

```sh
box profile clean claude
```

```text
box profile clean <name>... [--no-ask]
box profile clean <name> --box-id <box ID> [--no-ask]
box profile clean --all [--no-ask]
```

| Flag | What it does |
| --- | --- |
| `<name>...` | The profiles whose boxes to remove. |
| `--box-id <box ID>` | Remove only this box, from [`box runs list claude`](#box-runs-list). Name exactly one profile, the one the box belongs to. |
| `--all` | Remove every box, of every profile. |
| `--no-ask` | Remove without asking, for a script. |

```text
Remove 2 boxes of profile claude, and their records? [y/N] y
box: removed 2 boxes of profile claude
```

To remove one stopped box while another box of the same profile is still running, name it:

```text
$ box profile clean claude --box-id b-5b8e3d70c92f14ab
Remove box b-5b8e3d70c92f14ab of profile claude, and its records? [y/N] y
box: removed box b-5b8e3d70c92f14ab of profile claude
```

`box` refuses a box that belongs to another profile, and a box that is still running.

## box profile reset

Start a profile’s agent fresh. `box` deletes the profile’s storage: the agent’s settings, sessions, and memory that every run of the profile shares. The profile and its boxes stay. `box` asks first.

```sh
box profile reset claude
```

```text
Delete the storage of profile claude? The agent loses its settings and sessions. The profile and its boxes stay. [y/N] y
box: deleted the storage of profile claude
```

```text
box profile reset <name>... [--no-ask]
box profile reset --all [--no-ask]
```

| Flag | What it does |
| --- | --- |
| `<name>...` | The profiles whose storage to delete. |
| `--all` | Delete the storage of every profile. |
| `--no-ask` | Delete without asking, for a script. |

The next run of the profile copies your files into storage again, as on its first run, and the agent starts with no sessions. It may ask you to sign in again. If the profile has no storage, `box` prints `box: no storage found for profile claude`. If one of its boxes is still running, `box` deletes nothing and names the box. Exit that box, then run the command again.

## box profile delete

Delete profiles you no longer need, with the boxes they own and their storage. `box` asks first, and names what it will delete.

```sh
box profile delete claude
```

```text
Delete profile claude, with 2 boxes and its storage? [y/N] y
box: deleted profile claude, with 2 boxes and its storage
```

```text
box profile delete <name>... [--no-ask]
box profile delete --all [--no-ask]
```

| Flag | What it does |
| --- | --- |
| `<name>...` | The profiles to delete. |
| `--all` | Delete every profile, every box, and all storage. |
| `--no-ask` | Delete without asking, for a script. |

Nothing of the profile is left, so a new profile with the same name starts from the beginning: `box profile create` asks its questions again, and its first run is like the first run of any profile. A profile file of yours stays where it is; `box` deletes only what it keeps in `~/.strands/box`. If one of the boxes is still running, `box` deletes nothing and names the box. Exit that box, then run the command again.

### Which command to use

| Command | Deletes | Keeps | The next run |
| --- | --- | --- | --- |
| [`box profile clean`](#box-profile-clean) | The profile’s boxes | The profile and its storage | Starts in a new box, with the agent’s settings and sessions as before. |
| `box profile reset` | The profile’s storage | The profile and its boxes | Starts the agent fresh: no sessions, and your files copied in again. |
| `box profile delete` | The profile, its boxes, and its storage | Nothing | Needs a new profile. `box profile create` asks its questions again. |

## box runs list

Find an earlier run and its box ID, to run in the same box again or to read its history.

```sh
box runs list
```

```text
box runs list [<profile>] [--format json]
```

| Flag | What it does |
| --- | --- |
| `<profile>` | Show only this profile’s runs: the same boxes that [`box profile clean`](#box-profile-clean) removes for it. For a profile file, give the name in its `[profile]` table. |
| `--format json` | Print one JSON array, for a script. Each object has `profile`, `updated`, and `id`. `updated` keeps its nanoseconds. |

```text
PROFILE  UPDATED (UTC)  BOX ID
claude  2026-11-11T21:50:13Z  b-5b8e3d70c92f14ab
claude  2026-11-11T21:50:12Z  b-287e61a2d05c93b7
```

The most recently updated run comes first. The list holds runs that are still going and runs that have finished.

## box runs history

See what the box allowed and denied in a run. Use the box ID that `box run` printed, or find it with [`box runs list`](#box-runs-list).

```sh
box runs history b-5b8e3d70c92f14ab --deny
```

```text
box runs history <box ID> [--deny | --would-deny] [--action <action>] [--resource <text>]
    [--since <time>] [--tail <count>] [--format json]
```

| Flag | What it does |
| --- | --- |
| `--deny` | Show only what the box denied. |
| `--would-deny` | Show only what your policy would deny but the box let through. |
| `--action <action>` | Show one kind of operation, such as `fs:read` or `net:connect`, or `policy` for the policy rows. |
| `--resource <text>` | Show operations whose file or host contains this text, such as `/private` or `github.com`. |
| `--since <time>` | Show operations at or after a time, such as `2026-11-11T12:26:41Z`. |
| `--tail <count>` | Show only the last `count` matches. |
| `--format json` | Print one JSON array, for a script. Each object has `time`, `result`, `enforced`, `action`, `resource`, `rule`, and `reason`. `time` keeps its nanoseconds. |

```text
TIME (UTC)  RESULT  ACTION  RESOURCE  RULE  REASON
2026-11-11T12:26:41Z  deny  fs:read  /private/file  <default-deny>  no permit matched
```

The `RULE` column names the rule that decided, by its `@id` ([Generated policy](/docs/user-guide/box/policies/index.md#generated-policy) lists the ones `box` writes).

The history also has a `policy` row each time the box installs a policy or refuses one, such as when you turn policy off or on, or apply a policy edit. Its `RESULT` is `installed` or `refused`, and its `RESOURCE` is `policy.dw`, or `policy off` while policy is off. While policy is off, the forbids `box` writes for every box still apply, and every other operation is a `permit` by rule `policy_off`.

```text
TIME (UTC)  RESULT  ACTION  RESOURCE  RULE  REASON
2026-11-11T12:30:02Z  installed  policy  policy off  -  -
2026-11-11T12:31:40Z  installed  policy  policy.dw  -  -
```

## box telemetry

Turn usage telemetry on or off. [Usage telemetry](https://github.com/strands-agents/box/blob/28071d0dad40cbd428ffb920adbb1a4920c252b4/CLI_TELEMETRY.md) says what `box` sends.

```sh
box telemetry off
```

```text
box telemetry on | off | status
```

| Command | What it does |
| --- | --- |
| `on` | Send usage telemetry, and save that choice. |
| `off` | Stop sending usage telemetry, and save that choice. |
| `status` | Say whether telemetry is on, and what decided it. |

To turn it off for one shell, such as in CI, set `BOX_TELEMETRY=0` or `DO_NOT_TRACK=1`.

## box help agent

Give a coding agent on your host the guide it needs to make or change a profile. The guide comes with your installed `box`, and holds the steps for each change, such as adding a tool, an MCP server, or a policy rule, and how to check it. Tell the agent to run the command, then say what you want ([Get help from a coding agent](/docs/user-guide/box/profiles/index.md#get-help-from-a-coding-agent) shows a prompt). It takes no flags:

```console
$ box help agent
Read this file and follow it to create or change a profile:
  /Users/you/.strands/box/packages/0.1.12-aarch64-apple-darwin/resources/editing-box-profile.md

box         0.1.12
box home    /Users/you/.strands/box
profiles    /Users/you/.strands/box/profiles   (claude, work)
packs       /Users/you/.strands/box/packages/0.1.12-aarch64-apple-darwin/resources/packs

For one profile, run: box profile show <name> --full
Run this on the host, not in a box. A boxed agent cannot change a profile.
```

It works before you have a profile, and `box --help` tells a coding agent to run it first. Run the agent on your host, not in a box. The guide and your profiles are outside your project, so an agent that asks before it reads or edits a file there asks for them: allow it `~/.strands/box`, and the guide’s folder if that’s outside `~/.strands/box`.

## Environment variables

| Variable | What it does |
| --- | --- |
| `BOX_HOME` | Use another folder in place of `~/.strands/box`, such as to try `box` with no profiles. It takes a full path, and an empty value counts as not set. Without it, `box` refuses a link at `~/.strands` or `~/.strands/box`. Only `installation.toml` and `packages/` stay in `~/.strands/box` ([Where Box keeps its files](/docs/user-guide/box/reference/files/index.md)). |
| `BOX_TELEMETRY`, `DO_NOT_TRACK` | Turn usage telemetry off for one shell, with `BOX_TELEMETRY=0` or `DO_NOT_TRACK=1`. |
| `BOX_TEST_TELEMETRY_ENDPOINT` | Developer capture: send usage telemetry to an HTTP URL with a literal loopback address and no credentials. Invalid values, including empty or non-UTF-8 values, disable delivery. Consent still applies. See [local capture](https://github.com/strands-agents/box/blob/28071d0dad40cbd428ffb920adbb1a4920c252b4/docs/dev/manual-testing.md#check-telemetry-delivery). |
| `NO_COLOR` | Turn off color in the output of `box`. |
| `CREDSD_SOCKET` | The socket of the credentials daemon, for a `credsd://` route ([Where the box finds the daemon](/docs/user-guide/box/credentials/index.md#where-the-box-finds-the-daemon)). |
| `BOX_RESOURCES` | Use the packs, plugins, starters, policy starters, and agent guide in another folder in place of the ones that come with `box`. |

The model key’s variable is the one `box profile create` named. The installer reads its own variables, listed in [Installer variables](/docs/user-guide/box/install/index.md#installer-variables).

## Exit status

| Status | When |
| --- | --- |
| `0` | The command succeeded. |
| `1` | An error. An error from `box` starts with `box: error:`, and one that stops a box as it starts is a Box message with the severity `error`, such as `strands-box: error[<code>]:`. Box’s [message codes](/docs/user-guide/box/reference/message-codes/index.md) explain each code. Most name their own fix. For the rest, see [Troubleshooting](/docs/user-guide/box/troubleshooting/index.md). `box runs history` also exits with `1` when it can’t read a line of the run’s log, after it shows the rest. |
| `2` | The command line is wrong, such as an unknown flag. |
| `130` | You pressed Ctrl+C at a prompt. |

`box run` exits with the agent’s status.