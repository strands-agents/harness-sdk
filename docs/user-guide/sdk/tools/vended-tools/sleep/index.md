Pauses the agent for a bounded number of seconds. Cancelling the enclosing invocation aborts the sleep immediately rather than waiting for the full duration, so a long timer never ties up a session the caller has moved on from.

*Supported in: Node.js, modern browsers (TypeScript); all platforms (Python).*

The maximum duration is configurable at construction (default: 60 seconds) and cannot be raised by the model. Negative, `NaN`, infinite, non-numeric, and boolean durations are rejected at the tool boundary.

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { sleep } from '@strands-agents/sdk/vended-tools/sleep'

const agent = new Agent({
  tools: [sleep],
})
await agent.invoke('Pause for two seconds, then continue.')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import sleep

agent = Agent(tools=[sleep])
agent("Pause for two seconds, then continue.")
```
(( /tab "Python" ))

**Custom maximum:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { makeSleep } from '@strands-agents/sdk/vended-tools/sleep'

const shortSleep = makeSleep({ maxDuration: 5 })
const agent = new Agent({ tools: [shortSleep] })
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import make_sleep

short_sleep = make_sleep(max_duration=5)
agent = Agent(tools=[short_sleep])
```
(( /tab "Python" ))

[Full API reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/sleep/README.md)

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

- [harness-sdk/strands-ts/src/vended-tools/sleep/sleep.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/sleep/sleep.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/sleep/sleep.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/sleep/sleep.py)
