You’ve built a tool that calls your company’s internal API. Or a model provider for a regional LLM service. Or a session manager that persists to Redis. It works great for your project. Now you want to share it with others.

This guide walks you through packaging and publishing your Strands components so other developers can install and use them in their own agents.

## Why publish

When you build a useful component, you have two choices: keep it in your project, or publish it as a package.

Publishing makes sense when your component solves a problem others face too. A Slack integration, a database session manager, a provider for a popular LLM service: these help the broader community. Publishing also means you own the package. You control when to release updates, what features to add, and how to prioritize bugs.

Your package can get listed on our [integrations page](/integrations/index.md), making it discoverable to developers looking for exactly what you built.

## What you can publish

Strands has several extension points. Each serves a different purpose in the agent lifecycle.

| Component | Purpose | Learn more |
| --- | --- | --- |
| **Tools** | Add capabilities to agents: call APIs, access databases, interact with services | [Custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) |
| **Model providers** | Integrate LLM APIs beyond the built-in providers | [Custom model providers](/docs/user-guide/sdk/model-providers/custom_model_provider/index.md) |
| **Decision models** | Answer closed questions for agents through decision APIs beyond the built-in providers | [Custom decision models](/docs/user-guide/sdk/decision-models/models/index.md#custom-decision-models) |
| **Plugins** | Extend or modify agent behavior during lifecycle events such as invocations, tool calls, and model calls | [Plugins](/docs/user-guide/sdk/plugins/index.md) |
| **Interventions** | Add composable control handlers for authorization, guardrails, and steering with typed actions | [Interventions](/docs/user-guide/sdk/agents/interventions/index.md) |
| **Session managers** | Persist conversations to external storage for resumption or sharing | [Session management](/docs/user-guide/sdk/agents/session-management/index.md) |
| **Conversation managers** | Control how message history grows: trim old messages or summarize context | [Conversation management](/docs/user-guide/sdk/agents/conversation-management/index.md) |
| **Storage** | Persist raw bytes under string keys for session snapshots, context offloading, and other durable data | [Storage backends](/docs/user-guide/sdk/plugins/context-offloader/index.md#storage-backends) |

Tools are the most common extension type. They let agents interact with specific services like Slack, databases, or internal APIs.

## Start from the template

The fastest way to create a publishable extension is the [extension template](https://github.com/strands-agents/extension-template). It gives you a ready-made project structure with skeleton implementations for Python and TypeScript, testing setup, and GitHub Actions workflows for publishing.

1.  Click “Use this template” on GitHub to create your repository
2.  Run the setup script to customize the project: pick a package name, select which components you need (tool, model provider, decision model, plugin, intervention, session manager, conversation manager, memory store, storage), and fill in your author info
3.  Install dependencies and run checks
4.  Implement your component logic in the generated files

The template follows Strands naming conventions automatically: your package becomes `strands-{name}` on PyPI or npm and uses the appropriate module naming for each language.

## Get discovered

Once you publish, the next step is getting other developers to discover and use your package. See the [Add Your Integration guide](/docs/integrations/get-featured/index.md) for how to get listed on the integrations page.