import {
  Agent,
  ClientTool,
  InterruptResponseContent,
  SessionManager,
} from '@strands-agents/sdk'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
import type { InvokeArgs, JSONValue } from '@strands-agents/sdk'
import { z } from 'zod'

function defineExample() {
  // --8<-- [start:define]
  // A Zod schema: the agent validates the model's input before stopping
  const getLocation = new ClientTool({
    name: 'get_location',
    description: "Get the user's current location from their device.",
    inputSchema: z.object({
      precision: z.enum(['city', 'exact']).describe('How precise to be'),
    }),
  })

  // A JSON schema: sent to the model as-is, without validation
  const pickFile = new ClientTool({
    name: 'pick_file',
    description: 'Ask the user to pick a file from their computer.',
    inputSchema: {
      type: 'object',
      properties: { extensions: { type: 'array', items: { type: 'string' } } },
    },
  })

  const agent = new Agent({ tools: [getLocation, pickFile] })
  // --8<-- [end:define]
}

async function resumeExample() {
  // --8<-- [start:resume]
  const getLocation = new ClientTool({
    name: 'get_location',
    description: "Get the user's current location from their device.",
  })
  const agent = new Agent({ tools: [getLocation], printer: false })

  function runOnClient(name: string, input: JSONValue): JSONValue {
    // Stands in for the code that runs where the tool lives
    if (name === 'get_location') return { city: 'Seattle', country: 'US' }
    throw new Error(`Unknown client tool: ${name}`)
  }

  let result = await agent.invoke('Is it a good day for a walk where I am?')
  while (result.stopReason === 'interrupt') {
    const responses = result
      .interrupts!.filter((i) => getLocation.isInterrupt(i))
      .map(
        (interrupt) =>
          new InterruptResponseContent({
            interruptId: interrupt.id,
            response: runOnClient(interrupt.reason.name, interrupt.reason.input),
          })
      )
    result = await agent.invoke(responses)
  }

  console.log(result.toString())
  // --8<-- [end:resume]
}

async function errorExample() {
  // --8<-- [start:error]
  const getLocation = new ClientTool({
    name: 'get_location',
    description: "Get the user's current location from their device.",
  })
  const agent = new Agent({ tools: [getLocation], printer: false })

  let result = await agent.invoke('Is it a good day for a walk where I am?')
  const denied = {
    status: 'error',
    content: [{ text: 'The user denied location access.' }],
  }
  result = await agent.invoke(
    result.interrupts!.map(
      (interrupt) =>
        new InterruptResponseContent({ interruptId: interrupt.id, response: denied })
    )
  )
  // --8<-- [end:error]
}

async function serverClientExample() {
  // --8<-- [start:server_client]
  const getLocation = new ClientTool({
    name: 'get_location',
    description: "Get the user's current location from their device.",
  })

  type ToolCall = { id: string; name: string; input: JSONValue }
  type Reply = { reply: string } | { toolCalls: ToolCall[] }

  // Server: run one agent turn and return the reply or the pending tool calls
  async function handleRequest(sessionId: string, payload: InvokeArgs): Promise<Reply> {
    const agent = new Agent({
      tools: [getLocation],
      sessionManager: new SessionManager({
        sessionId,
        storage: new LocalFileStorage('./sessions'),
      }),
      printer: false,
    })
    const result = await agent.invoke(payload)
    if (result.stopReason !== 'interrupt') return { reply: result.toString() }
    return {
      toolCalls: result
        .interrupts!.filter((i) => getLocation.isInterrupt(i))
        .map((interrupt) => ({
          id: interrupt.id,
          name: interrupt.reason.name,
          input: interrupt.reason.input,
        })),
    }
  }

  function runOnDevice(call: ToolCall): JSONValue {
    // Client: in a real app this reads the device's location API
    return { city: 'Seattle', country: 'US' }
  }

  // Client: each handleRequest call stands in for an HTTP request to the server
  let reply = await handleRequest('user-42', 'Is it a good day for a walk where I am?')
  while ('toolCalls' in reply) {
    const responses = reply.toolCalls.map((call) => ({
      interruptResponse: { interruptId: call.id, response: runOnDevice(call) },
    }))
    reply = await handleRequest('user-42', responses)
  }

  console.log(reply.reply)
  // --8<-- [end:server_client]
}

async function longRunningExample() {
  // --8<-- [start:long_running]
  const runTests = new ClientTool({
    name: 'run_tests',
    description: 'Run the integration test suite on a branch. Takes up to an hour.',
    inputSchema: {
      type: 'object',
      properties: { branch: { type: 'string' } },
      required: ['branch'],
    },
  })

  function createAgent(sessionId: string): Agent {
    return new Agent({
      tools: [runTests],
      sessionManager: new SessionManager({
        sessionId,
        storage: new LocalFileStorage('./sessions'),
      }),
      printer: false,
    })
  }

  function submitCiJob(branch: string, sessionId: string, interruptId: string): void {
    // Stands in for your CI system's API; store the IDs with the job
    console.log(`Started tests on ${branch}`)
  }

  async function start(sessionId: string, prompt: string): Promise<void> {
    const result = await createAgent(sessionId).invoke(prompt)
    for (const interrupt of (result.interrupts ?? []).filter((i) =>
      runTests.isInterrupt(i)
    )) {
      const { branch } = interrupt.reason.input as { branch: string }
      submitCiJob(branch, sessionId, interrupt.id)
    }
    // Return now: nothing stays in memory while the tests run
  }

  async function onCiFinished(
    sessionId: string,
    interruptId: string,
    outcome: JSONValue
  ): Promise<void> {
    // Runs when the CI system reports back, possibly in another process
    const result = await createAgent(sessionId).invoke([
      new InterruptResponseContent({ interruptId, response: outcome }),
    ])
    console.log(result.toString())
  }

  await start('release-7', "Run the tests on main and tell me if it's safe to release.")
  // Later, from your CI webhook handler:
  // await onCiFinished('release-7', interruptId, { passed: 412, failed: 0 })
  // --8<-- [end:long_running]
}

// Suppress unused function warnings
void defineExample
void resumeExample
void errorExample
void serverClientExample
void longRunningExample
