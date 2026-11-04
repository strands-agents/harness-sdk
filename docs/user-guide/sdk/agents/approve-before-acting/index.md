An agent chooses and runs its own tools. Most calls are fine to run unattended, but a few, such as deleting files or sending an email, should wait for a person to sign off. Asking about every call leads to [decision fatigue](https://en.wikipedia.org/wiki/Decision_fatigue): people start approving without reading. The `HumanInTheLoop` intervention handler, with its risk classifier turned on, asks only about the calls that matter: a model rates each tool call, safe calls run, and risky ones pause the agent until a person approves or rejects them.

## Ask before risky tool calls

To have a person approve risky calls, add the handler with the classifier, terminal prompts, and trust turned on. This agent cleans up log files. Listing a directory is safe, so it runs. Deleting files can’t be undone, so the agent asks first:

(( tab "Python" ))
```python
from strands import Agent, tool
from strands.vended_interventions.hitl import HumanInTheLoop


@tool
def list_files(directory: str) -> list[str]:
    """List the files in a directory."""
    return ["app.log", "app.log.1", "app.log.2"]


@tool
def delete_files(paths: list[str]) -> str:
    """Delete the files at the given paths."""
    return f"Deleted {len(paths)} files"


agent = Agent(
    tools=[list_files, delete_files],
    interventions=[HumanInTheLoop(classifier=True, ask="stdio", enable_trust=True)],
)

agent("Delete the rotated logs in /var/log/app")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'
import { z } from 'zod'

const listFiles = tool({
  name: 'list_files',
  description: 'List the files in a directory.',
  inputSchema: z.object({ directory: z.string() }),
  callback: () => ['app.log', 'app.log.1', 'app.log.2'],
})

const deleteFiles = tool({
  name: 'delete_files',
  description: 'Delete the files at the given paths.',
  inputSchema: z.object({ paths: z.array(z.string()) }),
  callback: ({ paths }) => `Deleted ${paths.length} files`,
})

const agent = new Agent({
  tools: [listFiles, deleteFiles],
  interventions: [
    new HumanInTheLoop({ classifier: true, ask: 'stdio', enableTrust: true }),
  ],
})

await agent.invoke('Delete the rotated logs in /var/log/app')
```
(( /tab "TypeScript" ))

Typical output:

```plaintext
Let me start by listing the files in that directory to identify the rotated logs.
Tool #1: list_files
The rotated logs are `app.log.1` and `app.log.2`. Let me delete them now.
Tool #2: delete_files
Approve "delete_files" — Deleting files is irreversible and destructive.?
  Input: {"paths": ["/var/log/app/app.log.1", "/var/log/app/app.log.2"]} (y/n/t): y
Done! The 2 rotated log files have been removed, while the current active log file
(`app.log`) was left untouched.
```

Before each tool call, the classifier sends the tool name and input to a model and asks whether the call needs approval. `list_files` runs without a prompt. For `delete_files`, the handler prints the approval prompt in the terminal, with the classifier’s reason, and the agent waits for the answer:

-   `y` or `yes` approves this call.
-   `t` or `trust` approves this call and every later call to the same tool, for as long as the agent exists.
-   Anything else rejects the call. The agent learns it was rejected, so it can tell the user or try something else.

The default classifier is an LLM acting as a judge. It runs on the agent’s model, or on the [auxiliary model](/docs/user-guide/sdk/model-providers/index.md#auxiliary-model) when you set one. You can swap in a System One model instead, a small model built to answer closed questions fast, such as Jev or [Strands Decider](https://github.com/strands-labs/strands-decider), or bring your own classifier function. [Human in the loop](/docs/user-guide/sdk/agents/interventions/human-in-the-loop/index.md#risk-classifier) shows each option. Without a classifier, every tool call prompts.

## Set hard limits

The classifier is a judgment, not a guarantee: it can rate a risky call safe. For a tool that must always ask, negate it with `allowed_tools=["!delete_files"]``allowedTools: ['!delete_files']`. A negated tool always prompts and can’t be trusted.

For limits no one can approve past, such as tools only some users may call, add [Cedar Authorization](/docs/user-guide/sdk/agents/interventions/cedar-authorization/index.md) before `HumanInTheLoop`. Cedar denies any call that no policy permits, so the classifier and the person never see it. Here anyone may list files, but only `alice` may delete them:

(( tab "Python" ))
```python
from strands.vended_interventions.cedar import CedarAuthorization

cedar = CedarAuthorization(
    policies="""
      permit(principal, action == Action::"list_files", resource);

      permit(
        principal == User::"alice",
        action == Action::"delete_files",
        resource
      );
    """,
    principal_resolver=lambda state: {"type": "User", "id": state["user_id"]},
)

agent = Agent(
    tools=[list_files, delete_files],
    interventions=[
        cedar,
        HumanInTheLoop(classifier=True, ask="stdio", enable_trust=True),
    ],
)

# alice is asked to approve the delete
agent("Delete the rotated logs in /var/log/app", invocation_state={"user_id": "alice"})

# bob's delete is denied without a prompt
agent("Delete the rotated logs in /var/log/app", invocation_state={"user_id": "bob"})
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'
import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'

const cedar = new CedarAuthorization({
  policies: `
    permit(principal, action == Action::"list_files", resource);

    permit(
      principal == User::"alice",
      action == Action::"delete_files",
      resource
    );
  `,
  principalResolver: (state) => ({ type: 'User', id: String(state.user_id) }),
})

const agent = new Agent({
  tools: [listFiles, deleteFiles],
  interventions: [
    cedar,
    new HumanInTheLoop({ classifier: true, ask: 'stdio', enableTrust: true }),
  ],
})

// alice is asked to approve the delete
await agent.invoke('Delete the rotated logs in /var/log/app', {
  invocationState: { user_id: 'alice' },
})

// bob's delete is denied without a prompt
await agent.invoke('Delete the rotated logs in /var/log/app', {
  invocationState: { user_id: 'bob' },
})
```
(( /tab "TypeScript" ))

Interventions run in the order you list them, and a denial skips the rest, so put Cedar first.

If the classifier’s model call fails, the handler asks a person to approve that tool call, so a classifier outage never lets a risky call run unchecked.

## Next steps

-   [Human in the loop](/docs/user-guide/sdk/agents/interventions/human-in-the-loop/index.md): pause the agent and resume it from a web service instead of prompting at the terminal, collect answers in a custom UI, let known-safe tools skip review, classify with a System One model or your own function, change the classifier’s prompt or model, and define what counts as approval.
-   [Cedar Authorization](/docs/user-guide/sdk/agents/interventions/cedar-authorization/index.md): give each user a role, rate-limit tools, and check policies against your tool schemas.
-   [Interrupts](/docs/user-guide/sdk/interrupts/index.md): pause the agent from your own hooks and tools.
-   [Interventions](/docs/user-guide/sdk/agents/interventions/index.md): write your own handler to deny, guide, or transform tool calls.

## Related pages

- [Human in the loop](/docs/user-guide/sdk/agents/interventions/human-in-the-loop/index.md) (2 shared tags)
- [Cedar Authorization](/docs/user-guide/sdk/agents/interventions/cedar-authorization/index.md) (2 shared tags)
- [Interventions](/docs/user-guide/sdk/agents/interventions/index.md) (2 shared tags)
- [Creating a Custom Model Provider](/docs/user-guide/sdk/model-providers/custom_model_provider/index.md) (1 shared tag)
- [Tools](/docs/user-guide/sdk/bidi/tools/index.md) (1 shared tag)
- [Middleware](/docs/user-guide/sdk/agents/middleware/index.md) (1 shared tag)
- [Tool Executors](/docs/user-guide/sdk/tools/executors/index.md) (1 shared tag)
- [Available Sandboxes](/docs/user-guide/sdk/sandbox/available-sandboxes/index.md) (1 shared tag)
- [Building a Custom Sandbox](/docs/user-guide/sdk/sandbox/custom-sandbox/index.md) (1 shared tag)
- [Sandbox](/docs/user-guide/sdk/sandbox/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/vended_interventions/hitl/hitl.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/hitl/hitl.py)

### TypeScript

- [harness-sdk/strands-ts/src/vended-interventions/hitl/hitl.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-interventions/hitl/hitl.ts)
