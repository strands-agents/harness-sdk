This page says how `box` builds a run’s policy, and lists each rule it writes from your packs and profile. To learn what a policy checks and how to write a rule, start with [Policies](/docs/user-guide/box/policies/index.md).

```sh
box profile show claude --full
```

That command prints the whole policy a run gets, in the order this page describes.

| Item | What it’s for |
| --- | --- |
| [The run’s policy](#the-runs-policy) | How your rule files and the rules `box` writes become one policy. |
| [Generated policy](#generated-policy) | The `@id` of each rule `box` writes, and the setting that makes it. |

## The run’s policy

`box` joins the files in your profile’s `policies` list, in list order, with the rules it writes for the run, into the run’s `policy.dw`.

| Rule | What it means for you |
| --- | --- |
| Placeholders | `box` fills in no placeholder in your files. |
| Paths | A path in your home directory starts with `~/`, such as `~/src/shared-lib`, and the home directory itself is `~`, because that is how the box gives a rule each path. |
| Line numbers | A line number in a policy error counts from the top of the joined file. |
| Order | Rule order decides nothing: a matching `forbid` wins over a `permit`. |
| `@id` | Optional, but the run history names a rule by it, so give each rule one. An `@id` must be unique, and not one that `box` writes. `box profile show` refuses a clash, including one between two of your files, and checks the whole policy as `box run` does. |

## Generated policy

`box` writes these rules on every run, from the settings of your packs and profile. Each ID also shows in the `RULE` column of [`box runs history`](/docs/user-guide/box/reference/cli/index.md#box-runs-history).

| IDs | What they allow or forbid |
| --- | --- |
| `spawn_<tool>`, `tool_<tool>`, `package_hosts_connect`, `package_hosts_request` | Start each tool the run keeps, run each command of a tool with a [grammar](/docs/user-guide/box/packs/index.md#tool-grammars), and reach the tools’ package hosts. |
| `route_<name>_connect`, `route_<name>_request` | Reach each route’s hosts. |
| IDs that start with `mcp_` or `launcher_` | Call, start, or reach each `[mcp.<name>]` server, and reach a launcher’s registry. |
| `storage_<n>_read`, `_write`, `_delete`, `_move` | Use each storage directory, counted from 0. |
| IDs that start with `hook_script_` | Read each [imported hook](/docs/user-guide/box/packs/index.md#import-hooks-storagehooks)’s script. |
| `box_home_write`, `_delete`, `_move`, and `box_home_1_write`, `_delete`, `_move` | Forbid changes to the box home (`~/.strands/box`, or `BOX_HOME` when you set it) outside the run’s storage directories and its tools’ storage. They also cover each launcher cache, so no rule you write lets the box change code that an MCP server runs from it. With `BOX_HOME` set, the `box_home_1_` rules forbid the same on `~/.strands/box`. |
| `resources_write`, `_delete`, `_move`, and `resources_folder_move`, `_delete` | Forbid changes to box’s resources directory, which holds the packs and policy starters, and moving or deleting a folder above it or a link on the way to it. You see them only when the directory or such a link is outside the box home, such as when you set `BOX_RESOURCES`. |
| `protected_<n>_write`, `_delete`, `_move`, and `protected_<n>_folder_move`, `_delete` | Forbid changes to each other protected folder outside the box home, counted from 0: `~/.local/bin`, where `install.sh` puts the `box` command, then the folder `box` runs from when it’s outside the box home, such as a build folder. They also forbid moving or deleting a folder above it. |
| `profile_file_write`, `_delete`, `_move`, and `profile_folder_move`, `_delete` | Forbid changes to the profile’s file and its rule files, and moving or deleting a folder above them, so a box can’t change what a later run reads. |
| `project_read`, `_write`, `_delete`, `_move` | Use your project, as [Project access](/docs/user-guide/box/profiles/index.md#project-access) gives. |
| `project_configuration_write`, `_delete`, `_move` | Forbid changes to `.box` in your project. |
| `deny_write_write_<n>`, `_delete_<n>`, `_move_<n>`, and `deny_write_parent_move_<n>`, `deny_write_parent_delete_<n>` | Forbid the box’s shell and Python to change each folder in `[filesystem] deny_write` and `[agent.filesystem] deny_write`, counted from 0, or to move or delete a folder between it and its write grant. `box` drops a folder that no agent `write` entry holds, with its rules. Policy off turns them off, so the box’s shell and Python can then change a program in the folder that a later run runs. A denial prints the rule’s description, which names `deny_write`. |
| `filesystem_deny_read_<n>`, `_write_<n>`, `_delete_<n>`, `_move_<n>`, and `filesystem_deny_parent_move_<n>`, `filesystem_deny_parent_delete_<n>` | Forbid the box’s shell and Python to read or change each path in `[filesystem] deny`, counted from 0, or to move or delete a folder between it and the agent’s write grant. A denial prints the rule’s description, which names the profile’s `[filesystem] deny`. Policy off turns them off. |
| `policy_off` | Allow every operation while policy is off, except what the `box_home_`, `resources_`, `protected_`, `profile_`, and `project_configuration_` rules forbid. It replaces your rules and every other rule `box` writes until policy is on again, and it isn’t in the run’s `policy.dw`, so `box` can’t refuse a rule of yours with this ID. The `policy` rows of [`box runs history`](/docs/user-guide/box/reference/cli/index.md#box-runs-history), `installed` `policy off` and `installed` `policy.dw`, mark when policy was off. |

[Write custom rules](/docs/user-guide/box/policies/index.md#write-custom-rules) shows how to add a rule.