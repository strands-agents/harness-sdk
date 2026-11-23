This page lists every key that a `starter.toml` and a policy starter’s `policy.toml` can hold, and what each one does. To write a starter or a policy starter, or make a profile from one, start with [Starters](/docs/user-guide/box/starters/index.md). The menus that offer them are in [Box config reference](/docs/user-guide/box/reference/box-config/index.md).

| Item | Where | What it’s for |
| --- | --- | --- |
| [The `starter.toml` keys](#the-startertoml-keys) | `starter.toml` | A starter’s packs, settings, questions, and the places it reads answers from. |
| [The `[policy]` table](#the-policy-table) | `policy.toml` | How a policy starter shows in the policy menu, and the project access a new profile gets. |

## The `starter.toml` keys

A key marked required must be there, and `box` refuses a starter with a key that isn’t in this table. A pack name without `@box/` means your pack in `~/.strands/box/packs/` when you have one, else the pack that Box ships. A name with another scope, such as `@acme/tools`, is a pack in the [collection](/docs/user-guide/box/reference/files/index.md#collections) in `~/.strands/box/external/acme/`.

| Key | Where | What it does |
| --- | --- | --- |
| `name` | `[starter]` | Required. The starter’s name, which is its folder name in `~/.strands/box/starters/`, or `@<scope>/<folder>` for a starter in a [collection](/docs/user-guide/box/reference/files/index.md#collections)’s `starters/` folder, such as `@acme/claude` for `~/.strands/box/external/acme/starters/claude/`. |
| `label` | `[starter]` | Required. What the agent menu, `box profile list`, and the hint for a missing profile show. |
| `packs` | `[starter]` | Required. The packs every profile starts with, as a list of pack names. Each must exist. A starter can add a tool pack here, but it can’t leave out a default tool pack: `--tools` picks the tools. |
| `options` | `[starter]` | The settings every profile starts with: a table of input names and values (a string, a number, or `true` or `false`). `box profile create` refuses a name that no pack in the profile declares, and `--option` replaces a value. |
| `ask` | `[starter]` | Inputs to ask for even though they have a `default`, as `<namespace>.<key>` names. An entry that no chosen pack declares is skipped. |
| `policy` | `[starter]` | The policy that answers the policy question, such as `@box/scoped` or `team`. It must be in the [policy menu](/docs/user-guide/box/reference/box-config/index.md#policy-starters), so with `only = ["@box/scoped"]` a starter that sets `@box/open` is refused. `--policy` replaces it. |
| `id` | `[[question]]` | Required. The question’s name, unique in the file. |
| `prompt` | `[[question]]` | Required. The question that `box` asks. |
| `default` | `[[question]]` | The `id` of the choice that Enter and a script pick. Without it, they pick the choice with no packs, if there is one. |
| `when` | `[[question]]` | `{ variable = "answers.<question id>", equals = "<choice id>" }`: ask only when that earlier question got that choice. `equals` must be one of its choice IDs, so a typo can’t hide the question. |
| `id` | `[[question.choice]]` | Required. The choice’s name, unique in its question. `default` and `when` name it. |
| `label` | `[[question.choice]]` | What the menu shows. Without it, the menu shows the `id`. |
| `packs` | `[[question.choice]]` | Required. The packs this choice adds. Two choices in one question can’t add the same pack. `[]` is the choice with no packs: a question can have one, and it sets no `options`. A question needs two choices, or one choice that adds a pack. |
| `options` | `[[question.choice]]` | Settings this choice adds, as in `[starter] options`. |
| `detect` | `[[question.choice]]` | `{ source = "<source id>", equals = "<value>" }`, where `equals` can also be a list: pick this choice when the source gives one of the values. A number or `true` matches as its text, such as `"1"`. The source can’t have `pack`. |
| `id` | `[[source]]` | Required. The source’s name, unique in the file. |
| `label` | `[[source]]` | The name in the `Detected` block. Without it, the block shows the `id`. |
| `places` | `[[source]]` | Required. A list of places, in the order the agent reads them. The first that holds a value wins. An empty string, a missing file, or a missing key gives no value. |
| `input` | `[[source]]` | The input this source fills, instead of picking a choice. The input is a `string` with `pattern` or `values`, or a `bool`. A source without `input` is for a choice’s `detect`. |
| `pack` | `[[source]]` | With `input` only. Use the value only when the profile has this pack or your own pack in its place, for two packs that read one setting from different places. Must exist, as in `[starter] packs`. |
| `equals` | `[[source]]` | With a `bool` input only, and required there: a value or a list of values. The input is `true` when the source gives one of them, and `false` when it gives any other. |
| `file` | A place | A JSON or TOML file to read, as an absolute path or one that starts with `~/`, with no placeholder. Needs `kind` and `key`. |
| `kind` | A place | With `file`: `json` or `toml`. |
| `key` | A place | With `file`: the path to the value in the file, as a list of keys, such as `["env", "AWS_REGION"]`. |
| `directory-env` | A place | With `file`: read the file from the folder in this variable instead. When the variable is unset or empty, `box` reads the folder in `file`. A relative folder, or one a box can write, is skipped with a reason. |
| `env` | A place | An environment variable to read. A place has `file` or `env`, not both. |
| `when` | A place | `macos` or `linux`: read this place only on that system. |

A source refuses a variable that a pack uses as a credential, such as `AWS_BEARER_TOKEN_BEDROCK`, with an error that names it. It skips a file a box can write, such as one in your project or in `~/.strands/box`, and the `Detected` block says why. It skips a file under a pack’s write grant only when `box` understands the grant before create ([Keep settings files out of a write grant](/docs/user-guide/box/packs/index.md#keep-settings-files-out-of-a-write-grant)). Running `box profile create` from your home folder doesn’t make it a project folder. When you edit a profile that lists a [plugin](/docs/user-guide/box/plugins/index.md), a file in a folder that the plugin keeps on your machine, such as `~/.config/op`, is skipped too, and the `Detected` block says why.

A starter’s folder, and each file in it, must be a real folder and real files: `box` refuses a link at `~/.strands/box/starters/`, at a folder in it, or at a file in that folder.

## The `[policy]` table

A policy starter’s `policy.toml` holds only `[policy]`, and `box` refuses any key that isn’t in this table. The rules themselves are in `policy.dw` beside it.

~/.strands/box/policies/team/policy.toml

```toml
[policy]
name = "team"
label = "Team hosts"
description = "Any command, and only the hosts the team's tools use."
project = "write"
```

| Key | What it does |
| --- | --- |
| `name` | Required. The folder’s name, such as `team` for `~/.strands/box/policies/team/`. A shipped policy’s is `@box/<name>`, and one in a [collection](/docs/user-guide/box/reference/files/index.md#collections)’s `policies/` folder is `@<scope>/<folder>`, such as `@acme/team` for `~/.strands/box/external/acme/policies/team/`. |
| `label` | Required. What the policy menu and the `box profile create` report show. |
| `description` | Required. What the policy menu shows beside the label. |
| `project` | The [`[project] access`](/docs/user-guide/box/profiles/index.md#project-access) that a profile made from this policy gets: `"write"`, `"read"`, or `"none"`. Without it, the profile gets no `[project]` table, so the agent can’t reach your project until you add one. |

[Starters](https://github.com/strands-agents/box/blob/7c4ea75ff509e54298e8a077f6c8e0dae1e8e216/docs/design/cli/starters.md) and [Detection](https://github.com/strands-agents/box/blob/7c4ea75ff509e54298e8a077f6c8e0dae1e8e216/docs/design/cli/detection.md) explain how `box` reads a starter and answers its questions, for background.