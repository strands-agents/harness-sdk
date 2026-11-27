import {
  Agent,
  FunctionTool,
  InterventionHandler,
  InterventionActions,
} from '@strands-agents/sdk'
import type { OnError } from '@strands-agents/sdk'
import {
  BeforeInvocationEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  BeforeModelCallEvent,
  AfterModelCallEvent,
} from '@strands-agents/sdk'

// Mock tools for examples
const searchTool = new FunctionTool({
  name: 'search',
  description: 'Search for information',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  callback: async (input: unknown) => 'search results',
})

const sendEmailTool = new FunctionTool({
  name: 'send_email',
  description: 'Send an email',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      body: { type: 'string' },
    },
  },
  callback: async (input: unknown) => 'email sent',
})

const deleteTool = new FunctionTool({
  name: 'delete_file',
  description: 'Delete a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  callback: async (input: unknown) => 'deleted',
})

// =====================
// Basic Usage
// =====================

async function basicUsageExample() {
  // --8<-- [start:basic_usage]
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
  // --8<-- [end:basic_usage]
}

// =====================
// Action Types
// =====================

async function actionTypesExample() {
  // --8<-- [start:action_types]
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
  // --8<-- [end:action_types]
}

// =====================
// Short-Circuiting
// =====================

async function shortCircuitingExample() {
  // --8<-- [start:short_circuiting]
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
  // --8<-- [end:short_circuiting]
}

// =====================
// Error Handling
// =====================

async function errorHandlingExample() {
  // --8<-- [start:error_handling]
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
  // --8<-- [end:error_handling]
}

// =====================
// Confirm Action
// =====================

async function confirmExample() {
  // --8<-- [start:confirm]
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
  // --8<-- [end:confirm]
}

// Suppress unused function warnings
void basicUsageExample
void actionTypesExample
void shortCircuitingExample
void errorHandlingExample
void confirmExample
