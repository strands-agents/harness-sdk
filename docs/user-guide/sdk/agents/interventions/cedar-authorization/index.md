Cedar Authorization evaluates [Cedar](https://cedarpolicy.com) policies before each tool call, giving you declarative, identity-aware access control over agent behavior. It ships as a vended intervention handler in both the Python and TypeScript SDKs.

## How it works

The handler sits at the tool-call boundary. When the agent attempts to invoke a tool, Cedar Authorization maps the call to a Cedar authorization request and evaluates your policies. If no `permit` statement matches, the tool call is denied and the agent receives feedback explaining the denial.

| Cedar concept | Maps to | Example |
| --- | --- | --- |
| **Principal** | User identity | `User::"alice@acme.com"` |
| **Action** | Tool name | `Action::"search"` |
| **Resource** | Static (unconstrained) | `Resource::"agent"` |
| **Context.input** | Tool arguments | `{ query: "quarterly report" }` |
| **Context.session** | Invocation metadata | `{ hour_utc: 14, call_count: 3, role: "admin" }` |

The design is fail-closed: if principal identity cannot be resolved, all tool calls are denied.

## Basic usage

Permit specific tools and deny everything else:

(( tab "Python" ))
```python
from strands import Agent, tool
from strands.vended_interventions.cedar import (
    CedarAuthorization,
)

@tool
def search(query: str) -> str:
    """Search for information."""
    return f"Results for: {query}"

@tool
def delete_record(record_id: str) -> str:
    """Delete a record by ID."""
    return f"Deleted {record_id}"

cedar = CedarAuthorization(
    policies=(
        'permit(principal, action == Action::"search",'
        " resource);"
    ),
)

agent = Agent(
    tools=[search, delete_record],
    interventions=[cedar],
)

agent(
    "Search for quarterly reports then delete record 42"
)
# search is permitted; delete_record is denied
# (no matching permit)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'
import { z } from 'zod'

const searchTool = tool({
  name: 'search',
  description: 'Search for information',
  inputSchema: z.object({ query: z.string() }),
  callback: (input) => `Results for: ${input.query}`,
})

const deleteTool = tool({
  name: 'delete_record',
  description: 'Delete a record by ID',
  inputSchema: z.object({ record_id: z.string() }),
  callback: (input) => `Deleted ${input.record_id}`,
})

const cedar = new CedarAuthorization({
  policies: `
    permit(principal, action == Action::"search", resource);
  `,
})

const agent = new Agent({
  tools: [searchTool, deleteTool],
  interventions: [cedar],
})

await agent.invoke('Search for quarterly reports then delete record 42')
// If the agent calls search, it's permitted; a delete_record call is denied (no matching permit)
```
(( /tab "TypeScript" ))

Cedar uses default-deny semantics. Tools without a matching `permit` statement are automatically blocked.

## Role-based access control

For multi-tenant agents where each request carries user identity, use `principal_resolver``principalResolver` to extract the principal from `invocation_state``invocationState` and `context_enricher``contextEnricher` to forward role information into Cedar context:

(( tab "Python" ))
```python
from strands import Agent, tool
from strands.vended_interventions.cedar import (
    CedarAuthorization,
)

@tool
def search(query: str) -> str:
    """Search for information."""
    return f"Results for: {query}"

@tool
def delete_record(record_id: str) -> str:
    """Delete a record by ID."""
    return f"Deleted {record_id}"

cedar = CedarAuthorization(
    policies="""
      permit(principal, action, resource)
      when { context.session.role == "admin" };

      permit(
        principal,
        action == Action::"search",
        resource
      )
      when { context.session.role == "analyst" };
    """,
    principal_resolver=lambda state: (
        {"type": "User", "id": state["user_id"]}
        if state.get("user_id")
        else None
    ),
    context_enricher=lambda ctx: {
        "role": ctx["invocation_state"].get(
            "role", "none"
        ),
    },
)

agent = Agent(
    tools=[search, delete_record],
    interventions=[cedar],
)

# admin can use any tool
agent(
    "Delete record 42",
    invocation_state={
        "user_id": "alice",
        "role": "admin",
    },
)

# analyst can only search
agent(
    "Delete record 42",
    invocation_state={
        "user_id": "bob",
        "role": "analyst",
    },
)
# denied: no permit for delete_record with "analyst"
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'
import { z } from 'zod'

const searchTool = tool({
  name: 'search',
  description: 'Search for information',
  inputSchema: z.object({ query: z.string() }),
  callback: (input) => `Results for: ${input.query}`,
})

const deleteTool = tool({
  name: 'delete_record',
  description: 'Delete a record by ID',
  inputSchema: z.object({ record_id: z.string() }),
  callback: (input) => `Deleted ${input.record_id}`,
})

const cedar = new CedarAuthorization({
  policies: `
    permit(principal, action, resource)
    when { context.session.role == "admin" };

    permit(principal, action == Action::"search", resource)
    when { context.session.role == "analyst" };
  `,
  principalResolver: (state) => {
    if (!state.user_id) return undefined
    return { type: 'User', id: String(state.user_id) }
  },
  contextEnricher: ({ invocationState }) => ({
    role: String(invocationState.role ?? 'none'),
  }),
})

const agent = new Agent({
  tools: [searchTool, deleteTool],
  interventions: [cedar],
})

// admin can use any tool
await agent.invoke('Delete record 42', {
  invocationState: { user_id: 'alice', role: 'admin' },
})

// analyst can only search
await agent.invoke('Delete record 42', {
  invocationState: { user_id: 'bob', role: 'analyst' },
})
// denied: no permit matches for delete_record with role "analyst"
```
(( /tab "TypeScript" ))

When `principal_resolver``principalResolver` returns `None``undefined` (no identity found), the handler denies all tool calls for that request.

## Rate limiting

Cedar policies can reference `context.session.call_count`, which tracks how many times each tool has been invoked successfully during the session:

(( tab "Python" ))
```python
from strands import Agent, tool
from strands.vended_interventions.cedar import (
    CedarAuthorization,
)

@tool
def send_email(to: str, body: str) -> str:
    """Send an email."""
    return f"Sent to {to}"

@tool
def search(query: str) -> str:
    """Search for information."""
    return f"Results for: {query}"

cedar = CedarAuthorization(
    policies="""
      permit(
        principal,
        action == Action::"send_email",
        resource
      )
      when { context.session.call_count < 5 };

      permit(
        principal,
        action == Action::"search",
        resource
      );
    """,
)

agent = Agent(
    tools=[send_email, search],
    interventions=[cedar],
)

# send_email permitted for calls 1-4, denied on 5th
# search is unlimited
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'
import { z } from 'zod'

const sendEmailTool = tool({
  name: 'send_email',
  description: 'Send an email',
  inputSchema: z.object({ to: z.string(), body: z.string() }),
  callback: (input) => `Sent to ${input.to}`,
})

const searchTool = tool({
  name: 'search',
  description: 'Search for information',
  inputSchema: z.object({ query: z.string() }),
  callback: (input) => `Results for: ${input.query}`,
})

const cedar = new CedarAuthorization({
  policies: `
    permit(principal, action == Action::"send_email", resource)
    when { context.session.call_count < 5 };

    permit(principal, action == Action::"search", resource);
  `,
})

const agent = new Agent({
  tools: [sendEmailTool, searchTool],
  interventions: [cedar],
})

// send_email is permitted for the first 4 calls, then denied on the 5th
// search is unlimited
```
(( /tab "TypeScript" ))

Call counts persist with the agent’s state and survive session reloads. Only successful tool calls increment the counter.

## Schema validation

Pass your tool definitions to catch policy typos at construction time. The handler generates a Cedar schema from tool definitions and validates policies against it:

(( tab "Python" ))
```python
from strands.vended_interventions.cedar import (
    CedarAuthorization,
    ToolDefinition,
)

search_def: ToolDefinition = {
    "name": "search",
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {"type": "string"}
        },
    },
}

delete_def: ToolDefinition = {
    "name": "delete_record",
    "inputSchema": {
        "type": "object",
        "properties": {
            "record_id": {"type": "string"}
        },
    },
}

# Valid policies pass schema validation
cedar = CedarAuthorization(
    policies="""
      permit(
        principal,
        action == Action::"search",
        resource
      );
      permit(
        principal,
        action == Action::"delete_record",
        resource
      )
      when { context.session.role == "admin" };
    """,
    tools=[search_def, delete_def],
    context_enricher=lambda ctx: {
        "role": ctx["invocation_state"].get(
            "role", "none"
        ),
    },
)

# A typo in the action name raises at construction:
# CedarAuthorization(
#     policies='permit(principal, action == Action::"deleet_record", resource);',
#     tools=[search_def, delete_def],
# )
# raises ValueError: Cedar policy validation failed:
#   unrecognized action "deleet_record"
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'
import { z } from 'zod'

const searchTool = tool({
  name: 'search',
  description: 'Search for information',
  inputSchema: z.object({ query: z.string() }),
  callback: (input) => `Results for: ${input.query}`,
})

const deleteTool = tool({
  name: 'delete_record',
  description: 'Delete a record by ID',
  inputSchema: z.object({ record_id: z.string() }),
  callback: (input) => `Deleted ${input.record_id}`,
})

// Valid policies pass schema validation
const cedar = new CedarAuthorization({
  policies: `
    permit(principal, action == Action::"search", resource);
    permit(principal, action == Action::"delete_record", resource)
    when { context.session.role == "admin" };
  `,
  tools: [searchTool, deleteTool],
  contextEnricher: ({ invocationState }) => ({
    role: String(invocationState.role ?? 'none'),
  }),
})

// A typo in the action name throws at construction:
// new CedarAuthorization({
//   policies: 'permit(principal, action == Action::"deleet_record", resource);',
//   tools: [searchTool, deleteTool],
// })
// throws "Cedar policy validation failed: unrecognized action"
```
(( /tab "TypeScript" ))

Schema validation integrates with the [`cedar-for-agents`](https://github.com/cedar-policy/cedar-for-agents) ecosystem via `@cedar-policy/mcp-schema-generator-wasm` (TypeScript) and `cedar-policy-mcp-schema-generator` (Python).

## Namespaced policies

When using policy generators like [`cedar-agent-policy-builder`](https://github.com/cedar-policy/cedar-for-agents) that produce namespaced Cedar policies (e.g. `Agent::Action::"search"` instead of `Action::"search"`), set the `namespace` option to match:

(( tab "TypeScript" ))
```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'
import { z } from 'zod'

const searchTool = tool({
  name: 'search',
  description: 'Search for information',
  inputSchema: z.object({ query: z.string() }),
  callback: (input) => `Results for: ${input.query}`,
})

const cedar = new CedarAuthorization({
  namespace: 'Agent',
  policies: `
    permit(principal, action == Agent::Action::"search", resource);
  `,
  tools: [searchTool],
  entities: [
    { uid: { type: 'Agent::Resource', id: 'default' }, attrs: {}, parents: [] },
  ],
  principalResolver: (state) => {
    if (!state.user_id) return undefined
    return { type: 'Agent::User', id: String(state.user_id) }
  },
})

const agent = new Agent({
  tools: [searchTool],
  interventions: [cedar],
})

await agent.invoke('Search for reports', {
  invocationState: { user_id: 'alice' },
})
```
(( /tab "TypeScript" ))

When `namespace` is set:

| Cedar concept | Unnamespaced (default) | Namespaced (`namespace: 'Agent'`) |
| --- | --- | --- |
| **Action** | `Action::"search"` | `Agent::Action::"search"` |
| **Resource** | `Resource::"agent"` | `Agent::Resource::"default"` |
| **Default principal** | `User::"anonymous"` | `Agent::User::"anonymous"` |

Schema generation also uses the configured namespace, so `tools` and `namespace` work together correctly.

Note

The `namespace` option is currently available in the TypeScript SDK only. Python support is planned.

## Environment gating

Block tools based on deployment context by forwarding environment metadata through `context_enricher``contextEnricher`:

(( tab "Python" ))
```python
from strands import Agent, tool
from strands.vended_interventions.cedar import (
    CedarAuthorization,
)

@tool
def deploy(version: str) -> str:
    """Deploy the service."""
    return f"Deployed {version}"

cedar = CedarAuthorization(
    policies="""
      permit(
        principal,
        action == Action::"deploy",
        resource
      )
      when {
        context.session has environment &&
        ["staging", "dev"].contains(
          context.session.environment
        )
      };
    """,
    context_enricher=lambda ctx: {
        "environment": ctx["invocation_state"].get(
            "environment", "unknown"
        ),
    },
)

agent = Agent(
    tools=[deploy],
    interventions=[cedar],
)

# works in staging
agent(
    "Deploy the service",
    invocation_state={"environment": "staging"},
)

# denied in production
agent(
    "Deploy the service",
    invocation_state={"environment": "production"},
)

# denied when environment is absent: the enricher falls
# back to "unknown", which is outside the permitted set
agent("Deploy the service")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'
import { z } from 'zod'

const deployTool = tool({
  name: 'deploy',
  description: 'Deploy the service',
  inputSchema: z.object({ version: z.string() }),
  callback: (input) => `Deployed ${input.version}`,
})

const cedar = new CedarAuthorization({
  policies: `
    permit(principal, action == Action::"deploy", resource)
    when { context.session has environment &&
           ["staging", "dev"].contains(context.session.environment) };
  `,
  contextEnricher: ({ invocationState }) => ({
    environment: String(invocationState.environment ?? 'unknown'),
  }),
})

const agent = new Agent({
  tools: [deployTool],
  interventions: [cedar],
})

// works in staging
await agent.invoke('Deploy the service', {
  invocationState: { environment: 'staging' },
})

// denied in production
await agent.invoke('Deploy the service', {
  invocationState: { environment: 'production' },
})

// denied when environment is absent: the enricher falls back to
// 'unknown', which is outside the permitted set
await agent.invoke('Deploy the service')
```
(( /tab "TypeScript" ))

Permit an allowlist of environments rather than denying `"production"`. An allowlist stays fail-closed: when `environment` is missing from `invocation_state``invocationState`, the enricher’s fallback value falls outside the permitted set and the call is denied. A rule that denies `"production"` instead would permit that call, along with any spelling the rule doesn’t match exactly: `"Production"`, `"prod"`, `"prod-us-east-1"`.

## File-based policies

For production deployments, keep policies in `.cedar` files rather than inline strings:

(( tab "Python" ))
```python
from strands.vended_interventions.cedar import (
    CedarAuthorization,
)

cedar = CedarAuthorization(
    policies="./policies/agent.cedar",
    entities="./policies/entities.json",
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'

const cedar = new CedarAuthorization({
  policies: './policies/agent.cedar',
  entities: './policies/entities.json',
})
```
(( /tab "TypeScript" ))

The handler reads and parses files at construction time. Invalid syntax throws immediately.

## Hot reload

Update policies without restarting your agent process:

(( tab "Python" ))
```python
from strands import Agent, tool
from strands.vended_interventions.cedar import (
    CedarAuthorization,
)

@tool
def search(query: str) -> str:
    """Search for information."""
    return f"Results for: {query}"

cedar = CedarAuthorization(
    policies="./policies/agent.cedar",
)

agent = Agent(
    tools=[search],
    interventions=[cedar],
)

# After editing agent.cedar on disk:
cedar.reload()
# Validates new policies before applying.
# Raises ValueError if invalid.
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'
import { z } from 'zod'

const searchTool = tool({
  name: 'search',
  description: 'Search for information',
  inputSchema: z.object({ query: z.string() }),
  callback: (input) => `Results for: ${input.query}`,
})

const cedar = new CedarAuthorization({
  policies: './policies/agent.cedar',
})

const agent = new Agent({
  tools: [searchTool],
  interventions: [cedar],
})

// After editing agent.cedar on disk:
cedar.reload()
// Validates new policies before applying. Throws if invalid.
```
(( /tab "TypeScript" ))

`reload()` reads fresh policy, entity, and schema files, validates them, and atomically swaps the active policy set. If validation fails, the previous policies remain in effect and the method throws.

## Context structure

Every authorization request includes a structured context object:

```json
{
  "input": { "query": "quarterly report" },
  "session": {
    "hour_utc": 14,
    "call_count": 3,
    "role": "admin"
  }
}
```

-   `context.input` contains the tool’s input arguments, accessible in policies via `context.input.fieldName`
-   `context.session.hour_utc` is auto-populated with the current UTC hour (0-23)
-   `context.session.call_count` tracks per-tool invocation count
-   Additional `context.session` fields come from your `context_enricher``contextEnricher`

## Error handling

Cedar engine failures (malformed policies, evaluation errors) are always fail-closed: the tool call is denied regardless of configuration.

The `on_error``onError` option controls what happens when your user-supplied callbacks (`principal_resolver``principalResolver` or `context_enricher``contextEnricher`) raise an exception:

-   `'throw'` (default): re-raises the exception to the caller
-   `'deny'`: treats the callback failure as a denial (fail-closed)
-   `'proceed'`: allows the tool call despite the callback error (fail-open)

Fail-open on callback errors

With `'proceed'`, any exception from `principal_resolver``principalResolver` or `context_enricher``contextEnricher` lets the tool call run without a Cedar authorization check. Don’t use it when your agent relies on Cedar to enforce access. To block the tool call instead of failing the invocation, use `'deny'`.

## Installation

(( tab "Python" ))
```bash
pip install strands-agents[cedar]
```

Requires `cedarpy` and `cedar-policy-mcp-schema-generator` (installed automatically with the extra).
(( /tab "Python" ))

(( tab "TypeScript" ))
```bash
npm install @strands-agents/sdk
```

Cedar support is included in the core package via `@cedar-policy/mcp-schema-generator-wasm`.
(( /tab "TypeScript" ))

## Cedar policy syntax

For the full policy language grammar, operators, and built-in functions, see the [Cedar policy language reference](https://docs.cedarpolicy.com/syntax-policy.html).

## Related pages

- [Human in the loop](/docs/user-guide/sdk/agents/interventions/human-in-the-loop/index.md) (2 shared tags)
- [Interventions](/docs/user-guide/sdk/agents/interventions/index.md) (2 shared tags)
- [Creating a Custom Model Provider](/docs/user-guide/sdk/model-providers/custom_model_provider/index.md) (1 shared tag)
- [Attack strategies](/docs/user-guide/evals-sdk/red-teaming/strategies/index.md) (1 shared tag)
- [Harmfulness evaluator](/docs/user-guide/evals-sdk/evaluators/harmfulness_evaluator/index.md) (1 shared tag)
- [Reading the report](/docs/user-guide/evals-sdk/red-teaming/reading_the_report/index.md) (1 shared tag)
- [Red teaming](/docs/user-guide/evals-sdk/red-teaming/index.md) (1 shared tag)
- [Refusal evaluator](/docs/user-guide/evals-sdk/evaluators/refusal_evaluator/index.md) (1 shared tag)
- [Responsible AI](/docs/user-guide/sdk/safety-security/responsible-ai/index.md) (1 shared tag)
- [Scoring attacks](/docs/user-guide/evals-sdk/red-teaming/evaluators/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/vended_interventions/cedar/cedar_authorization.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/cedar/cedar_authorization.py)

### TypeScript

- [harness-sdk/strands-ts/src/vended-interventions/cedar/cedar.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-interventions/cedar/cedar.ts)
