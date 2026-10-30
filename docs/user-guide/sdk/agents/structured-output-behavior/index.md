Structured output makes an agent return a validated object instead of text. You define a schema, attach it to an agent or to a single call, and read the object from the result. For a worked example, see [Return structured output](/docs/user-guide/sdk/agents/structured-output/index.md).

## How it works

Strands doesn’t ask the model to write JSON in its reply. It turns your schema into a tool, and the model returns the object by calling that tool with the field values as input. The tool gives the model a typed input schema to fill in, and gives Strands a way to send validation errors back through the [agent loop](/docs/user-guide/sdk/agents/agent-loop/index.md).

> **Diagram:** How structured output works. Your schema is given to the model as a tool, inside the agent loop. The model calls the structured output tool, which validates the call's arguments against the schema. If validation fails, the errors go back to the model so it can retry. When the arguments are valid, the validated object is placed on the agent result.

For each call with a schema:

1.  Strands adds a structured output tool, built from your schema, to the agent’s tools.
2.  The model works as usual and can call your other tools along the way.
3.  The model calls the structured output tool with the field values.
4.  Strands validates that input. If it passes, the invocation ends and the object is on `result.structured_output``result.structuredOutput`. When you stream the call, it’s on the final result event.
5.  Strands removes the structured output tool when the invocation ends.

## Schemas

A schema lists the fields the object must have. Strands builds the tool from it, so the model reads every field description.

(( tab "Python" ))
A schema is a [Pydantic model](https://docs.pydantic.dev/latest/concepts/models/). The tool is named after the class, so a `TicketTriage` schema produces a `TicketTriage` tool. The class docstring becomes the tool description, and each `Field(description=...)` describes that field to the model.
(( /tab "Python" ))

(( tab "TypeScript" ))
A schema is a [Zod](https://zod.dev/) object schema. The tool is named `strands_structured_output`. A `.describe()` on the object becomes the tool description, and a `.describe()` on a field describes that field to the model.
(( /tab "TypeScript" ))

Strands adds an instruction to the tool description telling the model to call the tool last, after any other tools it needs.

## Agent and call schemas

A schema set when you create the agent applies to every call. A schema passed to a call applies to that call only and takes precedence over the agent’s schema.

(( tab "Python" ))
```python
from pydantic import BaseModel
from strands import Agent


class CustomerInfo(BaseModel):
    name: str
    email: str


class RefundRequest(BaseModel):
    order_id: str
    amount: float


agent = Agent(structured_output_model=CustomerInfo, callback_handler=None)

customer = agent("This is Dana Ruiz, dana@example.com.").structured_output
refund = agent(
    "Please refund order 4512. It was $49.99.",
    structured_output_model=RefundRequest,
).structured_output

print(customer)
print(refund)
```

Typical output:

```plaintext
name='Dana Ruiz' email='dana@example.com'
order_id='4512' amount=49.99
```

`Agent.structured_output()` and `Agent.structured_output_async()` are deprecated and emit a `DeprecationWarning`. Pass the schema to the call instead, as shown above.
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { z } from 'zod'

const CustomerInfoSchema = z.object({
  name: z.string(),
  email: z.string(),
})

const RefundRequestSchema = z.object({
  orderId: z.string(),
  amount: z.number(),
})

const agent = new Agent({ structuredOutputSchema: CustomerInfoSchema, printer: false })

const customer = await agent.invoke('This is Dana Ruiz, dana@example.com.')
const refund = await agent.invoke('Please refund order 4512. It was $49.99.', {
  structuredOutputSchema: RefundRequestSchema,
})

console.log(customer.structuredOutput)
console.log(refund.structuredOutput)
```

Typical output:

```plaintext
{ name: 'Dana Ruiz', email: 'dana@example.com' }
{ orderId: '4512', amount: 49.99 }
```
(( /tab "TypeScript" ))

An agent schema applies to every call, including turns that only build up context. If some calls should answer in plain text, pass the schema per call instead.

## Validation errors

A schema can hold rules the model won’t always meet on the first try, like a check that a date is in the future. When the input fails validation, Strands doesn’t raise. It returns the validation errors to the model as the tool result, and the model can call the tool again with corrected values.

(( tab "Python" ))
```python
from datetime import date

from pydantic import BaseModel, field_validator
from strands import Agent


class FollowUp(BaseModel):
    """A follow-up task for a support ticket."""

    action: str
    due_date: date

    @field_validator("due_date")
    @classmethod
    def must_be_in_future(cls, value: date) -> date:
        if value <= date.today():
            raise ValueError(f"due_date must be after {date.today().isoformat()}")
        return value


agent = Agent(callback_handler=None)
result = agent(
    "Schedule a follow-up call with the customer next Tuesday.",
    structured_output_model=FollowUp,
)
print(result.structured_output)
```

Typical output:

```plaintext
action='Schedule a follow-up call with the customer' due_date=datetime.date(2026, 10, 20)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { z } from 'zod'

const today = new Date().toISOString().slice(0, 10)

const FollowUpSchema = z
  .object({
    action: z.string(),
    dueDate: z.iso.date().refine((value) => value > today, {
      message: `dueDate must be after ${today}`,
    }),
  })
  .describe('A follow-up task for a support ticket')

const agent = new Agent({ printer: false })
const result = await agent.invoke(
  'Schedule a follow-up call with the customer next Tuesday.',
  { structuredOutputSchema: FollowUpSchema }
)
console.log(result.structuredOutput)
```

Typical output:

```plaintext
{ action: 'Follow-up call with the customer', dueDate: '2026-10-20' }
```
(( /tab "TypeScript" ))

The model doesn’t know today’s date, so its first guess can fail the check:

```plaintext
Example:
1. Model calls the structured output tool with a due date of 2025-07-22
2. Validation fails, and the model receives "due_date must be after 2026-10-12"
3. Model calls the tool again with 2026-10-13
4. Validation passes, and the invocation returns the object
```

Put rules like this in the schema, not in your prompt. The model sees the exact error message, so write it as an instruction the model can act on. The model can retry as often as it needs; to cap the retries, see [Limit attempts](#limit-attempts).

## Forced tool call

Sometimes the model ends its turn with a text reply and never calls the structured output tool. Strands then retries once with the structured output tool required, so the model’s only option is to call it.

(( tab "Python" ))
Before the retry, Strands adds a user message to the conversation: `You must format the previous response as structured output.` To replace it, pass `structured_output_prompt` to the agent or to a single call. A value passed to a call takes precedence over the agent’s value.

```python
from pydantic import BaseModel
from strands import Agent


class Contact(BaseModel):
    name: str
    email: str


agent = Agent(
    structured_output_prompt="Return the contact details you found as a Contact.",
    callback_handler=None,
)
result = agent("Reach Dana Ruiz at dana@example.com.", structured_output_model=Contact)
print(result.structured_output)
```

Typical output:

```plaintext
name='Dana Ruiz' email='dana@example.com'
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Strands drops the text reply and retries with only the tool choice changed. No message is added, so there’s no prompt to configure.
(( /tab "TypeScript" ))

If the retry still doesn’t return valid structured output, the call raises `StructuredOutputException``StructuredOutputError`. Catch it where your application can fall back. [Return structured output](/docs/user-guide/sdk/agents/structured-output/index.md#request-structured-output) shows an example. To retry again instead of raising, set an attempt limit.

## Limit attempts

To cap how many times the model can fail to produce structured output, set

`limits['structured_output_attempts']``limits.structuredOutputAttempts`

on the call. Each model response that fails counts as one attempt: a structured output tool call that fails validation, or a forced retry that doesn’t return valid structured output. With a limit set, Strands retries a failed forced retry instead of raising. Calls to your other tools before the forced retry don’t count.

In TypeScript, a forced retry that a content filter or guardrail stops also counts as a failed attempt and is retried within the limit. In Python, that retry ends the call with its own stop reason, such as `content_filtered``contentFiltered`.

When the limit is reached, the call stops before the next model call. The result has the stop reason

`limit_structured_output_attempts``limitStructuredOutputAttempts`

and no structured output.

(( tab "Python" ))
```python
from pydantic import BaseModel
from strands import Agent


class Contact(BaseModel):
    name: str
    email: str


agent = Agent(callback_handler=None)
result = agent(
    "Find the contact details in this note: call Dana back tomorrow.",
    structured_output_model=Contact,
    limits={"structured_output_attempts": 3},
)
if result.stop_reason == "limit_structured_output_attempts":
    print("No valid contact after 3 attempts")
else:
    print(result.structured_output)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { z } from 'zod'

const ContactSchema = z.object({
  name: z.string(),
  email: z.string(),
})

const agent = new Agent({ printer: false })
const result = await agent.invoke(
  'Find the contact details in this note: call Dana back tomorrow.',
  { structuredOutputSchema: ContactSchema, limits: { structuredOutputAttempts: 3 } }
)
if (result.stopReason === 'limitStructuredOutputAttempts') {
  console.log('No valid contact after 3 attempts')
} else {
  console.log(result.structuredOutput)
}
```
(( /tab "TypeScript" ))

The limit covers the whole request, like the other [invocation limits](/docs/user-guide/sdk/agents/lifecycle-controls/index.md#cap-the-work-one-call-can-do). Agents that run as tools in the same request count toward it, and passing `result.invocation_context``result.invocationContext` to a later call continues it.

## Related pages

- [LiteLLM](/docs/user-guide/sdk/model-providers/litellm/index.md) (1 shared tag)
- [Return structured output](/docs/user-guide/sdk/agents/structured-output/index.md) (1 shared tag)
- [Structured output similarity evaluator](/docs/user-guide/evals-sdk/evaluators/structured_output_evaluator/index.md) (1 shared tag)
- [Model Routing](/docs/user-guide/sdk/model-providers/model-routing/index.md) (1 shared tag)
- [OpenAI](/docs/user-guide/sdk/model-providers/openai/index.md) (1 shared tag)
- [Writer](/docs/user-guide/sdk/model-providers/writer/index.md) (1 shared tag)
- [Anthropic](/docs/user-guide/sdk/model-providers/anthropic/index.md) (1 shared tag)
- [Production Lifecycle Controls](/docs/user-guide/sdk/agents/lifecycle-controls/index.md) (1 shared tag)
- [Retry Strategies](/docs/user-guide/sdk/agents/retry-strategies/index.md) (1 shared tag)
- [Chaos testing](/docs/user-guide/evals-sdk/chaos_testing/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/tools/structured_output/structured_output_tool.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/structured_output/structured_output_tool.py)
- [harness-sdk/strands-py/src/strands/event_loop/event_loop.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/event_loop.py)

### TypeScript

- [harness-sdk/strands-ts/src/tools/structured-output-tool.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/structured-output-tool.ts)
- [harness-sdk/strands-ts/src/agent/agent.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts)
