Lets the model pause the agent loop and surface a message to the user for human-in-the-loop input. Use this when the agent needs explicit confirmation, additional information, or user approval before proceeding.

*Supported in: Node.js, modern browsers (TypeScript); all platforms (Python).*

Bidirectional streaming not supported

`handoff_to_user` relies on the interrupt/resume mechanism, which requires the agent loop to fully halt and restart. It cannot be used inside bidirectional streaming sessions, where the loop runs continuously without a clean pause point.

The loop halts with a `stop_reason` / `stopReason` of `"interrupt"` and the message is available on the interrupt’s `reason` field in `AgentResult.interrupts`. Resume the agent by passing back an `interruptResponse` content block with the interrupt ID and the user’s reply; the tool then returns that reply as its result and the model continues. To recognize a handoff interrupt, match its `name` against the exported `HANDOFF_INTERRUPT_NAME` constant.

Combining with HumanInTheLoop

`HumanInTheLoop()` requires approval for every tool by default, so pairing it with `handoff_to_user` prompts the user twice — once to approve the call, then again to answer it. Allow-list the tool with `HumanInTheLoop(allowed_tools=["handoff_to_user"])` / `new HumanInTheLoop({ allowedTools: ["handoff_to_user"] })` so only the handoff itself prompts.

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent, InterruptResponseContent } from '@strands-agents/sdk'
import {
  handoffToUser,
  HANDOFF_INTERRUPT_NAME,
} from '@strands-agents/sdk/vended-tools/handoff-to-user'

const agent = new Agent({
  tools: [handoffToUser],
  systemPrompt:
    'Before deleting any files, call handoff_to_user to confirm with the user.',
})

let result = await agent.invoke('Delete all .tmp files in /workspace.')
const interrupt = result.interrupts?.find((i) => i.name === HANDOFF_INTERRUPT_NAME)
if (interrupt) {
  console.log(interrupt.reason)
  result = await agent.invoke([
    new InterruptResponseContent({ interruptId: interrupt.id, response: 'confirmed' }),
  ])
}
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools.handoff_to_user import HANDOFF_INTERRUPT_NAME, handoff_to_user

agent = Agent(
    tools=[handoff_to_user],
    system_prompt=(
        "Before deleting any files, call handoff_to_user to confirm with the user."
    ),
)

result = agent("Delete all .tmp files in /workspace.")
interrupt = next(i for i in (result.interrupts or []) if i.name == HANDOFF_INTERRUPT_NAME)
print(interrupt.reason)

resumed = agent([
    {
        "interruptResponse": {
            "interruptId": interrupt.id,
            "response": "confirmed",
        }
    }
])
```
(( /tab "Python" ))

📖 [Full API Reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/handoff-to-user/README.md)

## Related pages

- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) (1 shared tag)
- [File editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) (1 shared tag)
- [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) (1 shared tag)
- [HTTP request](/docs/user-guide/sdk/tools/vended-tools/http-request/index.md) (1 shared tag)
- [MCP Router](/docs/user-guide/sdk/tools/vended-tools/mcp-router/index.md) (1 shared tag)


## Implementation

### TypeScript

- [harness-sdk/strands-ts/src/vended-tools/handoff-to-user/handoff-to-user.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/handoff-to-user/handoff-to-user.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/handoff_to_user/handoff_to_user.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/handoff_to_user/handoff_to_user.py)
