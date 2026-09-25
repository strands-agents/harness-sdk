Strands harness is a state-of-the-art, fully assembled agent harness. You can get started in a few different ways:

-   **[Set up with your coding agent](#set-up-with-your-coding-agent)** — paste a prompt into Codex, Claude Code, or Kiro and let it guide you through the setup.
-   **[Build an agent with the CLI](#build-an-agent-with-the-cli)** — connect a model provider in the terminal and start chatting, then export to Python or TypeScript when you’re ready.
-   **[Use it as a library](#use-it-as-a-library)** — install the Python or TypeScript package and write a few lines yourself.

## Set up with your coding agent

**Using a coding agent?** Copy this prompt into Codex, Claude Code, Kiro, or any coding assistant and it will walk you through this page, ask which path, language, and model provider you want, and offer to set up the Strands MCP server.

Copy prompt

## Build an agent with the CLI

The `strands` CLI gets you chatting with a harness agent in your terminal, with no code required.

### Install the CLI

```bash
npm install -g @strands-agents/cli
```

### Create your agent

Run `strands` to open setup, then choose **Quickstart**. The only thing you set up is a model provider:

1.  **Pick a provider.** Choose Amazon Bedrock, Anthropic, OpenAI, Google Gemini, Ollama, or LiteLLM. The CLI detects credentials you already have, such as an AWS profile or an `OPENAI_API_KEY` in your environment. If a provider needs a key, paste it in. The CLI keeps a pasted key for the current session only, so add it to your shell profile to reuse it.
2.  **Pick a model.** Search the provider’s models, or keep the default. You can also set the reasoning effort and turn on web search here.
3.  **Choose Save and Launch.** Your agent opens in a chat.

Everything else comes from the default harness: file and shell tools, prompt caching, context management, long-term memory, and more. See [the agent you get](#the-agent-you-get).

To change more than the model, choose **Customize** instead. It walks you through the agent’s name and instructions, tools, plugins, context and memory, and tool permissions. Run `/setup` in a chat to reopen setup later.

You can also start from an existing agent file, which skips setup, or override the saved configuration for a single run with flags:

```bash
strands --agent ./agent.ts                     # start from an exported agent
strands --model anthropic/claude-sonnet-5      # use a different model for this run
```

### Export it to code

When you’re ready to embed the agent in an application, run `/export` in a chat. The command writes a Python or TypeScript project with your choices set directly on `create_harness(...)``createHarness(...)`. The project exports a ready-to-import `agent`, so the CLI is a fast on-ramp to the library below: build interactively, then drop into code.

## Use it as a library

Prefer to write the code yourself? Install the Python or TypeScript package and run your first agent in a few lines. The source lives on GitHub:

(( tab "Python" ))
[`harness-py`](https://github.com/strands-agents/harness-sdk/tree/main/harness-py) — the Python package.
(( /tab "Python" ))

(( tab "TypeScript" ))
[`harness-ts`](https://github.com/strands-agents/harness-sdk/tree/main/harness-ts) — the TypeScript package.
(( /tab "TypeScript" ))

### Install

(( tab "Python" ))
Requires Python 3.10 or newer.

```bash
pip install strands-harness
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Requires Node.js 20 or newer.

```bash
npm install @strands-agents/harness
```
(( /tab "TypeScript" ))

### Run your first agent

Strands harness runs on the model of your choice and supports model providers across Amazon Bedrock, Anthropic, OpenAI, and Google, plus Ollama for running locally. Amazon Bedrock is the default; pass `model="provider/name"` to pick another. See [choose a model](/docs/user-guide/harness/configure/model/index.md) for the full list.

Even a one-line call has a shell, file tools, and web access working out of the box. Strands harness can search the web, compare what it finds, and save the results to a file.

(( tab "Amazon Bedrock" ))
Bedrock is the default, using Claude Opus 4.8 in the region your AWS configuration selects.

(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness()
agent("Research the three most common strategies for versioning a REST API, compare their tradeoffs, and write a recommendation to api-versioning.md")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness()
await agent.invoke('Research the three most common strategies for versioning a REST API, compare their tradeoffs, and write a recommendation to api-versioning.md')
```
(( /tab "TypeScript" ))

Give Strands harness AWS credentials with permission to invoke the model, using one of:

-   **Bedrock API key**: set `AWS_BEARER_TOKEN_BEDROCK` to a [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-key-management.html). Quickest for local development.
-   **AWS credentials**: `aws configure`, or `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN` as environment variables.
-   **IAM roles**: on AWS services like EC2, ECS, or Lambda.

Enable access to the models you use in the Amazon Bedrock console; see the [AWS documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access-modify.html).
(( /tab "Amazon Bedrock" ))

(( tab "Anthropic" ))
```bash
export ANTHROPIC_API_KEY=<your key>
```

(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness(model="anthropic/claude-sonnet-5")
agent("Research the three most common strategies for versioning a REST API, compare their tradeoffs, and write a recommendation to api-versioning.md")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness({ model: 'anthropic/claude-sonnet-5' })
await agent.invoke('Research the three most common strategies for versioning a REST API, compare their tradeoffs, and write a recommendation to api-versioning.md')
```
(( /tab "TypeScript" ))
(( /tab "Anthropic" ))

(( tab "OpenAI" ))
```bash
export OPENAI_API_KEY=<your key>
```

(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness(model="openai/gpt-5.4")
agent("Research the three most common strategies for versioning a REST API, compare their tradeoffs, and write a recommendation to api-versioning.md")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness({ model: 'openai/gpt-5.4' })
await agent.invoke('Research the three most common strategies for versioning a REST API, compare their tradeoffs, and write a recommendation to api-versioning.md')
```
(( /tab "TypeScript" ))
(( /tab "OpenAI" ))

(( tab "Google" ))
```bash
export GEMINI_API_KEY=<your key>
```

(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness(model="google/gemini-2.5-flash")
agent("Research the three most common strategies for versioning a REST API, compare their tradeoffs, and write a recommendation to api-versioning.md")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness({ model: 'google/gemini-2.5-flash' })
await agent.invoke('Research the three most common strategies for versioning a REST API, compare their tradeoffs, and write a recommendation to api-versioning.md')
```
(( /tab "TypeScript" ))
(( /tab "Google" ))

(( tab "Ollama" ))
Runs models locally on your machine. No API key or cloud account needed.

```bash
ollama serve
ollama pull llama3.1
```

(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness(model="ollama/llama3.1")
agent("Research the three most common strategies for versioning a REST API, compare their tradeoffs, and write a recommendation to api-versioning.md")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness({ model: 'ollama/llama3.1' })
await agent.invoke('Research the three most common strategies for versioning a REST API, compare their tradeoffs, and write a recommendation to api-versioning.md')
```
(( /tab "TypeScript" ))
(( /tab "Ollama" ))

### Keep a conversation across runs

Sessions are on by default: Strands harness persists each conversation to disk under `./.agent/sessions` with a generated id. Choose the id yourself and a later run rehydrates the same conversation:

(( tab "Python" ))
```python
from strands_harness import create_harness

agent = create_harness(session={"id": "api-design"})
agent("Which of those would you pick for an API with external customers, and why?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { createHarness } from '@strands-agents/harness'

const agent = await createHarness({ session: { id: 'api-design' } })
await agent.invoke("Which of those would you pick for an API with external customers, and why?")
```
(( /tab "TypeScript" ))

See [persist sessions](/docs/user-guide/harness/configure/sessions/index.md) for how session storage works and how it differs from long-term memory. The CLI persists sessions the same way — resume one with `strands --session-id api-design`.

## The agent you get

However you start it, Strands harness runs on the model of your choice with reasoning on, and it follows a tuned system prompt that tells it to explore before changing things, confirm before anything irreversible, and verify before calling a task done. It also has prompt caching, automatic context management, long-term memory, a `generalist` subagent, and a `todos` task tracker enabled by default. See [what the default harness does](/docs/user-guide/harness/index.md#what-the-default-harness-does) for the full set.

## Next steps

-   [What the default harness does](/docs/user-guide/harness/index.md#what-the-default-harness-does): the tools, plugins, and subagents you get out of the box.
-   [Configure the agent](/docs/user-guide/harness/configure/model/index.md): point Strands harness at another model, add your own tools, or turn defaults off.
-   [Compose with the Strands Harness SDK](/docs/user-guide/harness/composing-with-sdk/index.md): reach past the defaults into the full Strands Harness SDK.

## Implementation

### Python

- [harness-sdk/harness-py/src/strands_harness/agent.py](https://github.com/strands-agents/harness-sdk/blob/main/harness-py/src/strands_harness/agent.py)

### TypeScript

- [harness-sdk/harness-ts/src/agent.ts](https://github.com/strands-agents/harness-sdk/blob/main/harness-ts/src/agent.ts)
