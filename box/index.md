# /box

Strands Box is an open source sandbox for agents. Start your agent with one command, give it the access it needs, and keep the rest of your computer and data out of reach.

- [Run Box](https://strandsagents.com/docs/user-guide/box/quickstart/)
- [Install Box CLI](https://strandsagents.com/docs/user-guide/box/install/)
- [View Box on GitHub](https://github.com/strands-agents/box)

## Install Box CLI

Box is in preview and works on Apple silicon Macs with macOS 15 or later and on Linux ARM64 and x86-64.

```sh
curl -fsSL https://raw.githubusercontent.com/strands-agents/box/main/install.sh | sh
```

Open a new terminal before verifying the install:

```console
$ box --version
```

## Run Box

Open a terminal in the project where you want to run the agent. The first `box run` creates a reusable profile and asks for its settings. Later runs reuse that profile.

### Claude Code

Run Claude Code through Box.

```sh
box run claude
```

[Open the Claude Code setup guide](https://github.com/strands-agents/box/blob/main/resources/packs/claude/README.md)

### Codex

Run Codex through Box.

```sh
box run codex
```

[Open the Codex setup guide](https://github.com/strands-agents/box/blob/main/resources/packs/codex/README.md)

### Kiro CLI

Run Kiro CLI through Box.

```sh
box run kiro
```

[Open the Kiro CLI setup guide](https://github.com/strands-agents/box/blob/main/resources/packs/kiro/README.md)

## What Box does

Control what your agent can access and do.

Give the agent only the access it needs, check sensitive actions as they happen, and keep real credentials outside the agent.

### Choose what it can access

Give the agent the project files and programs it needs. Keep everything else out of reach.

### Set limits on what it can do

Allow or block commands, file changes, network requests, and tool calls while it runs.

### Keep credentials private

Let the agent call approved services without seeing the real API keys or tokens.

### Example boundary

Your profile and policy determine how Box handles each request.

- `Read project files`: allowed
- `Read private files`: blocked
- `Connect to GitHub`: credential protected
- `Connect to an unknown site`: blocked

## How it works

Two files define the boundary.

Packs describe the agent, model provider, and tools. `profile.toml` combines those packs with MCP imports and startup access. Box-created profiles start with `policy.dw`, and profiles can list additional policy files that decide mediated requests while the agent runs. The Box CLI resolves both files and writes the Box Core configuration for each run.

### Choose what the agent can access

Give the agent the project files, programs, and connected tools it needs.

`profile.toml`:

```toml
packs = ["box/claude", "box/bedrock", "box/git"]
policies = ["policy.dw"]

[options]
claude.host = "bedrock"
bedrock.region = "us-east-1"
claude.import-mcp = "false"
claude.import-hooks = "false"
```

`box profile create` writes the profile. `box profile show --full <profile>` prints the complete resolved boundary before you run it.

[Set up access](https://strandsagents.com/docs/user-guide/box/profiles/)

### Set limits on what the agent can do

Allow or block commands, file changes, network requests, and tool calls while the agent runs.

`policy.dw`:

```text
@id("no_env")
@description("Block shell-mediated reads of .env files.")
forbid (principal, action == Box::Action::"fs:read", resource)
when { context.input.path like "*/.env" };

@id("docs_connect")
permit (principal, action == Box::Action::"net:connect", resource)
when { context.input.host == "docs.example.com" && context.input.port == 443 };

@id("docs_request")
permit (principal, action == Box::Action::"http:request", resource)
when { context.input.host == "docs.example.com" };
```

A forbid rule wins over a broader permit. If policy is off, turn it on before applying; with no banner or for startup access changes, restart.

[Set up rules](https://strandsagents.com/docs/user-guide/box/reference/policy/)

### Enforced outside the agent

Operating system isolation fixes direct access before the agent starts and applies to the code it launches. Dogwood policy runs outside the sandbox to decide mediated shell, file, network, and MCP requests. The coding agent’s own approval mode does not change these controls.

For routed credentials, the agent receives a stand-in. The gateway adds the real value only after policy permits a matching request. Box does not hide credentials stored in files the agent can read.

Box records mediated policy decisions with the requested action, resource, result, and reason. Direct operating-system grants remain separate from that decision history.

- [Read about Dogwood](https://github.com/dogwood-policy/dogwood)
- [Configure routed credentials](https://strandsagents.com/docs/user-guide/box/guides/network-and-credentials/)
- [Understand the security model](https://strandsagents.com/docs/user-guide/box/security/)
- [Read the Box design story](https://strandsagents.com/blog/strands-box-the-big-picture/)

### Keep credentials private

Let the agent call approved services without seeing the real API keys or tokens.

`profile.toml`:

```toml
[egress.github]
destinations = ["api.github.com"]
secret.ref = "env://GITHUB_TOKEN"
```

Every process in one box shares its routes. Use separate profiles when workloads need separate credential boundaries.

[Protect credentials](https://strandsagents.com/docs/user-guide/box/guides/network-and-credentials/)

## Deploy with Box Core

Use Box CLI to run supported coding agents locally. Box Core is in preview and supports embedded workloads and documented Linux deployment environments.

[Read the Box Core deployment guide](https://strandsagents.com/docs/user-guide/box/reference/cloud-deployments/)

## Inspect and refine the boundary

Expand the activity banner with `Ctrl+]` to watch denials. With the banner active and policy on, save a policy-only edit and press `Ctrl+Alt+R` to apply the pending update. With `--no-banner`, restart instead. After the run, use `box runs history <box-id> --deny` to inspect saved decisions.

- [Read decision records](https://strandsagents.com/docs/user-guide/box/reference/cli/#box-runs-history)
- [Understand the security model](https://strandsagents.com/docs/user-guide/box/security/)
- [Configure profiles and MCP imports](https://strandsagents.com/docs/user-guide/box/profiles/#mcp-servers)
- [Read the Box design story](https://strandsagents.com/blog/strands-box-the-big-picture/)

## Content

- [Sandbox Your AI Agents in One Command with Strands Box](https://www.youtube.com/watch?v=Z18kFF3uhSA) (Video from AWS Developers, November 23, 2026, 9:57): See how Box limits files, websites, tools, and credentials while Claude Code, Codex, or Kiro CLI runs in a local sandbox.
- [Strands Box adds native support for Claude Code, Codex, and Kiro CLI](https://strandsagents.com/blog/strands-box-cli/) (Strands Blog, November 23, 2026): Run Claude Code, Codex, or Kiro CLI in YOLO mode inside Strands Box with one command. Profiles and packs set up the agent, credentials stay outside the box, and Dogwood rules decide what it can reach.
- [Strands Box brings its open source sandbox to Linux](https://strandsagents.com/blog/strands-box-linux-sandbox/) (Strands Blog, November 5, 2026): Strands Box now supports Linux, bringing file and network controls, credential protection, and Dogwood policies to agents on Kubernetes, Amazon Bedrock AgentCore Runtime, and Linux hosts across cloud providers or your own infrastructure.
