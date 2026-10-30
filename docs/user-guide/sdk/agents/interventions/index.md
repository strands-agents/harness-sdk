Interventions are a composable control layer for agents. They provide a typed action model for common control concerns (authorization, guardrails, steering, and content transformation) with ordered evaluation and short-circuiting. Unlike raw [hooks](/docs/user-guide/sdk/agents/hooks/index.md) and [plugins](/docs/user-guide/sdk/plugins/index.md) which mutate event objects directly, intervention handlers return typed decisions (`proceed`, `deny`, `guide`, `confirm`, `transform`) that the framework applies with well-defined semantics: automatic short-circuiting, feedback accumulation, and conflict resolution.

## Basic Usage

Create an intervention handler by extending `InterventionHandler` and overriding the lifecycle methods you need. Register handlers via the `interventions` option in agent configuration:

(( tab "Python" ))
```python
from strands import Agent
from strands.interventions import Deny, InterventionHandler, Proceed

class ToolGuard(InterventionHandler):
    name = "tool-guard"

    def __init__(self, blocked_tools: list[str]):
        self.blocked_tools = blocked_tools

    def before_tool_call(self, event: BeforeToolCallEvent):
        if event.tool_use["name"] in self.blocked_tools:
            name = event.tool_use["name"]
            return Deny(
                reason=f"Tool '{name}' is not allowed"
            )
        return Proceed()

agent = Agent(
    tools=[search, delete_file],
    interventions=[ToolGuard(blocked_tools=["delete_file"])],
)

# The agent can search freely, but any attempt to call delete_file
# is blocked before execution: the model sees the denial reason
# and adjusts its approach
agent("Clean up the temp directory")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, InterventionHandler, InterventionActions } from '@strands-agents/sdk'
import type { BeforeToolCallEvent } from '@strands-agents/sdk'

class ToolGuard extends InterventionHandler {
  readonly name = 'tool-guard'
  private blockedTools: string[]

  constructor(blockedTools: string[]) {
    super()
    this.blockedTools = blockedTools
  }

  override beforeToolCall(event: BeforeToolCallEvent) {
    if (this.blockedTools.includes(event.toolUse.name)) {
      return InterventionActions.deny(
        `Tool '${event.toolUse.name}' is not allowed in this environment`
      )
    }
    return InterventionActions.proceed()
  }
}

const agent = new Agent({
  tools: [searchTool, deleteTool],
  interventions: [new ToolGuard(['delete_file'])],
})

// The agent can search freely, but any attempt to call delete_file
// is blocked before execution: the model sees the denial reason
// and adjusts its approach
await agent.invoke('Clean up the temp directory')
```
(( /tab "TypeScript" ))

Handlers only need to override the lifecycle methods relevant to their concern. All methods default to `Proceed()``proceed()`.

## Action Types

Each lifecycle method returns one of five typed actions:

(( tab "Python" ))
| Action | Class | Description |
| --- | --- | --- |
| Proceed | `Proceed()` | Allow the operation to continue unchanged |
| Deny | `Deny(reason="...")` | Block the operation. Short-circuits remaining handlers |
| Guide | `Guide(feedback="...")` | Cancel and provide feedback for the model to retry with |
| Confirm | `Confirm(prompt="...")` | Pause for human approval |
| Transform | `Transform(apply=fn)` | Modify event content in-place before execution continues |
(( /tab "Python" ))

(( tab "TypeScript" ))
| Action | Factory | Description |
| --- | --- | --- |
| Proceed | `InterventionActions.proceed()` | Allow the operation to continue unchanged |
| Deny | `InterventionActions.deny(reason)` | Block the operation. Short-circuits remaining handlers |
| Guide | `InterventionActions.guide(feedback)` | Cancel and provide feedback for the model to retry with |
| Confirm | `InterventionActions.confirm(prompt)` | Pause for human approval |
| Transform | `InterventionActions.transform(apply)` | Modify event content in-place before execution continues |
(( /tab "TypeScript" ))

The following examples show each action type in a realistic handler:

(( tab "Python" ))
```python
from strands.interventions import (
    Confirm, Deny, Guide, InterventionHandler,
    Proceed, Transform,
)

# Deny: block tool calls that access production resources
class EnvironmentGuard(InterventionHandler):
    name = "environment-guard"

    def before_tool_call(self, event: BeforeToolCallEvent):
        tool_input = event.tool_use.get("input", {})
        if "prod" in tool_input.get("database", ""):
            return Deny(reason="Production database access is not allowed")
        return Proceed()

# Guide: steer the model when it tries to send emails without a subject
class EmailValidator(InterventionHandler):
    name = "email-validator"

    def before_tool_call(self, event: BeforeToolCallEvent):
        if event.tool_use["name"] == "send_email":
            tool_input = event.tool_use.get("input", {})
            if not tool_input.get("subject"):
                return Guide(feedback="All emails must include a subject line.")
        return Proceed()

# Confirm: require human approval before deleting files
class DeleteApproval(InterventionHandler):
    name = "delete-approval"

    def before_tool_call(self, event: BeforeToolCallEvent):
        if event.tool_use["name"] == "delete_file":
            tool_input = event.tool_use.get("input", {})
            return Confirm(prompt=f"Approve deleting \"{tool_input.get('path')}\"?")
        return Proceed()

# Transform: redact PII from outgoing email bodies
class PiiRedactor(InterventionHandler):
    name = "pii-redactor"

    def before_tool_call(self, event: BeforeToolCallEvent):
        if event.tool_use["name"] == "send_email":
            import re

            def redact(e: BeforeToolCallEvent):
                tool_input = e.tool_use.get("input", {})
                body = tool_input.get("body", "")
                ssn_pattern = r"\b\d{3}-\d{2}-\d{4}\b"
                tool_input["body"] = re.sub(
                    ssn_pattern, "[REDACTED]", body
                )

            return Transform(apply=redact)
        return Proceed()
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { InterventionHandler, InterventionActions } from '@strands-agents/sdk'
import type { BeforeToolCallEvent } from '@strands-agents/sdk'

// deny: block tool calls that access production resources
class EnvironmentGuard extends InterventionHandler {
  readonly name = 'environment-guard'

  override beforeToolCall(event: BeforeToolCallEvent) {
    const input = event.toolUse.input as Record<string, string>
    if (input.database?.includes('prod')) {
      return InterventionActions.deny('Production database access is not allowed')
    }
    return InterventionActions.proceed()
  }
}

// guide: steer the model when it tries to send emails without a subject
class EmailValidator extends InterventionHandler {
  readonly name = 'email-validator'

  override beforeToolCall(event: BeforeToolCallEvent) {
    if (event.toolUse.name === 'send_email') {
      const input = event.toolUse.input as Record<string, string>
      if (!input.subject) {
        return InterventionActions.guide('All emails must include a subject line.')
      }
    }
    return InterventionActions.proceed()
  }
}

// confirm: require human approval before deleting files
class DeleteApproval extends InterventionHandler {
  readonly name = 'delete-approval'

  override beforeToolCall(event: BeforeToolCallEvent) {
    if (event.toolUse.name === 'delete_file') {
      const input = event.toolUse.input as Record<string, string>
      return InterventionActions.confirm(`Approve deleting "${input.path}"?`)
    }
    return InterventionActions.proceed()
  }
}

// transform: redact PII from outgoing email bodies
class PiiRedactor extends InterventionHandler {
  readonly name = 'pii-redactor'

  override beforeToolCall(event: BeforeToolCallEvent) {
    if (event.toolUse.name === 'send_email') {
      return InterventionActions.transform((e) => {
        const toolEvent = e as BeforeToolCallEvent
        const input = toolEvent.toolUse.input as Record<string, string>
        input.body = input.body.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED]')
      })
    }
    return InterventionActions.proceed()
  }
}
```
(( /tab "TypeScript" ))

## Lifecycle Methods

Intervention handlers can override five lifecycle methods. Each method supports a specific subset of actions:

| Method | Valid Actions | When it Runs |
| --- | --- | --- |
| `before_invocation``beforeInvocation` | Proceed, Deny, Guide, Transform | Before the agent loop starts |
| `before_tool_call``beforeToolCall` | Proceed, Deny, Guide, Confirm, Transform | Before each tool execution |
| `after_tool_call``afterToolCall` | Proceed, Transform | After each tool execution |
| `before_model_call``beforeModelCall` | Proceed, Deny, Guide, Transform | Before each model API call |
| `after_model_call``afterModelCall` | Proceed, Guide, Transform | After each model response |

How actions behave depends on the lifecycle method:

| Action | Before events | After events |
| --- | --- | --- |
| **Deny** | Sets `event.cancel`, short-circuits remaining handlers | No effect (warns at runtime) |
| **Guide** | On `before_tool_call``beforeToolCall`/`before_invocation``beforeInvocation`: cancels with accumulated feedback. On `before_model_call``beforeModelCall`: injects feedback as user message | Injects feedback and retries |
| **Confirm** | Pauses agent via interrupt/resume for human approval; denied responses set `event.cancel` | Not supported |
| **Transform** | Calls `action.apply(event)`; later handlers see modified content | Calls `action.apply(event)` |

On `after_model_call``afterModelCall`, `Guide` triggers a model retry. Handlers must ensure convergence (e.g., by tracking retry count and escalating to `Deny` after repeated failures). The framework imposes no retry cap on guide-triggered retries.

## Evaluation Order and Short-Circuiting

Handlers evaluate in **registration order**. If any handler returns `Deny`, remaining handlers are skipped: the operation is blocked immediately. This enables efficient pipelines where fast checks (like authorization) run first and prevent expensive evaluations (like LLM-based steering) from running unnecessarily.

(( tab "Python" ))
```python
from strands import Agent
from strands.interventions import Deny, Guide, InterventionHandler, Proceed

class RateLimiter(InterventionHandler):
    name = "rate-limiter"

    def __init__(self):
        self.call_count = 0

    def before_tool_call(self, event: BeforeToolCallEvent):
        self.call_count += 1
        if self.call_count > 10:
            # Deny short-circuits: handlers registered after this one are skipped
            return Deny(reason="Rate limit exceeded")
        return Proceed()

class ToneSteering(InterventionHandler):
    name = "tone-steering"

    def after_model_call(self, event: AfterModelCallEvent):
        # This handler never runs for denied tool calls
        return Guide(feedback="Use a more professional tone.")

# Handlers evaluate in registration order
agent = Agent(
    tools=[search],
    interventions=[
        RateLimiter(),    # Evaluates first
        ToneSteering(),   # Skipped if RateLimiter denies
    ],
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, InterventionHandler, InterventionActions } from '@strands-agents/sdk'
import type { BeforeToolCallEvent, AfterModelCallEvent } from '@strands-agents/sdk'

class RateLimiter extends InterventionHandler {
  readonly name = 'rate-limiter'
  private callCount = 0

  override beforeToolCall(event: BeforeToolCallEvent) {
    this.callCount++
    if (this.callCount > 10) {
      // deny() short-circuits: handlers registered after this one are skipped
      return InterventionActions.deny('Rate limit exceeded')
    }
    return InterventionActions.proceed()
  }
}

class ToneSteeringHandler extends InterventionHandler {
  readonly name = 'tone-steering'

  override afterModelCall(event: AfterModelCallEvent) {
    // This handler never runs for denied tool calls
    return InterventionActions.guide('Use a more professional tone.')
  }
}

// Handlers evaluate in registration order
const agent = new Agent({
  tools: [searchTool],
  interventions: [
    new RateLimiter(), // Evaluates first
    new ToneSteeringHandler(), // Skipped if RateLimiter denies
  ],
})
```
(( /tab "TypeScript" ))

For `Guide` actions, all handlers continue to run and their feedback is accumulated: the model receives combined guidance from all guiding handlers.

## Error Handling

The `on_error``onError` property controls what happens when a handler throws an exception:

| Value | Behavior |
| --- | --- |
| `'throw'` | Rethrow the error (default). The invocation fails. |
| `'proceed'` | Skip the handler and continue as if `Proceed()` was returned (fail-open). |
| `'deny'` | Log the error and treat it as a `Deny` (fail-closed). |

(( tab "Python" ))
```python
from strands.interventions import Deny, InterventionHandler, OnError, Proceed

# 'proceed': if this handler throws, continue as if Proceed() was returned
class BestEffortLogger(InterventionHandler):
    name = "best-effort-logger"

    @property
    def on_error(self) -> OnError:
        return "proceed"

    def before_tool_call(self, event: BeforeToolCallEvent):
        # If the logging service is unreachable, the agent continues normally
        print(f"Tool called: {event.tool_use['name']}")
        return Proceed()

# 'deny': if this handler throws, treat it as a Deny (fail-closed)
class StrictAuth(InterventionHandler):
    name = "strict-auth"

    @property
    def on_error(self) -> OnError:
        return "deny"

    def before_tool_call(self, event: BeforeToolCallEvent):
        # If the auth service is down (throws), the operation is denied
        if not self._check_permission(event.tool_use["name"]):
            return Deny(reason="Unauthorized")
        return Proceed()

    def _check_permission(self, tool_name: str) -> bool:
        # ... call external auth service
        return True

# 'throw' (default): errors propagate and fail the invocation
class CriticalValidator(InterventionHandler):
    name = "critical-validator"
    # on_error defaults to 'throw'

    def before_tool_call(self, event: BeforeToolCallEvent):
        # If this throws, the entire invocation fails
        return Proceed()
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { InterventionHandler, InterventionActions } from '@strands-agents/sdk'
import type { OnError, BeforeToolCallEvent } from '@strands-agents/sdk'

// 'proceed': if this handler throws, continue as if proceed() was returned
class BestEffortLogger extends InterventionHandler {
  readonly name = 'best-effort-logger'
  readonly onError: OnError = 'proceed'

  override beforeToolCall(event: BeforeToolCallEvent) {
    // If the logging service is unreachable, the agent continues normally
    console.log(`Tool called: ${event.toolUse.name}`)
    return InterventionActions.proceed()
  }
}

// 'deny': if this handler throws, treat it as a deny (fail-closed)
class StrictAuth extends InterventionHandler {
  readonly name = 'strict-auth'
  readonly onError: OnError = 'deny'

  override beforeToolCall(event: BeforeToolCallEvent) {
    // If the auth service is down (throws), the operation is denied
    if (!this.checkPermission(event.toolUse.name)) {
      return InterventionActions.deny('Unauthorized')
    }
    return InterventionActions.proceed()
  }

  private checkPermission(toolName: string): boolean {
    // ... call external auth service
    return true
  }
}

// 'throw' (default): errors propagate and fail the invocation
class CriticalValidator extends InterventionHandler {
  readonly name = 'critical-validator'
  // onError defaults to 'throw'

  override beforeToolCall(event: BeforeToolCallEvent) {
    // If this throws, the entire invocation fails
    return InterventionActions.proceed()
  }
}
```
(( /tab "TypeScript" ))

Use `'deny'` for security-critical handlers where a failure should block execution. Use `'proceed'` only for non-critical handlers like logging where availability is more important than enforcement. Never use `'proceed'` on an authorization or other security handler: if it throws, the action it guards runs unchecked.

## Confirm Action

The `Confirm` action is only supported on `before_tool_call``beforeToolCall`. It integrates with the SDK’s interrupt/resume system to pause for human approval before a tool executes.

(( tab "Python" ))
`Confirm` supports two modes depending on whether `response` is provided:

-   **With `response`**: the value is passed directly to the `evaluate` function, so the agent never pauses.
-   **Without `response`**: breaks out of the agent loop to pause for external resume via the interrupt system.

The `evaluate` function determines whether the response counts as approval. The default accepts `True`, `"y"`, or `"yes"` (case-insensitive).

```python
from strands.interventions import Confirm, InterventionHandler, Proceed

class SensitiveToolApproval(InterventionHandler):
    name = "sensitive-tool-approval"

    def before_tool_call(self, event: BeforeToolCallEvent):
        if event.tool_use["name"] in ("delete_file", "send_email"):
            return Confirm(
                prompt=f"Allow {event.tool_use['name']}?"
            )
        return Proceed()

# Preemptive approval: agent doesn't pause
class AutoApprove(InterventionHandler):
    name = "auto-approve"

    def before_tool_call(self, event: BeforeToolCallEvent):
        if event.tool_use["name"] == "search":
            return Confirm(
                prompt="Allow search?",
                response="yes",
            )
        return Proceed()
```
(( /tab "Python" ))

(( tab "TypeScript" ))
`Confirm` pauses the agent loop via the interrupt system. The agent resumes when the interrupt is resolved externally.

```typescript
import { InterventionHandler, InterventionActions } from '@strands-agents/sdk'
import type { BeforeToolCallEvent } from '@strands-agents/sdk'

class DeleteApproval extends InterventionHandler {
  readonly name = 'delete-approval'

  override beforeToolCall(event: BeforeToolCallEvent) {
    if (event.toolUse.name === 'delete_file') {
      const input = event.toolUse.input as Record<string, string>
      return InterventionActions.confirm(`Approve deleting "${input.path}"?`)
    }
    return InterventionActions.proceed()
  }
}
```

See [Human in the Loop](/docs/user-guide/sdk/agents/interventions/human-in-the-loop/index.md) for ready-to-use approval workflows with configurable modes for CLI, web, and custom UIs.
(( /tab "TypeScript" ))

## Relationship to Hooks and Plugins

Interventions build on the [hooks](/docs/user-guide/sdk/agents/hooks/index.md) system: each lifecycle method registers a hook callback. The difference is in how they communicate with the framework.

[Hooks](/docs/user-guide/sdk/agents/hooks/index.md) and [plugins](/docs/user-guide/sdk/plugins/index.md) mutate event properties directly (e.g., setting `event.cancel = "reason"`). The framework doesn’t know *why* something was cancelled. Was it a hard authorization denial, or soft guidance to retry differently? Multiple plugins modifying the same event can conflict silently with last-write-wins semantics.

Interventions return typed actions that the framework interprets. This enables:

-   **Short-circuiting**: a `Deny` from an authorization handler skips all remaining handlers automatically. With hooks, each plugin must independently check `event.cancel` before doing work.
-   **Feedback accumulation**: multiple handlers can return `Guide` and their feedback is combined into a single message to the model, rather than overwriting each other.
-   **Human-in-the-loop**: `Confirm` integrates with the SDK’s interrupt/resume system to pause for approval without the handler needing to manage interrupt lifecycle.
-   **Ordered evaluation**: handlers always run in registration order with well-defined precedence (deny > confirm > guide > transform > proceed).
-   **Error policies**: each handler declares its own failure mode via `on_error``onError`. A logging handler can use `'proceed'` (skip on failure), while an auth handler can use `'deny'` (fail closed). Hooks have no equivalent: a thrown error always propagates.

## Related topics

-   [Cedar Authorization](/docs/user-guide/sdk/agents/interventions/cedar-authorization/index.md): declarative, identity-aware access control using Cedar policies
-   [Steering](/docs/user-guide/sdk/agents/interventions/steering/index.md): LLM-based contextual guidance using the steering handler
-   [Human in the Loop](/docs/user-guide/sdk/agents/interventions/human-in-the-loop/index.md): ready-to-use intervention handler for tool approval workflows
-   [Hooks](/docs/user-guide/sdk/agents/hooks/index.md): low-level event callbacks for observing and modifying agent behavior
-   [Plugins](/docs/user-guide/sdk/plugins/index.md): bundle related hooks and tools into reusable modules
-   [Interrupts](/docs/user-guide/sdk/interrupts/index.md): the interrupt/resume system that `Confirm` builds on

## Related pages

- [Agent Loop](/docs/user-guide/sdk/agents/agent-loop/index.md) (3 shared tags)
- [Hook events](/docs/user-guide/sdk/agents/hooks-events/index.md) (3 shared tags)
- [Hooks](/docs/user-guide/sdk/agents/hooks/index.md) (3 shared tags)
- [Interrupts](/docs/user-guide/sdk/interrupts/index.md) (3 shared tags)
- [Steering](/docs/user-guide/sdk/agents/interventions/steering/index.md) (3 shared tags)
- [Human in the loop](/docs/user-guide/sdk/agents/interventions/human-in-the-loop/index.md) (2 shared tags)
- [Build a custom plugin](/docs/user-guide/sdk/plugins/custom-plugins/index.md) (2 shared tags)
- [Plugins](/docs/user-guide/sdk/plugins/index.md) (2 shared tags)
- [Middleware](/docs/user-guide/sdk/agents/middleware/index.md) (2 shared tags)
- [Tool Executors](/docs/user-guide/sdk/tools/executors/index.md) (2 shared tags)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/interventions/handler.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interventions/handler.py)
- [harness-sdk/strands-py/src/strands/interventions/actions.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interventions/actions.py)
- [harness-sdk/strands-py/src/strands/interventions/registry.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interventions/registry.py)

### TypeScript

- [harness-sdk/strands-ts/src/interventions/handler.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interventions/handler.ts)
- [harness-sdk/strands-ts/src/interventions/actions.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interventions/actions.ts)
- [harness-sdk/strands-ts/src/interventions/registry.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interventions/registry.ts)
