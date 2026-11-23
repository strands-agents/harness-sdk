A file rule in your policy, such as one that forbids reading `.env`, applies only to the box’s shell and to Python in the box. This page shows what that means, what to write when a rule has to hold for everything in the box, and how it will change.

## What a file rule checks

The profile’s filesystem lists give every process in the box a sandbox when the run starts ([Files and folders](/docs/user-guide/box/profiles/index.md#files-and-folders)). Your policy then decides each read, write, delete, and move that the shell and Python make, but no one else’s:

| What touches the file | What decides it | In the run history |
| --- | --- | --- |
| A shell command, such as `cat`, `rm`, or a redirect | Your policy | Yes |
| Python in the box | Your policy | Yes |
| The agent’s own file tools, such as Claude Code’s Read and Edit | The agent’s filesystem lists | No |
| A tool the box starts, such as `git` or `node` | The tool’s filesystem lists | No |
| A local MCP server | The server’s filesystem lists | No |

Say your profile reaches the project with `[project] access = "write"`, and you add these rules:

```text
@id("no_env_read")
forbid (principal, action == Box::Action::"fs:read", resource)
when { context.input.path like "~/src/my-app/.env" };

@id("no_deletes")
forbid (principal, action == Box::Action::"fs:delete", resource);
```

The shell refuses `cat .env`, but the agent’s Read tool and `git diff --no-index /dev/null .env` still print the file. The shell refuses `rm notes.txt`, but `git rm notes.txt` deletes it. Neither the Read tool nor `git` shows up in [`box runs history`](/docs/user-guide/box/reference/cli/index.md#box-runs-history).

## Keep a file from every process

Every process in the box keeps to the filesystem lists, so write the rule as a list in your profile’s `profile.toml`, such as `~/.strands/box/profiles/claude/profile.toml`. `${{ workspace }}` stands for your project:

| To | Write |
| --- | --- |
| Keep a file or folder away from every process | `[filesystem] deny = ["${{ workspace }}/.env"]` |
| Keep a folder read-only for every process | `[filesystem] deny_write = ["${{ workspace }}/.git/hooks"]` |
| Give every process the project read-only | `[project] access = "read"` |

The next run picks up the change. Each of these also refuses the shell, so a `forbid` rule beside it adds nothing, but it does no harm either. Run `box profile show --full claude` to see the path in the `deny` list of the agent and each tool. When the agent’s tools try the path, they get an error such as `operation not permitted`, and on Linux a denied file reads as empty.

On Linux, a path in `deny` must exist when the run starts. For a profile you use in projects without the file, write the entry as `{ path = "${{ workspace }}/.env", optional = true }`. [Keep a folder away from every process](/docs/user-guide/box/profiles/index.md#keep-a-folder-away-from-every-process) and [Protect a folder the agent runs from](/docs/user-guide/box/profiles/index.md#protect-a-folder-the-agent-runs-from) show more.

`[project] access` is only what `box` adds. A pack or your profile that grants a folder in the project still gets it.

A list hides a path, but not a copy of the file somewhere else. If git tracks the file, `git show` still prints it from the project’s `.git` folder. So keep such a file out of git: run `git rm --cached .env` and add it to `.gitignore`. Its old versions stay in the history, where `git log -p` still prints them.

## Rules that no list can match

A list entry names one exact path, with no wildcards, and either hides it or makes it read-only. So these rules still hold only for the shell and Python:

-   **A rule that refuses only deletes, or only moves.** `git rm` and a `node` script still delete. Put the folders you can’t lose in `deny_write`, or make the project read-only.
    
-   **A rule with a pattern**, such as every `.env*` file except `.env.example`. List each file that you want kept out instead.
    
-   **A rule about what the agent read earlier in the run**, such as no requests after it reads `config/secrets.json`. The rule never sees the agent’s Read tool open the file. If you want each read to count, leave the file to the shell alone: deny it to the agent, each tool, and each MCP server that you declare.
    
    ```toml
    [agent.filesystem]
    deny = ["${{ workspace }}/config/secrets.json"]
    
    [tool.git.filesystem]                # and each other tool that box profile show lists
    deny = ["${{ workspace }}/config/secrets.json"]
    
    [mcp.fetch.filesystem]                # and each [mcp.<name>] with type = "stdio"
    deny = ["${{ workspace }}/config/secrets.json"]
    ```
    
    The agent can then read the file only with a shell command such as `cat`, which the history records. A tool that a pack adds later can read the file until you list it too. `[filesystem] deny` doesn’t work here, because it keeps the file from the shell too.
    

## Check every process with native filesystem policy

Box’s experimental native filesystem policy lets your policy decide the file operations that the agent, its tools, and its local MCP servers make directly. Your file rules then hold for all of them, and each of their reads goes into the run history. It needs macOS 27 or later, or Linux on ARM64 with extra capabilities, and a `box` built for it. The `box` you install isn’t built that way. [Experimental native filesystem policy](/docs/user-guide/box/reference/profiles/index.md#experimental-native-filesystem-policy) says what each system needs, how to build such a `box`, and what the checks don’t cover.

To try it, turn it on in `profile.toml`:

```toml
[experimental-features]
native-filesystem-policy = true
```

With it on, the policy decides every file that the agent and each tool open, their own libraries included, and it refuses what no rule permits. The shipped policies permit none of those paths, so the agent can fail to start until you add rules that permit them.

## What changes later

Once macOS 27 is common enough, the plan is to make native filesystem policy the baseline: `box` will turn it on for every run where the system supports it, and the rules you write in your policy will then hold for the agent’s file tools, each tool, and each MCP server. Until then it stays off unless you turn it on, because a run with it on fails on macOS 26 and earlier, and on Linux it needs capabilities that a normal install doesn’t have. The lists on this page are the way to keep a file from every process today, and they keep working after the change.