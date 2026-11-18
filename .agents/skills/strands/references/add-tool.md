# Add a tool

Define tools around narrow application capabilities. Give each tool a clear name, description, typed input, and predictable return value. Keep credentials and request-scoped identity out of model-visible parameters.

## Python

Use the `@tool` decorator. Type hints define the schema and the docstring tells the model when and how to call the tool.

```python
from strands import Agent, tool


@tool
def lookup_order(order_id: str) -> str:
    """Return the current status for an order.

    Args:
        order_id: The order identifier supplied by the customer.
    """
    return f"Order {order_id} is ready to ship"


agent = Agent(tools=[lookup_order])
result = agent("Check order A-104.")
print(result)
```

Use `ToolContext` for request-scoped data that should not appear in the schema. Use a class-based tool or closure for stable dependencies such as an API client.

## TypeScript

Use `tool()` with Zod or JSON Schema. Prefer Zod when the project already uses it and runtime validation is useful.

```typescript
import { Agent, tool } from '@strands-agents/sdk'
import z from 'zod'

const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Return the current status for an order.',
  inputSchema: z.object({
    orderId: z.string().describe('The order identifier supplied by the customer'),
  }),
  callback: ({ orderId }) => `Order ${orderId} is ready to ship`,
})

const agent = new Agent({ tools: [lookupOrder] })
const result = await agent.invoke('Check order A-104.')
console.log(result.lastMessage)
```

The callback's optional context parameter carries invocation state and agent context. Keep stable dependencies outside the model-visible schema.

## Verify the tool

1. Test the underlying deterministic function directly.
2. Confirm the generated or declared schema contains only values the model should choose.
3. Invoke the agent with a request that clearly requires the tool.
4. Check the result or trace to confirm the tool ran with the expected input.
5. Return useful errors instead of hiding failures or leaking credentials.
