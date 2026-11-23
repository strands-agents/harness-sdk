`~/.strands/box/config.toml` holds the settings that apply to every profile on this computer. You write it by hand, and `box` only reads it. When [`BOX_HOME`](/docs/user-guide/box/reference/cli/index.md#environment-variables) is set, the file is `config.toml` in that folder. This page also covers [`collection.toml`](#collectiontoml), the file that puts a collection’s starters and policies in the menus.

~/.strands/box/config.toml

```toml
[starters]
add = ["acme-claude"]

[policy-starters]
add = ["team"]
default = "team"

[banner]
enabled = false
```

| Table | What it sets |
| --- | --- |
| [`[starters]`](#starters) | Which starters `box profile create` offers. |
| [`[policy-starters]`](#policy-starters) | Which policies `box profile create` offers, and the one that Enter picks. |
| [`[banner]`](#banner) | Whether runs show the activity banner. |

The file holds only these three tables, and `box` refuses any other key. `box run` checks the whole file, even for a profile that already exists, and `box profile create` checks `[starters]` and `[policy-starters]`. So a mistake in a menu stops both, and a mistake in `[banner]` stops the next run. Without the file, the menus hold what ships with Box and what your collections add, and the banner is on.

## `collection.toml`

The file at the top of a [collection](/docs/user-guide/box/reference/files/index.md#collections), such as `~/.strands/box/external/acme/collection.toml`. It says what the collection adds to the menus of `box profile create`. The file is optional: without it, a profile can still name the collection’s packs, plugins, starters, and policies in full, but the menus stay as they are.

The collection’s scope is its folder name, so the file doesn’t name it. Everything in `~/.strands/box/external/acme/` goes by `@acme/<name>`.

~/.strands/box/external/acme/collection.toml

```toml
[starters]
add = ["@acme/claude"]        # external/acme/starters/claude/
remove = ["@box/claude"]      # two starters can't share the short name claude

[policy-starters]
add = ["@acme/team"]          # external/acme/policies/team/
default = "@acme/team"
```

| Key | What it does |
| --- | --- |
| `[starters] add` | The collection’s starters to add to the menu. |
| `[starters] remove` | Starters that ship with Box to hide. |
| `[policy-starters] add` | The collection’s policies to add to the menu. |
| `[policy-starters] remove` | Policies that ship with Box to hide. |
| `[policy-starters] default` | The policy that Enter picks. |

Write every name in full. An `add` name starts with the collection’s own scope, such as `@acme/claude`, and a `remove` name starts with `@box/`. A collection has no `only`, and it can’t hide what another collection adds.

`box profile create` builds each menu in this order: the list that ships with Box, then each collection in the alphabetical order of its folder name, then your own `config.toml`. Each step changes the list that the step before it left, so your `config.toml` wins. Its `remove` can hide a starter or a policy that a collection adds, its `only` replaces the whole menu, and its `default` wins over a collection’s. A `remove` of something that an earlier step already removed changes nothing, so you and a collection can both remove `@box/claude`. When a collection removes the default policy and names no `default`, Enter picks the first policy in the menu. [Share with a team](/docs/user-guide/box/starters/index.md#share-with-a-team) shows a collection in use.

## `[starters]`

The menu of starters that `box profile create` offers. Without it, the menu holds `@box/claude`, `@box/codex`, and `@box/kiro`, as each [collection](#collectiontoml) changes them.

| Key | What it does |
| --- | --- |
| `add` | Your starters, after the ones from Box and your collections. |
| `remove` | Starters from Box or a collection to hide. |
| `only` | The whole menu, in your order. It can’t go with `add` or `remove`. |

`box` uses no starter that isn’t in the menu, even when a flag names it. A starter’s short name is the last part of its name, so `@box/claude` is `claude`, and two starters in the menu can’t share one. [Set the starter menu](/docs/user-guide/box/starters/index.md#set-the-starter-menu) shows how to offer a starter of your own.

## `[policy-starters]`

The menu of policies that `box profile create` offers. Without it, the menu holds the policies that ship with Box ([Pick the agent’s policy](/docs/user-guide/box/starters/index.md#pick-the-agents-policy)), as each [collection](#collectiontoml) changes them, and Enter picks `@box/open`.

| Key | What it does |
| --- | --- |
| `add` | Your policies, after the ones from Box and your collections. |
| `remove` | Policies from Box or a collection to hide. |
| `only` | The whole menu, in your order. It can’t go with `add` or `remove`. |
| `default` | The policy that Enter picks. It must be in the menu. Without it, Enter picks the `default` of the last collection that sets one, else `@box/open`. When `only` or `remove` leaves that policy out, Enter picks the first policy in the menu. |

A plain name, such as `team`, means your policy in `~/.strands/box/policies/` when you have one, else the shipped `@box/<name>`. A policy from a collection always takes its full name, such as `@acme/team`. `box` uses no policy that isn’t in the menu, even when `--policy` or a starter’s `policy` names it. [Set the policy menu](/docs/user-guide/box/starters/index.md#set-the-policy-menu) shows how to offer a policy of your own.

## `[banner]`

Whether runs show the [activity banner](/docs/user-guide/box/reference/cli/index.md#the-activity-banner).

| Key | What it does |
| --- | --- |
| `enabled` | `false` turns the banner off for every profile, and `true` turns it on. |

A profile’s own [`[banner] enabled`](/docs/user-guide/box/profiles/index.md#what-a-profile-holds) wins over this one, and `--banner` or `--no-banner` on [`box run`](/docs/user-guide/box/reference/cli/index.md#box-run) wins over both.