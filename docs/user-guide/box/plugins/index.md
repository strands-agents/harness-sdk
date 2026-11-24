A plugin lets the box read a secret, such as an API token, from your password manager when it starts. You list the plugin in your profile and name the secret on a route. The agent never sees the secret: it gets a placeholder, and the box puts the real value on each request that your policy allows.

This page explains what a plugin is, how to use one, and how to write one. Every key a plugin can hold, and every rule a plugin follows, is in the [plugin reference](/docs/user-guide/box/reference/plugins/index.md).

## What a plugin is

A plugin is not a pack. Every program a pack names runs inside the box. A plugin names a program, such as 1Password’s `op`, that runs on your machine, outside the box, with your own sign-in. So a plugin follows stricter rules than a pack, and only your profile can list one ([Rules](/docs/user-guide/box/reference/plugins/index.md#rules)).

## Where plugins are defined

A profile lists a plugin in `plugins`. `@box/<name>` is a plugin that ships with `box`, and a plain name is a folder in `~/.strands/box/plugins/`, so `~/.strands/box/plugins/op-service/plugin.toml` is the plugin `op-service`. A plugin that a team shares is in the `plugins/` folder of a [collection](/docs/user-guide/box/reference/files/index.md#collections), and `@<scope>/<name>` names it, such as `@acme/vault` for `~/.strands/box/external/acme/plugins/vault/`. `box` ships two plugins, and [Plugins](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/docs/cli/README.md#plugins) lists them.

## Use a plugin

List the plugin, and name the secret on a route:

```toml
plugins = ["@box/1password"]

[egress.github]
destinations = ["api.github.com"]
secret.ref = "op://Personal/GitHub/token"
secret.env = "GH_TOKEN"
```

`secret.ref` names the item in your vault, and `secret.env` names the variable that holds the placeholder in the box, here `GH_TOKEN`. You don’t set `GH_TOKEN` yourself, because the box reads the secret with the plugin’s program.

To read a pack’s key from your vault, set it on the pack’s route in your profile, with the variable the agent reads:

```toml
[egress.anthropic.secret]
ref = "op://Private/Anthropic/credential"
env = "ANTHROPIC_API_KEY"
```

## What is in a plugin

A plugin is a `plugin.toml` in a folder of its own. Yours go in `~/.strands/box/plugins/<name>/`, and a profile lists one by its folder name. It looks like an agent pack, because it also runs one program. This plugin, `~/.strands/box/plugins/op-service/plugin.toml`, reads `op://` references with a 1Password service account token only:

```toml
[plugin]
name    = "op-service"
version = 1
kind    = "secret-source"
scheme  = "op"                  # this plugin reads each op:// reference

[inputs.onepassword.path]       # the program, which box finds on your PATH
description = "The 1Password command-line program."
type        = "program"
program     = "op"

[run]                           # how the box runs the program for one reference
command = ["${{ inputs.onepassword.path }}", "read", "op://{ref}"]

[env]                           # the variables of your shell that the program gets
OP_SERVICE_ACCOUNT_TOKEN = { from = "env:OP_SERVICE_ACCOUNT_TOKEN" }

[protect]                       # what the box keeps from the agent
env   = ["OP_SERVICE_ACCOUNT_TOKEN"]
paths = ["${{ home }}/.config/op"]
```

Compare it with the shipped [`@box/1password`](https://github.com/strands-agents/box/blob/cfff47d5824aaa8de76c93011680f278de5e696b/resources/plugins/1password/plugin.toml).

The program runs on your machine, outside the box. So a plugin’s `[env]` goes to that program and never to the agent, and its `[protect]` says what the box keeps from the agent. The [plugin reference](/docs/user-guide/box/reference/plugins/index.md) lists each key.

## The program: `[inputs]` and `[run]`

```toml
[inputs.onepassword.path]
type    = "program"             # box finds `op` and writes its full path
program = "op"

[run]
command = ["${{ inputs.onepassword.path }}", "read", "op://{ref}"]   # {ref} is the reference after op://
```

`[inputs]` declares the program, as an agent pack declares its agent, and the first element of `command` is that input. The box runs the command for each secret that the profile names, such as on a route, with the part of the reference after `op://` in place of `{ref}`, and reads the secret from what the program prints.

-   **Use another copy of the program.** Set the input in your profile, such as `onepassword.path = "/opt/homebrew/bin/op"` under `[options]`.
-   **Read a program that prints JSON.** Add `output = "json"` to `[run]`.

## The variables of your shell: `[env]`

```toml
[env]
OP_ACCOUNT               = { from = "env:OP_ACCOUNT" }                # a setting
OP_SERVICE_ACCOUNT_TOKEN = { from = "env:OP_SERVICE_ACCOUNT_TOKEN" }  # a credential of the vault
```

The program gets the variables that `[env]` names, when your shell sets them, and your `HOME`. Each entry passes one variable under its own name.

## What the box keeps from the agent: `[protect]`

```toml
[protect]
env   = ["OP_SERVICE_ACCOUNT_TOKEN"]                                         # the credentials of the vault
paths = ["${{ home }}/.config/op",                                           # where the vault keeps its sign-in
         "${{ home }}/Library/Group Containers/2BUA8C4S2C.com.1password"]
```

`[protect]` grants nothing. It names what the box keeps from the agent, its tools, and its MCP servers:

-   **A credential of the vault.** List each variable of `[env]` that signs in to the vault in `env`. Then the box stops a pack or a profile that tries to give it to the agent ([`env`](/docs/user-guide/box/reference/plugins/index.md#protect)).
-   **The files of the vault.** List where your vault keeps its sign-in in `paths`. The box refuses each grant of the agent, a tool, or an MCP server that reaches one of these paths.

## Commands

[`box profile show <name>`](/docs/user-guide/box/reference/cli/index.md#box-profile-show) lists the options that a profile reads, and the program input of each plugin with the path that `box` found.