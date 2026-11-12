Plugins change the typical behavior of an agent. They let you introduce concepts like [Skills](https://agentskills.io/specification), [steering](/docs/user-guide/sdk/agents/interventions/steering/index.md), or other behavioral modifications into the agent loop by composing on the low-level primitives the Agent class exposes—`model`, `system_prompt``systemPrompt`, `messages`, `tools`, and `hooks`. Attach the built-in plugins the SDK ships, or write your own.

## Extend your agent

[Skills](skills/index.md)Give the agent on-demand access to specialized instructions, following the AgentSkills specification.

[Context Offloader](context-offloader/index.md)Offload oversized tool results to storage, leaving retrievable previews behind.

[Context Injector](context-injector/index.md)Fold real-time text into the model input before each call, without persisting it to history.

[GoalLoop](goal-loop/index.md)Validate responses against a goal and loop with feedback until they satisfy it.

[Build a custom plugin](custom-plugins/index.md)Write your own plugin: register hooks and tools, manage state, and initialize it.

## Attach a plugin

The smallest useful setup passes a plugin to an agent’s `plugins` list. The agent runs the plugin’s logic as part of its loop:

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
agent("What time is it right now?")
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

await agent.invoke('What time is it right now?')
```
(( /tab "TypeScript" ))

From here you attach the plugins your application needs, or build your own.

## Where to go next

New to plugins? Attach a built-in one from the grid above—[Skills](/docs/user-guide/sdk/plugins/skills/index.md), [Context Offloader](/docs/user-guide/sdk/plugins/context-offloader/index.md), [Context Injector](/docs/user-guide/sdk/plugins/context-injector/index.md), or [GoalLoop](/docs/user-guide/sdk/plugins/goal-loop/index.md)—and see it change the agent’s behavior.

Ready to write your own? [Build a custom plugin](/docs/user-guide/sdk/plugins/custom-plugins/index.md) walks through registering hooks and tools, managing state, and async initialization. [Hooks](/docs/user-guide/sdk/agents/hooks/index.md) covers how the hook system works, and [Hook events](/docs/user-guide/sdk/agents/hooks-events/index.md) is the reference for every lifecycle event a plugin can react to.

## Related pages

- [Build a custom plugin](/docs/user-guide/sdk/plugins/custom-plugins/index.md) (2 shared tags)
- [Agent Loop](/docs/user-guide/sdk/agents/agent-loop/index.md) (2 shared tags)
- [Hook events](/docs/user-guide/sdk/agents/hooks-events/index.md) (2 shared tags)
- [Hooks](/docs/user-guide/sdk/agents/hooks/index.md) (2 shared tags)
- [GoalLoop](/docs/user-guide/sdk/plugins/goal-loop/index.md) (2 shared tags)
- [Interrupts](/docs/user-guide/sdk/interrupts/index.md) (2 shared tags)
- [Interrupts in Multi-Agent Systems](/docs/user-guide/sdk/interrupts-multi-agent/index.md) (2 shared tags)
- [Steering](/docs/user-guide/sdk/agents/interventions/steering/index.md) (2 shared tags)
- [Interventions](/docs/user-guide/sdk/agents/interventions/index.md) (2 shared tags)
- [Hooks](/docs/user-guide/sdk/bidi/hooks/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/plugins/plugin.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/plugins/plugin.py)

### TypeScript

- [harness-sdk/strands-ts/src/plugins/plugin.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/plugins/plugin.ts)
