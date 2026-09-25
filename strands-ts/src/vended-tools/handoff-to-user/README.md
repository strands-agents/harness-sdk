# Handoff to User Tool

Pauses the agent and surfaces a message to the user for human-in-the-loop input.

Use this when the agent cannot proceed without confirmation, approval, or information that only the user has — not to deliver a final answer or report progress. The tool takes a non-empty `message`. Calling it raises an interrupt that halts the agent and surfaces the message to the caller. When the caller resumes the agent with a response, the user's reply is returned as the tool result and the model continues.

Every interrupt raised by this tool reports the stable name `HANDOFF_INTERRUPT_NAME`, regardless of the tool's own name. Callers can match on that constant to reliably identify handoff interrupts, even when the tool is renamed via `makeHandoffToUser({ name })`.

## Usage

```typescript
import { Agent, InterruptResponseContent } from '@strands-agents/sdk'
import { handoffToUser, HANDOFF_INTERRUPT_NAME } from '@strands-agents/sdk/vended-tools/handoff-to-user'

const agent = new Agent({
  tools: [handoffToUser],
  systemPrompt: 'Before deleting any files, call handoff_to_user to confirm with the user.',
})

// The agent stops when it calls the tool. The message is surfaced on the interrupt.
let result = await agent.invoke('Delete all .tmp files in /workspace.')
const interrupt = result.interrupts?.find((i) => i.name === HANDOFF_INTERRUPT_NAME)
if (interrupt) {
  console.log(interrupt.reason)
  // Resume with the user's reply, which becomes the tool result.
  result = await agent.invoke([new InterruptResponseContent({ interruptId: interrupt.id, response: 'confirmed' })])
}
```

## API

### `makeHandoffToUser(options?)`

| Option        | Type     | Default           | Description                     |
| ------------- | -------- | ----------------- | ------------------------------- |
| `name`        | `string` | `handoff_to_user` | Tool name.                      |
| `description` | `string` | (built-in)        | Description shown to the model. |

### `handoffToUser`

The default tool, produced by `makeHandoffToUser()`.

### `HANDOFF_INTERRUPT_NAME`

The name reported on every interrupt raised by this tool. Stable across renames; match on it to identify handoff interrupts.

### Input

| Property  | Type     | Required | Description                                            |
| --------- | -------- | -------- | ------------------------------------------------------ |
| `message` | `string` | Yes      | The message to surface to the user. Must be non-empty. |

### Output

Raises an interrupt on invocation; the agent stops with the message surfaced on the interrupt's `reason`. On resume, returns the user's reply as the tool result.
