Lets your agent spin up a team of specialised sub-agents that collaborate autonomously via handoffs to solve a complex task. This is a meta-agent tool where the model defines each agent’s name and role; the tool resolves those specs through an authority-mode system, builds the agents, runs the swarm, and returns a consolidated result.

Use the factory to control safety limits, lock down instructions or tools with [axis policies](/docs/user-guide/sdk/tools/vended-tools/index.md#multi-agent-tools), or supply named presets the model can select from.

*Supported in: Python, TypeScript (Node.js, browsers).*

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { swarm } from '@strands-agents/sdk/vended-tools/swarm'

const agent = new Agent({ tools: [swarm] })
await agent.invoke(
  'Research the pros and cons of microservices vs monoliths and write a summary'
)
```

Custom configuration with `makeSwarm`. `maxAgents` caps agents per call; the other limits pass through to `Swarm`: `maxSteps` caps total agent executions, and `timeout` and `nodeTimeout` are in milliseconds.

```typescript
import { Agent } from '@strands-agents/sdk'
import { Choice, Fixed, Inherit, Preset } from '@strands-agents/sdk/multiagent'
import { makeSwarm } from '@strands-agents/sdk/vended-tools/swarm'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { webFetch } from '@strands-agents/sdk/vended-tools/web-fetch'

const swarm = makeSwarm({
  presets: {
    researcher: new Preset({
      instructions: 'You search for and synthesise information.',
      tools: ['http_request', 'web_fetch'],
      description: 'Gathers raw information from the web.',
    }),
    writer: new Preset({
      instructions: 'You write clear, engaging prose.',
      description: 'Turns research into polished text.',
    }),
  },
  defaultPreset: 'researcher',
  instructions: new Choice([
    'You are a researcher.',
    'You are a writer.',
    'You are an editor.',
  ]),
  tools: new Inherit(),
  model: new Fixed('us.amazon.nova-pro-v1:0'),
  maxAgents: 5,
  maxSteps: 15,
  timeout: 300_000,
  nodeTimeout: 120_000,
  repetitiveHandoffDetectionWindow: 6,
  repetitiveHandoffMinUniqueAgents: 3,
})
const agent = new Agent({ tools: [swarm, httpRequest, webFetch] })
await agent.invoke('Write a blog post about AI agents')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import swarm

agent = Agent(tools=[swarm])
agent("Research the pros and cons of microservices vs monoliths and write a summary")
```

Custom configuration with `make_swarm`. `max_agents` caps agents per call; the other limits pass through to `Swarm`: `max_handoffs` and `max_iterations` cap handoffs and agent executions separately, and `execution_timeout` and `node_timeout` are in seconds.

```python
from strands import Agent
from strands.multiagent.spec import Choice, Fixed, Inherit, Preset
from strands.vended_tools import make_swarm
from strands.vended_tools import http_request, web_fetch

swarm = make_swarm(
    presets={
        "researcher": Preset(
            instructions="You search for and synthesise information.",
            tools=["http_request", "web_fetch"],
            description="Gathers raw information from the web.",
        ),
        "writer": Preset(
            instructions="You write clear, engaging prose.",
            description="Turns research into polished text.",
        ),
    },
    default_preset="researcher",
    instructions=Choice(["You are a researcher.", "You are a writer.", "You are an editor."]),
    tools=Inherit(),
    model=Fixed("us.amazon.nova-pro-v1:0"),
    max_agents=5,
    max_handoffs=10,
    max_iterations=15,
    execution_timeout=300.0,
    node_timeout=120.0,
    repetitive_handoff_detection_window=6,
    repetitive_handoff_min_unique_agents=3,
)
agent = Agent(tools=[swarm, http_request, web_fetch])
agent("Write a blog post about AI agents")
```
(( /tab "Python" ))

Full API reference: [TypeScript](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/swarm/README.md)

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

- [harness-sdk/strands-ts/src/vended-tools/swarm/swarm.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/swarm/swarm.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/swarm/swarm.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/swarm/swarm.py)
