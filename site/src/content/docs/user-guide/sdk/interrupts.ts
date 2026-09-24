// @ts-nocheck
// NOTE: Type-checking is disabled because the interrupt feature is not yet published in the installed SDK.

import { Agent, tool, SessionManager, FileStorage } from '@strands-agents/sdk'
import { BeforeToolCallEvent, BeforeToolsEvent } from '@strands-agents/sdk'
import { z } from 'zod'

// =====================
// Hooks: BeforeToolCallEvent Example
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
// Hooks: BeforeToolsEvent Example
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

  // Server function: creates a fresh agent with session management each call
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

// Suppress unused function warnings
void hooksBeforeToolCallExample
void hooksBeforeToolsExample
void toolsExample
void sessionManagementExample
