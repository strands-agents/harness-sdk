Read this page before you trust a run with work that matters, such as a run with the agent’s permission prompts off. While the box runs, it controls which files the agent reads and writes, which programs it starts, and which hosts it reaches ([How Box works](/docs/user-guide/box/how-box-works/index.md#the-box)). What happens in your project after the run is up to you, and the box trusts the settings, profiles, and packs you give it. Each section below names one thing the box leaves to you, who it affects, and what to check or turn off.

This page covers what holds for every run. A pack or a plugin can have limits of its own, and those are in the **Limitations** section of its README. Its fixes are in the **Troubleshooting** section of the same README. [Packs](https://github.com/strands-agents/box/blob/7c4ea75ff509e54298e8a077f6c8e0dae1e8e216/docs/cli/README.md#packs) and [Plugins](https://github.com/strands-agents/box/blob/7c4ea75ff509e54298e8a077f6c8e0dae1e8e216/docs/cli/README.md#plugins) list each one.

## How the agents ask before they act

Each agent decides for itself when to ask you before it acts, and the box checks each action as well. The agent’s pack decides which of your settings come into the box, so in a box the agent can ask about different actions than it does on your machine. If you rely on those prompts, read the pack’s README, which says how its agent asks. An agent pack can also offer an option that turns the prompts off, as [Turn off the agent’s permission prompts](/docs/user-guide/box/profiles/index.md#turn-off-the-agents-permission-prompts) shows.

## Before turning permission prompts off

With the prompts off, the agent takes every action the box allows without asking you, including deleting files in your project or writing a file that runs code outside the box later ([The agent can plant code that runs outside the box later](#the-agent-can-plant-code-that-runs-outside-the-box-later)). The box’s checks stay in force: the operating system sandbox limits the agent to the files and programs granted when the run starts, and the policy decides each shell command, network request, and MCP call. So what the box allows is what the agent does. Keep that small:

-   Use the Scoped or Locked policy, so the agent reaches only the hosts that your packs and profile allow ([Pick the agent’s policy](/docs/user-guide/box/starters/index.md#pick-the-agents-policy)).
-   Give the profile only the tools and [routes](/docs/user-guide/box/how-box-works/index.md#credentials) the work needs. Each tool runs code from your project ([Tools in the box run project code too](#tools-in-the-box-run-project-code-too)), and every program in the box can use each route.
-   Leave MCP import and hook import off unless the work needs them.

With the activity banner on, **Ctrl+\\** turns off what you add to the policy until you press it again: the rules in your policy files, and the shell and Python limits of your profile’s `[filesystem] deny` and `deny_write`. Then the box allows every operation except what `box` forbids for every box, such as changes to the box home, your profile, and `.box` ([Generated policy](/docs/user-guide/box/reference/policies/index.md#generated-policy)). A `deny_write` folder is then open to the box’s shell and Python, so they can change a program in it that a later run runs. The folders and programs set when the run started still limit the agent.

A run’s records, in `~/.strands/box/r/<box ID>/`, are the box’s own decisions for that run, and they stay until `box profile clean` removes the run. They’re a plain file on your machine, not a tamper-proof audit log.

## File rules decide only the box’s shell

A policy rule about files, such as one that forbids reading `.env` or forbids deletes, decides only what the box’s shell and Python touch. The agent’s own file tools, the tools the box starts, and MCP servers reach every file the profile grants them, and the run history doesn’t show it. [Where file rules apply](/docs/user-guide/box/file-rules/index.md) shows how to keep a file from every process, and what native filesystem policy will change.

## Broad write rules reach past what box protects

`box` refuses a filesystem `write` grant over the places a later run trusts, such as `~/.local/bin` and its own install folders, and its own rules keep the box’s shell out of them. But it doesn’t check the rules in your policy. A rule that permits writes across your home lets the shell change the rest of it, such as another folder on your `PATH` or an agent’s settings, with no warning. Keep write rules to the folders the agent needs, or add a `forbid` beside a broad one ([Keep write rules narrow](/docs/user-guide/box/policies/index.md#keep-write-rules-narrow)).

## The agent can plant code that runs outside the box later

The agent can change any file in your project, unless the profile’s `[project] access` is `"read"` or `"none"` ([Give the agent read-only access to the project](/docs/user-guide/box/profiles/index.md#give-the-agent-read-only-access-to-the-project)). Some of those files make a program on your machine run code the next time you use the project, outside the box. So this affects you as soon as you run `git`, a build, or an editor in the project after a run:

| File | What runs it |
| --- | --- |
| `.git/hooks/*`, and `.git/config` (`core.hooksPath`, `core.fsmonitor`, aliases) | `git`. Even `git status` runs `core.fsmonitor`, and `git status` doesn’t list either file. |
| `.claude/settings.json` and `.claude/settings.local.json` (hooks), `.mcp.json` | Claude Code, when you run it outside the box. The permission mode and the allow rules Claude Code uses in the next box run. |
| `package.json` scripts, `.npmrc` | `npm install`, `npm test`, and the like. |
| `Makefile`, `build.rs`, `.cargo/config.toml`, other build files | `make`, `cargo build`, and other build tools. |
| `.envrc` | `direnv`, as soon as you `cd` into the project. |
| `.vscode/` (`tasks.json`, `settings.json`, `launch.json`) | VS Code. |
| A project file that an MCP server’s `args` name in your agent’s MCP settings, and the files its launcher (such as `npx`) reads, such as `package.json` | `strands-box policy generate-schema`, if you run it to write MCP tool rules, because it starts each server outside the box, in the folder you run it from. |
| A program, its `#!` interpreter, or a file that a [secret source](/docs/user-guide/box/plugins/index.md) of one of your profiles names | Box Core, outside the box, when a box with that profile starts in another folder. `box` refuses such a program only in the project of the run, so keep it outside every project. |

After a run, and before you run anything in the project:

1.  Before you run any `git` command, read `.git/config` and list the hooks:
    
    ```sh
    cat .git/config
    ls .git/hooks | grep -v '\.sample$'
    ```
    
    Look for a hook you didn’t add, and for `core.hooksPath`, `core.fsmonitor`, an `alias`, or a `filter` or `diff` driver that you didn’t set.
    
2.  Run `git status --ignored` and `git diff`, and read each change. `--ignored` matters: a file your `.gitignore` hides, such as `.envrc` or `.claude/settings.local.json`, shows up only with it.
    
3.  Open each file from the table that changed or is new, even when its diff looks harmless.
    

If you don’t trust the work, clone the project into a new folder and run `box run claude` there instead. When you’ve read the changes (step 1 first), bring back the ones you want as a patch: run `git diff > ~/agent.patch` in the clone, and `git apply ~/agent.patch` in your project.

## File times on macOS

On macOS, the agent and its tools can set file times in the folders they write, so `touch`, `cp -p`, `rsync -t`, and lock files work. macOS can’t allow the times alone, so in those folders the agent can also set the set-user-ID and set-group-ID bits on a file, change a file’s group to one of yours, and add an access control list to a file or a folder.

None of this lets the agent out of the box, but it can reach other people who use your Mac. A set-ID file that the agent leaves in your project runs as its owner, or with its group, such as `admin`, for whoever starts it. An access list on a folder can let every user of your Mac read what you write there later, and `ls -l` shows it only as a `+` after the mode. That’s why `box` turns file times on for your own user and leaves them off when you run it as root.

To turn them off, put this at the top of your `profile.toml`, above the first `[table]`. Then `touch` and the rest fail with `Operation not permitted`:

```toml
file-attributes = false
```

If you leave them on, check your project after a run. Remove the set-ID bits from any file you didn’t make, and the access lists from a folder and everything in it:

```sh
find . -perm +6000 -type f
chmod u-s,g-s <file>
chmod -R -N <folder>
```

The key’s full entry is in the [profile reference](/docs/user-guide/box/reference/profiles/index.md#what-a-profile-holds). Linux ignores it, because a box there can already set file times.

## File watching on macOS

On macOS, a box blocks FSEvents, the service that tells a program a file changed, so a dev server such as `next dev` misses your edits and Node can report `EMFILE`. Watching can be turned on for one program in its own table, by your profile or by a pack it uses, so a profile can have it even though you never wrote it. To see every table that has it, run `box profile show --full <name>` and look for `file-watching` in the `box.toml` it prints. To turn it on yourself, set it in the program’s table, such as `[agent]`, a `[tool.<name>]`, or a local server’s `[mcp.<name>]`:

```toml
[tool.npm]
file-watching = true
```

FSEvents doesn’t follow the box’s file rules, so a program that watches files learns the names of files it can’t read, including files outside the project and files changed before the run. It still can’t read or write them. A table in your profile can set it back to `false`, even when a pack turned it on.

If file names must stay private, leave it off and use the tool’s polling mode instead, such as `WATCHPACK_POLLING=1000` for Next.js. The key’s full entry is in the [profile reference](/docs/user-guide/box/reference/profiles/index.md#file-watching). Linux ignores it, because a box there can already watch files.

## The project is open to the agent by default

The project is the folder you start `box` from, and a new profile lets the agent read the files in it, keys and `.env` files included, and usually change them too. `[project] access` limits what `box` adds by default, but a pack can still give the agent more of the project ([Project access](/docs/user-guide/box/reference/profiles/index.md#project-access)), so don’t count on it to hide a key.

So start `box` in the project itself, never in a folder such as `~/.aws` or `~/.ssh`. `box` refuses to start in your home folder, because it holds every other folder. If your project keeps keys in a folder of its own, [keep that folder away from every process](/docs/user-guide/box/profiles/index.md#keep-a-folder-away-from-every-process).

## Servers in the box

A program in a box can’t listen on a network port, even on `127.0.0.1`, on macOS or Linux. So a server that a tool starts never takes a caller:

-   A web server or dev server fails when it binds its port, or never answers. On macOS, `uvicorn` started through `uv run` stops with `ERROR: [Errno 1] Operation not permitted`.
-   A Jupyter notebook can’t run its cells. On macOS, its kernel can’t open the local ports it uses to talk to Jupyter. On Linux, the kernel aborts in libzmq when it starts, before it opens a port. That abort’s cause hasn’t been traced.

The box records no denial for the refused port, so the run shows only the program’s own error. Box Core tracks the port limit as [strands-agents/box#285](https://github.com/strands-agents/box/issues/285). Until it’s fixed, run the server outside the box, or check the work another way, such as with the project’s tests.

The agent’s own server is the one exception. A profile can give the agent ports to serve on, with `ingress` in [the `[agent]` table](/docs/user-guide/box/reference/profiles/index.md#the-agent-table). A tool such as `uv` or `npm` can’t take `ingress`, so a server that a tool starts still can’t listen.

## Tools in the box run project code too

A tool is a toolchain that `box` finds on your machine and lets the agent run in the box, and a new profile gets each of the [default tools](/docs/user-guide/box/reference/cli/index.md#box-profile-create) it finds. Each tool runs what the project tells it to, such as a git hook, a `build.rs`, or a package script. The agent can write all of those, and that code reaches whatever the tool can, which is often more than the agent can. `cargo`, for example, reads all of `~/.rustup`.

So give a profile only the tools it needs. Each tool is one pack, such as `@box/cargo`, on the `packs` line of your `profile.toml`, and deleting its pack takes the tool away ([Add or remove a toolchain](/docs/user-guide/box/profiles/index.md#add-or-remove-a-toolchain)).

## Tools write into the project

The agent keeps its own files outside your project, but the tools still use folders in it. A tool pack keeps its cache in the project’s `.cache/<tool>` folder ([Tools](/docs/user-guide/box/reference/profiles/index.md#tools)), and a pack that writes another folder names it in its README, such as cargo’s `.cargo` and `target` and node’s and npm’s `.npm`. Add `/.cache` and those folders to the project’s `.gitignore`. That hides them from plain `git status`, which is why step 2 of the [check after a run](#the-agent-can-plant-code-that-runs-outside-the-box-later) uses `--ignored`.

## Some tools need the box to check the whole project

Some tools are one file with several names: rustup’s `cargo` and `rustc` are names for `rustup`, and npm’s `bun` and `pnpm` are like this too. If the agent could write one of those names, it could change the tool, so before the run starts, the box checks that no name of the tool is in your project. On a Mac, and on Linux in Docker or on btrfs, that means reading every folder in the project, and the run stops if the box can’t finish or finds such a name. [The box can’t check the project for a tool’s other names](/docs/user-guide/box/troubleshooting/index.md#the-box-cant-check-the-project-for-a-tools-other-names) has the message and the fix.

## Instructions, skills, and settings in the box

The first time you run a profile, `box` copies some of your own files into that profile’s [storage](/docs/user-guide/box/reference/files/index.md#profile-storage-and-runs), such as your instructions, skills, and preferences, and the agent reads them from there in every project. The agent’s pack decides which files come in, and its README lists them. `box profile show` prints a `copy` line for each one. The rest of your setup stays outside the box, so the agent doesn’t see it. Your MCP settings come in separately, as the [next section](#mcp-servers-in-the-box) explains.

The agent can change those copies. Its edits never reach your own files, but they do reach every project of the profile ([One profile is shared by all projects](#one-profile-is-shared-by-all-projects)). For files such as your instructions and skills, each run copies in a file you changed since the last copy, and if the agent changed its copy too, yours replaces it and `box` prints which copy it replaced. A file you delete on your machine stays in the box. A file that the agent adds to, such as Claude Code’s settings, comes in only once, and `box profile show` marks it `already in storage`. To take a fresh copy of one of those, delete the copy from the storage folder that `box profile show` prints, and the next run copies your file again. That throws away what the agent changed in it ([Copy status](/docs/user-guide/box/reference/packs/index.md#copy-status)). The full copy rules are on the [design page](https://github.com/strands-agents/box/blob/7c4ea75ff509e54298e8a077f6c8e0dae1e8e216/docs/design/cli/profile-language.md#sync), if you want the details.

A skill that is a link to a folder elsewhere comes in too, unless that folder is in your project, in `~/.strands/box`, in a folder the agent can write, or in a folder that a [plugin](/docs/user-guide/box/plugins/index.md) keeps on your machine. `box` leaves those out and prints a line for each one when the run starts. So don’t link a folder with secrets into your skills: `box` copies what the link points to.

To turn a copy off, set the agent pack’s option under `[options]`, such as `claude.import-skills = false`. `box profile show` lists the options a profile takes. An agent pack can also bring your agent’s hooks into the box, and its README says which hooks run there and what they can’t do.

## MCP servers in the box

When a profile turns on MCP import, `box` reads the MCP servers you set up for the agent on your machine, from the files its pack names, and gives them to the agent in the box. A Claude Code profile, for example, reads the servers in `~/.claude.json`: your own, and the ones you added for the current project. `box` doesn’t read the MCP settings in your project, such as `.mcp.json`, because the agent can change those in the box. To bring in one of those servers, add it to your own configuration instead.

This affects only a profile with import on. Import is off until you set the agent pack’s option under `[options]`, such as `claude.import-mcp = true`. To stop, set it to `false`: the servers already saved in the agent’s settings stay, but they get no access from `box` by themselves.

Your servers reach the agent in two ways:

-   **The agent’s settings.** `box` adds your servers to the agent’s settings in storage where the agent has none saved yet: on the first run, and for a project’s servers, on the first run in that project. After that, it leaves the saved servers alone. A server you add or change later reaches the agent only after you follow the [refresh steps](/docs/user-guide/box/troubleshooting/index.md#box-lists-an-mcp-server-but-my-agent-doesnt-show-it).
    
-   **Permissions.** On every run, `box` reads your servers again and declares each one it can, which means it gives the server its own permissions and keys. It prints a line for each server when the run starts:
    
    ```text
    box: MCP server fetch declared from ~/.claude.json
    box: MCP server docs declared from ~/.claude.json, with the key in DOCS_TOKEN
    box: no automatic MCP declaration for tickets (from ~/.claude.json): runs docker, a launcher that fetches the server when it starts, and box ships no pack that runs it in the box
    ```
    
    A server that isn’t declared still comes into the agent’s settings as you wrote it, but it gets only what your profile already grants, so it may fail. The line says why, and [An MCP server has no automatic declaration](/docs/user-guide/box/troubleshooting/index.md#an-mcp-server-has-no-automatic-declaration) has the fixes. How `box` matches a server and fills in its variables is on the [design page](https://github.com/strands-agents/box/blob/7c4ea75ff509e54298e8a077f6c8e0dae1e8e216/docs/design/cli/profiles.md#mcp-servers), if you want the details.
    

A server that signs in through your browser (OAuth) may fail when the agent uses it, and the agent pack’s README says how its agent handles sign-in. Before you turn import on, know what it opens:

-   **A key written into the configuration can be read by the agent.** That covers a key in a header, such as `"Authorization": "Bearer ghp_abc"`, a key in an argument, and a key in the `env` of a server that isn’t declared, or that your profile declares with another command. Put the key in a variable instead and export it before `box run`: `"Bearer ${DOCS_TOKEN}"` in a header, or `${GITHUB_TOKEN}` in `env`. For a local server, put keys in `env`, not in arguments: `box` fills in `env` from your shell, but a variable in an argument reaches the server as literal text.
    
-   **The sign-in of your vault stays out, with two gaps.** With a [plugin](/docs/user-guide/box/plugins/index.md) in the profile, `box` leaves out a server that reads or sets a variable that the plugin keeps from the agent, such as `OP_SERVICE_ACCOUNT_TOKEN`, or a local server whose `env` or arguments hold your value of it, and the agent’s copy of that server’s settings loses its `env` or its arguments. `box` doesn’t look for that value in a remote server’s header or URL, so don’t paste one there. And a server that the box saved with its `env` or arguments before you listed the plugin keeps them, and `box` reports the saved settings as different. To drop them, follow the [refresh steps](/docs/user-guide/box/troubleshooting/index.md#box-lists-an-mcp-server-but-my-agent-doesnt-show-it).
    
-   **A declared server holds your real key, and the agent doesn’t.** A remote server’s key goes only over HTTPS: the agent holds a placeholder key, and the box adds your key on the way to the server. Use `https://` for every remote server, because a key written into an `http://` server’s settings goes out unencrypted. A local server holds your key as it does on your machine.
    
-   **Project code can run with a local server’s keys.** A server can load code from your project, such as a package that `npx` or `bunx` picks from it. If the agent replaces that package, its code runs with the server’s keys. A server whose `HOME` is in your project keeps what it writes there, such as a cached token, where the agent can read it.
    
-   **A server’s variables can change what code it loads.** A library path, such as `RUBYLIB` or `NODE_PATH`, and runtime options, such as `JDK_JAVA_OPTIONS`, tell a program where to load code from. If one points to a place the agent can write, the agent’s code runs with the server’s keys. So `box` looks for paths in each value of a server’s `env`, whatever the variable is called, except `HOME` and `TMPDIR`. It doesn’t declare a server when a path there starts with `./`, `../`, or a `~/` that the agent’s settings don’t fill in, or lies in your project, the run’s storage, `~/.strands/box`, or a folder your profile lets the box write. Under a name that ends like the name of a path, such as `RUBYLIB` or `NODE_PATH`, every part of the value must be a full path.
    
    `box` can’t find every path. These pass, so check them yourself:
    
    -   A plain word or a path with no `./` in front, such as `lib`, `lib/ruby`, or `@options.txt`, under a name that doesn’t end like the name of a path. A program looks for it in your project.
        
    -   A variable that the agent’s settings don’t fill in, such as `$HOME/lib`.
        
    -   Options. In a value that opens with `-`, `box` checks each path it can see, as in any other value, but it doesn’t read the options. A file or a folder that an option names with no path in front, such as `agent.jar`, passes. `box` declares the server and names the variable:
        
        ```text
        box: did not check JDK_JAVA_OPTIONS of MCP server build (from ~/.claude.json): it opens as options do, and box reads no option. A file or a folder that an option names with no path in front is loaded from the workspace, where the agent can write, with the server's keys
        ```
        
    
    Write each file and folder in a server’s `env` as a full path outside the places the agent can write.
    
-   **Launcher caches are shared across projects.** Servers started with `npx`, `uvx`, `bunx`, or `pnpx` share one cache in the profile’s storage, so a server in one project can run code that a server in another project cached ([One profile is shared by all projects](#one-profile-is-shared-by-all-projects)).
    
-   **The hosts a server reaches are open to the agent too.** A launcher’s package registry is open to the whole box. With the `scoped` or `locked` policy, a server that calls a web API, such as `api.github.com`, fails until you [let the box reach that host](/docs/user-guide/box/profiles/index.md#let-the-agent-reach-another-host), and then the agent can reach it as well.
    
-   **A server can read more than its own files.** If `box` doesn’t recognize how a server was installed, the server can read the whole folder that holds its program. Every local server can also run the other programs in the box. `box profile show --full <profile>` shows each server’s grants.
    
-   **Keys are saved with the run.** A key in a declared server’s `env` stays in `~/.strands/box/r/<run>/` until you run `box profile clean`. The agent can’t read `~/.strands/box`, but `box profile show --full` prints the key, and so does `box profile show --format json --full`, so be careful where you paste the output.
    

## One profile is shared by all projects

A profile keeps one storage folder for every project you run it in. That’s what lets your settings, skills, and memory follow you, but it also means a box in one project can read and change what the profile keeps for your other projects: their sessions and memory, the shared settings, instructions, and skills, the packages and temporary files of your MCP servers, and what your tools keep for themselves.

So if an agent in one project follows instructions it read in a file there, such as a dependency’s README, and writes them into the shared `CLAUDE.md`, a hook, or its memory, the next box of that profile in another project loads them. From there, it can change what that project’s tools and servers run. The change stays inside your boxes: `box` never writes back to your own `~/.claude`.

Think of a profile as one zone of trust. Each profile has its own storage, so nothing one keeps reaches another. Use a separate profile, such as `claude-untrusted`, for work you don’t want mixed in with the rest:

-   A repository you don’t trust yet, such as one you cloned to try out.
-   Sensitive work, such as a project with credentials or customer data.
-   Work for someone else whose instructions or memory shouldn’t reach your other projects.

## Hosts with your own certificate authority

The box checks each server’s certificate against a built-in set of public certificate authorities, and has no setting to add your own. So a host whose certificate comes from your company’s internal certificate authority can’t be reached through the box, even with a route. This affects any agent, tool, or MCP server that calls such a host.

For one tool, you can turn the box’s gateway off, as [Let a tool connect directly](/docs/user-guide/box/reference/profiles/index.md#let-a-tool-connect-directly) shows, name your certificate file in that tool’s `env`, such as `SSL_CERT_FILE`, and add the file to the tool’s `filesystem` `read_file` list. The tool then connects outside your policy and gets no credential from a route, so do this only for a tool and a host you trust.

## How Linux differs

Box runs on Linux on aarch64, such as AWS Graviton, and on x86\_64, with no opt-in. What is different from a Mac:

-   Each run creates an empty `.box` folder in your project, so that the box can keep the agent out of it. git ignores an empty folder, so `git status` doesn’t show it.
-   When you run `box` as root, as in a container that runs as root, the agent writes your project as root, and the files it makes belong to root.
-   A tool from the system, such as `/usr/bin/git`, gets only its own folders, such as `/usr/libexec/git-core`, and not all of `/usr`. If a tool can’t find a file in the box, install it under your home, for example with `rustup` for `cargo`.
-   If a run stops with an error from `strands-box-contain-trampoline`, such as `denying setgroups`, your system doesn’t let `box` build the box. Ubuntu 24.04 does this by default through AppArmor. See [Operating system and container permissions](/docs/user-guide/box/reference/linux-requirements/index.md#operating-system-and-container-permissions) in Box’s guide, which lists each error.

## Packs get the same trust as the profile

Your profile names the packs it builds on in its `packs` line, such as `packs = ["@box/claude", "@box/bedrock"]`, and a pack can build on other packs. Each of them can change almost anything about a run: the command, the files the agent can reach, the hosts, and the credentials.

The `@box/` packs ship with Box, in `resources/packs/` of the Box source. A pack you add yourself is a folder with a `pack.toml` in `~/.strands/box/packs/<name>/`, and a profile uses it when you put `<name>` in its `packs` line. Read it before you add it. Then run `box profile show --full claude` in your project, which prints the configuration and policy of a run with every pack merged in. To write a pack of your own, see [Write a pack](/docs/user-guide/box/packs/index.md#whats-in-a-pack).

A [collection](/docs/user-guide/box/reference/files/index.md#collections) that you clone into `~/.strands/box/external/`, such as your team’s `@acme/` packs, gets the same trust as your own packs: `box` doesn’t check what a pack in it asks for, and each `git pull` reaches your profiles on their next run. So clone only a collection whose changes you would accept into your own `packs/` folder. The agent can’t change it, because each run protects all of `~/.strands/box`.

A profile file that you run by its path ([Run a profile file](/docs/user-guide/box/reference/cli/index.md#run-a-profile-file)), such as one that a repository you cloned keeps, can’t declare a [secret source](/docs/user-guide/box/plugins/index.md) or set the program of a plugin (the [plugin reference](/docs/user-guide/box/reference/plugins/index.md#a-profile-file-that-runs-by-its-path) has the rules). But it still chooses which secret goes to which host. With a plugin listed, it can name any item of your vault that your sign-in can read, and a host to send it to, as it can name any variable of your shell with `env://`. Run only a profile file that you trust, as you would a script.