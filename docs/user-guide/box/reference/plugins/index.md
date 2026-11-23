This page lists every key that a `plugin.toml` can hold, and the rules for plugins. To use or write a plugin, start with [Plugins](/docs/user-guide/box/plugins/index.md).

A plugin looks like an agent pack, with two differences. Its `[env]` is the program’s: it goes to the plugin’s program on your machine, and never to the agent ([`[env]`](#env)). Its `[protect]` says what the box keeps from the agent, each tool, and each MCP server: the credentials of your vault, and the paths where it keeps its sign-in ([`[protect]`](#protect)).

```toml
[plugin]
name    = "1password"
version = 1
kind    = "secret-source"
scheme  = "op"

[inputs.onepassword.path]
type    = "program"
program = "op"

[run]
command = ["${{ inputs.onepassword.path }}", "read", "op://{ref}"]

[env]
OP_ACCOUNT               = { from = "env:OP_ACCOUNT" }
OP_SERVICE_ACCOUNT_TOKEN = { from = "env:OP_SERVICE_ACCOUNT_TOKEN" }

[protect]
env   = ["OP_SERVICE_ACCOUNT_TOKEN"]
paths = ["${{ home }}/.config/op"]
```

## What a plugin holds

A plugin is a `plugin.toml` in a folder of its own. Every key is in a table, the file starts with `[plugin]`, and `box` stops at any other table.

| Key | What it holds |
| --- | --- |
| `[plugin]` | The [header](#plugin): name, version, kind, and the scheme of the references that the plugin reads. Required, and first. |
| `[inputs.<name>]` | The [inputs](#inputs) of the plugin. One of them is its program. |
| `[run]` | The [program and its arguments](#run), and how the box reads what the program prints. Required. |
| `[env]` | The [variables of your shell](#env) that the program gets. |
| `[protect]` | What the box [keeps from the agent](#protect): the credentials of your vault, and the paths where it keeps its sign-in. |

`box` checks the shape of the file. Box checks what a source may hold when the box starts, and its message names other keys ([A message from Box Core](#a-message-from-box-core)).

## `[plugin]`

`[plugin]` comes first, with the keys of [`[pack]`](/docs/user-guide/box/packs/index.md#pack): `name` and `version`. A plugin can also hold [`[requires]`](/docs/user-guide/box/profiles/index.md#requires), as a pack can.

| Key | What it holds |
| --- | --- |
| `kind` | `"secret-source"`, the one kind of plugin. |
| `scheme` | The part of a reference before `://`, such as `op` for `op://Personal/GitHub/token`. |

## Inputs

`[inputs]` declares the program, as an agent pack declares its agent. `box` finds the program as it finds any `program` input ([Inputs](/docs/user-guide/box/packs/index.md#inputs)): on your `PATH`, in the folders of its `search`, or at its `default`, and writes its full path into the command. To use another copy, set the input in your profile, such as `onepassword.path = "/opt/homebrew/bin/op"` under `[options]`. The program passes the checks of an agent’s program, so it can’t be in your project, in storage, or in `~/.strands/box`, and the agent can’t write its folder. When the program is a script, the agent can’t write the folder of its `#!` interpreter either. A path that the plugin passes to its program, such as a script in the plugin’s own folder or a settings folder, follows the same rules, also when nothing is there yet, and a folder that it passes can’t hold a folder that the agent can write. So keep each one outside `~/.strands/box`. `box` checks each argument as the plugin writes it, with `{ref}` as plain text, so it doesn’t check the path that a reference completes. For `/Users/you/secrets/{ref}`, it stops the run when the agent can write `/Users/you/secrets`, but not when the agent can write a folder in it, such as `/Users/you/secrets/team`. Keep each path that a reference can name outside every folder the agent can write.

`[run] command`, and each `default` and `search` in the plugin’s `[inputs]`, reads only the plugin’s own inputs, and a second plugin that declares one of them stops the run.

`box profile show` lists the program input with the path it found, and a `source` line that names the program the box runs for each scheme.

## `[run]`

How the box starts the program for each reference in the plugin’s scheme. The program runs on your machine, outside the box, when the box starts.

```toml
[run]
command = ["${{ inputs.aws-secrets-manager.path }}", "secretsmanager", "get-secret-value", "--secret-id", "{ref}", "--query", "SecretString", "--output", "json"]
output  = "json"
```

| Key | What it holds |
| --- | --- |
| `command` | The program, then its arguments, each as a string. The first element must be the program input, such as `${{ inputs.onepassword.path }}`, and any other input in `command` needs a `pattern` or `values`. The box replaces `{ref}` in an argument with the part of the reference after `scheme://`, without a `#FIELD` at its end. |
| `output` | How the box reads what the program prints: `text`, the default, or `json`, where the program prints one JSON string. |

A plugin’s `[run]` takes no other key, and no element of `command` takes a `when`.

## `[env]`

Each variable of your shell that the program gets when it is set. The program gets nothing else from your shell, except your `HOME` and a fixed `PATH`.

```toml
[env]
AWS_REGION        = { from = "env:AWS_REGION" }
AWS_ACCESS_KEY_ID = { from = "env:AWS_ACCESS_KEY_ID" }
```

| Key | What it holds |
| --- | --- |
| The name | The variable: letters, digits, and `_`. A name takes no `*`, so each entry names one variable. |
| `from` | `env:` and the same name. The program gets the variable under its own name, so an entry can’t rename a variable or set a value. |

An entry takes no other key, such as `when`, `value`, or `default`. A variable here is a plain setting, such as `AWS_REGION`, and a pack or your profile can also give it to the agent, unless [`[protect] env`](#protect) names it.

## `[protect]`

What the box keeps from the agent, each tool, and each MCP server. `[protect]` grants nothing: the program runs outside the box and needs no grant.

```toml
[protect]
env   = ["OP_SERVICE_ACCOUNT_TOKEN", "OP_CONNECT_TOKEN"]
paths = ["${{ home }}/.config/op", "${{ home }}/.op",
         "${{ home }}/Library/Group Containers/2BUA8C4S2C.com.1password"]
```

| Key | What it holds |
| --- | --- |
| `env` | The variables of `[env]` that are credentials of your vault, such as `OP_SERVICE_ACCOUNT_TOKEN`, as a list of names. Only the program gets one: an input or an `env` entry of a pack or your profile that reads it stops the run, and `box` leaves out an MCP server of your agent that reads or sets it, so the agent doesn’t get it, except in the cases that [MCP servers in the box](/docs/user-guide/box/limitations/index.md#mcp-servers-in-the-box) names. Each name is a key of this plugin’s `[env]`, because the box can keep back only a variable that the program gets. |
| `paths` | The paths where your vault keeps its sign-in, such as the settings folder of the program and the folder of a sign-in socket, as a list. The box refuses each grant that reaches one. The grant lists are the lists of a `filesystem` table of a pack or a profile other than `deny` and `deny_write`, such as `read` and `write`. |

On Linux, the box closes a path only when it exists as the box starts, and it prints a line for each path that doesn’t, which Box’s [What Box protects](/docs/user-guide/box/reference/configuration/index.md#what-box-protects) shows.

The paths that a plugin names here, such as `~/.config/op`, stay on your machine too. A `[[storage.files]]` row whose `source` is one of them, lies in one, or holds one, such as `~/.config`, stops the run, even through a link. `box` leaves out an MCP server of your agent whose program or interpreter lies in one of them, and drops a server’s CA file setting that names a file there.

Each entry of `paths` is a string that names one path: `${{ home }}/...`, `~/...`, or a full path. It takes no other placeholder, and no `when` or `optional`. A plugin holds no `[filesystem]` table, because it grants nothing. The box’s shell and Python follow your policy, not this list, so a policy rule that permits a read of one of these paths lets the agent read it through them. Box’s [What Box protects](/docs/user-guide/box/reference/configuration/index.md#what-box-protects) shows the rule to write.

## A message from Box Core

`box` writes a plugin into the run’s configuration as one `[secret-source.<scheme>]` table, with the real path of the program. Box reads that table when the box starts, and it checks what a source may hold: the scheme, the `{ref}` in `command`, the value of `output`, each name in `[env]`, and each path. So a message from Box names that table and its keys, not the keys of your plugin:

| In the message | In your plugin |
| --- | --- |
| `[secret-source.<scheme>]` | The plugin whose `[plugin] scheme` is `<scheme>` |
| `command` | `[run] command` |
| `output` | `[run] output` |
| `pass-env` | An `[env]` entry |
| `pass-secret-env` | An `[env]` entry that `[protect] env` names |
| `deny` | `[protect] paths` |

A plugin’s paths all go to `deny`. A [source of your own](/docs/user-guide/box/profiles/index.md#what-a-profile-holds) in a profile can also hold `reads`, which Box protects the same way.

Box’s [`[secret-source.<scheme>]` reference](/docs/user-guide/box/reference/configuration/index.md#secret-sourcescheme) lists what each key may hold.

## Rules

A plugin names a program that runs on your machine, outside the box, with your own sign-in. So a plugin follows stricter rules than a pack:

-   Only your profile lists a plugin, in `plugins`. A pack can’t pull one in with `extend` or `include`, and `packs` refuses one.
-   Only a plugin, or your profile itself, declares a secret source. A pack can’t. A source in your profile is a [`[secret-source.<scheme>]`](/docs/user-guide/box/profiles/index.md#what-a-profile-holds) table.
-   One scheme, such as `op`, comes from one plugin. Two plugins, or a plugin and your profile, that declare the same scheme stop the run.
-   A pack, or a second plugin, can’t declare an input of a plugin, so it can’t choose which program the plugin runs. Your profile sets a plugin’s input in `[options]`.
-   A plugin reads no `${{ root }}` or `${{ tool.<name>.root }}`, the folder of a program that a pack finds.
-   Only your profile names a reference in a plugin’s scheme. A pack that writes one stops the run, so a pack can’t choose which item of your vault the box reads. To read a pack’s key from your vault, set it on the pack’s route in your profile ([Use a plugin](/docs/user-guide/box/plugins/index.md#use-a-plugin)).

Secret sources are experimental in Box Core. `box` turns them on for each run whose profile uses one, or names a `secret.env` on a route or an MCP server.

### A profile file that runs by its path

A profile file that you run by its path ([Run a profile file](/docs/user-guide/box/reference/cli/index.md#run-a-profile-file)) can list a plugin, but it can’t declare a `[secret-source.<scheme>]`, and it can’t set a plugin’s `program` input in `[options]`, such as `onepassword.path`. Either one stops the run. Put such a source in a plugin of your own in `~/.strands/box/plugins/<name>/`, put the plugin’s program where the plugin finds it, such as in a folder that comes first on your `PATH`, or keep the profile in `~/.strands/box/profiles/<name>/`.

Of a plugin’s other inputs, the file can set a `bool`, and an input to a value that the plugin lists in `values`. Any other input stops the run, because a `pattern` limits the form of a value, not what the value names: the folder where the plugin finds its program, or an argument of the program, such as the address of the server that gets your sign-in. So list the `values` of an input that a project sets.

In that file, `${{ profile }}` is the folder of the file, so such a file can’t list a plugin whose `[inputs]` or `[run] command` reads `${{ profile }}` or `${{ profile.file }}`. Write a fixed path in the plugin instead.