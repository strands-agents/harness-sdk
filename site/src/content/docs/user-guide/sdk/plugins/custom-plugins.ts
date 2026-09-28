import { Agent, FunctionTool, Tool } from '@strands-agents/sdk'
import type { LocalAgent, Plugin } from '@strands-agents/sdk'
import {
  BeforeToolCallEvent,
  AfterToolCallEvent,
  BeforeModelCallEvent,
  AfterModelCallEvent,
} from '@strands-agents/sdk'

// Mock tools for examples
const myTool = new FunctionTool({
  name: 'my_tool',
  description: 'A sample tool',
  inputSchema: { type: 'object', properties: {} },
  callback: async () => 'result',
})

void myTool

// =====================
// Using Plugins Example
// =====================

async function usingPluginsExample() {
  class GuidancePlugin implements Plugin {
    private systemPrompt: string

    constructor(systemPrompt: string) {
      this.systemPrompt = systemPrompt
    }

    name = 'guidance-plugin'

    initAgent(agent: LocalAgent): void {
      // Register hooks to guide agent behavior
      agent.addHook(BeforeModelCallEvent, () => {
        console.log(`[Guidance] System prompt: ${this.systemPrompt}`)
      })
    }
  }

  const myTool = null as unknown as Tool
  // --8<-- [start:using_plugins]

  // Create an agent with plugins
  const agent = new Agent({
    tools: [myTool],
    plugins: [new GuidancePlugin('Guide the agent...')],
  })

  // --8<-- [end:using_plugins]

  void GuidancePlugin
  void agent
}

// =====================
// Basic Plugin Structure
// =====================

async function basicPluginExample() {
  // --8<-- [start:basic_plugin]
  class LoggingPlugin implements Plugin {
    name = 'logging-plugin'

    initAgent(agent: LocalAgent): void {
      // Register hooks manually in initAgent
      agent.addHook(BeforeToolCallEvent, (event) => {
        console.log(`[LOG] Calling tool: ${event.toolUse.name}`)
        console.log(`[LOG] Input: ${JSON.stringify(event.toolUse.input)}`)
      })

      agent.addHook(AfterToolCallEvent, (event) => {
        console.log(`[LOG] Tool completed: ${event.toolUse.name}`)
      })
    }

    getTools(): Tool[] {
      // Provide additional tools via the plugin
      return [debugPrintTool]
    }
  }

  // Using the plugin
  const agent = new Agent({
    plugins: [new LoggingPlugin()],
  })

  // Custom tool to add
  const debugPrintTool = new FunctionTool({
    name: 'debug_print',
    description: 'Print a debug message',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to print' },
      },
      required: ['message'],
    },
    callback: async (input: unknown) => {
      const typedInput = input as { message: string }
      console.log(`[DEBUG] ${typedInput.message}`)
      return `Printed: ${typedInput.message}`
    },
  })
  // --8<-- [end:basic_plugin]
  void agent
}

// =====================
// Hook Decorator Alternative
// =====================

async function hookDecoratorAlternativeExample() {
  // --8<-- [start:hook_decorator_alternative]
  class ModelMonitorPlugin implements Plugin {
    name = 'model-monitor'

    initAgent(agent: LocalAgent): void {
      // Register a hook for a single event type
      agent.addHook(BeforeModelCallEvent, () => {
        console.log('Model call starting...')
      })

      // Register the same handler for multiple event types (union equivalent)
      const onModelEvent = (event: BeforeModelCallEvent | AfterModelCallEvent) => {
        console.log(`Model event: ${event.constructor.name}`)
      }
      agent.addHook(BeforeModelCallEvent, onModelEvent)
      agent.addHook(AfterModelCallEvent, onModelEvent)
    }
  }
  // --8<-- [end:hook_decorator_alternative]

  void ModelMonitorPlugin
}

// =====================
// Manual Hook and Tool Registration
// =====================

async function manualRegistrationExample() {
  // --8<-- [start:manual_registration]
  class ManualPlugin implements Plugin {
    private verbose: boolean

    name = 'manual-plugin'

    constructor(options: { verbose?: boolean } = {}) {
      this.verbose = options.verbose ?? false
    }

    initAgent(agent: LocalAgent): void {
      // Conditionally register additional hooks
      if (this.verbose) {
        agent.addHook(BeforeToolCallEvent, (event) => {
          console.log(`[VERBOSE] ${JSON.stringify(event.toolUse)}`)
        })
      }

      // Access agent tools via toolRegistry
      console.log(`Attached to agent with ${agent.toolRegistry.list().length} tools`)
    }
  }
  // --8<-- [end:manual_registration]

  void ManualPlugin
}

// =====================
// Plugin State Management
// =====================

async function stateManagementExample() {
  // --8<-- [start:state_management]
  class MetricsPlugin implements Plugin {
    name = 'metrics-plugin'

    initAgent(agent: LocalAgent): void {
      // Initialize state values if not present
      if (!agent.appState.get('metrics_call_count')) {
        agent.appState.set('metrics_call_count', 0)
      }

      agent.addHook(BeforeToolCallEvent, () => {
        const current = (agent.appState.get('metrics_call_count') as number) ?? 0
        agent.appState.set('metrics_call_count', current + 1)
      })
    }
  }

  // Usage
  const metricsPlugin = new MetricsPlugin()
  const agent = new Agent({
    plugins: [metricsPlugin],
  })
  console.log(`Tool calls: ${agent.appState.get('metrics_call_count')}`)
  // --8<-- [end:state_management]
  void metricsPlugin
}

// =====================
// Async Initialization
// =====================

async function asyncInitializationExample() {
  // --8<-- [start:async_initialization]
  class AsyncConfigPlugin implements Plugin {
    private config: Record<string, unknown> = {}

    name = 'async-config'

    async initAgent(agent: LocalAgent): Promise<void> {
      // Async initialization
      this.config = await this.loadConfig()

      agent.addHook(BeforeToolCallEvent, () => {
        console.log(`Config: ${JSON.stringify(this.config)}`)
      })
    }

    private async loadConfig(): Promise<Record<string, unknown>> {
      await new Promise((resolve) => setTimeout(resolve, 100)) // Simulate async operation
      return { setting: 'value' }
    }
  }
  // --8<-- [end:async_initialization]

  void AsyncConfigPlugin
}

// Suppress unused function warnings
void usingPluginsExample
void basicPluginExample
void hookDecoratorAlternativeExample
void manualRegistrationExample
void stateManagementExample
void asyncInitializationExample
