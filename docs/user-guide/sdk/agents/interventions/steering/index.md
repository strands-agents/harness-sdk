Steering provides modular prompting for complex agent tasks through context-aware guidance that appears when relevant, rather than front-loading all instructions in monolithic prompts. Steering handlers observe agent activity and intervene at key moments, before a tool call or after a model response, with targeted feedback.

The mechanism differs by SDK: in Python, steering handlers are [plugins](/docs/user-guide/sdk/plugins/index.md); in TypeScript, they build on the [interventions](/docs/user-guide/sdk/agents/interventions/index.md) framework and its typed action model. The concepts below are shared; the code in each tab shows the language-specific API.

## What Is Steering?

Building agents for complex multi-step tasks runs into a prompting wall. Traditional approaches require front-loading all instructions, business rules, and operational guidance into a single prompt. For tasks with 30+ steps, monolithic prompts become unwieldy: agents ignore instructions, hallucinate behaviors, or fail to follow critical procedures.

A common workaround is decomposing the agent into a graph with predefined nodes and edges that control execution flow. While this improves predictability and reduces prompt complexity, it limits the adaptive reasoning that makes agents valuable in the first place, and it is costly to maintain as requirements change.

Steering takes a different approach: **modular prompting**. Instead of front-loading all instructions, you define context-aware steering handlers that provide feedback at the right moment. Each handler defines the business rules to enforce and the lifecycle hooks where agent behavior should be validated, like before a tool call or before returning output to the user.

## Comparison with Other Approaches

### Steering vs. Workflow Frameworks

Workflow frameworks force you to specify discrete steps and control flow logic upfront, making agents brittle and requiring extensive developer time to define complex decision trees. When business requirements change, you rebuild the workflow logic. Steering uses modular prompting where you define contextual guidance that appears when relevant rather than prescribing exact execution paths. This maintains the adaptive reasoning that makes agents valuable while enabling reliable execution of complex procedures.

### Steering vs. Traditional Prompting

Traditional prompting requires front-loading all instructions into a single prompt. For complex tasks with 30+ steps, this leads to prompt bloat where agents ignore instructions, hallucinate behaviors, or fail to follow critical procedures. Steering provides context-aware reminders that appear at the right moment, like post-it notes that guide agents when they need specific information. This keeps context windows lean while maintaining agent effectiveness on complex tasks.

## Context Population

To give the handler something to reason about, attach a provider that observes agent activity and records it as steering context.

> **Diagram:** Context population. The agent fires hook events. Context providers registered on the steering handler, such as the tool ledger, observe those events and record structured data into the handler's steering context. The handler reads the steering context when deciding whether to intervene.

**Context providers** observe agent activity and contribute structured data into the handler’s steering context. The built-in tool ledger provider (`LedgerProvider``ToolLedgerProvider`) tracks tool call history, timing, and results. Steering handlers read from this context when deciding whether to intervene.

## Steering moments

### Before a tool call

When you want the handler to validate a tool call before it runs, return a steering action from the before-tool-call moment:

> **Diagram:** Steering before a tool call. The model's tool call reaches the steering handler on BeforeToolCallEvent, and the handler picks one of three outcomes. Proceed: the tool runs immediately. Guide: the tool call is cancelled and the agent gets the handler's feedback. Ask a human: execution pauses until a human approves or provides input.

The handler returns one of three actions:

(( tab "Python" ))
-   **`Proceed`**: tool executes immediately
-   **`Guide`**: tool is cancelled, agent receives contextual feedback
-   **`Interrupt`**: tool execution pauses for human input
(( /tab "Python" ))

(( tab "TypeScript" ))
-   **`InterventionActions.proceed()`**: tool executes immediately
-   **`InterventionActions.guide(feedback)`**: tool is cancelled, agent receives contextual feedback and retries
-   **`InterventionActions.confirm(prompt)`**: tool execution pauses for human approval
(( /tab "TypeScript" ))

### After a model response

When you want the handler to validate the model’s output before it reaches the user, return a steering action from the after-model-call moment:

> **Diagram:** Steering after a model response. The model's response reaches the steering handler on AfterModelCallEvent, and the handler picks one of two outcomes. Proceed: the response is accepted as-is. Guide: the response is discarded and the model retries with the guidance injected into the conversation.

The handler returns one of two actions:

(( tab "Python" ))
-   **`Proceed`**: accept the response as-is
-   **`Guide`**: discard the response and retry with guidance injected into the conversation
(( /tab "Python" ))

(( tab "TypeScript" ))
-   **`InterventionActions.proceed()`**: accept the response as-is
-   **`InterventionActions.guide(feedback)`**: discard the response and retry with guidance injected into the conversation
(( /tab "TypeScript" ))

After-model steering lets handlers validate responses, ensure required tools are used before completion, or guide conversation flow based on output.

## Steering with natural language

When you want to express steering rules in plain language rather than imperative code, use `LLMSteeringHandler`. It delegates each decision to an LLM that evaluates the pending tool call against your system prompt and the accumulated steering context.

(( tab "Python" ))
Attach the handler with `plugins=[handler]` on the agent:

```python
from strands import Agent, tool
from strands.vended_plugins.steering import LLMSteeringHandler


@tool
def send_email(recipient: str, subject: str, message: str) -> str:
    """Send an email to a recipient."""
    return f"Email sent to {recipient}"


handler = LLMSteeringHandler(
    system_prompt="""
    You are providing guidance to ensure emails maintain a cheerful, positive tone.

    Guidance:
    - Review email content for tone and sentiment
    - Suggest more cheerful phrasing if the message seems negative or neutral
    - Encourage use of positive language and friendly greetings
    """
)

agent = Agent(
    tools=[send_email],
    plugins=[handler],
)

agent(
    "Send a frustrated email to tom@example.com, "
    "a client who keeps rescheduling important meetings at the last minute"
)

# Typical: agent.messages includes a cancelled send_email tool call,
# a guidance message, then a retried send_email with cheerier wording.
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Attach the handler through the interventions framework:

```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { LLMSteeringHandler } from '@strands-agents/sdk/vended-interventions/steering'
import { z } from 'zod'

const handler = new LLMSteeringHandler({
  systemPrompt: `
    You are providing guidance to ensure the agent follows best practices:

    Rules:
    - Emails must always include a clear subject line
    - Never send emails with aggressive or unprofessional language
    - If the same tool has failed twice in a row, suggest a different approach
    - Require human confirmation before sending emails to external domains
  `,
})

const agent = new Agent({
  tools: [sendEmail, searchWeb],
  interventions: [handler],
})

await agent.invoke('Email the client about the project delay')
// LLM evaluates tone and content → may guide agent to soften language before sending
```
(( /tab "TypeScript" ))

> **Diagram:** A typical run of the cheerful-email example, in two phases. First attempt: the user asks the agent to send a frustrated email; the agent calls the email tool and the LLM steering handler intercepts the call. The handler evaluates the message's tone against its system prompt and returns guide, so the call is cancelled and the agent receives guidance toward a cheerful tone. Retry: the agent calls the email tool again with cheerier wording; the handler returns proceed; the email tool sends the email; and the agent gives the user its final response.

For best practices on writing steering prompts, see the [Agent Standard Operating Procedures (SOP)](https://github.com/strands-agents/agent-sop) framework.

## The tool ledger provider

The built-in tool ledger provider tracks tool call history within a session so the steering handler can reason about patterns like repeated failures, excessive retries, or tool usage sequences. It records each tool call’s name and input arguments, start and end timestamps, execution status (`pending`, `success`, `error`), and result or error content.

`LLMSteeringHandler` uses the tool ledger provider by default. In both SDKs, the ledger is stored in JSON-serializable form so it is directly accessible to LLM-based steering decisions.

## The TypeScript interventions API

The TypeScript SDK builds steering on the [interventions](/docs/user-guide/sdk/agents/interventions/index.md) framework, which adds a few surfaces beyond the shared model above.

### Writing custom steering logic

`SteeringHandler` extends `InterventionHandler` and narrows the return types to enforce a steering-specific contract:

| Method | Valid Returns | Purpose |
| --- | --- | --- |
| `beforeToolCall` | `Proceed | Guide | Confirm` | Gate or redirect a tool call |
| `afterModelCall` | `Proceed | Guide` | Validate model output before delivery |

The wider intervention vocabulary (`Deny`, `Transform`) is excluded at the type level, so out-of-contract actions are caught at compile time. Subclass `SteeringHandler` when you want to write imperative steering logic:

```typescript
import { Agent, tool, InterventionActions } from '@strands-agents/sdk'
import type { BeforeToolCallEvent, AfterModelCallEvent } from '@strands-agents/sdk'
import { SteeringHandler } from '@strands-agents/sdk/vended-interventions/steering'
import { z } from 'zod'

class ToneSteeringHandler extends SteeringHandler {
  override readonly name = 'tone-steering'

  override beforeToolCall(event: BeforeToolCallEvent) {
    if (event.toolUse.name === 'send_email') {
      const input = event.toolUse.input as Record<string, string>
      if (input.message?.includes('URGENT') || input.message?.includes('!!!')) {
        return InterventionActions.guide(
          'Rewrite the email with a calmer, more professional tone. ' +
            'Avoid all-caps words and excessive punctuation.'
        )
      }
    }
    return InterventionActions.proceed()
  }

  override afterModelCall(_event: AfterModelCallEvent) {
    return InterventionActions.proceed()
  }
}

const agent = new Agent({
  tools: [sendEmail],
  interventions: [new ToneSteeringHandler()],
})

await agent.invoke('Send an urgent email to the team about the deadline')
// Handler detects "URGENT" → guides agent to rewrite with calmer tone → email sends
```

`SteeringHandler` also implements `LifecycleObserver`. When the agent initializes, it calls `observeAgent(agent)` on each intervention handler that implements this interface. `SteeringHandler` forwards this call to its registered context providers, allowing them to self-subscribe to agent hooks.

### Configuring the LLM steering handler

`LLMSteeringHandler` accepts:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `systemPrompt` | `string | SystemContentBlock[]` | *(required)* | Steering rules for the evaluation LLM |
| `model` | `Model` | `agent.auxModel` | Model used for steering evaluation |
| `contextProviders` | `SteeringContextProvider[]` | `[new ToolLedgerProvider()]` | Providers that supply evaluation context. Pass `[]` to disable |
| `promptBuilder` | `PromptBuilder` | Built-in builder with cache points | Custom function to build evaluation prompts |
| `name` | `string` | `'strands:llm-steering-handler'` | Unique handler name (must be distinct if multiple handlers are attached) |

Before each tool call, the handler collects context snapshots from all registered providers, builds an evaluation prompt combining your system prompt, the context data, and the pending tool call, and a **fresh inner agent** returns a structured decision (`proceed`, `guide`, or `confirm`) that maps to the corresponding intervention action. Constructing the inner agent fresh per evaluation keeps the handler stateless and safe for concurrent evaluations across multiple parent agents. The default prompt builder uses **prompt caching**: static instructions are separated from dynamic context with a `CachePointBlock`, reducing API cost for repeated evaluations within a session.

### Custom context providers

Context providers are passive observers that track agent activity and supply structured data to steering handlers. They implement the `SteeringContextProvider` interface:

-   **`name`**: identifier for the provider instance
-   **`observeAgent(agent)`**: called once at initialization; subscribe to hooks here
-   **`context`** (getter): returns the current context snapshot for steering evaluation

```typescript
import { Agent, tool, AfterToolCallEvent } from '@strands-agents/sdk'
import type { LocalAgent } from '@strands-agents/sdk'
import {
  LLMSteeringHandler,
  ToolLedgerProvider,
} from '@strands-agents/sdk/vended-interventions/steering'
import type {
  SteeringContextProvider,
  SteeringContextData,
} from '@strands-agents/sdk/vended-interventions/steering'
import { z } from 'zod'

class ToolCallCounter implements SteeringContextProvider {
  readonly name = 'toolCallCounter'
  private _count = 0

  observeAgent(agent: LocalAgent): void {
    agent.addHook(AfterToolCallEvent, () => {
      this._count += 1
    })
  }

  get context(): SteeringContextData {
    return { type: 'toolCallCounter', totalCalls: this._count }
  }
}

const handler = new LLMSteeringHandler({
  systemPrompt: `
    Monitor tool usage. If the agent has made more than 5 tool calls,
    guide it to wrap up and produce a final answer.
  `,
  contextProviders: [new ToolCallCounter(), new ToolLedgerProvider()],
})

const agent = new Agent({
  tools: [searchWeb],
  interventions: [handler],
})

await agent.invoke('Research the history of quantum computing')
// After 5+ tool calls, handler guides the agent to wrap up and produce a final answer
```

Providers self-register their hooks via `observeAgent`, so the steering handler does not need to know which hooks a provider uses. Providers observe, handlers decide.

The built-in `ToolLedgerProvider` accepts:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxEntries` | `number` | `100` | Maximum tool calls to retain (oldest dropped) |
| `name` | `string` | `'strands:steering:toolLedger'` | Provider instance identifier |

```typescript
import { Agent, tool } from '@strands-agents/sdk'
import {
  LLMSteeringHandler,
  ToolLedgerProvider,
} from '@strands-agents/sdk/vended-interventions/steering'
import { z } from 'zod'

const ledger = new ToolLedgerProvider({
  maxEntries: 50,
  name: 'my-app:tool-ledger',
})

const handler = new LLMSteeringHandler({
  systemPrompt: `
    You monitor tool call patterns. If a tool has failed 3 times consecutively,
    guide the agent to try a different approach rather than retrying.
  `,
  contextProviders: [ledger],
})

const agent = new Agent({
  tools: [searchWeb, sendEmail],
  interventions: [handler],
})

await agent.invoke('Find contact info for Acme Corp and send them a proposal')
// If search_web fails 3 times, handler guides agent to try a different approach
```

## Related topics

-   [Interventions](/docs/user-guide/sdk/agents/interventions/index.md): the typed action model, lifecycle methods, evaluation order, and error handling
-   [Plugins](/docs/user-guide/sdk/plugins/index.md): the Python interface steering handlers build on
-   [Hooks](/docs/user-guide/sdk/agents/hooks/index.md): low-level event callbacks that context providers subscribe to rs subscribe to

## Related pages

- [GoalLoop](/docs/user-guide/sdk/plugins/goal-loop/index.md) (3 shared tags)
- [Hook events](/docs/user-guide/sdk/agents/hooks-events/index.md) (3 shared tags)
- [Hooks](/docs/user-guide/sdk/agents/hooks/index.md) (3 shared tags)
- [Agent Loop](/docs/user-guide/sdk/agents/agent-loop/index.md) (3 shared tags)
- [Interrupts](/docs/user-guide/sdk/interrupts/index.md) (3 shared tags)
- [Interventions](/docs/user-guide/sdk/agents/interventions/index.md) (3 shared tags)
- [Build a custom plugin](/docs/user-guide/sdk/plugins/custom-plugins/index.md) (2 shared tags)
- [Plugins](/docs/user-guide/sdk/plugins/index.md) (2 shared tags)
- [Middleware](/docs/user-guide/sdk/agents/middleware/index.md) (2 shared tags)
- [Tool Executors](/docs/user-guide/sdk/tools/executors/index.md) (2 shared tags)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/vended_plugins/steering/core/handler.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/steering/core/handler.py)
- [harness-sdk/strands-py/src/strands/vended_plugins/steering/handlers/llm/llm_handler.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/steering/handlers/llm/llm_handler.py)

### TypeScript

- [harness-sdk/strands-ts/src/vended-interventions/steering/handlers/llm.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-interventions/steering/handlers/llm.ts)
