This tutorial is a hands-on tour of the Strands Agents **hooks** system, the composable, type-safe extension point that fires callbacks throughout an agent’s request lifecycle. By the end, you will know where every hook fires, how to register one, and how to use writable hook fields (`messages`, `cancel_tool`, `retry`, `resume`) to control agent behavior at runtime.

## Tutorial Details

| Information | Details |
| --- | --- |
| **Strands Features** | Hooks, `HookProvider`, `AgentInitializedEvent`, `BeforeInvocationEvent`, `AfterInvocationEvent`, `BeforeModelCallEvent`, `AfterModelCallEvent`, `BeforeToolCallEvent`, `AfterToolCallEvent`, `MessageAddedEvent`, `invocation_state` |
| **Agent Pattern** | Single agent with lifecycle observers and interceptors |
| **Tools** | Small custom tools used to exercise the tool events |
| **Model** | Claude Haiku 4.5 on Amazon Bedrock (any Strands-supported model works) |

## What You’ll Learn

The tutorial is split into three sequential notebooks, each self-contained and independently runnable:

1.  [**01\_hooks\_basics.ipynb**](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/16-hooks-lifecycle/01_hooks_basics.ipynb) - Register callbacks for `BeforeModelCallEvent` and `AfterModelCallEvent` with `agent.add_hook()` to measure model latency, use `AgentInitializedEvent` for one-time setup, and trace the full event lifecycle across model and tool calls.
2.  [**02\_hooks\_intercept.ipynb**](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/16-hooks-lifecycle/02_hooks_intercept.ipynb) - Use `BeforeToolCallEvent.cancel_tool` to block a tool, `AfterToolCallEvent.retry` to re-run a failed call, `AfterInvocationEvent.resume` to auto-continue the agent, and `BeforeInvocationEvent.messages` to redact input before the model sees it.
3.  [**03\_hooks\_packaging.ipynb**](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/16-hooks-lifecycle/03_hooks_packaging.ipynb) - Pass per-invocation context between hooks via `invocation_state`, package hooks into a reusable `HookProvider` class, and combine everything into a single observability and control plugin.

## Lifecycle Diagram

```plaintext
Agent(...)  ──►  AgentInitializedEvent                   (once, at construction)

agent("Summarize the weather in Seattle")
│
├─ BeforeInvocationEvent              (once per request)
│  │                                    writable: messages
│  └─ MessageAddedEvent  (user input added to history)
│
├─ BeforeModelCallEvent               (each time the model is invoked)
│  └─ AfterModelCallEvent             writable: retry
│     └─ MessageAddedEvent (model's assistant turn)
│
├─ BeforeToolCallEvent                (for every tool the model requests)
│  │                                    writable: cancel_tool, selected_tool, tool_use
│  └─ AfterToolCallEvent              writable: result, retry  (reverse order)
│     └─ MessageAddedEvent (tool result appended)
│
├─ (loop: BeforeModelCall → AfterModelCall → tool calls → ... until end_turn)
│
└─ AfterInvocationEvent               (once per request, reverse order)
                                         writable: resume
```

## Prerequisites

-   Python 3.10 or later.
-   An AWS account with [Amazon Bedrock](https://aws.amazon.com/bedrock/) model access (Claude Haiku 4.5 by default; see the notebook for how to swap models).
-   Basic familiarity with Strands Agents ([Quickstart Guide](https://strandsagents.com/latest/documentation/docs/user-guide/quickstart/)).

## Tutorial Structure

```plaintext
16-hooks-lifecycle/
├── README.md
├── requirements.txt
├── 01_hooks_basics.ipynb
├── 02_hooks_intercept.ipynb
└── 03_hooks_packaging.ipynb
```

| File | Description |
| --- | --- |
| [01\_hooks\_basics.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/16-hooks-lifecycle/01_hooks_basics.ipynb) | Your first hook and the full event lifecycle. |
| [02\_hooks\_intercept.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/16-hooks-lifecycle/02_hooks_intercept.ipynb) | Writable fields: cancel, retry, resume, and redaction. |
| [03\_hooks\_packaging.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/16-hooks-lifecycle/03_hooks_packaging.ipynb) | Cross-hook data sharing and reusable `HookProvider` packaging. |

## Installation

```bash
pip install -r requirements.txt
```

## Running the Examples

1.  Start with [01\_hooks\_basics.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/16-hooks-lifecycle/01_hooks_basics.ipynb) and work through the notebooks in order.
2.  Each notebook is self-contained: run cells sequentially within any single notebook.

## Key Concepts

-   **Hook**: a typed callback the agent invokes when a specific lifecycle event fires.
-   **HookEvent**: a strongly-typed event object carrying data for that lifecycle stage. Most fields are read-only; a handful are intentionally writable to let hooks control agent behavior.
-   **HookProvider**: a class that bundles multiple callbacks so you can ship hooks as reusable components.
-   **`invocation_state`**: a per-invocation dictionary every hook event exposes. It is the clean way to share data between hooks within a single request.
-   **Reverse ordering**: `After*Event` callbacks fire in reverse registration order so outer hooks see inner hooks’ side-effects (think `try/finally`).

## Important Notes

-   Hook callbacks may be synchronous or `async`. Strands will await async callbacks automatically.
-   Setting `AfterModelCallEvent.retry = True` or `AfterToolCallEvent.retry = True` causes the call to re-execute with the same inputs. Always pair retries with a counter to avoid infinite loops.
-   `AfterInvocationEvent.resume` triggers a brand-new invocation cycle (including a fresh `BeforeInvocationEvent`); guard it with a termination condition held on your `HookProvider` instance, not in `invocation_state` (which resets on each new invocation).
-   `Agent.structured_output(...)` does **not** fire `BeforeModelCallEvent` or `AfterModelCallEvent`. Use `BeforeInvocationEvent` / `AfterInvocationEvent` if you need to hook that code path.
-   When a retry is requested, intermediate streaming events from the discarded attempt have already been emitted to `stream_async` consumers. Only the final attempt’s result is added to conversation history.

## Additional Resources

-   [Hooks Concept Guide](https://strandsagents.com/docs/user-guide/concepts/agents/hooks/)
-   [`strands.hooks.events` API reference](https://strandsagents.com/docs/api/python/strands.hooks.events/)
-   [`strands.hooks.registry` API reference](https://strandsagents.com/docs/api/python/strands.hooks.registry/)
-   [Plugins](https://strandsagents.com/docs/user-guide/concepts/plugins/): package hooks plus tools plus config together.

## Next Steps

-   See [`13-human-in-the-loop`](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/13-human-in-the-loop/) for how interrupts compose with hooks (`BeforeToolCallEvent` is `_Interruptible`).
-   See [`08-observability`](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/08-observability/) for production-grade tracing built on the same hook surface.
-   Explore **multi-agent hooks** (`BeforeMultiAgentInvocationEvent`, `BeforeNodeCallEvent`, `AfterNodeCallEvent`, and `cancel_node`) when moving to `Graph` or `Swarm` orchestration.

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/16-hooks-lifecycle)
