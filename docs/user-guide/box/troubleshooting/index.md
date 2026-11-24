Use this page when `box` stops with an error, or when the agent can’t do something in the box. Most messages that start with `box: error:` name their own fix, so this page covers the ones that don’t, and the failures that show up after the box starts. Search the page for a few words of your message. The examples use `/Users/you` for your home folder.

This page covers what every [pack](https://github.com/strands-agents/box/blob/2762080a7a4c65fd7e777646a8fd79706aebd66a/docs/cli/README.md#packs) and [plugin](https://github.com/strands-agents/box/blob/2762080a7a4c65fd7e777646a8fd79706aebd66a/docs/cli/README.md#plugins) can hit, such as `@box/claude`, which runs Claude Code. An error that only one pack or plugin prints, and its fix, is in the **Troubleshooting** section of its README, and its own limits are in its **Limitations** section.

## Before the box starts

### The agent isn’t found

```text
box: error: /Users/you/.strands/box/profiles/claude/profile.toml: `agent.command.0`: no `claude` that the box can run in the folders `[inputs.claude.path] search` names; passed over /opt/homebrew/bin/claude (a node script, which the box cannot start). Install it, or set `claude.path` in your profile's `[options]`
```

`box` looks for the agent in the folders its pack lists, and in each folder on your `PATH`. After “passed over”, the message lists each copy `box` found but won’t run, and why. That reason usually points at the fix:

-   `a node script, which the box cannot start`: `npm install` puts the agent on your machine as a Node.js script, but the box needs the agent’s own program. The agent’s README says how to install it.
-   `in the workspace, which a box can write`: the agent is installed inside your project, the folder you ran `box run` in. `box` won’t run a program the agent could replace, so run from a project that doesn’t hold the agent.

With nothing after “names”, `box` found no copy at all. Install the agent and run again. There’s no need to remake the profile, because `box run` looks for the agent each time.

If the agent lives somewhere `box` doesn’t look, name it in your profile, with the option that the message names. In `~/.strands/box/profiles/claude/profile.toml`:

```toml
[options]
claude.path = "/opt/tools/claude/bin/claude"
```

`box` then runs that program and doesn’t look anywhere else. `box profile show claude` prints the program a run uses, and where it came from.

### A run on Linux stops on a `deny` entry

```text
... does not exist yet, and the Linux namespace backend cannot refuse a path that is not there
```

On Linux, a `deny` entry must name a path that exists when the run starts. Create the file or folder first, or deny an existing folder above it. On a Mac, a `deny` entry works for a path that doesn’t exist yet.

### A toolchain is skipped

```text
box: skipped tool npm (@box/npm): it runs node, and node was skipped
```

That’s a note, not an error. The run goes ahead without the toolchain, and most reasons say what to do. These don’t:

-   `it runs node, and node was skipped`: `npm` needs `node` to run. Install Node.js if your machine doesn’t have it. The line for `node` says why it was skipped.
-   `lies in the workspace, which a box can write`: the toolchain is installed inside your project, where the agent could swap it out. Install it outside the project, or take it out of the profile. The same goes for `the run's storage` and `the box home`.
-   `which is the command of no tool table`: the toolchain is a script whose first line names a program that no toolchain in the profile runs, such as an npm from one Node.js install and a `node` from another. Put the two in the same install first on your `PATH`.

To stop the note for a toolchain you don’t need, delete its pack from the `packs` line in `profile.toml`.

### The box can’t check the project for a tool’s other names

Some tools are one file with several names, such as rustup’s `cargo` and `rustc`. Before a run, the box checks that no name of the tool is in your project. On a Mac, and on Linux in Docker or on btrfs, it reads every folder to do that, and if it can’t finish, the run stops:

```text
strands-box: error: `[agent]` filesystem entry "<project>" is refused: this write grant cannot be inspected for configured command hard links: directory inspection failed: Permission denied (os error 13).
```

That happens when a folder in your project is one you can’t read, such as a database folder another user owns, when a folder changes while the box reads it, such as `.git` while your editor runs `git status`, or when the project is too big to read in 30 seconds. Make the folder readable or move it out of the project, or close the program that changes it, and run again. You can also take the tool’s pack off the `packs` line in `profile.toml`.

If the run stops with `contains a hard link to a configured tool command`, delete that file, because the agent could change the tool through it.

### An MCP server has no automatic declaration

```text
box: no automatic MCP declaration for tickets (from ~/.claude.json): runs docker, a launcher that fetches the server when it starts, and box ships no pack that runs it in the box
```

The run goes on. If the server is in your agent’s settings on your machine, it still comes into the box as you wrote it, but it gets only what your profile already grants, so it may fail when the agent uses it. After you fix the cause, the next run declares the server. If you changed the server’s entry itself, the agent keeps the copy it saved until you follow the [refresh steps](#box-lists-an-mcp-server-but-my-agent-doesnt-show-it).

The reason after the colon usually says what to change. These reasons need more:

| The reason says | What to change |
| --- | --- |
| `runs docker, a launcher that fetches the server when it starts`, `runs node, which runs a script or a package rather than an installed server program`, or `runs bash, which the box does not start as a server` | The box starts a server only as a program of its own. Install the server, for example with `npm install -g <package>`, and point the agent’s configuration at the program it installs. |
| `lies in a credential store, which box grants no server` | The server’s program, its interpreter, or its install folder is in a folder that holds credentials, such as `~/.config`, which also holds `~/.config/gcloud`. Install it in a folder that holds none, such as `~/.local/bin`. Moving only a link doesn’t help, because `box` follows the link to the real file. |
| `uses headers`, or `uses <field>` | The field doesn’t fit how the server runs, such as a `url` on a server with a `command`. On a server with a `command`, `uses headers` means a header takes its key from a variable, and `box` can’t give that key to a server on your machine yet. Headers that hold only plain values, such as `"X-Client": "claude"`, are fine. |
| `sets its headers header Authorization to a value that does not end in one variable`, or `passes a variable in its url, which box does not fill in` | The box adds the key in one place only. End the header with one variable, such as `"Bearer ${DOCS_TOKEN}"`, or make the key a whole query value, such as `?api_key=${DOCS_TOKEN}`. |
| `has the same detected command as the server <name>`, or `its argument wildcards overlap with the server <name>` | `box` declares `<name>` and still imports both entries, so both get that server’s permissions and keys. If they need different access, give them different filenames or arguments. |
| ``mixes a literal `*` argument with a variable argument`` | Replace the variable argument with the value the server needs, or remove the `*`. |
| ``the profile's `[mcp.<name>]` does not match its command and arguments`` | Your profile declares the server, but the agent’s entry for it runs another program name or other arguments, so the agent can read the keys in that entry’s `env`. Make your table’s `command` use the entry’s program name and arguments, or take the keys out of the entry, then follow the [refresh steps](#box-lists-an-mcp-server-but-my-agent-doesnt-show-it). |
| `` `[mcp.<name>]` has no `type`, so it adds to a server this run finds `` | Your profile, or the pack the line names, adds to a server that your agent doesn’t have. From a pack, that’s expected. From your profile, fix that server or remove the table. |
| `needs DOCS_TOKEN, which is not set in your environment` | Export the variable in the shell you start `box run` from, or give a local server a default, such as `${LOG_LEVEL:-info}`. |
| `which is not on your PATH outside the project`, `which is not an executable file`, `is a link out of a folder the box can write`, or `its HOME "mcp-home" is not a full path` | Use a real program at a full path, and a full path for `HOME`. The box doesn’t look on `PATH` for a replacement. A server writes a `HOME` outside your project only when you grant that folder in its `[mcp.<name>.filesystem]`. |
| `sets NODE_OPTIONS`, `LD_PRELOAD`, a name that starts with `PYTHON`, `sets PATH`, or `your PATH directory ... lies in the workspace` | Remove the variable from the server’s `env`, and keep project folders off your own `PATH`. These make a program load other code. |
| `sets RUBYLIB to a path that is not a full path`, `sets RUBYLIB, which box reads as a path by its name, to a path that is not a full path`, or `sets RUBYLIB to a place the box can write` | The variable holds a file or a folder, alone or in a list, and the agent could put code there for the server to load. Use a full path to a folder outside your project and outside every folder the box can write. `box` reads a part of a value as a path when it starts with `/`, `./`, `../`, or `~/`. It reads the whole value as a list of paths, with `:` or `;` between them, when the variable’s name ends in `PATH`, `PATHS`, `LIB`, `LIBS`, `DIR`, `DIRS`, or `HOME`, unless the value is a number or a word such as `true`. If the value isn’t a path at all, declare the server yourself, as described below this table. Until you do, the server’s entry stays in the agent’s settings with the keys in its `env`. |
| `reads OP_SERVICE_ACCOUNT_TOKEN, which the plugin @box/1password passes to its program as a credential`, or `takes its key from ...` for a remote server, `its env T holds the value of ...` or `its argument 2 holds the value of ...` for a copy of the value, or `its env sets ...` for a variable that the server sets itself | A [plugin](/docs/user-guide/box/plugins/index.md) in your profile keeps the sign-in of your vault on your machine, so no server in the box gets it. Give the server a token of its own in another variable. |
| ``reads GH_TOKEN, which the route github names in `secret.env` for its op:// key`` | In the box, that variable holds a stand-in, and the box puts the key from your vault on each request to the route’s hosts. Your shell’s own `GH_TOKEN` is not that key. The route refuses a request to its hosts without the stand-in, so a token of the server’s own works only for other hosts. For the route’s hosts, declare the server in your profile as an `[mcp.<name>]` table whose `env` doesn’t set the variable, so the server gets the stand-in as the agent does. |
| `runs <program>, which ... runs too`, or `reaches <host>, which ... reaches too` | The box puts one program of each name on `PATH`, and routes a remote server by its host alone. Remove the duplicate entry. |
| `takes keys from A and B`, or `sends DOCS_TOKEN in more than one place` | The box attaches one key to a remote server, in one place. Give the server one variable, in one header or one query value. |
| `` takes its key from DOCS_TOKEN, which your profile sets in `[agent.env]` `` | The agent would hold the real key. Remove the variable from `[agent.env]`, or give the server a variable of its own. |

When no fix here fits, declare the server yourself: write its `[mcp.<name>]` table in your profile, with its `type`, and a `secret.ref` for an `https://` server’s key. Your table takes the place of the one `box` would write ([`[mcp.<name>]` in a profile](/docs/user-guide/box/reference/profiles/index.md#mcpname-in-a-profile)).

### A program’s installation files can’t be found

```text
installation metadata <file>: <reason>
```

`box` could not find the files a program needs, and the message says `installation metadata` or `installation dependency`. Check the named file or dependency with the package manager that installed the program. Don’t give the program access to the entire Homebrew installation to work around it. If the installation is intact, report the error and the `# installation` comments from `box profile show --full <profile>`, without sharing any environment values in that output.

### An MCP server loses a variable or a `PATH` entry

```text
box: dropped HTTPS_PROXY from MCP server keyed (from ~/.claude.json): the box sets it itself
```

This is a note, and the run goes on without the variable or the `PATH` entry it names. For a proxy setting, the box’s own proxy takes its place. For a `PATH` entry that isn’t a full path, such as `.` or `~/bin`, replace it with the full path where your shell sets it. On a Mac, an entry that starts with `~` often comes from a file in `/etc/paths.d`, such as the one the .NET installer writes.

### The box folder path is too long

```text
its broker socket path exceeds the platform limit
```

Box Core reports this when the full socket path is too long. With the default `~/.strands/box` location, the home path can be at most 52 bytes on macOS and Linux. Set `BOX_HOME` to a shorter absolute folder, then create the profile there. Shortening the profile name does not help.

### A run in an earlier box stops on a clock error

```text
strands-box: error: policy staging failed: policy staging history failure: durable timestamp 1795305600000000000 is 3600000000000 ns ahead of the current clock 1795302000000000000, exceeding the maximum allowed future skew of 300000000000 ns; refusing the operation rather than issuing future-dated timestamps
```

The box’s history is stamped more than five minutes ahead of the clock. This happens after the clock moves back, such as after a clock reset or a restored virtual machine. Box refuses, because a history that looks like the future would let rules that count over time count wrongly.

Most often you see it at the start of a `box run --box-id`, which reuses an earlier box. A run without `--box-id` can meet it too, when the clock moves back while the agent runs and you then apply a policy edit with **Ctrl+Alt+R** or turn policy on or off.

You have two ways out:

-   **Fix the clock.** Set it right, or wait until it is within five minutes of the history. Then run again. A reused box keeps its history. If it happened in a running box, apply the edit again.
-   **Leave the box behind.** Remove it with `box profile clean <name> --box-id <box ID>` and run again without `--box-id`. The new box starts with an empty history, so rules that count over time start from zero. For a box that was running, stop the run first, because `box profile clean` refuses a box that is still running.

### The agent could change what a later run trusts

```text
box: error: the agent could change files that box trusts

  Writable: /Users/you/src/box
  Protected: /Users/you/src/box/target/debug
```

A write grant is a folder the agent can change, and your project is always one. But each run also trusts a few folders to stay as you left them: `~/.strands/box`, the folder where `box` lives, and the packs that come with Box. If a write grant holds one of those, or sits inside one, the agent could change how your next run is set up, so `box` stops.

This usually means you ran `box` from the wrong place, such as the folder you built Box in. Run from your project instead. If you’re already there, `box profile show --full <name>` lists every `write` entry, so you can find the one from your `profile.toml` and remove it or name a narrower folder.

### A program sits in a folder the agent can write

```text
box: error: /Users/you/src/my-app/node_modules/.bin lies under the write grant /Users/you/src/my-app of `[agent]`, so the workload can replace it; to keep it, list /Users/you/src/my-app/node_modules/.bin in your profile's `[filesystem] deny_write`
```

Your profile starts a program from a folder the agent can change, so the agent (the “workload” in the message) could swap in a program of its own. The packs that come with Box never do this, so it’s something you added to `profile.toml`: a `command`, an `exec` entry, or a `PATH` folder in `[agent.env]` that points into your project or another write grant. Point it at a program or folder outside those.

To keep the program where it is, such as a Python `.venv` in your project, list its folder in your profile’s `[filesystem] deny_write`, as [Protect a folder the agent runs from](/docs/user-guide/box/profiles/index.md#protect-a-folder-the-agent-runs-from) shows. If you list it on one process’s own `deny_write` instead, the error names each other process that can still write it, such as `[tool.git]`.

The reverse stops the run too: a folder the box runs programs from that holds a folder the agent can write.

```text
box: error: the `exec` folder /Users/you holds the write grant /Users/you/src/my-app, so the workload can run a file it writes
```

The same check covers a setting in `[options]` that names a program, for a pack of your own that has one. Then the message names the setting and ends `box runs no program from there`, and `box` stops before it runs the program at all. Set it to a program outside your project and outside every `write` folder.

## A profile has a mistake

When `box` can’t use a profile, the message names the file and the line, then what’s wrong:

```text
box: error: /Users/you/.strands/box/profiles/claude/profile.toml:6: `inputs.bedrock.region` = "eu-west" does not match its pattern
```

The `6` is the line to fix. When the mistake is in a pack the profile uses, the message names that pack’s `pack.toml` instead. Some messages name only the file, so look for the setting the message quotes.

`inputs.bedrock.region` is the option you set as `bedrock.region` under `[options]`. A pack declares it, but the bad value is yours.

A mistake in one of your policy files stops the run before the box starts. The message names the combined `policy.dw` and the line in that output, then what Box Core found, and often the name you probably meant. Use the action, field, or rule ID in the message to find the mistake in your listed files; the line number does not refer to an individual source file:

```text
box: error: policy.dw:2: attribute `input.pth` in context for Box::Action::"fs:read" not found; did you mean `path`?
```

When Box Core finds more than one mistake, `box` lists each one on its own line:

```text
box: error: Box Core refuses the policy:
  policy.dw:3: unrecognized action `Box::Action::"fs:raed"`; did you mean `Box::Action::"fs:read"`?
  policy.dw: rule 1 (@id "reads"): unable to find an applicable action given the policy scope constraints
```

Both lines are about the one misspelled action on line 3, so fixing it fixes both.

Some mistakes come with no line. Then the message names the rule instead: `rule 2` is the second rule in the combined `policy.dw`, counting from the top, and `@id "write_budget"` is the `@id` it carries. A `def cedar` or `def temporal` statement isn’t a rule, so leave it out when you count:

```text
box: error: policy.dw: rule 2 (@id "write_budget"), rule 1 (@id "writes"): rule @id("write_budget") (rule 2) carries a temporal clause beside rule @id("writes") (rule 1), which permits the same action with no condition; a permit cannot narrow another permit, so write the cap as a forbid
```

Two rules with the same `@id` get the same kind of message. When the other rule is one that `box` writes, the message says so. Its number is that rule’s place in the combined policy, where the rules `box` adds come after all of your listed files:

```text
box: error: policy.dw: rule 1 (@id "project_read"), rule 23 (@id "project_read"): @id("project_read") is on rules 1, 23; box writes a rule with the id "project_read", so give your rule another id
```

A missing final `;` or another syntax error can produce a message that names `policy.dw` without a line number. Check the end of each listed file. A message that says `this is a rule that box writes` is a bug in `box`, not a mistake of yours. Please report it.

| The problem | What to do |
| --- | --- |
| `` `[options] region` sets an input that no pack declares `` | The option’s name is wrong, or the pack that offers it isn’t in `packs`. Use the full name, such as `bedrock.region`. `box profile show` lists the options. |
| `` `[egress.bedrock]` is declared by both @box/bedrock-mantle and @box/bedrock, and two packs cannot declare one route `` | Two packs in the profile each declare a [route](/docs/user-guide/box/how-box-works/index.md#credentials) with that name. Most often the profile names a second provider by mistake, so take out the one you didn’t mean to use. If both are packs of your own, rename the route in one of them. |
| `` `[egress.collector]` in collector reads env://ANTHROPIC_API_KEY, which `[egress.anthropic]` in @box/anthropic reads, and two packs cannot read one key `` | A route in a second pack reads a key that another pack’s route already reads. The box would put that key on the second pack’s hosts too. Take out the pack you didn’t mean to use. If you want that host to get the key, add it to a route in your own profile. |
| `` a profile holds no `box_dir` `` (or `name`, or `workspace`) | `box run` sets these itself, so delete the line. To work in another project, `cd` there first. |
| `` `[telemetry.records]` is the target `box run` writes for each run `` | Delete the section. Each run’s records go to `records.jsonl` in its run folder. |
| `@id("mcp_github_call") is on rules 1, 24; box writes a rule with the id "mcp_github_call"` | `box` now writes the permits for each `[mcp.<name>]` server itself, and one of your policy files has a permit you wrote for it. Delete your `shell:spawn`, `mcp:call`, `net:connect`, and `http:request` permits for that server. To keep a rule of your own, give it another `@id`. |
| `` `inputs.dir` = "a/b" is not one path component `` | A placeholder after the start of a path holds a `/`, so it would fill more than one folder name. Make the placeholder the start of the path, or give the input a `pattern` that refuses `/` ([Paths](/docs/user-guide/box/reference/profiles/index.md#paths)). |
| `` `inputs.token` would give the workload the host's `AWS_BEARER_TOKEN_BEDROCK`, which a route or a server names as its credential `` | The input’s `from` reads a variable that a route sends as its credential, or that holds a route’s placeholder (`secret.env`), so the agent must not see it. Remove the input. The box adds the credential to each request itself. The same goes for a message that ends `passes to its program as a credential`: a plugin’s program reads that variable, and the agent doesn’t get it. |
| ``team declares `inputs.onepassword.path`, an input of the plugin @box/1password`` | A pack tries to set how a plugin finds its program. Remove the input from the pack. To use another copy of the program, set the input in your profile’s `[options]`. |
| ``the plugin team-vault declares `inputs.onepassword.path`, an input of the plugin @box/1password`` | Two plugins in `plugins` declare the same input. Give the input another name in your own plugin. |
| `` `[secret-source.vault]` reads `inputs.vault.path`, an input of a pack or a plugin `` | A source in your profile takes no input, so no pack or plugin can choose the program it runs. Write the full path of the program, and each other value of `command`, in your profile’s `[secret-source.vault]`. |
| ``team writes `[egress.github] secret.ref = "op://Personal/GitHub/token"`, a reference in `op://`, which @box/1password declares`` | A pack names an item of your vault, and only your profile can. Ask the pack’s author to remove the reference, and set it on the route in your profile instead, as [Use a plugin](/docs/user-guide/box/plugins/index.md#use-a-plugin) shows. |
| `` `storage.files[0] source`: ~/.config holds ~/.config/op, a path that the plugin @box/1password lists in `[protect] paths`, which the box keeps from every workload; box copies no file from there `` | The row copies a folder that a [plugin](/docs/user-guide/box/plugins/index.md) keeps on your machine, or a folder that holds one. Copy a narrower folder that doesn’t hold it. If a pack’s row does it, turn that copy off with the option the pack offers, which `box profile show` lists. A tool’s link row stops the same way, with `box links nothing from there`. |
| `` `[[storage.files]] target = "config/CLAUDE.md"` is in both @box/claude and the profile `` | Your profile copies to a target that a pack already copies to. Pick another target. To turn off the pack’s copy, set the input its `when` reads, if it has one. |
| Box Core: `filesystem entry "/Users/you/.config/tool" is refused: /Users/you/.config/tool is not there: ...` | A filesystem entry names a path that this machine doesn’t have. Mark it `optional = true` ([Entry tables](/docs/user-guide/box/reference/profiles/index.md#entry-tables)), or remove it. This one shows up only when the run starts, not in `box profile show`. |

After you fix it, run `box profile show <name>` in your project to test the profile without starting a box. The [profile reference](/docs/user-guide/box/reference/profiles/index.md) lists every key a profile or a pack can hold, and the values it takes.

## After the box starts

To see what the box denied, run [`box runs history`](/docs/user-guide/box/reference/cli/index.md#box-runs-history) in another terminal, with the box ID that `box run` printed when it started ([`box runs list`](/docs/user-guide/box/reference/cli/index.md#box-runs-list) finds it again):

```sh
box runs history b-5b8e3d70c92f14ab --deny
```

It shows each denial with its action, resource, rule, and reason.

### `box` lists an MCP server, but my agent doesn’t show it

A `box: MCP server ... declared from ...` line lists servers from your agent’s configuration on your machine. With import enabled, `Saved MCP settings ... differ from the current import` names servers that are missing, have different settings, or exist only in the saved section. `box` leaves the saved file alone. If the settings match, it prints no import notice, but that does not mean the agent loaded each server.

There is no reimport command. To refresh the section manually:

1.  Stop all runs of this profile, in every project.
2.  From the project directory, run `box profile show claude`, replacing `claude` with your profile name. Check that the server you want is listed, and find the `storage` path.
3.  Back up the agent’s saved MCP file below that path, such as `config/.claude.json` for Claude Code.
4.  Edit that saved file, and remove the MCP section that you want to import again. The agent’s README names that section. Leave other settings in place and keep the file valid JSON or TOML. An empty MCP section prevents import, so remove it entirely.
5.  Run `box run claude` with your profile name and MCP import enabled, such as `claude.import-mcp = true` (see [The agent and its provider](/docs/user-guide/box/profiles/index.md#the-agent-and-its-provider)). `box` then fills the section with the host servers, including those without generated policy.

This preserves login and other settings outside the MCP section, but replaces any MCP edits made inside the box. Keep the backup if you need those edits later. If the run reports `Did not import MCP settings`, it names the file and the reason it left it alone.

The saved section keeps the keys it was saved with, even ones that `box` now leaves out, such as after you make a profile table match a server’s entry. So to take a key out of the agent’s reach, follow these steps, and then replace the key with a new one from its provider, because the agent could read the old one. Delete the backup once you no longer need it, since it holds the old key.

### A long command stops with an execution timeout

```text
strands-shell: execution timeout exceeded
```

The box sets no Shell timeout by default, so this message means the profile sets `shell.timeout` and the command ran longer than that. Raise the limit in `profile.toml`, in seconds, or delete the key (or set it to `false`) for no limit ([Limits](/docs/user-guide/box/reference/profiles/index.md#limits)):

```toml
[limits]
shell.timeout = 600
```

### The agent can’t reach its model

The agent reports a connection error, or a 403, on its first request. Run `box runs history <box-id> --deny` with the box ID that `box run` printed when it started. If a denied host belongs to another model service, such as `api.anthropic.com` in a Bedrock profile, the agent is talking to a provider the profile doesn’t allow.

This happens when the agent picks its provider from its own settings or from the keys it sees. Make a profile with the provider for the refused host, and set the agent’s matching option. For example:

```sh
box profile create claude-api --with claude,anthropic --option claude.host=anthropic
```

### The credential variable isn’t set

```text
strands-box: error: credential setup failed: credential variable AWS_BEARER_TOKEN_BEDROCK is not set, or holds only whitespace
```

The box reads the model key from the variable the message names, in the shell you ran `box run` in, and the variable isn’t set there. Did you open a new terminal window? An `export` lasts only in the window you ran it in. Run the `export` command from [Get started](/docs/user-guide/box/quickstart/index.md) in this window, then start the run again.

### AWS credentials resolve to nothing

```text
AWS default credential chain resolved no credentials
```

A route with `aws://` found no AWS credentials, or the AWS profile signs in with SSO or `aws login`, which the box doesn’t read. Export the profile’s temporary keys in the shell where you run `box run`. A route that names an AWS profile, such as `aws://your-profile`, also needs its `secret.ref` set to `aws://` with no profile name ([`aws://` credentials](/docs/user-guide/box/reference/profiles/index.md#aws-credentials)):

```sh
eval "$(aws configure export-credentials --profile your-profile --format env)"
```

The keys expire with the SSO session, so a later run needs a fresh export.

### The agent can’t reach a file or a host

The box is doing its job here: it blocks whatever the profile doesn’t allow. A blocked shell command fails with a message that starts with `strands-shell:`, says `policy denied this operation`, and names the path. A blocked web request fails, or gets a 403 from the box itself. To check the saved decisions, run `box runs history <box-id> --deny` with the run’s box ID and look for the path or host. An error such as `operation not permitted` from the agent’s own file tools, or from a program its shell starts, is a sandbox refusal, so the history has no row for it ([The box](/docs/user-guide/box/how-box-works/index.md#the-box)). For a program such as `git` or `cargo`, give its toolchain the folder ([Change a toolchain’s settings](/docs/user-guide/box/profiles/index.md#change-a-toolchains-settings)).

A `deny` or `deny_write` entry always wins, even when a pack or another table grants the path. So when a pack should give the agent a path and the box still refuses it, look for one of these:

-   The shell’s message ends with `[policy: filesystem_deny_read_0]: The profile's [filesystem] deny keeps this path out of the box.` The path is in your profile’s `[filesystem] deny`.
-   The shell’s message names a `deny_write_*` rule. The folder is in your profile’s `[filesystem] deny_write`, or in the agent’s own `deny_write`, which `[agent.filesystem]` in your profile or the agent pack sets.
-   A sandbox refusal with no history row, from a process that holds the path in its own `deny` or `deny_write`. Check the profile’s `[filesystem]` and that process’s `filesystem` table.
-   The box doesn’t start, and the error says a grant `is at or inside` a path `which no grant reaches`. A grant lies inside a `deny` path.

To give one process the path, take it out of `[filesystem]` and put `deny` or `deny_write` on the other processes’ own tables instead.

Each denial’s action and resource name the change to make:

| A `deny` on | Change |
| --- | --- |
| `fs:read`, `fs:write`, or another `fs:` action, outside your project and storage | A filesystem entry in `[agent.filesystem]`. If a shell command made the request, a permit in a listed policy file too, as [Give the agent another directory](/docs/user-guide/box/profiles/index.md#give-the-agent-another-directory) shows. |
| `net:connect` or `http:request` | A route, with a `secret` for a host that takes a credential and without one for a host that does not. See [Routes and other hosts](/docs/user-guide/box/reference/profiles/index.md#routes-and-other-hosts). |
| `shell:exec` | A rule in `policy.dw` that lets the shell run the command ([Every command is refused](#every-command-is-refused)). |
| `shell:spawn` | A [tool](/docs/user-guide/box/reference/profiles/index.md#tools) pack, or a tool table and its permit. |

[Profiles](/docs/user-guide/box/profiles/index.md) shows how to add a folder outside your project, a host, or a variable from your shell.

### A program rejects a certificate

The box reads each HTTPS request on its way out, so the agent and its tools see a certificate that the box makes for each run. The box points `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `AWS_CA_BUNDLE`, `GIT_SSL_CAINFO`, and `CODEX_CA_CERTIFICATE` at it, which covers most programs. A program that reads none of these, or that pins its own certificates, rejects the box’s certificate and can’t connect.

A host whose certificate comes from your company’s own certificate authority can’t be reached through the box’s gateway. [Hosts with your own certificate authority](/docs/user-guide/box/limitations/index.md#hosts-with-your-own-certificate-authority) says why, and how to let one tool connect directly instead.

### The agent can’t see or change the project

The agent says a file in your project doesn’t exist, or that it can’t write one, and the run started with one of these lines:

```text
box: profile claude gives the agent no access to this project; to allow it, add `[project] access = "write"` to ~/.strands/box/profiles/claude/profile.toml
box: the agent can read but not change this project (`[project] access = "read"` in ~/.strands/box/profiles/claude/profile.toml)
```

The profile’s `[project] access` decides this, along with its policy. A profile made with the Locked policy gets `"read"` on purpose, so leave it as it is unless you want the agent to change the project. Otherwise, add the table the line names, or set `access` to `"write"` ([Project access](/docs/user-guide/box/reference/profiles/index.md#project-access)), and run again. A profile made by an earlier `box` has no `[project]` table, so the agent gets no access to the project.

### Every command is refused

Every command the agent runs fails with `policy denied this operation`. The profile’s `policy.dw` has no rule that lets the shell run commands. A profile made from the Locked policy has none on purpose ([Rules from packs and profiles](/docs/user-guide/box/policies/index.md#rules-from-packs-and-profiles)). An agent can run commands of its own around yours, so before you allow only a few, read the **Limitations** of the agent’s pack README.

A profile made by an earlier `box` lacks that rule, and the `/dev/null` rule too. To get both, create the profile again with `--force` and the flags you used the first time, such as `box profile create claude --force`. That replaces `profile.toml` and `policy.dw`, so your edits to them are lost, and `policies` lists only `policy.dw` again, so add back any rule file of yours.

To keep your edits, fix the profile by hand instead. Add both to `policy.dw`:

```text
@id("shell_commands")
permit (principal, action == Box::Action::"shell:exec", resource);

@id("dev_null")
permit (principal, action in [Box::Action::"fs:read", Box::Action::"fs:write"], resource)
when { context.input.path == "/dev/null" };
```

An earlier `box` also blocked the cloud metadata service for every profile. Today only the Open policy blocks its common address. On a cloud machine, whether you recreate the profile or fix it by hand, read the **Limitations** of your policy first, which [Pick the agent’s policy](/docs/user-guide/box/starters/index.md#pick-the-agents-policy) links.

## If nothing here matches

Run `box profile show --full <name>` in your project. It prints the `box.toml` and `policy.dw` that a run hands to Box Core, with every value filled in, so you can see exactly which folders, programs, and hosts the agent gets. If the box already started, the same two files are in the run’s folder under `~/.strands/box/r/`, next to `records.jsonl`.