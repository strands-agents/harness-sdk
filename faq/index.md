# Frequently asked questions

Find practical answers about choosing a starting point, building and evaluating an agent, and preparing it for production.

## Choose your starting point

### Should I use Strands harness or the Strands Harness SDK?

[Strands harness](https://strandsagents.com/docs/user-guide/harness/index.md) gives you a complete agent harness with opinionated defaults that you can override. The Strands Harness SDK gives you the agent loop and the individual components for building a harness, including tools, memory, sessions, plugins, and interventions.

Use Strands harness when its defaults fit your application. Use the SDK when you want to choose the components or control orchestration yourself. Strands harness is built on the SDK, so you can [replace individual components later](https://strandsagents.com/docs/user-guide/harness/composing-with-sdk/index.md).

### Can I keep my current model when I move to Strands?

You can keep the model when its provider supports the capabilities your agent needs. The agent loop is separate from the [model provider](https://strandsagents.com/docs/user-guide/sdk/model-providers/index.md), so you can change providers without restructuring the agent. For example, an application moving from OpenAI can keep its OpenAI model and credentials while using Strands for orchestration.

You still need to adapt tool definitions, state handling, and multi-agent behavior to the Strands APIs. The [OpenAI migration guide](https://strandsagents.com/docs/user-guide/migrate/openai/index.md) maps those concepts and explains where the behavior does not translate directly.

### Should I use Python or TypeScript?

Use the SDK that matches your application's runtime. Both implement the core agent loop and support tools, MCP tools, streaming, structured output, sessions, and the main multi-agent patterns.

Support for features and providers varies between the SDKs. Bidirectional agents are currently Python-only, for example. Start with the [Python quickstart](https://strandsagents.com/docs/user-guide/sdk/quickstart/python/index.md) or [TypeScript quickstart](https://strandsagents.com/docs/user-guide/sdk/quickstart/typescript/index.md), then check the language tabs and provider pages for the feature you need.

### When should I use bidirectional streaming instead of standard streaming?

Standard [streaming](https://strandsagents.com/docs/user-guide/sdk/streaming/async-iterators/index.md) emits events as one agent invocation produces its response. Both SDKs support async iteration, and Python also supports callback handlers.

[Bidirectional agents](https://strandsagents.com/docs/user-guide/sdk/bidi/index.md) keep a live, full-duplex session open. They can accept new text or audio while the model is still responding. Use them for interruptible voice and other real-time interactions. The [Bidi model adapters](https://strandsagents.com/docs/user-guide/sdk/bidi/models/index.md) list the current provider support.

### When should I use a Strands Labs project?

[Strands Labs](https://strandsagents.com/docs/labs/index.md) houses experimental projects that extend the SDK into robotics, world models, agentic benchmarks, harness optimization, audio processing, and decision models. Each project lives in its own open source repository in the [Strands Labs GitHub organization](https://github.com/strands-labs) and works alongside the SDK.

Labs projects change faster than the core SDK. Check each project for its current setup, support, and maturity before using it in production. A project may graduate, become a standalone product, or remain experimental.

### Can Strands control simulated and physical robots?

[Strands Robots](https://github.com/strands-labs/robots) is an experimental Python library with one interface for simulation and supported hardware. An agent can select robot capabilities through tools, while the robot runtime applies motion and safety controls.

Start in simulation before connecting physical hardware. A deployed robot still needs tested limits, an emergency stop, and supervision appropriate to the task.

### What can Strands for Cosmos add to an agent?

[Strands for Cosmos](https://github.com/strands-labs/strands-for-cosmos) is an experimental Python model provider integration for NVIDIA Cosmos. It lets an agent reason over images and video and use project tools for media or robot-action workflows on local NVIDIA compute.

Choose it for physical-world or multimodal work that needs Cosmos models. Check the project requirements first because model choice, GPU memory, and runtime setup differ by task.

### Should I use Benchmark Harnesses or the Strands Evals SDK?

Use [Benchmark Harnesses](https://github.com/strands-labs/benchmark-harnesses) to reproduce or modify a complete agent and environment for a public benchmark. Each project includes its runner, tools, configuration, and task environment.

Use the [Strands Evals SDK](https://strandsagents.com/docs/user-guide/evals-sdk/index.md) to measure your own agent with repeatable cases and evaluators, diagnose failures, and compare reports across runs.

### When should I use AI Functions instead of regular Python code?

Use [AI Functions](https://github.com/strands-labs/ai-functions) when a task is hard to implement deterministically but you can validate the result. A typed Python function and its docstring define the task. Post-conditions check each result and return validation errors to the model for another attempt, up to the configured limit.

Write regular Python when the logic is straightforward and deterministic. AI Functions is a Strands Labs project. Code execution stays off by default, and its local execution mode is not a sandbox.

## Build the agent

### Should I build a custom tool or use an MCP tool?

Use a [custom tool](https://strandsagents.com/docs/user-guide/sdk/tools/custom-tools/index.md) for application code registered directly with an agent. Use an [MCP tool](https://strandsagents.com/docs/user-guide/sdk/tools/mcp-tools/index.md) when the tool is discovered and called through an MCP server. An agent can use both types together.

When one model response requests several tools, both SDKs run them concurrently by default. Choose a [sequential executor](https://strandsagents.com/docs/user-guide/sdk/tools/executors/index.md) when order matters or the tools share mutable state that is not safe to access concurrently.

### Which multi-agent pattern fits my application?

The right pattern depends on who should control the execution path:

- Agents as tools keep one coordinator in control while it calls specialists.
- Agent-to-Agent (A2A) lets independently deployed agents communicate across service boundaries.
- A graph lets you define allowed nodes and edges, including branches and loops.
- In a swarm, agents choose which peer receives the next handoff.
- A workflow puts a fixed dependency graph in code for repeatable work.

The [multi-agent patterns](https://strandsagents.com/docs/user-guide/sdk/multi-agent/multi-agent-patterns/index.md) guide compares examples and tradeoffs.

### How do sessions, memory, and context management work together?

[Session management](https://strandsagents.com/docs/user-guide/sdk/agents/session-management/index.md) persists conversation and agent state so your application can resume work later. [Long-term memory](https://strandsagents.com/docs/user-guide/sdk/memory/overview/index.md) stores selected knowledge for recall across sessions without replaying the full conversation. [Context management](https://strandsagents.com/docs/user-guide/sdk/context-management/index.md) decides what stays in the active model context as the conversation continues.

### Should I use automatic or agentic context management?

Both modes use the experimental Context Manager strategy API, which may change in future versions.

[Automatic mode](https://strandsagents.com/docs/user-guide/sdk/context-management/built-in-modes/index.md) uses SDK-defined thresholds and actions to offload, truncate, or summarize context. A summary can be model-written; the SDK still decides when the strategy runs.

[Agentic mode](https://strandsagents.com/docs/user-guide/sdk/context-management/built-in-modes/index.md#agentic-context-management) gives the model context-usage information and tools so it can decide when and what to compress or protect. That flexibility requires additional model work.

### What happens when structured output fails validation?

[Structured output](https://strandsagents.com/docs/user-guide/sdk/agents/structured-output-behavior/index.md#forced-tool-call) presents your schema to the model as a tool. Strands validates the tool input and returns any errors to the model so it can correct the result.

If the model still does not return valid structured output after the forced retry, the call raises `StructuredOutputException` in Python or `StructuredOutputError` in TypeScript.

To keep retrying and cap the total number of failures, set `limits['structured_output_attempts']` in Python or `limits.structuredOutputAttempts` in TypeScript on the call. When the [attempt limit](https://strandsagents.com/docs/user-guide/sdk/agents/structured-output-behavior/index.md#limit-attempts) is reached, the result has the stop reason `limit_structured_output_attempts` in Python or `limitStructuredOutputAttempts` in TypeScript, with no structured output.

### When should I use hooks, plugins, middleware, or interventions?

- [Hooks](https://strandsagents.com/docs/user-guide/sdk/agents/hooks/index.md) respond to lifecycle events on an agent.
- [Plugins](https://strandsagents.com/docs/user-guide/sdk/plugins/index.md) package reusable behavior and attach it to agents.
- [Middleware](https://strandsagents.com/docs/user-guide/sdk/agents/middleware/index.md) wraps model or tool execution.
- [Interventions](https://strandsagents.com/docs/user-guide/sdk/agents/interventions/index.md) inspect an action and can allow, modify, reject, or pause it.

### When should I define an agent in configuration instead of code?

Use the experimental [Agent Configuration](https://strandsagents.com/docs/user-guide/sdk/experimental/agent-config/index.md) API when the agent name, Amazon Bedrock model ID, system prompt, and tools that can be declared in configuration fit in a JSON file or Python dictionary. `config_to_agent` returns an `Agent`, and constructor arguments override values from the configuration.

Build the agent in code when a tool needs constructor arguments or another live object. Agent Configuration is available in the Python SDK and remains experimental.

### When should I use Harness Optimizer?

Use [Harness Optimizer](https://github.com/strands-labs/harness-optimizer) after you have repeatable tasks and a reward signal. It represents parts of an agent harness, such as the system prompt, tool descriptions, or agent skills, as tunable `Formula` objects. Rollout engines run the tasks, reward functions score the trajectories, and optimizers update the `Formula` objects.

Test each update against cases the optimizer did not use. This catches changes that improve the training rollouts without improving the agent more generally.

### How do I stop a voice agent from hearing its own speaker output?

In a Python Bidi agent, use a headset or enable [audio processing](https://strandsagents.com/docs/user-guide/sdk/bidi/io/index.md#audio-processing) in the same `AudioIO` instance that handles microphone input and speaker output. Install the `bidi-aec` extra and set `audio_processor=True`. Strands then applies echo cancellation, noise suppression, and automatic gain control.

Audio processing requires mono microphone input, and echo cancellation also requires mono playback. With a headset, use `AudioProcessorConfig` to turn off echo cancellation while keeping noise suppression and gain control.

## Run in production

### How do I require approval for risky tool calls?

Use [Human in the Loop](https://strandsagents.com/docs/user-guide/sdk/agents/approve-before-acting/index.md) to pause selected tool calls until a person approves or rejects them. Its optional model-based risk classifier can reduce unnecessary prompts. The classifier is still a model judgment, so it does not replace authorization.

If every call to a tool must prompt, negate its name with `allowed_tools=["!delete_files"]` in Python or `allowedTools: ['!delete_files']` in TypeScript. A negated tool always prompts and cannot be trusted. For permissions that approval must never override, add [Cedar Authorization](https://strandsagents.com/docs/user-guide/sdk/agents/interventions/cedar-authorization/index.md) before Human in the Loop.

### When should I use retries or invocation limits?

Use [retry strategies](https://strandsagents.com/docs/user-guide/sdk/agents/retry-strategies/index.md) to recover individual model calls from transient provider failures. Retry conditions, backoff, and defaults differ between SDKs and providers, so configure them for your runtime.

Use [production lifecycle controls](https://strandsagents.com/docs/user-guide/sdk/agents/lifecycle-controls/index.md) to bound the complete agent invocation. They cap turns, tokens, or failed structured-output attempts, support cancellation, and return a stop reason that your application can handle.

### How do I evaluate a Strands agent before production?

Use [Strands Evals](https://strandsagents.com/docs/user-guide/evals-sdk/index.md) to run repeatable cases and score an agent's output, trajectory, or interactions. An experiment combines cases, a task that runs the agent, and one or more evaluators. It returns scores and pass or fail results.

Start with output checks, then add trace-based evaluators for tool use or multi-turn behavior. Simulators create user and tool interactions, red teaming probes unsafe behavior, and detectors diagnose failed runs. The [evaluation guide](https://strandsagents.com/docs/user-guide/evals-sdk/how-evaluation-works/index.md) explains how these pieces fit together.

### Where can I deploy a Strands agent?

Strands agents run in your application process. Deploy the application behind the entry point required by the target environment. The [deployment guides](https://strandsagents.com/docs/user-guide/sdk/deploy/index.md) cover serverless, container, Kubernetes, and managed agent-runtime options.

Pick a target based on latency, streaming, state, network access, scaling, and isolation requirements. Keeping environment details outside the agent lets the same code move between targets.

### When should I use Strands Shell?

Use [Strands Shell](https://strandsagents.com/docs/user-guide/shell/index.md) when an agent needs a fast command line with controlled access to files, network destinations, and credentials. It runs inside your application as a Python or Node.js library, or as an MCP server. Only bound host paths are exposed, and configured credentials are injected for matching requests. Public HTTP(S) URLs remain reachable under the default SSRF guard; use `allowed_urls` to permit specific internal destinations.

Strands Shell provides in-process mediation. Run it inside a container or microVM when untrusted tenants can execute adversarial code. The [security model](https://strandsagents.com/docs/user-guide/shell/security/index.md) explains the boundary and configuration choices.

### How do I observe a Strands agent in production?

The SDK emits [OpenTelemetry traces and metrics](https://strandsagents.com/docs/user-guide/sdk/observability-evaluation/observability/index.md) and works with your application's logging. Configure trace and metric exporters or a collector, along with your logging handlers. Monitor model calls, tool calls, latency, token use, errors, and application outcomes.

Telemetry can contain prompts, messages, and tool input or output. Handle it as sensitive data: limit access and retention, collect only what you need, and [redact personal data](https://strandsagents.com/docs/user-guide/sdk/safety-security/pii-redaction/index.md).

### Which security controls do I need in production?

No single SDK setting secures an agent. System prompts can steer behavior, but they do not enforce policy. Give tools the least privilege they need, enforce deterministic authorization, and add interventions, validation, guardrails, trusted history, and telemetry controls. See [Secure for production](https://strandsagents.com/docs/user-guide/sdk/safety-security/index.md).

In Python and TypeScript on Node.js, omitting the `sandbox` setting makes command and file tools use the host process permissions. Configure a [Docker or SSH sandbox](https://strandsagents.com/docs/user-guide/sdk/sandbox/index.md), or a custom backend with the guarantees you need. The sandbox interface routes operations, while the backend and its environment determine the actual isolation boundary.
