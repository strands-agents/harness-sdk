Delegates a self-contained task to a child agent that runs in its own context and returns a final report. Use it when a subtask would otherwise flood the parent’s context with intermediate work and you only need the conclusion. The model writes the task each time it calls the tool; the child cannot ask follow-up questions, so the task must include all the context it needs.

The `make_subagent``makeSubagent` factory uses [axis policies](/docs/user-guide/sdk/tools/vended-tools/index.md#multi-agent-tools) to control what the model can configure on each child. The configurable axes are `instructions`, `tools`, `model`, and `context`. The parent also passes a task to the child.

By default, the child sees only the task (`context=Fixed("none")``context: new Fixed('none')`), but you can share the parent’s conversation by setting `context` to a `Choice` over `"none"`, `"all"` (full history including tool calls), and `"no_tools"` (text turns only). When a non-`"none"` option is available, the model can also pass `last_messages` to limit how many parent messages to share.

*Supported in: Python, TypeScript (Node.js, browsers).*

**Quickstart example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { subagent } from '@strands-agents/sdk/vended-tools/subagent'

const agent = new Agent({
  systemPrompt: 'You are a manager.',
  tools: [subagent],
})
await agent.invoke('Research the latest TypeScript 5.x features and summarize them.')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools.subagent import subagent

agent = Agent(
    system_prompt="You are a manager.",
    tools=[subagent],
)
agent("Research the latest Python 3.13 features and summarize them.")
```
(( /tab "Python" ))

**Example — full control with `make_subagent``makeSubagent`:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { Choice, Option, Preset } from '@strands-agents/sdk/multiagent'
import { makeSubagent } from '@strands-agents/sdk/vended-tools/subagent'

const subagent = makeSubagent({
  presets: {
    researcher: new Preset({
      instructions: 'You research topics thoroughly.',
      description: 'deep research on a topic',
    }),
    reviewer: new Preset({
      instructions: 'You review code for correctness and style.',
      description: 'code review',
    }),
  },
  model: new Choice([
    new Option('fast', 'global.anthropic.claude-sonnet-4-6', 'quick tasks'),
    new Option('deep', 'global.anthropic.claude-opus-4-6-v1', 'hard problems'),
  ]),
  context: new Choice(['none', 'all', 'no_tools']),
  tools: new Choice(['read', 'shell', 'write'], true),
  maxDepth: 3,
})
const agent = new Agent({ tools: [subagent] })
await agent.invoke('Review the changes in src/main.ts for correctness.')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.multiagent.spec import Choice, Option, Preset
from strands.vended_tools.subagent import make_subagent

subagent = make_subagent(
    presets={
        "researcher": Preset(
            instructions="You research topics thoroughly.",
            description="deep research on a topic",
        ),
        "reviewer": Preset(
            instructions="You review code for correctness and style.",
            description="code review",
        ),
    },
    model=Choice([
        Option("fast", "global.anthropic.claude-sonnet-4-6", "quick tasks"),
        Option("deep", "global.anthropic.claude-opus-4-6-v1", "hard problems"),
    ]),
    context=Choice(["none", "all", "no_tools"]),
    tools=Choice(["read", "shell", "write"], multiple=True),
    max_depth=3,
)
agent = Agent(tools=[subagent])
agent("Review the changes in src/main.py for correctness.")
```
(( /tab "Python" ))

Full API reference: [TypeScript](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/subagent/README.md)

## Related pages

- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) (1 shared tag)
- [File editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) (1 shared tag)
- [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) (1 shared tag)
- [Handoff to User](/docs/user-guide/sdk/tools/vended-tools/handoff-to-user/index.md) (1 shared tag)
- [HTTP request](/docs/user-guide/sdk/tools/vended-tools/http-request/index.md) (1 shared tag)


## Implementation

### TypeScript

- [harness-sdk/strands-ts/src/vended-tools/subagent/subagent.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/subagent/subagent.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/subagent/subagent.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/subagent/subagent.py)
