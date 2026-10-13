# Subagent Tool

Delegates a self-contained task to a child agent that runs in its own context and returns a final report.

Use this when a subtask would otherwise flood the parent's context with intermediate work and only the conclusion matters. Each call builds a fresh child, runs it to completion, and returns its final message. The child cannot ask follow-up questions, so the task must carry all the context it needs. Nested delegation is capped by `maxDepth` (default: 2).

`makeSubagent` takes axis policies from `@strands-agents/sdk/multiagent` (`Fixed`, `Inherit`, `Open`, `Choice`) that control which parameters the model sees and which values it can pick for the child's `instructions`, `tools`, `mcpServers`, `model`, and `context`. Named roles are bundled into `Preset`s that the model selects via `agent_type`.

## Usage

```typescript
import { Agent } from '@strands-agents/sdk'
import { subagent } from '@strands-agents/sdk/vended-tools/subagent'

const agent = new Agent({ tools: [subagent] })
await agent.invoke('Research the latest TypeScript 5.x features and summarize them.')
```

Presets, shared context, and a tool subset:

```typescript
import { Choice, Preset } from '@strands-agents/sdk/multiagent'
import { makeSubagent } from '@strands-agents/sdk/vended-tools/subagent'

const subagent = makeSubagent({
  presets: {
    reviewer: new Preset({
      instructions: 'You review code for correctness and style.',
      description: 'code review',
    }),
  },
  context: new Choice(['none', 'all', 'no_tools']),
  tools: new Choice(['read', 'shell'], true),
})
const agent = new Agent({ tools: [subagent] })
```

## API

### `subagent`

The default tool, produced by `makeSubagent()`: the `generalist` preset, free-form `instructions`, inherited tools, MCP servers, and model, and no shared context.

### `makeSubagent(options?)`

| Option          | Type                         | Default                        | Description                                                                            |
| --------------- | ---------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| `builder`       | `(spec: AgentSpec) => Agent` | (inherits from parent)         | Turns a resolved spec into a child agent.                                              |
| `presets`       | `Record<string, Preset>`     | `{ generalist: GENERALIST }`   | Named roles the model selects via `agent_type`. Pass `{}` to disable presets.          |
| `defaultPreset` | `string`                     | first preset                   | Preset used when the model omits `agent_type`.                                         |
| `instructions`  | `Open \| Choice \| Fixed`    | `new Open()`                   | Policy for the child's system prompt.                                                  |
| `tools`         | `Choice \| Fixed \| Inherit` | `new Inherit()`                | Policy for the child's tools. A `Choice` must be `multiple`.                           |
| `mcpServers`    | `Choice \| Fixed \| Inherit` | `new Inherit()`                | Policy for the child's MCP servers (by `clientName`). A `Choice` must be `multiple`.   |
| `model`         | `Inherit \| Choice \| Fixed` | `new Inherit()`                | Policy for the child's model.                                                          |
| `context`       | `Fixed \| Choice`            | `new Fixed('none')`            | How much of the parent's conversation the child sees: `'none'`, `'all'`, `'no_tools'`. |
| `maxDepth`      | `number`                     | `2`                            | Upper bound on nested delegation levels. Must be a positive integer.                   |
| `name`          | `string`                     | `subagent`                     | Tool name.                                                                             |
| `description`   | `string`                     | `DEFAULT_SUBAGENT_DESCRIPTION` | Tool description. Available presets are appended.                                      |

Throws if `name` or `description` is empty, `maxDepth` is not a positive integer, `defaultPreset` is not one of `presets`, a `context` mode is not `'none'`, `'all'`, or `'no_tools'`, or a `tools` / `mcpServers` `Choice` has no options or is not `multiple`.

The default builder gives each child the parent's model, tools, and MCP servers (narrowed by the resolved spec), sandbox, printer setting, and trace attributes, plus `contextManager: 'auto'` unless the child's model is stateful. The parent's context-manager tools (such as `retrieve_context`) are not inherited; the child's own context manager provides them.

### Input

Only `task` is always present; the others appear depending on the configured policies.

| Property        | Type       | Required | Description                                                                     |
| --------------- | ---------- | -------- | ------------------------------------------------------------------------------- |
| `task`          | `string`   | Yes      | The self-contained task, including all context the subagent needs.              |
| `agent_type`    | `string`   | No       | Preset name. Present when presets are configured.                               |
| `instructions`  | `string`   | No       | System prompt for the child. Present when `instructions` is `Open` or `Choice`. |
| `tools`         | `string[]` | No       | Subset of tools to grant. Present when `tools` is a `Choice`.                   |
| `mcp_servers`   | `string[]` | No       | Subset of MCP servers to grant. Present when `mcpServers` is a `Choice`.        |
| `model`         | `string`   | No       | Model option name. Present when `model` is a `Choice`.                          |
| `context`       | `string`   | No       | Context option name. Present when `context` is a `Choice`.                      |
| `last_messages` | `number`   | No       | Share only the last N parent messages. Present when context can be shared.      |

### Output

Returns the child's final response as text. Returns an error result when `task` is missing, `agent_type` is unknown, the depth limit is reached, or the child throws or is cancelled.

If the child stops on an interrupt, it is raised on the parent with the id `subagent:<toolUseId>:<childInterruptId>` (`toolUseId` URI-encoded). Resuming the parent resumes the same child; the child is held in memory only, so it cannot be resumed after a process restart.
