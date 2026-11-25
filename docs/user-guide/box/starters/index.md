A starter is the set of questions `box profile create` asks to make a profile, such as which model provider the agent uses and which policy it starts with. Your answers become the profile.

This page explains what a starter is, where it’s defined, and what’s in its file, then shows how to write one, how to write a policy starter for the policy question, and how to make a profile from one. Every key a starter can hold is in the [starter reference](/docs/user-guide/box/reference/starters/index.md).

## What a starter is

A starter names the packs every profile starts with, and asks questions whose answers add more packs and settings. When you make a profile, `box` writes your answers into `profile.toml`, and the profile never refers to the starter again. You edit it like any other profile, and a later change to the starter doesn’t reach it.

A starter can also read answers from the agent’s own settings, so if Claude Code on your machine already uses Bedrock, `box` selects Bedrock for you and still lists every provider.

## Where starters are defined

There are three places a starter can be defined:

1.  **In Box**, for the agents that Box supports. Each is named `@box/<agent>`, such as `@box/claude`, and has the agent’s short name, `claude`.
2.  **In your Box folder**, for a starter of your own. It’s a folder in `~/.strands/box/starters/`, and the folder’s name is the starter’s name, so `~/.strands/box/starters/acme-claude/starter.toml` is the starter `acme-claude`.
3.  **In a collection**, for a starter that a team shares. It’s a folder in the collection’s `starters/`, named with the collection’s scope, such as `@acme/claude` ([Share with a team](#share-with-a-team)).

`box profile create` offers the starters that ship with Box and the ones your collections add, and `[starters]` in `~/.strands/box/config.toml` changes that menu ([Set the starter menu](#set-the-starter-menu)). The policy question offers [policy starters](#policy-starters), which come from Box, a collection, or `~/.strands/box/policies/`.

## What’s in a starter

A starter is a `starter.toml` in its own folder. This one, a short version of `@box/claude`, asks one question and reads its answer from Claude Code’s settings when it can:

```toml
[starter]
name = "@box/claude"
label = "Claude Code"                  # what the agent menu shows
packs = ["@box/claude"]                # every profile from this starter starts with these
ask = ["bedrock.region"]               # an input to ask for even though it has a default

[[source]]
id = "use-bedrock"                     # where Claude Code keeps the setting, in its own order
label = "Provider"
places = [
  { file = "~/.claude/settings.json", kind = "json", key = ["env", "CLAUDE_CODE_USE_BEDROCK"] },
  { env = "CLAUDE_CODE_USE_BEDROCK" },
]

[[question]]
id = "provider"
prompt = "Which model provider should Claude Code use?"

[[question.choice]]
id = "bedrock"
label = "Amazon Bedrock"
packs = ["@box/bedrock"]                     # the packs this answer adds
options = { "claude.host" = "bedrock" }      # and the settings it writes
detect = { source = "use-bedrock", equals = ["1", "true", "yes", "on"] }

[[question.choice]]
id = "anthropic"
label = "The Anthropic API"
packs = ["@box/anthropic"]
options = { "claude.host" = "anthropic" }

[[question.choice]]
id = "subscription"
label = "A Claude subscription"
packs = ["@box/claude-subscription"]
options = { "claude.host" = "anthropic" }
```

A starter holds only `[starter]`, its questions, and the places it reads settings from. What the agent can do in the box belongs in a [pack](/docs/user-guide/box/packs/index.md).

The sections below each show one part of the file.

## Build a team starter

To give your team one standard setup, write a starter that already knows the answers. It needs no questions at all:

~/.strands/box/starters/acme-claude/starter.toml

```toml
[starter]
name = "acme-claude"
label = "Claude Code on Acme's Bedrock"
packs = ["@box/claude", "@box/bedrock", "acme-tools"]   # acme-tools is a pack of your own
policy = "@box/scoped"                                  # answers the policy question

[starter.options]
"claude.host" = "bedrock"
"bedrock.region" = "us-east-1"
"claude.import-mcp" = false       # @box/claude asks about both of these otherwise
"claude.import-hooks" = false
```

Then offer it in `~/.strands/box/config.toml`, with `[starters] add = ["acme-claude"]`. Making a profile from it asks nothing, even with no terminal. It doesn’t get the questions of the `@box/claude` starter: a starter asks only its own questions and the inputs of the packs it picks.

The profile holds those packs and values, plus the default tool packs, and nothing ties it to `acme-claude`. So a later change to the starter reaches only new profiles. A pack of your own, such as `acme-tools`, is what keeps applying: each profile that lists it gets your later changes on its next run. A pack can’t set another pack’s option, such as `bedrock.region`, so a change to an option or the policy goes into each profile by hand.

The `policy` must be one that the [policy menu](#set-the-policy-menu) offers. Leave it out and `box` asks the policy question as usual.

### Share with a team

To give a whole team the same setup, keep its starters, packs, and policies in one [collection](/docs/user-guide/box/reference/files/index.md#collections): a repository that each teammate clones into `~/.strands/box/external/`. The folder’s name is the collection’s scope, so a clone in `external/acme/` gives `@acme/` names.

```text
~/.strands/box/external/acme/      # a clone of the team's repository
  collection.toml                  # optional: what the menus get
  starters/claude/starter.toml     # the starter @acme/claude
  packs/tools/pack.toml            # the pack @acme/tools
  policies/team/                   # the policy starter @acme/team
```

~/.strands/box/external/acme/collection.toml

```toml
[starters]
add = ["@acme/claude"]       # joins the box profile create menu
remove = ["@box/claude"]     # two starters in the menu can't share the name claude

[policy-starters]
add = ["@acme/team"]
default = "@acme/team"       # the policy Enter picks
```

Write every name in a collection in full. The starter’s `name` is `"@acme/claude"`, its `packs` lists `"@acme/tools"`, and its `policy` is `"@acme/team"`. A plain name such as `tools` never reaches a collection: it still means your own folder, else Box.

Then each teammate runs one command:

```sh
git clone https://github.com/acme/acme-box ~/.strands/box/external/acme
```

`box profile create` now offers the team’s starter, and `box profile create claude --with @acme/claude` picks it without the menu. When the team changes `@acme/tools`, a `git pull` in that folder reaches every profile that lists it on its next run. A change to the starter or the policy reaches only new profiles, as for any starter. No box can write to a collection, so make changes to the team’s repository outside a box. [`collection.toml`](/docs/user-guide/box/reference/box-config/index.md#collectiontoml) has every key and says how the menus combine.

Copying single folders into each teammate’s `~/.strands/box/` still works, as in [Build a team starter](#build-a-team-starter).

## Questions

Each question offers choices, and each choice adds packs and can set options. Write a question only when the answer adds a pack:

```toml
[[question]]
id = "github"
prompt = "Let the agent run the GitHub CLI?"

[[question.choice]]
id = "no"                         # a choice with no packs: Enter and a script pick it
label = "No"
packs = []

[[question.choice]]
id = "yes"
label = "Yes"
packs = ["@box/gh"]

[[question]]
id = "proxy"
prompt = "Which Acme proxy should the box use?"
when = { variable = "answers.provider", equals = "bedrock" }   # only after someone picks Bedrock

[[question.choice]]
id = "us"
label = "US proxy"
packs = ["acme-proxy-us"]
```

Any other setting is an [input](/docs/user-guide/box/reference/packs/index.md#inputs) that a pack declares, and `box` asks for it on its own: each input of a chosen pack that has no `default`, has a `warning`, or is named in `ask`, unless `options`, a choice, a detected value, or `--option` already sets it.

To offer a default, add `default = "<choice id>"` to the question. Give each choice its own packs, because `--with` picks a choice by the packs it adds, so `--with claude,bedrock,gh` says yes to the GitHub question.

## Answers from the agent’s settings

A `[[source]]` says where the agent keeps a setting, and a `detect` on a choice says which values pick it, as in the file above. A source can fill an input instead:

```toml
[[source]]
id = "aws-region"
label = "Region"                   # the name in the Detected block of the report
input = "bedrock.region"           # used only when the value fits the input's pattern or values
places = [{ env = "AWS_REGION" }]  # in the order the agent reads them; the first value wins
```

When no choice matches, or two do, `box` asks as usual. A source never reads a variable that a pack uses as a credential, and skips a file that a box could write, such as one in your project or in `~/.strands/box`, because a box could plant a file there to pick a later profile’s provider. It also skips a file under a pack’s `write` grant, but only when the grant is a plain path: [Keep settings files out of a write grant](/docs/user-guide/box/packs/index.md#keep-settings-files-out-of-a-write-grant) covers the rest. The report never prints a value that nothing accepted, because a settings file can hold a key.

## Set the starter menu

The `[starters]` table in `~/.strands/box/config.toml` says which starters `box profile create` offers:

```toml
[starters]
add = ["acme-claude"]      # your starters, after the built-in ones
remove = ["@box/codex"]    # built-in starters to hide
```

Prefer `add` and `remove` to `only`, so a starter that a later `box` adds still shows up. To make `box run claude` use a starter of yours, name it `claude` and put `remove = ["@box/claude"]` beside it. The starters that a [collection](#share-with-a-team) adds are in the menu already, and `remove` can hide one of them too. [`[starters]`](/docs/user-guide/box/reference/box-config/index.md#starters) has every key.

## Policy starters

A policy starter is what the policy question offers: the rules a new profile starts with. Box ships a few, and you can write your own. `box profile create` copies the one you pick into the profile’s `policy.dw`, with a comment at the top that names it, and from then on that copy is the profile’s own file ([Policies](/docs/user-guide/box/policies/index.md) explains what it holds). So a change to a policy starter reaches only the profiles you make after it.

A policy starter is defined in one of three places:

1.  **In Box**, for the ones that Box ships. Each is named `@box/<name>`, such as `@box/scoped`, and lives beside the shipped packs in `~/.strands/box/packages/current/resources/policies/`.
2.  **In your Box folder**, for one of your own. It’s a folder in `~/.strands/box/policies/`, and the folder’s name is the policy’s name, in lowercase letters, digits, and `-`. So `~/.strands/box/policies/team/` is the policy `team`.
3.  **In a collection**, for one that a team shares. It’s a folder in the collection’s `policies/`, named with the collection’s scope, such as `@acme/team` ([Share with a team](#share-with-a-team)).

It’s a folder with two files. `policy.dw` holds the rules, and `policy.toml` says how the menu shows them:

~/.strands/box/policies/team/policy.toml

```toml
[policy]
name = "team"                    # the folder's name
label = "Team hosts"             # what the policy menu and the box profile create report show
description = "Any command, and only the hosts the team's tools use."   # shown beside the label
project = "write"                # the project access a new profile gets: "write", "read", or "none"
```

`project` becomes the new profile’s [`[project] access`](/docs/user-guide/box/reference/profiles/index.md#project-access). [The `[policy]` table](/docs/user-guide/box/reference/starters/index.md#the-policy-table) has every key.

Watch the names. A folder of yours with a shipped policy’s short name, such as `~/.strands/box/policies/open`, takes the plain name `open`, even before it holds a `policy.toml`, and the shipped one is then only `@box/open`. While that folder is incomplete, `open` fails instead of falling back to the shipped policy, so finish or remove the folder, or pick `@box/open`. Keep a policy as real files, too: `box` refuses a symbolic link and a file with more than one hard link.

### Write a custom policy starter

To start every new profile from your team’s rules, write a policy starter of your own. Begin with a copy of the shipped policy closest to what you want. For any command and only the hosts you name, that’s Scoped, which already lets the agent reach its model and its tools’ package hosts: copy the folder `~/.strands/box/packages/current/resources/policies/scoped` to `~/.strands/box/policies/team`. A policy written from an empty file has no rule that lets the shell run commands, so the agent’s shell would run nothing.

Then make the copy’s `policy.toml` describe your policy, and add your rules to the end of `policy.dw`:

~/.strands/box/policies/team/policy.toml

```toml
[policy]
name = "team"          # the copy says "@box/scoped": change it to the folder's name
label = "Team hosts"
description = "Any command, and only the hosts the team's tools use."
project = "write"      # leave it out, and a new profile has no project access until you add it
```

```text
// ~/.strands/box/policies/team/policy.dw: the copied Scoped rules stay above this line.

// Let the agent reach the team's docs: the first rule opens the connection, the second allows
// each request on it.
@id("docs_connect")
permit (principal, action == Box::Action::"net:connect", resource)
when { context.input.host == "docs.example.com" && context.input.port == 443 };

@id("docs_request")
permit (principal, action == Box::Action::"http:request", resource)
when { context.input.host == "docs.example.com" };
```

A rule here works as it does in a profile, and [Write custom rules](/docs/user-guide/box/policies/index.md#write-custom-rules) covers how to write one. A policy starter holds only rules, not a route, so it lets the agent reach a host with these two rules. In a profile, a route does the same job. A profile made from `team` gets a copy of your `policy.dw` as it is that day, with no tie to Scoped or to your folder. To offer it, add it to the policy menu, as the next section shows, and to give it to a team, put it in the team’s collection ([Share with a team](#share-with-a-team)).

### Set the policy menu

The `[policy-starters]` table in `~/.strands/box/config.toml` lists the policies that `box profile create` offers, and the one that Enter picks. Without it, the menu offers the ones that ship with Box and the ones your collections add, and Enter picks `@box/open` unless a collection sets another `default`:

```toml
[policy-starters]
add = ["team"]                 # your policies, after the built-in ones
default = "team"               # the policy Enter picks; it must be in the menu
# remove = ["@box/locked"]     # built-in policies to hide
# only = ["@box/scoped", "team"]   # or the whole menu, in your order, instead of add and remove
```

To offer your policy and make it the default, `add` it and set `default`, as above. Prefer `add` and `remove` to `only`, which sets the whole menu, so a policy that a later `box` adds still shows up. A starter’s `policy` key and the `--policy` flag can pick only a policy in the menu. [`[policy-starters]`](/docs/user-guide/box/reference/box-config/index.md#policy-starters) has every key and what Enter picks without `default`.

## Commands for starters

| To | Run |
| --- | --- |
| Make a profile from a starter | [`box profile create claude`](/docs/user-guide/box/reference/cli/index.md#box-profile-create) |
| Make a profile and start the agent | [`box run claude`](/docs/user-guide/box/reference/cli/index.md#box-run), when no profile has that name yet |
| Change the answers later | [`box profile edit claude`](/docs/user-guide/box/reference/cli/index.md#box-profile-edit) |
| See the starters you can use | [`box profile list`](/docs/user-guide/box/reference/cli/index.md#box-profile-list) |

### Create a profile

```sh
box profile create claude
```

The name is the profile’s name, and because it matches the `claude` starter, that’s the starter it uses. `box` asks one question at a time, under three tabs:

```text
  Create a new profile

  [ Setup ] │   Policy   │   Review

  Which model provider should Claude Code use?

  > [1] Amazon Bedrock

    [2] The Anthropic API

    [3] A Claude subscription

  ↑↓ choose  ←→ questions  Tab sections  Enter  Esc exit  Ctrl+C exit
```

Press Enter to keep the default. The lines that start with `!` under a question say what a yes lets the box do, so read them before you turn a setting on. On **Review**, choose **Save profile**. Then **Before running** names the variable the box reads your key from: set it in the terminal you run `box run` from. When a [plugin](/docs/user-guide/box/plugins/index.md) reads the key from your vault, it says that instead, and it names a plugin’s program that your machine doesn’t have.

To make a second profile from the same starter, pick a new name and pass the starter to `--with`, as in `box profile create claude-east --with claude`. Each agent’s README in [Packs](https://github.com/strands-agents/box/blob/526b5a0cf70e792fb1e5e9ca9b11ba0ed58f3ba6/docs/cli/README.md#packs) says what its starter asks, and any step the agent needs on your machine first.

### Start from the agent’s settings

Before it asks anything, the starter reads the agent’s settings. At a terminal, it still asks each question that they decide, such as the provider, with the found choice selected, so Enter keeps it and every other choice stays in view. It fills an input that they decide, such as the region, without asking. Without a terminal, a found choice is the answer. Review shows each detected answer and where it came from:

```text
DETECTED OPTIONS

Provider  Amazon Bedrock  from env.CLAUDE_CODE_USE_BEDROCK in ~/.claude/settings.json
Region    us-east-2  from env.AWS_REGION in ~/.claude/settings.json
```

Your flags win over what it found, and at a terminal, **Review or change settings** changes a found value for this profile only. `box` reads your settings once, when it makes the profile, so after you change them, run `box profile create claude --force` to pick up the change ([`--force`](/docs/user-guide/box/reference/cli/index.md#box-profile-create) says what it replaces).

### Pick the agent’s policy

The policy question picks the policy starter that a new profile begins with. It sets two things: the rules that `box` copies into the profile’s `policy.dw`, and the profile’s starting [`[project] access`](/docs/user-guide/box/reference/profiles/index.md#project-access). The packs and the profile then build on that start. A route, a tool, an MCP server, a filesystem grant, or storage lets the agent reach more, and a rule or a `deny` entry of yours takes something away ([Policies](/docs/user-guide/box/policies/index.md) explains how they combine). So the policy you pick is where the profile starts, and you change it by editing the profile.

Box ships a few policy starters, and the menu shows each one’s label and description. The [policy starters folder](https://github.com/strands-agents/box/blob/526b5a0cf70e792fb1e5e9ca9b11ba0ed58f3ba6/resources/policies/) holds each one, with a README that lists its rules and its limits. To offer a policy of your own, or make Enter pick another, see [Policy starters](#policy-starters).

The policy question comes after the agent starter’s own questions, and the menu shows each policy’s `label` and `description`. `--policy` names a policy by its folder name, such as `team`, a shipped one by its short name, such as `scoped`, and one from a collection by its full name, such as `@acme/team`. `--policy` picks the policy of a new profile, or of one that `--force` replaces. To move a profile you already have to another policy, see [Switch a profile to another policy](/docs/user-guide/box/policies/index.md#switch-a-profile-to-another-policy).

### Run an agent before it has a profile

In your project, run the agent. If it has no profile yet, `box` asks what `box profile create` asks, writes the same profile, and runs it:

```text
$ cd ~/src/my-app
$ box run claude
box: no profile named claude. Creating one from the claude starter.
```

### Answer the questions without a prompt

Give your answers as flags, and `box` asks only for what’s left. A command that answers everything asks nothing, which is what a script wants:

```sh
box profile create claude --with claude,bedrock --option bedrock.region=us-east-1 --policy scoped
```

`--with` names the starter and the packs that answer its questions, `--option` sets one setting, and `--policy` answers the policy question. Without a terminal, `box` uses each default, and when it still needs an answer, it stops and names the flag to add:

```text
box: error: box profile create claude needs an answer to "Which model provider should Claude Code use?"
  --with bedrock               Amazon Bedrock
  --with anthropic             The Anthropic API
  --with claude-subscription   A Claude subscription
```

The policy question has no default without a terminal, so a script gives `--policy`, unless the starter sets `policy`.