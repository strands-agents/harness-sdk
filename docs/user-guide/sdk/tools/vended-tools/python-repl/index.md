Runs model-generated Python through the agent’s [sandbox](/docs/user-guide/sdk/sandbox/index.md) by calling `sandbox.execute_code(code, "python3")` (`sandbox.executeCode(code, 'python3')` in TypeScript). It returns `output` (stdout), `error` (stderr, including tracebacks), and `exit_code`. Each call runs in a fresh interpreter, so variables, imports, and definitions do not persist across calls. Files written to the sandbox filesystem do persist, so the model can checkpoint intermediate results to disk and load them in a later call.

*Supported in: Node.js on Unix/Linux/macOS (TypeScript), Python.*

Security Warning

This tool executes arbitrary Python code. Without a [Sandbox](/docs/user-guide/sdk/sandbox/index.md), code runs with the full permissions of the process. Only use with trusted input and consider running in a [sandboxed environment](/docs/user-guide/sdk/sandbox/index.md) for production.

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { pythonRepl } from '@strands-agents/sdk/vended-tools/python-repl'

const agent = new Agent({ tools: [pythonRepl] })
await agent.invoke(
  'Use python_repl to compute the first 10 Fibonacci numbers and print them.'
)
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import python_repl

agent = Agent(tools=[python_repl])
agent("Use python_repl to compute the first 10 Fibonacci numbers and print them.")
```
(( /tab "Python" ))

**Bound sandbox or custom interpreter:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { DockerSandbox } from '@strands-agents/sdk/sandbox/docker'
import { makePythonRepl } from '@strands-agents/sdk/vended-tools/python-repl'

const pythonRepl = makePythonRepl(new DockerSandbox({ container: 'my-container' }), {
  language: 'python3.12',
})
const agent = new Agent({ tools: [pythonRepl] })
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.sandbox.docker import DockerSandbox
from strands.vended_tools import make_python_repl

python_repl = make_python_repl(
    sandbox=DockerSandbox("my-container"),  # bind at creation instead of reading agent.sandbox
    language="python3.12",  # interpreter on the sandbox's PATH
)
agent = Agent(tools=[python_repl])
```
(( /tab "Python" ))

[Full API reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/python-repl/README.md)

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

- [harness-sdk/strands-ts/src/vended-tools/python-repl/python-repl.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/python-repl/python-repl.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/python_repl/python_repl.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/python_repl/python_repl.py)
