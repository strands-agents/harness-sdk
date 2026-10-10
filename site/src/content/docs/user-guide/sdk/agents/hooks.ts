import { Agent, FunctionTool, HookOrder } from '@strands-agents/sdk'
import type { LocalAgent, Plugin, Interrupt } from '@strands-agents/sdk'
import {
  BeforeInvocationEvent,
  AfterInvocationEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  BeforeModelCallEvent,
  AfterModelCallEvent,
  MessageAddedEvent,
  InterruptEvent,
  ToolResultBlock,
  TextBlock,
} from '@strands-agents/sdk'
import {
  Graph,
  Swarm,
  BeforeNodeCallEvent,
  AfterNodeCallEvent,
} from '@strands-agents/sdk/multiagent'
import type { MultiAgent, MultiAgentPlugin } from '@strands-agents/sdk/multiagent'

// Mock tools for examples
const myTool = new FunctionTool({
  name: 'my_tool',
  description: 'A sample tool',
  inputSchema: { type: 'object', properties: {} },
  callback: async () => 'result',
})

const calculator = new FunctionTool({
  name: 'calculator',
  description: 'Perform calculations',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Mathematical expression to evaluate' },
    },
  },
  callback: async (input: unknown) => {
    // Simple mock implementation
    const typedInput = input as { expression: string }
    return eval(typedInput.expression).toString()
  },
})

const sleep = new FunctionTool({
  name: 'sleep',
  description: 'Sleep for a specified duration',
  inputSchema: {
    type: 'object',
    properties: {
      duration: { type: 'number', description: 'Duration in milliseconds' },
    },
  },
  callback: async (input: unknown) => {
    const typedInput = input as { duration: number }
    await new Promise((resolve) => setTimeout(resolve, typedInput.duration))
    return `Slept for ${typedInput.duration}ms`
  },
})

// =====================
// Basic Usage Examples
// =====================

async function individualCallbackExample() {
  // --8<-- [start:individual_callback]
  const agent = new Agent()

  // Register individual callback
  const myCallback = (event: BeforeInvocationEvent) => {
    console.log('Custom callback triggered')
  }

  agent.addHook(BeforeInvocationEvent, myCallback)
  // --8<-- [end:individual_callback]
}

async function hookOrderingExample() {
  // --8<-- [start:hook_ordering]
  const agent = new Agent()

  agent.addHook(BeforeToolCallEvent, (event) => {
    console.log('[logging] Tool called:', event.toolUse.name)
  }) // HookOrder.DEFAULT (0)

  // Run before the SDK's earliest hooks
  agent.addHook(
    BeforeToolCallEvent,
    (event) => {
      console.log('[guardrail] Runs before SDK hooks')
    },
    { order: HookOrder.SDK_FIRST - 1 }
  )

  // Arbitrary numbers for fine-grained control
  agent.addHook(
    BeforeToolCallEvent,
    (event) => {
      console.log('[validation] Validating input')
    },
    { order: -50 }
  )

  // Use -Infinity/Infinity for guaranteed absolute first/last
  agent.addHook(
    BeforeToolCallEvent,
    (event) => {
      console.log('[absolute] Always runs first, no matter what')
    },
    { order: -Infinity }
  )
  // --8<-- [end:hook_ordering]
}

// =====================
// Advanced Usage Examples
// =====================

async function invocationStateInHooksExample() {
  // --8<-- [start:invocation_state_in_hooks]
  const agent = new Agent()

  agent.addHook(BeforeToolCallEvent, (event) => {
    // Read caller-provided context
    const userId = event.invocationState.userId as string | undefined
    const sessionId = event.invocationState.sessionId as string | undefined

    console.log(
      `User ${userId} (session ${sessionId}) ` + `invoking tool: ${event.toolUse.name}`
    )
  })

  // Pass invocation state when invoking the agent
  const result = await agent.invoke('Process the data', {
    invocationState: {
      userId: 'user123',
      sessionId: 'sess456',
    },
  })

  // The same object is returned on the result
  console.log(result.invocationState.userId) // 'user123'
  // --8<-- [end:invocation_state_in_hooks]
}

async function toolInterceptionExample() {
  // --8<-- [start:tool_interception]
  class ToolInterceptor implements Plugin {
    name = 'tool-interceptor'

    constructor(private readonly safeAlternative: FunctionTool) {}

    initAgent(agent: LocalAgent): void {
      agent.addHook(BeforeToolCallEvent, (event) => this.interceptTool(event))
    }

    private interceptTool(event: BeforeToolCallEvent): void {
      if (event.toolUse.name !== 'sensitive_tool') return
      // Run a safer tool in place of the registry's match for this call.
      event.selectedTool = this.safeAlternative
      // Mirror the rename on toolUse so the model sees the substitution.
      event.toolUse.name = this.safeAlternative.name
    }
  }
  // --8<-- [end:tool_interception]
}

async function resultModificationExample() {
  // --8<-- [start:result_modification]
  class ResultProcessor implements Plugin {
    name = 'result-processor'

    initAgent(agent: LocalAgent): void {
      agent.addHook(AfterToolCallEvent, (event) => this.processResult(event))
    }

    private processResult(event: AfterToolCallEvent): void {
      if (event.toolUse.name !== 'calculator') return

      // Prefix calculator output before it propagates to the model.
      event.result = new ToolResultBlock({
        toolUseId: event.result.toolUseId,
        status: event.result.status,
        content: event.result.content.map((block) =>
          block.type === 'textBlock' ? new TextBlock(`Result: ${block.text}`) : block
        ),
        ...(event.result.error !== undefined ? { error: event.result.error } : {}),
      })
    }
  }
  // --8<-- [end:result_modification]
}

async function modelCallRetryExample() {
  // --8<-- [start:model_call_retry_class]
  class RetryOnServiceUnavailable implements Plugin {
    name = 'retry-on-service-unavailable'

    constructor(private readonly maxRetries = 3) {}

    initAgent(agent: LocalAgent): void {
      agent.addHook(AfterModelCallEvent, (event) => this.handleRetry(event))
    }

    private handleRetry(event: AfterModelCallEvent): void {
      // `attemptCount` is 1-indexed and includes the attempt that just failed,
      // so no manual counter is needed to cap retries.
      if (
        event.error !== undefined &&
        event.error.message.includes('ServiceUnavailable') &&
        event.attemptCount <= this.maxRetries
      ) {
        event.retry = true
      }
    }
  }
  // --8<-- [end:model_call_retry_class]

  // --8<-- [start:model_call_retry_usage]
  const agent = new Agent({ plugins: [new RetryOnServiceUnavailable(3)] })

  const result = await agent.invoke('What is the capital of France?')
  // --8<-- [end:model_call_retry_usage]
  return result
}

async function toolCallRetryExample() {
  // --8<-- [start:tool_call_retry_class]
  class RetryOnToolError implements Plugin {
    name = 'retry-on-tool-error'

    private readonly attempts = new Map<string, number>()

    constructor(private readonly maxRetries = 1) {}

    initAgent(agent: LocalAgent): void {
      agent.addHook(AfterToolCallEvent, (event) => this.handleRetry(event))
    }

    private handleRetry(event: AfterToolCallEvent): void {
      const toolUseId = event.result.toolUseId
      const attempt = (this.attempts.get(toolUseId) ?? 0) + 1
      this.attempts.set(toolUseId, attempt)

      if (event.error !== undefined && attempt <= this.maxRetries) {
        event.retry = true
      } else if (event.error === undefined) {
        // Clean up tracking once the tool call finally succeeds.
        this.attempts.delete(toolUseId)
      }
    }
  }
  // --8<-- [end:tool_call_retry_class]

  // --8<-- [start:tool_call_retry_usage]
  const agent = new Agent({ plugins: [new RetryOnToolError(1)] })

  const result = await agent.invoke('Fetch the latest metrics')
  // --8<-- [end:tool_call_retry_usage]
  return result
}

// =====================
// Best Practices Examples
// =====================

async function composabilityExample() {
  // --8<-- [start:composability]
  class RequestLoggingHook implements Plugin {
    name = 'request-logging'

    initAgent(agent: LocalAgent): void {
      agent.addHook(BeforeInvocationEvent, (ev) => this.logRequest(ev))
      agent.addHook(AfterInvocationEvent, (ev) => this.logResponse(ev))
      agent.addHook(BeforeToolCallEvent, (ev) => this.logToolUse(ev))
    }

    // ...
    // --8<-- [end:composability]

    private logRequest(event: BeforeInvocationEvent): void {
      // ...
    }

    private logResponse(event: AfterInvocationEvent): void {
      // ...
    }

    private logToolUse(event: BeforeToolCallEvent): void {
      // ...
    }
  }
}

async function loggingModificationsExample() {
  // --8<-- [start:logging_modifications]
  class ResultProcessor implements Plugin {
    name = 'result-processor'

    initAgent(agent: LocalAgent): void {
      agent.addHook(AfterToolCallEvent, (event) => this.processResult(event))
    }

    private processResult(event: AfterToolCallEvent): void {
      if (event.toolUse.name !== 'calculator') return

      const original = event.result.content.find((block) => block.type === 'textBlock')
      if (original?.type !== 'textBlock') return

      // Log the change before mutating so the audit trail captures both states.
      console.log(`Modifying calculator result: ${original.text}`)
      event.result = new ToolResultBlock({
        toolUseId: event.result.toolUseId,
        status: event.result.status,
        content: event.result.content.map((block) =>
          block.type === 'textBlock' ? new TextBlock(`Result: ${block.text}`) : block
        ),
        ...(event.result.error !== undefined ? { error: event.result.error } : {}),
      })
    }
  }
  // --8<-- [end:logging_modifications]
}

// =====================
// Cookbook Examples
// =====================

async function fixedToolArgumentsExample() {
  // --8<-- [start:fixed_tool_arguments_class]
  class ConstantToolArguments implements Plugin {
    private fixedToolArguments: Record<string, Record<string, unknown>>

    /**
     * Initialize fixed parameter values for tools.
     *
     * @param fixedToolArguments - A dictionary mapping tool names to dictionaries of
     *     parameter names and their fixed values. These values will override any
     *     values provided by the agent when the tool is invoked.
     */
    constructor(fixedToolArguments: Record<string, Record<string, unknown>>) {
      this.fixedToolArguments = fixedToolArguments
    }

    name = 'constant-tool-arguments'

    initAgent(agent: LocalAgent): void {
      agent.addHook(BeforeToolCallEvent, (ev) => this.fixToolArguments(ev))
    }

    private fixToolArguments(event: BeforeToolCallEvent): void {
      // If the tool is in our list of parameters, then use those parameters
      const parametersToFix = this.fixedToolArguments[event.toolUse.name]
      if (parametersToFix) {
        const toolInput = event.toolUse.input as Record<string, unknown>
        Object.assign(toolInput, parametersToFix)
      }
    }
  }
  // --8<-- [end:fixed_tool_arguments_class]

  // --8<-- [start:fixed_tool_arguments_usage]
  const fixParameters = new ConstantToolArguments({
    calculator: {
      precision: 1,
    },
  })

  const agent = new Agent({ tools: [calculator], plugins: [fixParameters] })
  const result = await agent.invoke('What is 2 / 3?')
  // --8<-- [end:fixed_tool_arguments_usage]
}

async function limitToolCountsExample() {
  // --8<-- [start:limit_tool_counts_class]
  class LimitToolCounts implements Plugin {
    private maxToolCounts: Record<string, number>
    private toolCounts: Record<string, number> = {}

    /**
     * Initialize with maximum allowed invocations per tool.
     *
     * @param maxToolCounts - A dictionary mapping tool names to their maximum
     *     allowed invocation counts per agent invocation.
     */
    constructor(maxToolCounts: Record<string, number>) {
      this.maxToolCounts = maxToolCounts
    }

    name = 'limit-tool-counts'

    initAgent(agent: LocalAgent): void {
      agent.addHook(BeforeInvocationEvent, () => this.resetCounts())
      agent.addHook(BeforeToolCallEvent, (event) => this.interceptTool(event))
    }

    private resetCounts(): void {
      this.toolCounts = {}
    }

    private interceptTool(event: BeforeToolCallEvent): void {
      const toolName = event.toolUse.name
      const maxToolCount = this.maxToolCounts[toolName]
      const toolCount = (this.toolCounts[toolName] ?? 0) + 1
      this.toolCounts[toolName] = toolCount

      if (maxToolCount !== undefined && toolCount > maxToolCount) {
        event.cancel =
          `Tool '${toolName}' has been invoked too many times and is now being throttled. ` +
          `DO NOT CALL THIS TOOL ANYMORE`
      }
    }
  }
  // --8<-- [end:limit_tool_counts_class]

  // --8<-- [start:limit_tool_counts_usage]
  const limitPlugin = new LimitToolCounts({ sleep: 3 })

  const agent = new Agent({ tools: [sleep], plugins: [limitPlugin] })

  // This call will only have 3 successful sleeps
  await agent.invoke("Sleep 5 times for 10ms each or until you can't anymore")
  // This will sleep successfully again because the count resets every invocation
  await agent.invoke('Sleep once')
  // --8<-- [end:limit_tool_counts_usage]
}

// =====================
// Multi-Agent Hook Examples
// =====================

async function orchestratorCallbackExample() {
  // --8<-- [start:orchestrator_callback]
  const researcher = new Agent({
    id: 'researcher',
    systemPrompt: 'You are a research specialist.',
  })
  const writer = new Agent({
    id: 'writer',
    systemPrompt: 'You are a writing specialist.',
  })

  const graph = new Graph({
    nodes: [researcher, writer],
    edges: [['researcher', 'writer']],
  })

  // Register individual callbacks on the orchestrator
  graph.addHook(BeforeNodeCallEvent, (event) => {
    console.log(`Node ${event.nodeId} starting`)
  })

  graph.addHook(AfterNodeCallEvent, (event) => {
    console.log(`Node ${event.nodeId} completed`)
  })
  // --8<-- [end:orchestrator_callback]
}

async function conditionalNodeExecutionExample() {
  // --8<-- [start:conditional_node_execution]
  const researcher = new Agent({
    id: 'researcher',
    systemPrompt: 'You are a research specialist.',
  })
  const writer = new Agent({
    id: 'writer',
    systemPrompt: 'You are a writing specialist.',
  })
  const reviewer = new Agent({
    id: 'reviewer',
    systemPrompt: 'You are a review specialist.',
  })

  const graph = new Graph({
    nodes: [researcher, writer, reviewer],
    edges: [
      ['researcher', 'writer'],
      ['writer', 'reviewer'],
    ],
  })

  // Cancel specific nodes based on custom conditions
  graph.addHook(BeforeNodeCallEvent, (event) => {
    if (event.nodeId === 'reviewer') {
      // Cancel with a custom message
      event.cancel = 'Skipping review for this run'
    }
  })
  // --8<-- [end:conditional_node_execution]
}

async function orchestratorAgnosticDesignExample() {
  // --8<-- [start:orchestrator_agnostic_design]
  class UniversalMultiAgentPlugin implements MultiAgentPlugin {
    readonly name = 'universal-multi-agent'

    initMultiAgent(orchestrator: MultiAgent): void {
      orchestrator.addHook(BeforeNodeCallEvent, (event) => {
        console.log(`Executing node ${event.nodeId} in ${orchestrator.id} orchestrator`)

        // Handle orchestrator-specific logic if needed
        if (orchestrator instanceof Graph) {
          this.handleGraphNode(event)
        } else if (orchestrator instanceof Swarm) {
          this.handleSwarmNode(event)
        }
      })
    }

    private handleGraphNode(event: BeforeNodeCallEvent): void {
      // Graph-specific handling
    }

    private handleSwarmNode(event: BeforeNodeCallEvent): void {
      // Swarm-specific handling
    }
  }
  // --8<-- [end:orchestrator_agnostic_design]
  void UniversalMultiAgentPlugin
}

async function layeredHooksExample() {
  // --8<-- [start:layered_hooks]
  // Agent-level hooks via plugins
  class AgentLoggingPlugin implements Plugin {
    name = 'agent-logging'

    initAgent(agent: LocalAgent): void {
      agent.addHook(BeforeToolCallEvent, (event) => {
        console.log(`Agent tool call: ${event.toolUse.name}`)
      })
    }
  }

  // Create agents with individual hooks
  const agent1 = new Agent({ id: 'agent1', plugins: [new AgentLoggingPlugin()] })
  const agent2 = new Agent({ id: 'agent2', plugins: [new AgentLoggingPlugin()] })

  // Orchestrator-level hooks via MultiAgentPlugin
  class OrchestratorLoggingPlugin implements MultiAgentPlugin {
    readonly name = 'orchestrator-logging'

    initMultiAgent(orchestrator: MultiAgent): void {
      orchestrator.addHook(BeforeNodeCallEvent, (event) => {
        console.log(`Orchestrator node execution: ${event.nodeId}`)
      })
    }
  }

  // Create orchestrator with multi-agent hooks
  const graph = new Graph({
    nodes: [agent1, agent2],
    edges: [['agent1', 'agent2']],
    plugins: [new OrchestratorLoggingPlugin()],
  })
  // --8<-- [end:layered_hooks]
  void graph
}

async function summarizeAfterToolsExample() {
  // --8<-- [start:summarize_after_tools]
  let resumeCount = 0

  const agent = new Agent({})
  agent.addHook(AfterInvocationEvent, (event) => {
    // Resume once after a clean turn to ask the model for a one-line summary.
    if (resumeCount === 0) {
      resumeCount += 1
      event.resume = 'Now summarize what you just did in one sentence.'
    }
  })

  const result = await agent.invoke('Look up the weather in Seattle')
  // --8<-- [end:summarize_after_tools]
  void result
}

async function iterativeRefinementExample() {
  // --8<-- [start:iterative_refinement]
  const MAX_ITERATIONS = 3
  let iteration = 0

  const agent = new Agent({})
  agent.addHook(AfterInvocationEvent, (event) => {
    if (iteration >= MAX_ITERATIONS) return
    iteration += 1
    event.resume = `Review your previous response and improve it. Iteration ${iteration} of ${MAX_ITERATIONS}.`
  })

  const result = await agent.invoke('Draft a haiku about programming')
  // --8<-- [end:iterative_refinement]
  void result
}

async function autoApproveInterruptsExample() {
  // --8<-- [start:auto_approve_interrupts]
  const agent = new Agent({ tools: [] })

  // Track interrupts as they fire so AfterInvocationEvent can build resume input.
  const pendingInterrupts: Interrupt[] = []

  agent.addHook(BeforeToolCallEvent, (event) => {
    if (event.toolUse.name === 'send_email') {
      event.interrupt({ name: 'email_approval', reason: 'Approve this email?' })
    }
  })

  agent.addHook(InterruptEvent, (event) => {
    pendingInterrupts.push(event.interrupt)
  })

  agent.addHook(AfterInvocationEvent, (event) => {
    if (pendingInterrupts.length === 0) return
    // Auto-approve every interrupted tool call so the caller never sees the interrupt.
    event.resume = pendingInterrupts.map((interrupt) => ({
      interruptResponse: {
        interruptId: interrupt.id,
        response: 'approved',
      },
    }))
    pendingInterrupts.length = 0
  })

  const result = await agent.invoke('Send an email to alice@example.com saying hello')
  // --8<-- [end:auto_approve_interrupts]
  void result
}

// Suppress unused function warnings
void invocationStateInHooksExample
void hookOrderingExample
void limitToolCountsExample
void orchestratorCallbackExample
void conditionalNodeExecutionExample
void orchestratorAgnosticDesignExample
void layeredHooksExample
void summarizeAfterToolsExample
void iterativeRefinementExample
void autoApproveInterruptsExample
