Box reads your settings from two places. Your Box folder, `~/.strands/box`, holds what you use in every project: your profiles, and any packs, starters, and policies of your own. A project can also keep a profile file in source control, so everyone who works on it runs the same setup. Box writes files of its own into `~/.strands/box` too: what each profile keeps between runs, and a record of each run. When [`BOX_HOME`](/docs/user-guide/box/reference/cli/index.md#environment-variables) is set, its folder takes the place of `~/.strands/box` on every page.

Most people edit only their profile. The rest is optional, for when you want to share tools, settings, or rules across profiles or with a team. A team can keep its own in a [collection](#collections), a repository that you clone into `~/.strands/box/external/`.

## Files to customize

| Item | Where it goes | What it’s for |
| --- | --- | --- |
| [A user profile](#user-profiles) | `~/.strands/box/profiles/<name>/` | One agent persona that you run by name in any project, such as `box run claude`. |
| [A project profile](#files-in-the-project) | The project’s `.box` folder, in source control | One setup for everyone who works on that project. |
| [A custom pack](#custom-packs-starters-and-policies) | `~/.strands/box/packs/<name>/` | Tools and settings that several profiles share. |
| [A custom starter](#custom-packs-starters-and-policies) | `~/.strands/box/starters/<name>/` | A ready-made choice in `box profile create`, such as a team’s standard setup. |
| [A custom policy](#custom-packs-starters-and-policies) | `~/.strands/box/policies/<name>/` | The rules that a new profile starts from. |
| [A collection](#collections) | `~/.strands/box/external/<name>/` | A team’s packs, plugins, starters, and policies, kept together in one repository. |
| [The menus and the banner](/docs/user-guide/box/reference/box-config/index.md) | `~/.strands/box/config.toml` | Which starters and policies `box profile create` offers, and whether runs show the activity banner. |

`box profile create` writes a user profile for you. You write everything else by hand, and `box` only reads it. A project keeps only its profile file: the packs that file lists come from Box, from a collection, or from each person’s own `~/.strands/box/packs/`, so a team that writes packs shares them as a collection ([Share with a team](/docs/user-guide/box/starters/index.md#share-with-a-team)).

## User profiles

Each profile that `box` runs by name is stored in `~/.strands/box/profiles/<name>/`. `box profile create` writes it, and after that both of its files are yours to edit. The next run uses each change.

-   `profile.toml` is the profile itself: its packs, your values for their options, and anything you add or take away. [Profiles](/docs/user-guide/box/profiles/index.md) explains what goes in it.
-   `policy.dw` holds the profile’s rules, a copy of the policy picked when the profile was made. An edit to it changes what the profile allows ([Write custom rules](/docs/user-guide/box/policies/index.md#write-custom-rules)). More rule files go beside it, each listed in `policies` in `profile.toml`.

## Files in the project

A project can keep a profile file beside its source, so the setup goes into source control with the code. Put it in the project’s `.box` folder, such as `.box/profile.toml`, with its rule files beside it. The agent can’t change anything in `.box`, and `box` refuses a profile file anywhere else in the project you run in, because the agent could rewrite it. The file looks like a user profile with a `[profile]` table that holds its name ([Where profiles are defined](/docs/user-guide/box/profiles/index.md#where-profiles-are-defined)), and you run it by its path ([Run a profile file](/docs/user-guide/box/reference/cli/index.md#run-a-profile-file)).

The project holds only what you put in `.box`. On Linux, a run also makes an empty `.box` folder when the project has none. Keep `.box` a folder: `box run` stops when it’s a file or a link.

The tools the agent runs still write their own files in the project, such as caches and build output, so add those to the project’s `.gitignore` ([Tools write into the project](/docs/user-guide/box/limitations/index.md#tools-write-into-the-project)).

## Custom packs, starters, and policies

A pack, a plugin, a starter, or a policy of your own is a folder in `~/.strands/box/`, and the folder’s name is its name. Make and edit these folders by hand: `box` reads them and never writes to them.

-   **A pack** is `~/.strands/box/packs/<name>/pack.toml`, with any files it uses beside it. A profile uses it when `<name>` is in its `packs` ([Packs](/docs/user-guide/box/packs/index.md)).
-   **A plugin** is `~/.strands/box/plugins/<name>/plugin.toml`. A profile uses it when `<name>` is in its `plugins` ([Plugins](/docs/user-guide/box/plugins/index.md)).
-   **A starter** is `~/.strands/box/starters/<name>/starter.toml`. `box profile create` offers it when `<name>` is in `[starters]` in `config.toml` ([Starters](/docs/user-guide/box/starters/index.md)).
-   **A policy** is `policy.toml` and `policy.dw` in `~/.strands/box/policies/<name>/`. `box profile create` offers it when `<name>` is in `[policy-starters]` in `config.toml` ([Policy starters](/docs/user-guide/box/starters/index.md#policy-starters)).

A change to a pack reaches every profile that lists it, on its next run. A starter and a policy are different: a new profile gets a copy of their answers and rules, and nothing ties it to them afterwards. So a later change to a starter or a policy reaches only the profiles made after it ([Build a team starter](/docs/user-guide/box/starters/index.md#build-a-team-starter)).

## Collections

A collection is a folder of packs, plugins, starters, and policies that a team or a company keeps together in its own repository. Each folder in `~/.strands/box/external/` is one collection, so to add one, clone the repository there:

```sh
git clone https://github.com/acme/acme-box ~/.strands/box/external/acme
```

The folder’s name is the collection’s scope. Everything in `external/acme/` goes by `@acme/<name>`, so a profile lists the pack in `packs/claude/` as `@acme/claude`. Pick a name of lowercase letters, digits, and `-` that doesn’t start with `-` and isn’t `box`. Inside, the collection has the same layout as your own folders, plus an optional `collection.toml`:

```text
~/.strands/box/external/acme/
|-- collection.toml       what the menus get (optional)
|-- packs/
|   `-- claude/           the pack @acme/claude
|       `-- pack.toml
|-- plugins/
|-- starters/
|   `-- claude/           the starter @acme/claude
|       `-- starter.toml
`-- policies/
    `-- team/             the policy @acme/team
        |-- policy.toml
        `-- policy.dw
```

Without `collection.toml`, a profile can still name anything in the collection, but `box profile create` offers nothing new. [`collection.toml`](/docs/user-guide/box/reference/box-config/index.md#collectiontoml) has the keys that put its starters and policies in the menus.

To update a collection, run `git pull` in its folder. Updates follow the same rule as your own folders: a changed pack reaches every profile that lists it on its next run, but a changed starter or policy reaches only the profiles made after it.

Put the clone itself in `external/`, not a link to a checkout somewhere else: `box` refuses a link there, and anything else that isn’t a folder. It skips names that start with `.`. Any other problem with a collection, such as a bad folder name or a mistake in its `collection.toml`, stops every run and `box profile create` until you fix it. Because a collection is inside `~/.strands/box`, each run protects it the way it protects the rest of that folder: no box can change it.

## Menus and banner: `config.toml`

`~/.strands/box/config.toml` is also written by hand. It sets the starter and policy menus of `box profile create`, and whether runs show the activity banner, for every profile. [Box config reference](/docs/user-guide/box/reference/box-config/index.md) has each table and key.

## Profile storage and runs

Each profile has a storage folder, `~/.strands/box/storage/<profile>/default/`. The agent keeps its settings and sessions in its `agent/` folder there between runs. Every project the profile runs in shares it, and some agents keep their sign-in there too, so give it the same care as the agent’s own settings folder. The agent can write to the folders in `agent/` and nowhere else in `~/.strands/box`. The rest of the storage folder holds what `box` keeps for the tools and MCP servers the agent runs.

A box in one project can read and change what the profile keeps for every other project, so give a project that needs to stay apart its own profile ([Limitations](/docs/user-guide/box/limitations/index.md#one-profile-is-shared-by-all-projects)). [Instructions, skills, and settings in the box](/docs/user-guide/box/limitations/index.md#instructions-skills-and-settings-in-the-box) says which of your files come into storage, and when.

Each run has a folder in `~/.strands/box/r/`, named by its box ID, such as `b-5b8e3d70c92f14ab`. It holds the settings and rules the run used (`box.toml` and `policy.dw`), a record of what the box allowed and stopped (`records.jsonl`), and the box’s own state. The box ID lets you [run in the same box again](/docs/user-guide/box/reference/cli/index.md#run-in-the-same-box-again).

[Terminal runs](/docs/user-guide/box/reference/cli/index.md#box-run) append the Box messages they receive, including warnings, to `box.log`. Only your account can read it, and it has no size limit. The agent’s output stays on the terminal.

A new run that fails before the box starts leaves no folder. Every other run folder stays until you clean it up, and storage stays until you delete it.

Two more items in `~/.strands/box` need no edits. `installation.toml` holds the choice made with `box telemetry` and the random ID that [usage telemetry](https://github.com/strands-agents/box/blob/4bdcea8013143a36a34cd23f6565fd1f8dc18b1f/CLI_TELEMETRY.md) sends. `packages/` holds each release that [the installer](/docs/user-guide/box/install/index.md#what-the-installer-adds) put on this computer. [Upgrade or choose a version](/docs/user-guide/box/install/index.md#upgrade-or-choose-a-version) says which old releases you can delete.

## Deleting files

-   **A run folder** is safe to delete once the run has finished. After that, its box ID no longer works.
-   **A storage folder** comes back on the next run, but the agent starts over. It loses its settings and sessions, and it may need a new sign-in. `box profile reset` deletes it.
-   **A profile folder** is gone for good once deleted, and so are your edits to it. Its storage and runs stay until you delete them too. `box profile delete` deletes all three together.
-   **`editing-box-profile.md`** in `~/.strands/box` is from an older `box`. `box` no longer uses it, so it’s safe to delete.

The [commands](#commands-for-box-files) below remove runs and profiles for you, and ask first.

## Moving to another computer

To move to another computer, copy these from `~/.strands/box` to the same place on the new one:

-   `profiles/`
-   `packs/`, `plugins/`, `starters/`, and `policies/`, if they exist
-   `config.toml`, if it exists
-   `external/`, if it exists, or clone each collection into `~/.strands/box/external/` again

Then install Box and the agents that the profiles use. A profile made with `box profile create` has no paths tied to the old computer. A full path you added by hand, such as a folder outside the project, has to exist on the new computer. A copy of `storage/` keeps each agent’s settings and sessions. Leave `r/`, `installation.toml`, and `packages/` behind. If usage telemetry is off, run `box telemetry off` on the new computer too.

## Commands for Box files

| To | Run |
| --- | --- |
| Make a user profile | [`box profile create`](/docs/user-guide/box/reference/cli/index.md#box-profile-create) |
| Change the answers in a profile, and keep your other edits | [`box profile edit`](/docs/user-guide/box/reference/cli/index.md#box-profile-edit) |
| See a profile’s storage folder, and what a run will get | [`box profile show`](/docs/user-guide/box/reference/cli/index.md#box-profile-show) |
| List your profiles and the starters you can make one from | [`box profile list`](/docs/user-guide/box/reference/cli/index.md#box-profile-list) |
| Find a run’s box ID | [`box runs list`](/docs/user-guide/box/reference/cli/index.md#box-runs-list) |
| Read what a run allowed and stopped | [`box runs history`](/docs/user-guide/box/reference/cli/index.md#box-runs-history) |
| Remove the runs of a profile, or every run | [`box profile clean`](/docs/user-guide/box/reference/cli/index.md#box-profile-clean) |
| Start a profile’s agent fresh, without its settings and sessions | [`box profile reset`](/docs/user-guide/box/reference/cli/index.md#box-profile-reset) |
| Delete a profile, with its runs and storage | [`box profile delete`](/docs/user-guide/box/reference/cli/index.md#box-profile-delete) |
| Turn usage telemetry on or off | [`box telemetry`](/docs/user-guide/box/reference/cli/index.md#box-telemetry) |

[The command reference](/docs/user-guide/box/reference/cli/index.md) has every command and flag.

## Folder layout

The whole of `~/.strands/box`, with one of each item:

```text
~/.strands/box/
|-- config.toml                     the starter and policy menus, and the banner
|-- installation.toml
|-- profiles/
|   `-- claude/                     one user profile
|       |-- profile.toml
|       `-- policy.dw
|-- packs/
|   `-- my-team/                    a custom pack
|       `-- pack.toml
|-- plugins/
|   `-- my-vault/                   a plugin you wrote
|       `-- plugin.toml
|-- starters/
|   `-- acme-claude/                a custom starter
|       `-- starter.toml
|-- policies/
|   `-- team/                       a custom policy, for new profiles
|       |-- policy.toml
|       `-- policy.dw
|-- external/
|   `-- acme/                       a collection, cloned from a team's repository
|-- storage/
|   `-- claude/
|       `-- default/                what the claude profile keeps between runs
|-- r/
|   `-- b-5b8e3d70c92f14ab/         one run
`-- packages/                       the installed releases
```

And a project that keeps its own profile:

```text
~/src/my-app/
`-- .box/
    |-- profile.toml                a project profile, in source control
    `-- policy.dw
```