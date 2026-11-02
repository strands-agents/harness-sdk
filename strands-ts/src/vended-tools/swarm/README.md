# Swarm Tool

Spins up a team of agents at runtime that solve a task together by handing off to one another, then returns each participating agent's final output.

The model defines the agents it needs on each call: a unique `name` plus whichever of `agent_type`, `instructions`, `tools`, and `model` the axis policies expose. The tool resolves each spec, builds the agents, and runs them as a [`Swarm`](../../multiagent/swarm.ts). The `entry_point` agent (default: the first) receives the task; the run ends when an agent finishes without handing off. Agents never receive a swarm tool, so swarms do not nest.

`makeSwarm` takes axis policies from `@strands-agents/sdk/multiagent` that control which parameters the model sees for each agent, plus the `Swarm` limits (`maxSteps`, `timeout`, `nodeTimeout`, and repetitive-handoff detection).

## Usage

```typescript
import { Agent } from '@strands-agents/sdk'
import { swarm } from '@strands-agents/sdk/vended-tools/swarm'

const agent = new Agent({ tools: [swarm] })
await agent.invoke('Research the pros and cons of microservices vs monoliths and write a summary.')
```

Presets, a tool subset, and limits:

```typescript
import { Agent } from '@strands-agents/sdk'
import { Choice, Preset } from '@strands-agents/sdk/multiagent'
import { makeSwarm } from '@strands-agents/sdk/vended-tools/swarm'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { webFetch } from '@strands-agents/sdk/vended-tools/web-fetch'

const team = makeSwarm({
  presets: {
    researcher: new Preset({ instructions: 'You gather information.', description: 'researches' }),
    writer: new Preset({ instructions: 'You write clear prose.', description: 'writes' }),
  },
  tools: new Choice(['http_request', 'web_fetch'], true),
  maxAgents: 5,
  maxSteps: 10,
  timeout: 300_000,
})
const agent = new Agent({ tools: [team, httpRequest, webFetch] })
```

## API

### `swarm`

The default tool, produced by `makeSwarm()`: no presets, free-form `instructions`, inherited tools and model, and bounded limits: 20 agent executions, a 15-minute swarm timeout, and a 5-minute per-agent timeout. Repetitive-handoff detection is off. Pass `Infinity` to `makeSwarm` to lift a limit.

### `makeSwarm(options?)`

| Option                             | Type                         | Default                     | Description                                                                 |
| ---------------------------------- | ---------------------------- | --------------------------- | --------------------------------------------------------------------------- |
| `builder`                          | `(spec: AgentSpec) => Agent` | (inherits from parent)      | Turns a resolved spec into an agent. The agent's `id` is its swarm node id. |
| `presets`                          | `Record<string, Preset>`     | `{}`                        | Named roles the model selects via `agent_type`.                             |
| `defaultPreset`                    | `string`                     | first preset                | Preset used when the model omits `agent_type`.                              |
| `instructions`                     | `Open \| Choice \| Fixed`    | `new Open()`                | Policy for each agent's system prompt.                                      |
| `tools`                            | `Choice \| Fixed \| Inherit` | `new Inherit()`             | Policy for each agent's tools. A `Choice` must be `multiple`.               |
| `model`                            | `Inherit \| Choice \| Fixed` | `new Inherit()`             | Policy for each agent's model.                                              |
| `maxAgents`                        | `number`                     | `20`                        | Upper bound on agents per call. Must be a positive integer.                 |
| `maxSteps`                         | `number`                     | `20`                        | Max total agent executions.                                                 |
| `timeout`                          | `number`                     | `900_000`                   | Wall-clock ceiling for the whole swarm, in milliseconds.                    |
| `nodeTimeout`                      | `number`                     | `300_000`                   | Per-agent wall-clock ceiling, in milliseconds.                              |
| `repetitiveHandoffDetectionWindow` | `number`                     | `Swarm` default             | Window size for repetitive-handoff detection.                               |
| `repetitiveHandoffMinUniqueAgents` | `number`                     | `Swarm` default             | Minimum unique agents required in the window.                               |
| `name`                             | `string`                     | `swarm`                     | Tool name.                                                                  |
| `description`                      | `string`                     | `DEFAULT_SWARM_DESCRIPTION` | Tool description.                                                           |

Throws if `name` or `description` is empty, `maxAgents` is not a positive integer, `defaultPreset` is not one of `presets`, or a `Choice` axis has no options, or a `tools` `Choice` is not `multiple`.

The default builder gives each agent the parent's model and tools (narrowed by the resolved spec), sandbox, printer setting, and trace attributes, plus `contextManager: 'auto'` unless the agent's model is stateful. The agent's `name` and `id` are its spec name.

### Input

| Property      | Type       | Required | Description                                                                       |
| ------------- | ---------- | -------- | --------------------------------------------------------------------------------- |
| `task`        | `string`   | Yes      | The objective for the agent team.                                                 |
| `agents`      | `object[]` | Yes      | Agent specifications: `name` plus the axis properties the policies expose.        |
| `entry_point` | `string`   | No       | Name of the agent that receives the task and starts the swarm. Defaults to first. |

### Output

Returns each participating agent's latest output as `name: output` lines. Returns an error result with the partial output when the swarm does not complete (an agent fails, a handoff loop is detected, or a step or time limit is hit), and an error result when the input is invalid.

If an agent stops on interrupts, they are raised on the parent with the id `swarm:<toolUseId>:<agentInterruptId>` (`toolUseId` URI-encoded) and the agent's original `name` and `reason`. The interrupted swarm's state is stored in the parent's interrupt state, so resuming the parent resumes the swarm, including after the parent is restored from a session. On resume the swarm's agents are rebuilt from the same input, so a custom `builder` must give each spec the same agent id.
