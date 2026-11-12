You call a decision model from your own code: a tool, a hook, or the application around the agent. It runs outside the agent loop, so it isn’t a tool the agent picks, and it doesn’t add messages to the conversation.

## Ask from a tool

A tool can hand part of its work to a decision model. This tool routes a customer message to a team. Each tool call carries an invocation context, a handle to the agent request it belongs to. The tool passes it to `ask`, so the decision’s tokens count toward that request:

(( tab "Python" ))
```python
from strands import Agent, LLMDecisionModel, ToolContext, tool

decisions = LLMDecisionModel()


@tool(context=True)
async def route_message(message: str, tool_context: ToolContext) -> str:
    """Send a customer message to the team that handles it."""
    result = await decisions.ask(
        message,
        {
            "team": {
                "question": "Which team should handle this message?",
                "choices": ["billing", "shipping", "technical"],
                "uncertainty": False,
            },
        },
        invocation_context=tool_context.invocation_context,
    )
    return f"Routed to {result.answers['team']}"


agent = Agent(tools=[route_message])
result = agent("Route this message: my package never arrived.")
print(result.invocation_context.usage)

# Typical output:
# {'turns_taken': 2, 'inputTokens': 2162, 'outputTokens': 149, 'totalTokens': 2311}
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, LLMDecisionModel, tool } from '@strands-agents/sdk'
import { z } from 'zod'

const decisions = new LLMDecisionModel()

const routeMessage = tool({
  name: 'route_message',
  description: 'Send a customer message to the team that handles it.',
  inputSchema: z.object({ message: z.string() }),
  callback: async ({ message }, context) => {
    const result = await decisions.ask(
      message,
      {
        team: {
          question: 'Which team should handle this message?',
          choices: ['billing', 'shipping', 'technical'],
          uncertainty: false,
        },
      },
      {
        ...(context?.invocationContext && {
          invocationContext: context.invocationContext,
        }),
      }
    )
    return `Routed to ${result.answers.team}`
  },
})

const agent = new Agent({ tools: [routeMessage] })
const result = await agent.invoke('Route this message: my package never arrived.')
console.log(result.invocationContext?.usage)

// Typical output:
// { turnsTaken: 2, inputTokens: 2154, outputTokens: 142, totalTokens: 2296 }
```
(( /tab "TypeScript" ))

Hook events that belong to a request carry the same invocation context, so a hook passes it to `ask` the same way.

## Token usage

With the invocation context, the decision’s tokens add to the request’s usage, which the agent result reports. The agent’s own model metrics stay separate and cover only the agent’s model calls. A decision always runs to completion, even when the request has reached one of its [invocation limits](/docs/user-guide/sdk/agents/agent-loop/index.md#invocation-limits), and it doesn’t count as a turn. Its tokens do count toward the request’s token limits, so later turns can stop sooner.

Without the invocation context, the decision still reports its tokens in its own result, but the request doesn’t include them.

## Approve tool calls

`HumanInTheLoop` can ask a decision model whether each tool call needs a person’s approval. An `Uncertain` answer requires approval:

(( tab "Python" ))
```python
from strands import Agent, LLMDecisionModel
from strands.vended_interventions.hitl import HumanInTheLoop

agent = Agent(interventions=[HumanInTheLoop(classifier=LLMDecisionModel())])
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, LLMDecisionModel } from '@strands-agents/sdk'
import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'

const agent = new Agent({
  interventions: [
    new HumanInTheLoop({ classifier: { decisionModel: new LLMDecisionModel() } }),
  ],
})
```
(( /tab "TypeScript" ))

[Human in the loop](/docs/user-guide/sdk/agents/interventions/human-in-the-loop/index.md#risk-classifier) covers the risk criteria and the other classifier options.

## Related pages

- [Decision models](/docs/user-guide/sdk/decision-models/index.md) (1 shared tag)
- [LLM decision model](/docs/user-guide/sdk/decision-models/models/llm/index.md) (1 shared tag)
- [Questions and answers](/docs/user-guide/sdk/decision-models/questions/index.md) (1 shared tag)
- [Supported decision models](/docs/user-guide/sdk/decision-models/models/index.md) (1 shared tag)
- [Decision model observability](/docs/user-guide/sdk/decision-models/observability/index.md) (1 shared tag)
- [Decision models quickstart](/docs/user-guide/sdk/decision-models/quickstart/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/decisions/decision_model.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/decision_model.py)
- [harness-sdk/strands-py/src/strands/agent/invocation_context.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/invocation_context.py)

### TypeScript

- [harness-sdk/strands-ts/src/decisions/decision-model.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decision-model.ts)
- [harness-sdk/strands-ts/src/agent/invocation-context.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/invocation-context.ts)
