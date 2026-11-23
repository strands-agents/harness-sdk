The `ContextInjector` plugin folds real-time text into the model input before each call. The text is added to that single call’s input only: it is never written to the conversation history, so it is not persisted or replayed on later turns. Use it for context the agent should always have but that does not belong in the stored history: the current time, a sandbox descriptor, environment facts, or a retrieval lookup.

## How It Works

A `ContextInjector` has two parts. The callback function decides **what** text to fold into the next model call’s input. The trigger decides **when** the callback is called. The injected text is **ephemeral by design**: it augments the model input for that one call and never persists into the durable conversation or session.

This is the same injection mechanism that powers [memory context injection](/docs/user-guide/sdk/memory/managing-memory/index.md#context-injection). `ContextInjector` is the generic surface for any consumer.

## Getting Started

Pass a `ContextInjector` to your agent’s `plugins` list with a callback that renders the text to inject. By default it injects only on a fresh user turn, the common case for chat agents:

(( tab "Python" ))
```python
from datetime import datetime, timezone

from strands import Agent
from strands.vended_plugins.context_injector import ContextInjector

agent = Agent(
    plugins=[
        ContextInjector(lambda context: f"<now>{datetime.now(timezone.utc).isoformat()}</now>"),
    ],
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { ContextInjector } from '@strands-agents/sdk/vended-plugins/context-injector'

const agent = new Agent({
  plugins: [
    new ContextInjector({
      renderContent: async () => `<now>${new Date().toISOString()}</now>`,
    }),
  ],
})
```
(( /tab "TypeScript" ))

## When to Inject

The trigger controls when the callback runs:

-   `'userTurn'` (the default) injects only when the latest message is a fresh user ask, a user message carrying no tool result. This is the common case for chat agents.
-   `'everyTurn'` injects before every model call, including mid-task tool-result turns. Use it for autonomous agents that should consult the injected context at each step.

(( tab "Python" ))
```python
from datetime import datetime, timezone

from strands.vended_plugins.context_injector import ContextInjector

clock = ContextInjector(
    lambda context: f"<now>{datetime.now(timezone.utc).isoformat()}</now>",
    name="clock",
    trigger="everyTurn",  # inject before every model call, not just fresh user asks
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { ContextInjector } from '@strands-agents/sdk/vended-plugins/context-injector'

const clock = new ContextInjector({
  name: 'clock',
  trigger: 'everyTurn', // inject before every model call, not just fresh user asks
  renderContent: async () => `<now>${new Date().toISOString()}</now>`,
})
```
(( /tab "TypeScript" ))

For finer control, pass a predicate: a function that receives the injection context and returns whether to inject this call. The context carries the current messages, durable state shared across calls via `context.state``context.appState`, and the agent. A predicate that throws fails open, so the model call still proceeds:

(( tab "Python" ))
```python
from strands.vended_plugins.context_injector import ContextInjector

injector = ContextInjector(
    lambda context: f"<context>{len(context.messages)} turns so far</context>",
    # Inject only when a tool stashed a flag in agent state last turn.
    trigger=lambda context: context.state.get("recall_enabled") is True,
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { ContextInjector } from '@strands-agents/sdk/vended-plugins/context-injector'
import type { InjectionContext } from '@strands-agents/sdk/vended-plugins/context-injector'

const injector = new ContextInjector({
  // Inject only when a tool stashed a flag in app state last turn.
  trigger: ({ appState }: InjectionContext) => appState.get('recallEnabled') === true,
  renderContent: async ({ messages }) =>
    `<context>${messages.length} turns so far</context>`,
})
```
(( /tab "TypeScript" ))

## Configuration

| Field | Purpose |
| --- | --- |
| `render_content``renderContent` | Returns the text to inject for this call, or `None / empty string``undefined / empty string` to skip. Required, and the only positional argument. |
| `trigger` | `'userTurn'` (default), `'everyTurn'`, or a predicate over the injection context. |
| `name` | Plugin name for logging and duplicate detection. Defaults to `'strands:context-injector'`. Set a distinct name when registering more than one. |

Injected text reaches the model verbatim

The rendered text is a prompt-injection surface. If it interpolates attacker-influenced data (tool output, user-derived state), escape it yourself before returning. A callback that throws fails open: injection is skipped and the model call proceeds.

## Related

-   [Memory](/docs/user-guide/sdk/memory/managing-memory/index.md#context-injection) builds on this engine to inject retrieved knowledge before a model call.

## Related pages

- [GenAI Prices Estimator](/docs/user-guide/sdk/plugins/genai-prices-estimator/index.md) (1 shared tag)
- [Todos](/docs/user-guide/sdk/plugins/todos/index.md) (1 shared tag)
- [Built-in Modes](/docs/user-guide/sdk/context-management/built-in-modes/index.md) (1 shared tag)
- [Context Estimation](/docs/user-guide/sdk/context-management/context-estimation/index.md) (1 shared tag)
- [Context management](/docs/user-guide/sdk/context-management/index.md) (1 shared tag)
- [Custom Strategies](/docs/user-guide/sdk/context-management/custom-strategies/index.md) (1 shared tag)
- [Strategy Presets](/docs/user-guide/sdk/context-management/presets/index.md) (1 shared tag)
- [Skills](/docs/user-guide/sdk/plugins/skills/index.md) (1 shared tag)
- [Context Offloader](/docs/user-guide/sdk/plugins/context-offloader/index.md) (1 shared tag)
- [Conversation Management](/docs/user-guide/sdk/agents/conversation-management/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/vended_plugins/context_injector/plugin.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/context_injector/plugin.py)

### TypeScript

- [harness-sdk/strands-ts/src/vended-plugins/context-injector/plugin.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-plugins/context-injector/plugin.ts)
