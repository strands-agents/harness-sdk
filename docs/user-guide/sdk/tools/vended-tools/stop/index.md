Lets the model gracefully end the agent loop with an optional final message. The default loop already terminates when the model returns without any tool call; the stop tool is useful when you want an explicit “I am done” affordance, when a workflow enforces that termination is a deliberate model decision, or when a sub-agent needs to signal completion back to a coordinator via the loop’s last assistant message.

*Supported in: Node.js, modern browsers (TypeScript); all platforms (Python).*

This is a cooperative stop, not an abort. Any other tools the model requested in the same turn still run to completion; the loop halts after that batch without calling the model again. The final message defaults to a 4096-character cap; pass `max_message_length` / `maxMessageLength` to `make_stop` / `makeStop` when a longer summary is legitimate.

Both SDKs stop the loop through `agent.cancel()` with the deferred flag (`agent.cancel({ message, afterCurrentTools: true })` / `agent.cancel(message=..., after_current_tools=True)`), so the final `AgentResult` is the same in each: `stopReason: "cancelled"` / `stop_reason: "cancelled"`, with the stop text as the last assistant message. A sub-agent that ends this way is reported as a successful result by `agent.as_tool()``agent.asTool()` and the subagent tool; only an immediate `agent.cancel()` is reported as an error.

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { stop } from '@strands-agents/sdk/vended-tools/stop'

const agent = new Agent({
  tools: [stop],
  systemPrompt: 'Complete the task. Call stop with a short summary when you are done.',
})
await agent.invoke('Summarize the changes in ./CHANGELOG.md')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import stop

agent = Agent(
    tools=[stop],
    system_prompt="Complete the task. Call stop with a short summary when you are done.",
)
result = agent("Summarize the changes in ./CHANGELOG.md")
```
(( /tab "Python" ))

[Full API reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/stop/README.md)

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

- [harness-sdk/strands-ts/src/vended-tools/stop/stop.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/stop/stop.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/stop/stop.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/stop/stop.py)
