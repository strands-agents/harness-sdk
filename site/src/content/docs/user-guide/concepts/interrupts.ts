// @ts-nocheck
// NOTE: Type-checking is disabled because the interrupt feature is not yet published in the installed SDK.

import { Agent, tool, SessionManager, FileStorage } from '@strands-agents/sdk'
import {
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  BeforeToolsEvent,
  BeforeNodeCallEvent,
  Graph,
  Swarm,
  Status,
} from '@strands-agents/sdk'
import { z } from 'zod'

// =====================
// Hooks — BeforeToolCallEvent Example
// =====================

async function hooksBeforeToolCallExample() {
  // --8<-- [start:hooks_before_tool_call]
  const deleteFiles = tool({
    name: 'delete_files',
    description: 'Delete files at the given paths',
    inputSchema: z.object({ paths: z.array(z.string()) }),
    callback: (input) => {
      // Implementation here
      return true
    },
  })

  const inspectFiles = tool({
    name: 'inspect_files',
    description: 'Inspect files at the given paths',
    inputSchema: z.object({ paths: z.array(z.string()) }),
    callback: (input) => {
      // Implementation here
      return {}
    },
  })

  const agent = new Agent({
    systemPrompt: 'You delete files older than 5 days',
    tools: [deleteFiles, inspectFiles],
  })

  agent.addHook(BeforeToolCallEvent, (event) => {
    if (event.toolUse.name !== 'delete_files') return

    const approval = event.interrupt<string>({
      name: 'myapp-approval',
      reason: { paths: (event.toolUse.input as { paths: string[] }).paths },
    })
    if (approval.toLowerCase() !== 'y') {
      event.cancel = 'User denied permission to delete files'
    }
  })

  const paths = ['a/b/c.txt', 'd/e/f.txt']
  let result = await agent.invoke(`paths=<${JSON.stringify(paths)}>`)

  while (result.stopReason === 'interrupt') {
    const responses = result.interrupts!.map((interrupt) => ({
      interruptResponse: {
        interruptId: interrupt.id,
        // In a real app, collect user input here
        response: 'y',
      },
    }))

    result = await agent.invoke(responses)
  }

  console.log('MESSAGE:', JSON.stringify(result.lastMessage))
  // --8<-- [end:hooks_before_tool_call]
}

// =====================
// Hooks — BeforeToolsEvent Example
// =====================

async function hooksBeforeToolsExample() {
  // --8<-- [start:hooks_before_tools]
  const agent = new Agent({
    tools: [/* ... */],
  })

  agent.addHook(BeforeToolsEvent, (event) => {
    const dangerousTools = event.message.content
      .filter((block) => block.type === 'toolUseBlock')
      .filter((block) => ['delete_files'].includes(block.name))

    if (dangerousTools.length > 0) {
      const response = event.interrupt<{ approved: boolean }>({
        name: 'batch_approval',
        reason: `Approve ${dangerousTools.length} dangerous tool calls?`,
      })
      if (!response.approved) {
        event.cancel = 'Batch cancelled by user'
      }
    }
  })
  // --8<-- [end:hooks_before_tools]
}

// =====================
// Hooks — BeforeModelCallEvent Example
// =====================

async function hooksBeforeModelCallExample() {
  // --8<-- [start:hooks_before_model_call]
  const agent = new Agent()

  agent.addHook(BeforeModelCallEvent, (event) => {
    const response = event.interrupt<{ approved: boolean }>({
      name: 'model_call_approval',
      reason: 'Approve this model call?',
    })
    if (!response.approved) {
      event.cancel = 'Model call cancelled by user'
    }
  })

  let result = await agent.invoke('Summarize the quarterly report')

  while (result.stopReason === 'interrupt') {
    const responses = result.interrupts!.map((interrupt) => ({
      interruptResponse: {
        interruptId: interrupt.id,
        // In a real app, collect user input here
        response: { approved: true },
      },
    }))

    result = await agent.invoke(responses)
  }

  console.log('MESSAGE:', JSON.stringify(result.lastMessage))
  // --8<-- [end:hooks_before_model_call]
}

// =====================
// Tools Example
// =====================

async function toolsExample() {
  // --8<-- [start:tools_example]
  const deleteFiles = tool({
    name: 'delete_files',
    description: 'Delete files at the given paths',
    inputSchema: z.object({ paths: z.array(z.string()) }),
    callback: (input, context) => {
      const approval = context.interrupt<string>({
        name: 'myapp-approval',
        reason: { paths: input.paths },
      })
      if (approval.toLowerCase() !== 'y') return false

      // Implementation here

      return true
    },
  })

  const inspectFiles = tool({
    name: 'inspect_files',
    description: 'Inspect files at the given paths',
    inputSchema: z.object({ paths: z.array(z.string()) }),
    callback: (input) => {
      // Implementation here
      return {}
    },
  })

  const agent = new Agent({
    systemPrompt: 'You delete files older than 5 days',
    tools: [deleteFiles, inspectFiles],
  })

  // ...
  // --8<-- [end:tools_example]
}

// =====================
// Session Management Example
// =====================

async function sessionManagementExample() {
  // --8<-- [start:session_management]
  const deleteFiles = tool({
    name: 'delete_files',
    description: 'Delete files at the given paths',
    inputSchema: z.object({ paths: z.array(z.string()) }),
    callback: (input) => {
      // Implementation here
      return true
    },
  })

  const inspectFiles = tool({
    name: 'inspect_files',
    description: 'Inspect files at the given paths',
    inputSchema: z.object({ paths: z.array(z.string()) }),
    callback: (input) => {
      // Implementation here
      return {}
    },
  })

  // Server function — creates a fresh agent with session management each call
  async function server(
    prompt: string | { interruptResponse: { interruptId: string; response: unknown } }[]
  ) {
    const agent = new Agent({
      systemPrompt: 'You delete files older than 5 days',
      tools: [deleteFiles, inspectFiles],
      sessionManager: new SessionManager({
        sessionId: 'myapp',
        storage: { snapshot: new FileStorage('/path/to/storage') },
      }),
    })

    agent.addHook(BeforeToolCallEvent, (event) => {
      if (event.toolUse.name !== 'delete_files') return

      // Check if user already trusted this approval
      if (event.agent.appState.get('myapp-approval') === 't') return

      const approval = event.interrupt<string>({
        name: 'myapp-approval',
        reason: { paths: (event.toolUse.input as { paths: string[] }).paths },
      })
      if (!['y', 't'].includes(approval.toLowerCase())) {
        event.cancel = 'User denied permission to delete files'
      }

      event.agent.appState.set('myapp-approval', approval.toLowerCase())
    })

    return agent.invoke(prompt)
  }

  // Client function
  async function client(paths: string[]) {
    let result = await server(`paths=<${JSON.stringify(paths)}>`)

    while (result.stopReason === 'interrupt') {
      const responses = result.interrupts!.map((interrupt) => ({
        interruptResponse: {
          interruptId: interrupt.id,
          // In a real app, collect user input here
          response: 'y',
        },
      }))

      result = await server(responses)
    }

    return result
  }

  const paths = ['a/b/c.txt', 'd/e/f.txt']
  const result = await client(paths)
  console.log('MESSAGE:', JSON.stringify(result.lastMessage))
  // --8<-- [end:session_management]
}

// =====================
// Multi-Agent — Swarm BeforeNodeCallEvent Example
// =====================

async function swarmBeforeNodeCallExample() {
  // --8<-- [start:multiagent_swarm]
  const cleanupAgent = new Agent({
    id: 'cleanup',
    systemPrompt: 'You clean up resources older than 5 days.',
  })

  const swarm = new Swarm({ nodes: [cleanupAgent], start: 'cleanup' })

  swarm.addHook(BeforeNodeCallEvent, (event) => {
    if (event.nodeId !== 'cleanup') return

    const approval = event.interrupt<string>({
      name: 'myapp-approval',
      reason: { resources: 'example' },
    })
    if (approval.toLowerCase() !== 'y') {
      event.cancel = 'User denied permission to cleanup resources'
    }
  })

  let result = await swarm.invoke('Clean up my resources')

  while (result.status === Status.INTERRUPTED) {
    const responses = result.interrupts!.map((interrupt) => ({
      interruptResponse: {
        interruptId: interrupt.id,
        // In a real app, collect user input here
        response: 'y',
      },
    }))

    result = await swarm.invoke(responses)
  }

  console.log('MESSAGE:', JSON.stringify(result.results, null, 2))
  // --8<-- [end:multiagent_swarm]
}

// =====================
// Multi-Agent — Graph BeforeNodeCallEvent Example
// =====================

async function graphBeforeNodeCallExample() {
  // --8<-- [start:multiagent_graph]
  const inspectorAgent = new Agent({
    id: 'inspector',
    systemPrompt: 'You inspect resources.',
  })
  const cleanupAgent = new Agent({
    id: 'cleanup',
    systemPrompt: 'You clean up resources older than 5 days.',
  })

  const graph = new Graph({
    nodes: [inspectorAgent, cleanupAgent],
    edges: [['inspector', 'cleanup']],
  })

  graph.addHook(BeforeNodeCallEvent, (event) => {
    if (event.nodeId !== 'cleanup') return

    const approval = event.interrupt<string>({
      name: 'myapp-approval',
      reason: { resources: 'example' },
    })
    if (approval.toLowerCase() !== 'y') {
      event.cancel = 'User denied permission to cleanup resources'
    }
  })

  let result = await graph.invoke('Inspect and clean up my resources')

  while (result.status === Status.INTERRUPTED) {
    const responses = result.interrupts!.map((interrupt) => ({
      interruptResponse: {
        interruptId: interrupt.id,
        // In a real app, collect user input here
        response: 'y',
      },
    }))

    result = await graph.invoke(responses)
  }

  console.log('MESSAGE:', JSON.stringify(result.results, null, 2))
  // --8<-- [end:multiagent_graph]
}

// Suppress unused function warnings
void hooksBeforeToolCallExample
void hooksBeforeToolsExample
void hooksBeforeModelCallExample
void toolsExample
void sessionManagementExample
void swarmBeforeNodeCallExample
void graphBeforeNodeCallExample
