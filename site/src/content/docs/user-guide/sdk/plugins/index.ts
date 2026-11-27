import { Agent } from '@strands-agents/sdk'
import type { LocalAgent, Plugin } from '@strands-agents/sdk'
import { BeforeToolCallEvent, AfterToolCallEvent } from '@strands-agents/sdk'
import { ContextInjector } from '@strands-agents/sdk/vended-plugins/context-injector'

// =====================
// Hub: attach a plugin to an agent
// =====================

async function hubAgentExample() {
  // --8<-- [start:hub_agent]
  const agent = new Agent({
    plugins: [
      new ContextInjector({
        renderContent: async () => `<now>${new Date().toISOString()}</now>`,
      }),
    ],
  })

  await agent.invoke('What time is it right now?')
  // --8<-- [end:hub_agent]

  void agent
}

// =====================
// Plugin for Hooks documentation reference
// =====================

async function pluginForHooksExample() {
  // --8<-- [start:plugin_for_hooks]
  class LoggingPlugin implements Plugin {
    name = 'logging-plugin'

    initAgent(agent: LocalAgent): void {
      agent.addHook(BeforeToolCallEvent, (event) => {
        console.log(`Calling: ${event.toolUse.name}`)
      })

      agent.addHook(AfterToolCallEvent, (event) => {
        console.log(`Completed: ${event.toolUse.name}`)
      })
    }
  }

  const agent = new Agent({ plugins: [new LoggingPlugin()] })
  // --8<-- [end:plugin_for_hooks]
  void agent
}

// Suppress unused function warnings
void hubAgentExample
void pluginForHooksExample
