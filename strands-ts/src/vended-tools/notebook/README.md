# Notebook Tool

A tool for managing persistent text notebooks within agent sessions. The notebook tool allows agents to create, read, write, list, and clear notebooks with automatic state persistence.

## Installation

```typescript
import { Agent, BedrockModel } from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'
```

## Quick Start

### Creating an Agent with the Notebook Tool

```typescript
import { Agent, BedrockModel } from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'

// Create an agent with the notebook tool
const agent = new Agent({
  model: new BedrockModel({
    region: 'us-east-1',
  }),
  tools: [notebook],
})

// Use natural language to interact with notebooks
await agent.invoke('Create a notebook called "ideas" with the title "# Project Ideas"')
await agent.invoke('Add "- Build a web scraper" to the ideas notebook')
await agent.invoke('Add "- Create a CLI tool" to the ideas notebook')
await agent.invoke('Read the ideas notebook')
```

### Customising with `makeNotebook`

Use `makeNotebook` to configure the tool's name, description, or per-notebook size cap before passing it to the agent.

```typescript
import { makeNotebook } from '@strands-agents/sdk/vended-tools/notebook'

// Custom name and a 64 KiB cap per notebook
const scratchpad = makeNotebook({
  name: 'scratchpad',
  description: 'A scratchpad for working notes.',
  maxNotebookSizeBytes: 65_536,
})

const agent = new Agent({
  model: new BedrockModel({
    region: 'us-east-1',
  }),
  tools: [scratchpad],
})
```

`makeNotebook` validates its arguments at call time:

- `name` must be a non-empty string.
- `maxNotebookSizeBytes` must be a positive integer. Defaults to 1 MiB (1,048,576 bytes).

### State Persistence

The notebook tool automatically persists state within an agent session:

```typescript
// Notebooks persist across multiple invocations
await agent.invoke('Create a notebook called "todo" with "# Tasks"')
await agent.invoke('Add "- [ ] Review code" to the todo notebook')
await agent.invoke('Add "- [ ] Write tests" to the todo notebook')

// State is accessible via the agent
console.log(agent.appState.get('notebooks'))
// Output: { todo: '# Tasks\n- [ ] Review code\n- [ ] Write tests' }
```

### Saving and Restoring State

Save notebook state across application restarts:

```typescript
// Save the current state
const savedState = agent.appState.getAll()

// Later, create a new agent with the saved state
const restoredAgent = new Agent({
  model: new BedrockModel({
    region: 'us-east-1',
  }),
  tools: [notebook],
  appState: savedState, // Restore previous notebooks
})

// All notebooks are immediately available
await restoredAgent.invoke('List all notebooks')
await restoredAgent.invoke('Read the todo notebook')
```

## Notebook Operations

The agent can perform these operations through natural language:

- **Create**: "Create a notebook called 'notes' with '# My Notes'"
- **List**: "List all notebooks"
- **Read**: "Read the notes notebook" or "Read lines 5-10 from notes"
- **Write**:
  - Append: "Append 'new line' to the notes notebook"
  - Replace: "Replace 'old text' with 'new text' in notes"
  - Insert: "Insert 'new line' after 'old line' in notes"
- **Clear**: "Clear the notes notebook"

## Example: Building a Task Manager

```typescript
const agent = new Agent({
  model: new BedrockModel({
    region: 'us-east-1',
  }),
  tools: [notebook],
})

// Create a task list
await agent.invoke('Create a notebook called "tasks" with "# Daily Tasks\n\n## Todo\n"')

// Add tasks
await agent.invoke('Add "- [ ] Morning standup" to the tasks notebook')
await agent.invoke('Add "- [ ] Code review" to the tasks notebook')
await agent.invoke('Add "- [ ] Update documentation" to the tasks notebook')

// Complete a task
await agent.invoke('Replace "- [ ] Morning standup" with "- [x] Morning standup" in tasks')

// Check progress
const result = await agent.invoke('Read the tasks notebook')

// Save state for tomorrow
const taskState = agent.appState.getAll()
// Store taskState in your database/file system
```

## Direct Tool Usage

You can also use the notebook tool directly without an agent:

```typescript
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'
import { StateStore } from '@strands-agents/sdk'

const state = new StateStore({ notebooks: {} })
const agent = { appState: state }
const context = {
  agent,
  toolUse: { name: 'notebook', toolUseId: 'test', input: {} },
}

// Create and write to a notebook
await notebook.invoke(
  {
    mode: 'create',
    name: 'direct',
    newStr: 'Direct notebook content',
  },
  context
)

// Read the notebook
const content = await notebook.invoke(
  {
    mode: 'read',
    name: 'direct',
  },
  context
)
```

## Key Features

- **Multiple Notebooks**: Manage multiple named notebooks simultaneously
- **Automatic Persistence**: State persists within agent sessions automatically
- **Natural Language**: Interact with notebooks using natural language through the agent
- **State Management**: Save and restore notebook state across application restarts
- **Size Limits**: Configurable per-notebook size cap (default 1 MiB) to prevent unbounded state growth
- **Type Safety**: Full TypeScript support with runtime validation
- **Universal**: Works in both browser and server environments

## API Reference

### `makeNotebook(options?)`

Creates a notebook tool instance.

| Option                 | Type     | Default              | Description                                                                |
| ---------------------- | -------- | -------------------- | -------------------------------------------------------------------------- |
| `name`                 | `string` | `"notebook"`         | Tool name exposed to the model. Must be non-empty.                         |
| `description`          | `string` | Built-in description | Tool description shown to the model.                                       |
| `maxNotebookSizeBytes` | `number` | `1_048_576`          | Maximum UTF-8 byte size for a single notebook. Must be a positive integer. |

The size cap is enforced after `create` and `write` operations (the only two that can grow a notebook). `clear` is never capped. If content would exceed the cap, the operation throws before persisting state.

### `notebook`

The default export — equivalent to `makeNotebook()` with all defaults.

### Input Schema

```typescript
type NotebookInput = {
  mode: 'create' | 'list' | 'read' | 'write' | 'clear'
  name?: string // Notebook name (defaults to 'default')
  newStr?: string // Content for create or append; replacement/insertion text for write
  oldStr?: string // Text to replace (write mode)
  insertLine?: string | number // Line to insert after (write mode)
  readRange?: [number, number] // Line range for read (1-indexed)
}
```

### State Structure

```typescript
interface NotebookState {
  notebooks: Record<string, string> // name -> content mapping
}
```

## License

Same license as the Strands SDK.
