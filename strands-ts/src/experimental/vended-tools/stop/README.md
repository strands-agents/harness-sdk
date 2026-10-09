# Stop Tool (Experimental)

> **This tool is experimental and subject to change in future revisions without notice.**

Lets the model gracefully end the agent loop when it decides its work is complete.

The model calls stop with an optional final message. The current tool batch runs to completion, then the loop ends without calling the model again. The final `AgentResult.stopReason` is `cancelled`, and the loop's last assistant `Message` carries a `TextBlock` whose text is the string the model passed to stop (or a default if it passed none).

This is a cooperative stop, not an abort. Any other tools the model requested in the same turn still run; the loop halts after the batch finishes, not mid-batch. For hard cancellation, use `agent.cancel()`.

## SDK behavior

Both SDKs halt on the same primitive — `agent.cancel({ message, afterCurrentTools: true })` / `agent.cancel(message, after_current_tools=True)` — and produce the same final `AgentResult`: `stopReason` / `stop_reason` is `"cancelled"`, and the stop text is the last assistant message in history (`result.lastMessage` / `result.message`).

## When to use it

The default agent loop already terminates when the model returns without any tool use. The stop tool is useful when:

- The model tends to keep calling tools past the point of usefulness and needs an explicit "I'm done" affordance.
- A workflow enforces that termination is a deliberate model decision (e.g. structured multi-step tasks) rather than an accident of not calling a tool.
- Sub-agents need to signal completion back to a coordinator via the text content of `AgentResult.lastMessage`.

If none of the above applies, you probably don't need to install this tool.

## Usage

```typescript
import { Agent } from '@strands-agents/sdk'
import { stop } from '@strands-agents/sdk/experimental/vended-tools/stop'

const agent = new Agent({
  model,
  tools: [stop],
  systemPrompt: 'Complete the task. Call stop with a short summary when you are done.',
})

const result = await agent.invoke('Summarize the changes in ./CHANGELOG.md')
console.log(result.stopReason) // 'cancelled'
// lastMessage is a Message; pull the text out of its content blocks:
const stopText = result.lastMessage.content
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('')
console.log(stopText) // The model's summary passed to stop()
```

## Input schema

```typescript
interface StopInput {
  /** Optional final assistant-facing message. Capped at 4096 characters. */
  message?: string | null
}
```

## How it works

The tool calls `context.agent.cancel({ message, afterCurrentTools: true })` and returns the message. The deferred flag leaves the agent's cancellation signal untripped, so the rest of the batch runs normally; the agent loop then observes the deferred cancel at its post-batch checkpoint, appends the message as the final assistant turn, and returns `stopReason: 'cancelled'` without calling the model again.

`agent.cancel()` is public, so any tool, hook, or plugin can end the loop the same way.

## Limitations

- Cooperative only. If the model requests stop alongside a very long-running tool call, the loop still waits for that call to finish before ending. Use `agent.cancel()` without `afterCurrentTools` if you need to bail out immediately.
- `stopReason: 'cancelled'` is also what external cancellation returns, so a caller that distinguishes the two needs to track the cancel it requested.
- Ending the loop does not drop the tool-result message or the surrounding turn; those remain in `agent.messages` as normal history.
