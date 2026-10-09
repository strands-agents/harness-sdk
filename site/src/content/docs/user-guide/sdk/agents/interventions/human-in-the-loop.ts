// @ts-nocheck
import { Agent, tool, InterruptResponseContent } from '@strands-agents/sdk'
import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'
import { z } from 'zod'

const deleteFiles = tool({
  name: 'delete_files',
  description: 'Delete files at the given paths',
  inputSchema: z.object({ paths: z.array(z.string()) }),
  callback: (input) => `Deleted ${input.paths.length} files`,
})

const readFile = tool({
  name: 'read_file',
  description: 'Read a file',
  inputSchema: z.object({ path: z.string() }),
  callback: (input) => `Contents of ${input.path}`,
})

// =====================
// Basic (Interrupt/Resume Mode)
// =====================

async function basicInterruptExample() {
  // --8<-- [start:basic_interrupt]
  const deleteFiles = tool({
    name: 'delete_files',
    description: 'Delete files at the given paths',
    inputSchema: z.object({ paths: z.array(z.string()) }),
    callback: (input) => `Deleted ${input.paths.length} files`,
  })

  const agent = new Agent({
    tools: [deleteFiles],
    interventions: [new HumanInTheLoop()],
  })

  // Agent pauses with stopReason 'interrupt' when a tool needs approval
  let result = await agent.invoke('Delete the temp files')

  if (result.stopReason === 'interrupt') {
    // Present the interrupt to the user (web UI, Slack, etc.)
    console.log(result.interrupts![0].reason)

    // Resume with the human's response
    result = await agent.invoke([
      new InterruptResponseContent({
        interruptId: result.interrupts![0].id,
        response: 'yes', // 'y', 'yes', or true → approved
      }),
    ])
  }
  // --8<-- [end:basic_interrupt]
}

// =====================
// Stdio Mode
// =====================

async function stdioModeExample() {
  // --8<-- [start:stdio_mode]
  // const deleteFiles = tool({ ... }): same as above

  const agent = new Agent({
    tools: [deleteFiles],
    interventions: [new HumanInTheLoop({ ask: 'stdio' })],
  })

  await agent.invoke('Delete the temp files')
  // Terminal prompt:
  // Tool "delete_files" requires human approval. Input: {...} (y/n):
  // --8<-- [end:stdio_mode]
}

// =====================
// Custom Ask Callback
// =====================

async function customAskExample() {
  // --8<-- [start:custom_ask]
  // const deleteFiles = tool({ ... }): same as above

  const agent = new Agent({
    tools: [deleteFiles],
    interventions: [
      new HumanInTheLoop({
        ask: async (prompt) => {
          // Your UI: Slack DM, web modal, push notification, etc.
          return await askUserViaSlack(prompt)
        },
      }),
    ],
  })

  await agent.invoke('Delete the temp files')
  // --8<-- [end:custom_ask]
}

// =====================
// Allowed Tools
// =====================

async function allowedToolsExample() {
  // --8<-- [start:allowed_tools]
  // const deleteFiles = tool({ ... }): same as above
  // const readFile = tool({ ... })

  const agent = new Agent({
    tools: [readFile, deleteFiles],
    interventions: [
      new HumanInTheLoop({
        ask: 'stdio',
        // Pattern syntax:
        //   'read_file'             → runs without approval
        //   '*'                     → all tools run freely (disables handler)
        //   ['*', '!delete_files']  → all except delete_files
        allowedTools: ['read_file'],
      }),
    ],
  })

  await agent.invoke('Read config.json then delete /tmp/old-logs')
  // Only delete_files prompts; read_file executes immediately
  // --8<-- [end:allowed_tools]
}

// =====================
// Trust Mode
// =====================

async function trustModeExample() {
  // --8<-- [start:trust_mode]
  // const deleteFiles = tool({ ... }): same as above

  const agent = new Agent({
    tools: [deleteFiles],
    interventions: [
      new HumanInTheLoop({
        ask: 'stdio',
        enableTrust: true,
      }),
    ],
  })

  await agent.invoke('Delete all log files in /tmp')
  // First call: user responds 't' → approved AND remembered
  // Subsequent calls: no prompt needed for the session
  // --8<-- [end:trust_mode]
}

// =====================
// Custom Evaluate (OTP example)
// =====================

async function customEvaluateExample() {
  // --8<-- [start:custom_evaluate]
  // const deleteFiles = tool({ ... }): same as above

  const agent = new Agent({
    tools: [deleteFiles],
    interventions: [
      new HumanInTheLoop({
        ask: 'stdio',
        // Only approve if the user types "confirm"
        evaluate: (response) =>
          typeof response === 'string' && response.toLowerCase() === 'confirm',
      }),
    ],
  })

  await agent.invoke('Delete the temp files')
  // Prompt: Tool "delete_files" requires human approval. Input: {...}
  // User must type "confirm" to approve (not just "y" or "yes")
  // --8<-- [end:custom_evaluate]
}

// =====================
// Classifier (LLM Risk Classification)
// =====================

async function classifierExample() {
  // --8<-- [start:classifier]
  // const readFile = tool({ ... })
  // const deleteFiles = tool({ ... })

  const agent = new Agent({
    tools: [readFile, deleteFiles],
    interventions: [
      new HumanInTheLoop({
        allowedTools: ['read_file'],
        classifier: true,
      }),
    ],
  })

  await agent.invoke('Read config.json then delete /tmp/old-logs')
  // read_file: allowed (bypasses classifier)
  // delete_files: classifier evaluates -> risky -> prompts human
  // --8<-- [end:classifier]
}

async function classifierCustomExample() {
  // --8<-- [start:classifier_custom]
  // Custom system prompt and model
  const agent = new Agent({
    tools: [deleteFiles],
    interventions: [
      new HumanInTheLoop({
        classifier: {
          systemPrompt: 'Only flag destructive operations.',
        },
      }),
    ],
  })

  // Or provide your own classification function
  const agentCustom = new Agent({
    tools: [deleteFiles],
    interventions: [
      new HumanInTheLoop({
        classifier: (event) => ({
          requiresHumanInTheLoop: event.toolUse.name.startsWith('delete'),
          reason: 'destructive tool',
        }),
      }),
    ],
  })
  // --8<-- [end:classifier_custom]
  void agent
  void agentCustom
}

// Suppress unused function warnings
void basicInterruptExample
void stdioModeExample
void customAskExample
void allowedToolsExample
void trustModeExample
void customEvaluateExample
void classifierExample
void classifierCustomExample

declare function askUserViaSlack(prompt: string): Promise<string>
