<div align="center">
  <div>
    <a href="https://strandsagents.com">
      <img src="https://strandsagents.com/latest/assets/logo-github.svg" alt="Strands Agents" width="55px" height="105px">
    </a>
  </div>

  <h1>
    Strands CLI
  </h1>

  <h2>
    Chat with a batteries-included agent from your terminal.
  </h2>

  <div align="center">
    <a href="https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE"><img alt="License" src="https://img.shields.io/github/license/strands-agents/harness-sdk"/></a>
    <a href="https://www.npmjs.com/package/@strands-agents/cli"><img alt="npm version" src="https://img.shields.io/npm/v/%40strands-agents%2Fcli"/></a>
    <a href="https://discord.gg/strands"><img alt="Strands Discord" src="https://img.shields.io/badge/Discord-Strands-5865F2?logo=discord&logoColor=white"/></a>
  </div>

  <p>
    <a href="https://github.com/strands-agents/harness-sdk/tree/main/harness-ts">Strands harness</a>
    ◆ <a href="https://github.com/strands-agents/harness-sdk">Strands Harness SDK</a>
    ◆ <a href="https://strandsagents.com/">Documentation</a>
    ◆ <a href="https://discord.gg/strands">Discord</a>
  </p>
</div>

`strands` is a terminal chat command for the [Strands harness](https://github.com/strands-agents/harness-sdk/tree/main/harness-ts),
a batteries-included agent built on the Strands Harness SDK. It's the fastest way to try the
Strands harness: no code, with an interactive setup for model providers and agent defaults.

```bash
npm install -g @strands-agents/cli   # gives you the `strands` command
strands "summarize what this repo does"
```

By default you get Claude Opus 4.8 on Amazon Bedrock, with reasoning, shell and file tools, web
access, caching, todos, environment context, a `subagent` delegate, Agent Skills, resumable
sessions, long-term memory, and automatic context management. The full-screen terminal keeps
background delegates non-blocking and automatically continues the agent when their results arrive.

## Installation

Install it globally to get the `strands` command:

```bash
npm install -g @strands-agents/cli
strands
```

Or run it on demand without installing, using `npx`:

```bash
npx @strands-agents/cli
```

On the first interactive launch, the intro animation plays before the setup panel opens. Quickstart
lets you choose providers and a model, then select tools, skills, MCP, and other capabilities before
launching. Select or deselect all, or toggle individual capabilities. Manual setup also
exposes the agent instructions, data paths, and approval controls. The CLI detects standard credential
sources but never writes API keys to its config.

## Using it

Run from the repository root with:

```bash
npm run setup
strands
```

`npm run setup` installs the workspace and links the `strands` command to this checkout. The linked
launcher fingerprints `harness-ts` and `strands-cli`, so switching branches or editing source causes one
silent rebuild before the CLI starts:

```bash
git switch main
strands

git switch another-branch
strands
```

If a branch changes dependencies, run `npm run setup` again. A packaged npm installation contains
compiled output and skips all source-build behavior.

## Customize the agent

Run `strands` or use `/setup` in chat to reopen the saved configuration. Quickstart and Manual
edit the same profile. Agent Q&A first asks which model should guide the setup conversation, then
opens the regular chat UI. This assistant model is independent of the model chosen for your custom
agent. Setup Assistant first asks whether to start from scratch or use the detected configuration, then
asks for your agent's name and goals. It recommends settings and keeps a draft until you agree to apply
it. After choosing appearance preferences, your custom agent opens in a fresh chat.

In interactive chat, the agent can also inspect and change its own configuration with `strands_config`.
For example: “Use high reasoning, disable shell and delegation, and keep responses concise.”
Changes are validated and applied after the turn; the conversation is retained. Quickstart, Manual,
and TypeScript/Python exports use the updated profile. A failed rebuild restores the previous profile.
For TypeScript agents loaded from source, the CLI edits the source definition and reloads it instead;
source exports retain that code.

## Run modes

The CLI chooses a mode from its flags and terminal streams:

| Mode           | Selected when                                | Behavior                                                                                     |
| -------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Ink**        | stdin and stdout are terminals               | Full-screen interactive UI with panels, slash commands, mouse support, and streaming updates |
| **Plain**      | stdin is a terminal but stdout is redirected | Readline chat with unstyled output; an initial request is answered before the prompt         |
| **Print**      | `--print` is set, or stdin is piped          | One request, then exit; styling follows whether stdout is a terminal                          |
| **ACP server** | `--acp-server` is set                        | Serve the agent over newline-delimited ACP on stdin/stdout                                        |

Examples:

```bash
strands                                      # Ink chat in a terminal
strands "summarize this repo"                # answer first, then keep chatting
strands "summarize this repo" > transcript   # plain interactive chat
strands -p "list the top-level modules"      # one answer and exit
printf 'summarize README.md' | strands       # read the request from stdin and exit
strands --acp-server                         # serve ACP on stdin/stdout
```

When stdin is piped, its complete contents become the request only when no positional request was
given. In plain mode, type `exit` or `quit`; in Ink, use `/exit`. Ctrl-D exits either interactive
mode. In Ink, Ctrl-C cancels an active turn or exits with status 130 when idle.
The composer stays editable during a turn: Enter queues a follow-up, Alt/Option+Enter interrupts
and steers the agent at the next model-loop boundary (Ctrl+Enter also works in terminals that report it
distinctly), and Escape interrupts without discarding the current draft.
Prefix an Ink input with `!` to run a shell command directly in the active workspace without
invoking the model, for example `!git status`. Each command runs once through the agent's shell
sandbox while the full-screen UI remains open, and its output is rendered inline without compact
summarization. Ctrl-C cancels the active command without exiting the CLI. Output past the inline safety
limit is written to a file under `~/.strands/cli/tool-results/`. Interactive shell sessions and prompts are not
supported.

## Options

Run `strands --help` for the parser's current list.

| Flag                              | Applies to   | Description                                                                                |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `-p`, `--print`                   | Print        | Answer once and exit                                                                       |
| `--prompt <text>`                 | All          | Initial request; equivalent to the positional request                                      |
| `--acp-server`                    | ACP server   | Serve the agent over ACP; cannot be combined with a request, `--print`, or `--setup`             |
| `--setup`                         | Ink          | Open the provider and default-agent setup wizard                                           |
| `--agent <path>`                  | All          | Load an agent ZIP, project folder, or `agent.ts`/`agent.py`                              |
| `--env-file <path>`               | All          | Load an explicitly trusted env file; repeat for several files, later files win           |
| `--set <field=value>`             | Harness backend | Override any portable config field; repeatable and JSON-aware                              |
| `--name <name>`                   | Harness backend | Override the agent name for this invocation                                                |
| `--description <text>`            | Harness backend | Override the agent description for this invocation                                         |
| `--model <model>`                 | Harness backend | A `provider/model` string or bare Amazon Bedrock model id                                         |
| `--effort <level>`                | Harness backend | Reasoning effort: `auto` (default), `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `--instructions <text>`           | Harness backend | Append domain instructions to the system prompt                                            |
| `--builtin-tools <tools>`         | Harness backend | Comma-separated built-ins, or `""` for none; defaults to `shell,read,write,edit,web_fetch,web_search,programmatic_tool_caller,subagent` |
| `--builtin-plugins <plugins>`     | Harness backend | Comma-separated built-ins, or `""` for none; defaults to `todos,environment`               |
| `--caching <mode>`                | Harness backend | Prompt caching: `auto` (default) or `off`                                                  |
| `--context-manager <mode>`        | Harness backend | `auto` (default), `agentic`, or `off`; object forms go through `--set`                     |
| `--session <mode>`                | Harness backend | Conversation persistence: `on` (default) or `off`                                          |
| `--session-id <id>`               | Harness backend | Resume a conversation by id (defaults to a fresh one); writes `session.id`                  |
| `--skills <dirs>`                 | Harness backend | Comma-separated Agent Skills directories or URLs, or `off`; defaults to `./.agent/skills`  |
| `--memory <mode>`                 | Harness backend | Long-term memory: `on` (default) or `off`                                                  |
| `--interventions <policy>`        | Harness backend | Gate tool calls with `ask`, `smart`, a `.cedar` policy file, or a natural-language rule    |
| `--mcp-config <path>`             | All modes    | Add an MCP configuration file; repeat for multiple files                                   |

Explicit CLI values apply only to the current invocation. Dedicated flags override `--set`, which
overrides the saved profile; imported agents take their configuration from their code:

```bash
strands --agent ./reviewer --prompt "Review this change"
strands --set 'builtinTools=["read","web_search"]' --set agentConfig.maxParallelTools=2
strands --set 'builtinTools.web_fetch.model="openai/gpt-5-mini"' --set 'session.dir="./.agent/sessions"'
```

## Setup and providers

Run `strands` or `/setup` to configure:

- enabled providers and the default model,
- the agent name and additional instructions,
- built-in tools, plugins, and the generalist delegate,
- skills directories, context management, caching, and long-term memory,
- the default tool-approval mode.

Configuration is stored in `~/.strands/cli/config.json`. Explicit CLI flags override the saved
profile. `/setup` saves changes for the next launch so the active conversation keeps a stable
runtime.

### Web search and Exa

`web_search` uses the model provider's own search where it has one (OpenAI, Google, GPT-5/GPT-6
models on `bedrock-mantle`, Anthropic). On a model without native search the Tools step offers
`web_search` through [Exa](https://exa.ai) instead, unchecked; ticking it writes
`"web_search": "exa"` to the profile.

> [!WARNING]
> Web search through Exa sends every search query the model writes to Exa (exa.ai), a third-party
> service. Queries leave your environment and are subject to
> [Exa's privacy policy](https://exa.ai/privacy-policy). The wizard shows this warning while the
> option is on; leaving it unchecked (or `"web_search": false`) keeps it off.

## Appearance

`/settings` offers **Auto**, **Light**, and **Dark** color modes. Auto uses the terminal's
`COLORFGBG` background hint when available and otherwise defaults to dark.
Choose **Theme** to preview Classic, Minimal, Homeland, Merlin, Kikker, Cyborg, Spectre,
or Custom. Arrow keys and clicks preview; Enter applies; Esc cancels.
Custom supports separate light and dark colors, a base theme, and per-variant reset.
Saved Magma selections migrate to Classic.
The welcome banner shrinks with the terminal, keeping the composer visible.
`/settings` also links to `/setup` for providers and the default agent.

## Import and export

The setup wizard imports an agent from `agent.ts` or `agent.py`, and `/export` writes a
TypeScript or Python project with options directly inside `createHarness(...)` / `create_harness(...)`.
The file exports `agent`, ready to import into another application, and each new CLI launch
reads the latest edits. No separate JSON snapshot or chat runner is included. TypeScript
projects include `npm run build` for compiling code to import into another application.

Run `strands --agent ./agent.zip` directly: the CLI extracts the project into
`~/.strands/cli/cache/agents/` and installs its declared dependencies on first launch.
For an existing source folder, install its dependencies (`npm install`, or create `.venv`
and install `requirements.txt` for Python), then launch with any of:

```bash
strands --agent ./project/agent.ts
strands --agent ./project/agent.py
strands --agent ./project
strands --agent ./agent.zip
```

Select a trusted environment file with `--env-file ./project/.env`; existing shell values take
precedence. Python agents run with their project `.venv` interpreter when present, otherwise
`python3`. Both exports include the matching harness library and provider dependencies.

Declare `agent` directly with the harness factory, after imports and supporting definitions.
The CLI reads that construction to create independent sessions and apply CLI overrides; no wrapper
function or separate config object is required in your code.
Imported projects re-export in their authored language, preserving their source files;
arbitrary Python tools and dependencies cannot be translated to TypeScript automatically.

Imported agents run in their own language and use the directory where you launched `strands`
as their workspace. Bundled skills, MCP configuration, and policy files resolve relative to
the imported agent's folder. To use it in another application, import its exported `agent`
and invoke it through the usual harness library API.

Skills, module-referenced tools, subagents, plugins, models, intervention handlers, sandboxes,
memory backends, and other executable `AgentConfig` values are bundled with their declared source
files and dependencies, including file-based Cedar policies. Python modules with neighboring helper
files should include `__init__.py` and use package-relative imports. Export fails when a value is
cross-language, lacks packageable source, or would embed an MCP secret. Credentials, conversation
sessions, memory contents, and running processes are runtime state and are intentionally not exported.
Machine-discovered MCP servers and skills are not part of the portable definition.

| Provider       | Model prefix      | Credential source                                                                |
| -------------- | ----------------- | -------------------------------------------------------------------------------- |
| Amazon Bedrock | `bedrock/`        | Standard AWS SDK credential chain                                                |
| Bedrock Mantle | `bedrock-mantle/` | Standard AWS SDK credential chain                                                |
| Anthropic      | `anthropic/`      | `ANTHROPIC_API_KEY`                                                              |
| OpenAI         | `openai/`         | `OPENAI_API_KEY`                                                                 |
| Google Gemini  | `google/`         | `GEMINI_API_KEY`                                                                 |
| Ollama         | `ollama/`         | Auto-detected locally; `OLLAMA_HOST` only for a custom server                   |
| LiteLLM proxy  | `litellm/`        | Auto-detected locally; `LITELLM_BASE_URL` for a custom proxy, optional key       |

The CLI does not store provider secrets. Setup detects credentials from the process environment,
explicitly selected env files, AWS profiles, and other credential sources supported by the
provider SDK.

Workspace, saved-profile, and imported-project `.env` and `.env.local` files are not loaded automatically. Select trusted
files explicitly, in precedence order: `strands --env-file .env --env-file .env.local`.
This also loads custom environment variables used by agent code or MCP configuration.
`AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` in selected files also control setup discovery.
Existing shell values take precedence over saved provider settings, which take precedence over selected files.
For an imported agent, use `strands --agent ./project --env-file ./project/.env`.
In setup, **Recheck configuration** reloads
those files and rechecks AWS credentials without restarting; new exports in another
shell require restarting the CLI. Amazon Bedrock API tokens also need `AWS_REGION` or
`AWS_DEFAULT_REGION` matching the region that issued the token.

## MCP configuration

The CLI accepts either `{ "mcpServers": { ... } }` or a direct JSON server map:

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["server.js"],
      "env": { "TOKEN": "${MCP_TOKEN}" }
    },
    "remote": {
      "url": "https://example.com/mcp",
      "transport": "streamable-http",
      "headers": { "Authorization": "Bearer ${env:MCP_TOKEN}" }
    }
  }
}
```

`${NAME}` and `${env:NAME}` interpolate environment variables. Servers can also set `cwd`,
`disabled`, `continueOnError`, and `tasksConfig`. Discovered servers default to
`continueOnError: true`, so a connection or missing-credential failure leaves that server
unavailable without blocking startup. Malformed configuration in the CLI's own files stops startup; a
problem in another tool's file skips that server or file and is listed under `/mcp`. Stdio servers
run with their stderr discarded, so server diagnostics never print over the terminal UI.

Configuration is merged by server name. Later files replace earlier definitions; a later
`"disabled": true` removes an earlier server.

Tool names are only unique within one server, so the harness exposes each tool as `<server>_<tool>`, using
the server's config key as the prefix (a `slack` server's `search` becomes `slack_search`; characters
outside `[A-Za-z0-9_-]` in the key become `_`). Set `prefix` on a server to choose the namespace, or
`""` to expose its tools under their original names.

When MCP discovery is enabled, user configuration is discovered in this order:

1. `~/.claude.json` (user servers, plus the current workspace's local servers and opt-outs)
2. `~/.kiro/settings/mcp.json`
3. `~/.gemini/settings.json` (comments allowed; `httpUrl` is streamable HTTP, `url` is SSE)
4. `~/.codex/config.toml`
5. `~/.strands/cli/mcp.json`

The CLI then applies trusted project configuration from `.mcp.json`, `.kiro/settings/mcp.json`,
`.gemini/settings.json`, `.codex/config.toml`, and `.strands/mcp.json`. Repeated `--mcp-config`
paths are applied last. Codex TOML uses its native `[mcp_servers.<name>]` tables; JSON sources use
their native `mcpServers` container. Set `STRANDS_CLI_MCP_DISCOVERY=off` to load only `--mcp-config` paths.

Project MCP files can run local commands, so the CLI asks before loading them in interactive Ink or
plain mode. Print and ACP-server mode never prompt; they load project files only when their current
fingerprint was approved previously.
Approval is bound to the canonical workspace and a fingerprint of the exact project file paths and
contents, stored in `~/.strands/cli/trusted-workspaces.json`. Changing a project file requires
approval again, and a change between approval and loading aborts startup. Passing a project file
explicitly with `--mcp-config` is treated as an intentional opt-in and does not prompt.

The merged servers are available to the agent. In ACP server mode, they are combined with servers
supplied by the ACP client.

## Agent Skills

When skill discovery is enabled, the CLI discovers Agent Skills in `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, and
`~/.strands/cli/skills`. It also scans each directory from the repository root down to the current
working directory for `.agents/skills`, `.claude/skills`, `.codex/skills`, `.agent/skills`, and
`.strands/skills`.

Sources are applied from general to specific, so a later project skill replaces an earlier
same-named user skill. Missing directories are skipped. The profile's skills directories (default
`./.agent/skills`, or `--skills`) are always applied last, even when discovery would also find
them, so a configured skill wins over a same-named discovered one. `--skills off` disables
skills.

Both kinds of discovery are off by default. Enable them with the `/settings` panel's **MCP discovery** and
**skill discovery** toggles (they apply at the next launch). `STRANDS_CLI_MCP_DISCOVERY=off` or
`STRANDS_CLI_SKILL_DISCOVERY=off` disables either for a single run. These switches control automatic
source discovery, not whether MCP or skills are enabled. With MCP discovery off, the CLI loads only
explicit `--mcp-config` paths. With skill discovery off, the CLI loads only the configured skills
directories (`./.agent/skills` by default); `--skills off` disables skills entirely.

## Tool approval and host execution

The Ink backend installs the Strands Harness SDK's Cedar intervention before constructing the agent
through `createHarness()`. Cedar automatically permits workspace-local `read` calls (after
canonical-path and symlink checks), `todo_write`, and `retrieve_offloaded_content`. Every other built-in
or MCP tool call opens a permission panel with **Allow once**, **Always allow tool**, and **Deny**.
Always-allowed tools are written to `~/.strands/cli/config.json` and apply by exact tool name across
launches. A denial is returned
to the agent as a denied tool call.

The CLI reads user-level permission settings from `~/.strands/cli/config.json`:

```json
{
  "permissions": {
    "mode": "default",
    "allow": ["shell", "edit"]
  }
}
```

`permissions.mode` accepts `"default"` or `"bypassPermissions"`. Bypass mode allows every built-in
and MCP tool call without opening the Cedar approval panel. It does not disable additional
interventions supplied by the caller or an operating-system sandbox. Permission configuration is
user-owned; the CLI does not load a project `config.json` that could silently enable bypass mode.
Use `/permissions` to inspect or change the mode and remove saved tool grants.
Use `/settings` to persist presentation preferences in the same file. Disabling animations also
skips the startup intro on later launches.

This approval layer is not an operating-system sandbox. Unless a caller supplies a Strands
`sandbox`, the harness's shell, file, MCP, delegate, and Background Task work runs in the host process with
the user's permissions. Plain, print, and ACP server modes have no permission UI and therefore use
stock harness tool behavior; library consumers can pass their own `interventions` and `sandbox` options
to `createHarness()`.

An Ink `!<command>` shell escape is an explicit user action, so it does not pass through the agent's
tool-approval intervention. It executes through the same `agent.sandbox` used by the harness's tools and
inherits that sandbox's isolation. With the SDK default, that environment is the local host rather
than an operating-system sandbox.

## Ink commands

These commands are local to the full-screen Ink UI:

| Command                      | Action                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| `/help`                    | Browse controls, commands, and the current agent's available tools |
| `/context`                   | Show context usage and prompt-cache activity                       |
| `/compact`                   | Summarize older conversation context                               |
| `/clear`                     | Rebuild the agent with a fresh conversation                             |
| `/tasks`                     | Show tasks and configure background completion behavior            |
| `/model [model-id]`          | Browse or change the active model                                  |
| `/effort [level]`            | Open the effort slider or set the reasoning effort directly        |
| `/fork [request]`            | Fork the current conversation into an independent agent            |
| `/agents`                    | View conversations and live subagents                              |
| `/rename <name>`             | Rename the currently viewed agent                                  |
| `/sessions`                  | Browse and resume saved sessions                              |
| `/skills`                    | Browse available and active Agent Skills                           |
| `/mcp`                       | Connect to configured MCP servers and show their tools and state   |
| `/permissions`               | Configure persistent tool approvals                           |
| `/voice [on\|off\|status]`   | Open bidirectional voice controls                                  |
| `/settings`                  | Configure presentation and inspect the active runtime              |
| `/setup`                     | Configure providers and the default agent                     |
| `/export`                    | Write the agent as a runnable TypeScript or Python project         |
| `!<command>`                 | Run a shell command in the active agent's sandbox             |
| `/exit`                      | Exit the CLI                                                          |

Slash commands provide inline signatures and argument completion. Press Tab or Enter
on a completion to replace the current argument token.

`/help` groups **Controls**, **Commands**, and **Available tools** in a searchable panel.
Select a control or tool for its full text, drag to copy, and press Esc to return.
Tool names and descriptions come from the active backend; unreported tools or origins are
marked as unknown rather than inferred from defaults. Command support follows the connection's
capabilities, including Python and ACP backends.

An available Agent Skill can also be invoked directly with `/skill-name [prompt]` or
`$skill-name [prompt]`. The CLI activates it through the SDK's `skills` tool, then runs the trailing
prompt with that skill's instructions active.

`/voice` opens the experimental Nova Sonic control panel without starting audio. Use `/voice on` to
start listening without opening the panel, or use the panel's start action. Nova Sonic handles live
audio, endpointing, transcription, and spoken playback; finalized utterances steer the active agent
conversation. The selected coding model still owns reasoning, tools, and the response itself.

The panel controls microphone mute, spoken replies, Nova Sonic's supported voice IDs, and
fast/balanced/patient end-of-turn detection. Spoken replies are off by default. When enabled,
sentence-sized pieces of the coding response are queued for speech as its text streams instead of
waiting for the entire response. With an empty composer, one Space tap toggles microphone mute,
including while the voice panel is open. Voice changes restart an active sidecar; selections made
while voice is off apply on the next start. `/voice off` releases the audio devices. The sidecar
enables the Harness SDK's WebRTC-based echo cancellation so speaker playback is removed from
microphone input while real user barge-in remains available. This currently requires `uv`, Python
3.13, PortAudio, AWS credentials, and Nova Sonic access. The published npm package includes the
Python sidecar; `uv` installs its Python dependencies on first use.

## ACP server

`strands --acp-server` exposes the agent to an ACP client over
stdin/stdout. It creates a harness agent for each ACP session, supports client-supplied MCP servers, and
supports loading saved sessions with transcript replay. Start a separate process for each workspace.

## Models, sessions, and background work

### Choosing a model

Pass a `bedrock/<id>` string or a bare Amazon Bedrock model id:

```bash
strands --model bedrock/global.anthropic.claude-sonnet-5 --effort high "explain this error"
strands --model global.anthropic.claude-opus-4-8 "review my auth flow"
```

To use a preconfigured SDK `Model` instance, use the library directly (see
[Beyond the CLI](#beyond-the-cli)).

In Ink, `/model` discovers available Amazon Bedrock models. A compatible Bedrock-family change is applied
live; changing model family rebuilds the agent immediately while preserving the conversation. The model
and context items in the status strip remain interactive during a turn; live model changes affect
the next model call, while rebuilds wait for the active turn to finish.

### Remembering a conversation

Every run persists by default under `./.agent/sessions`, minting a fresh session id when you don't
supply one, for interactive chats and one-shot `-p` runs alike. Use `/sessions` to browse and resume
them. Pass `--session-id` to choose a memorable id or pick up that exact conversation directly:

```bash
strands --session-id my-project "let's refactor the parser"
# ...later...
strands --session-id my-project "where did we leave off?"
```

Pass `--session off` for a throwaway run that persists nothing.

In Ink, `/sessions` combines saved sessions from workspaces previously seen on the machine and
can resume any of them, including from another worktree. Session data stays in each workspace's
configured `session.dir`; the user-level catalog stores only those roots.

### Background Tasks

`subagent` always runs in the background. Any other compatible tool may run there when the model
selects `_background_execution: true`. Ink starts in detached mode so the composer remains
available; `/tasks` shows task state and live subagent progress, and a ready result automatically
starts a continuation turn. The panel's **Wait for completion** switch rebuilds the agent with the SDK's
blocking mode when a turn should stay open until all background results have been delivered.

Turn token totals include delegated work. When detached work finishes, its originating turn's
total updates; the context meter continues to measure the parent agent's prompt.

Live subagents also appear in `/agents` while they are available for peer messages. They are
status rows rather than switchable conversations and disappear when the delegated task finishes.

Plain, print, ACP-server, and direct library invocations use the normal wait-for-completion
behavior. Ink blocks model-family restarts, session replacement, and wait-mode changes while
Background Tasks are running or waiting for delivery. Use the library's `backgroundTasks` option
for custom policy or to disable the feature.

## Debug logging

The interactive TUI has no console, so it can capture harness and SDK logs to a file instead. It is off
by default because the log contains your prompts and tool output. Turn it on for one run with
`STRANDS_CLI_LOG=1` (or a level name such as `STRANDS_CLI_LOG=warn`); the log lands in
`<tmpdir>/strands/cli.log`, readable by your user only. `STRANDS_CLI_LOG_FILE` changes the path and
`STRANDS_CLI_LOG_LEVEL` the level (`debug` | `info` | `warn` | `error`, default `debug`); neither turns
logging on. Earlier builds wrote this log on every launch, so you may want to delete a leftover
`<tmpdir>/strands/cli.log`.

## Telemetry

Each time the interactive TUI starts with the built-in profile, `strands` sends one anonymous ping to
`https://telemetry.strandsagents.com/ping` so we can see which versions, providers, built-in tools,
and plugins are actually in use. The whole payload is:

```json
{ "v": 1, "cli_version": "0.1.0", "provider": "bedrock", "builtin_tools": ["shell", "read"], "builtin_plugins": ["todos"] }
```

`provider` is one of the shipped provider names and is omitted for a custom model module. The payload
carries no identifiers of any kind and no prompts, model ids, paths, or environment details, and the
ping is fire-and-forget: startup never waits on it and failures are silent. Nothing is sent from
`--print`, piped, plain, or `--acp-server` runs, or when running an authored agent (`--agent`, imported
projects).

Turn it off with `STRANDS_CLI_TELEMETRY=off` (or `DO_NOT_TRACK=1`), the **Usage ping** toggle in `/settings`
(takes effect at the next launch), or `"settings": { "telemetry": false }` in `~/.strands/cli/config.json`.

## Beyond the CLI

For anything past these flags (custom tools, plugins, specialist subagents, interventions, a
bring-your-own model instance), use the library directly:

- **TypeScript:** [`@strands-agents/harness`](https://www.npmjs.com/package/@strands-agents/harness)
- **Python:** [`strands-harness`](https://pypi.org/project/strands-harness/)

## Contributing ❤️

Contributions are welcome: bug reports, features, docs, or a well-scoped PR. See the
[Contributing Guide](https://github.com/strands-agents/harness-sdk/blob/main/CONTRIBUTING.md) for
development setup, how we work, and the pull-request flow. Please also review our
[Code of Conduct](https://github.com/strands-agents/harness-sdk/blob/main/CODE_OF_CONDUCT.md).

The cache patch in `src/tui/terminal/ink.ts` bounds Ink 7.1.1's text-layout caches in memory during streaming.
Review this patch when upgrading Ink; it works with read-only installations without changing dependency files.

## Security

See [SECURITY.md](https://github.com/strands-agents/harness-sdk/blob/main/SECURITY.md) for how to
report a vulnerability. Please do not open a public issue for security concerns.

## License

Apache-2.0. See [LICENSE](https://github.com/strands-agents/harness-sdk/blob/main/strands-cli/LICENSE).
