/**
 * tau-bench adapter — spawns bridge.py and exposes a multi-turn task runner.
 *
 * Converts tau-bench's OpenAI-format tool schemas into strands-ts tools,
 * relays tool calls to the Python subprocess, and drives the multi-turn
 * conversation loop until the environment signals done.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { tool } from '../../../../strands-ts/src/tools/tool-factory.js'
import { createAgent } from '../../src/agent-factory.js'
import { toolPairingIntact, historyWellFormed } from '../../src/invariants.js'
import type { InvokableTool } from '../../../../strands-ts/src/tools/tool.js'
import type { JSONValue } from '../../../../strands-ts/src/types/json.js'
import type { ProfilerObserver } from '../../src/observer.js'

const BRIDGE_PATH = resolve(import.meta.dirname, 'bridge.py')
const VENV_PYTHON = resolve(import.meta.dirname, '.venv/bin/python')

// Timeout for a single task (5 minutes)
const TASK_TIMEOUT_MS = 5 * 60 * 1000

export interface TauBenchOptions {
  envName: 'retail' | 'airline'
  taskIndex: number
  userModel?: string
  userProvider?: string
}

export interface TauBenchResult {
  reward: number
  done: boolean
  turns: number
}

// --- JSON-RPC helpers ---

interface BridgeMessage {
  jsonrpc?: string
  method?: string
  id?: number
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

/**
 * Manages the Python bridge subprocess lifecycle and communication.
 */
class Bridge {
  private proc: ChildProcess
  private rl: Interface
  private pending = new Map<number, { resolve: (msg: BridgeMessage) => void; reject: (err: Error) => void }>()
  private nextId = 1
  private initMessage: BridgeMessage | null = null
  private initResolve: ((msg: BridgeMessage) => void) | null = null

  constructor(options: TauBenchOptions) {
    this.proc = spawn(VENV_PYTHON, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    this.rl = createInterface({ input: this.proc.stdout! })
    this.rl.on('line', (line) => this.handleLine(line))

    // Collect stderr for debugging
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) console.error(`[tau-bench bridge stderr] ${text}`)
    })

    // Reject all pending requests if the subprocess dies
    this.proc.on('exit', (code) => {
      const err = new Error(`Bridge process exited unexpectedly (code ${code})`)
      for (const [, handler] of this.pending) handler.reject(err)
      this.pending.clear()
      if (this.initResolve) {
        this.initResolve = null
      }
    })

    // Send init params
    this.send({
      jsonrpc: '2.0',
      method: 'init',
      params: {
        env_name: options.envName,
        task_index: options.taskIndex,
        user_model: options.userModel ?? 'bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0',
        user_provider: options.userProvider ?? 'bedrock',
      },
    })
  }

  private send(msg: BridgeMessage): void {
    this.proc.stdin!.write(JSON.stringify(msg) + '\n')
  }

  private handleLine(line: string): void {
    let msg: BridgeMessage
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    // Initialization notification (no id, has method "initialize")
    if (msg.method === 'initialize') {
      if (this.initResolve) {
        this.initResolve(msg)
        this.initResolve = null
      } else {
        this.initMessage = msg
      }
      return
    }

    // Response to a request (has id)
    if (msg.id !== undefined) {
      const handler = this.pending.get(msg.id)
      if (handler) {
        this.pending.delete(msg.id)
        handler.resolve(msg)
      }
    }
  }

  /**
   * Wait for the initialize message from the bridge.
   */
  async waitForInit(): Promise<BridgeMessage> {
    if (this.initMessage) {
      const msg = this.initMessage
      this.initMessage = null
      return msg
    }
    return new Promise((resolve) => {
      this.initResolve = resolve
    })
  }

  /**
   * Send a tool_call request and wait for the response.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ observation: string; done: boolean; reward: number }> {
    const id = this.nextId++
    this.send({
      jsonrpc: '2.0',
      id,
      method: 'tool_call',
      params: { name, arguments: args },
    })

    const response = await new Promise<BridgeMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })

    if (response.error) {
      throw new Error(`Bridge error: ${response.error.message}`)
    }

    const result = response.result!
    return {
      observation: result.observation as string,
      done: result.done as boolean,
      reward: (result.reward as number) ?? 0,
    }
  }

  kill(): void {
    this.rl.close()
    this.proc.kill('SIGTERM')
  }
}

// --- Tool schema conversion ---

interface OpenAIToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * Convert an OpenAI function-calling tool schema to a strands-ts InvokableTool.
 * The callback relays the call to the Python bridge.
 */
function createBridgedTool(
  schema: OpenAIToolSchema,
  bridge: Bridge,
  state: TaskState,
): InvokableTool<unknown, JSONValue> {
  const fn = schema.function
  return tool({
    name: fn.name,
    description: fn.description,
    inputSchema: fn.parameters as any,
    callback: async (input: unknown) => {
      const result = await bridge.callTool(fn.name, input as Record<string, unknown>)

      if (result.done) {
        state.done = true
        state.reward = result.reward
      }

      // For "respond": the observation is the user's next message
      if (fn.name === 'respond') {
        state.nextUserMessage = result.observation
      }

      return result.observation
    },
  })
}

interface TaskState {
  done: boolean
  reward: number
  nextUserMessage: string | null
}

// --- Main entry point ---

/**
 * Run a single tau-bench task end-to-end.
 *
 * Spawns the bridge, creates an agent with bridged tools, and drives the
 * multi-turn conversation until done.
 */
export async function runTauBenchTask(
  profiler: ProfilerObserver,
  options: TauBenchOptions,
): Promise<TauBenchResult> {
  const bridge = new Bridge(options)
  let turns = 0

  try {
    // Wait for initialization
    const initMsg = await Promise.race([
      bridge.waitForInit(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Bridge init timeout')), 30_000),
      ),
    ])

    const params = initMsg.params!
    const userMessage = params.user_message as string
    const toolSchemas = params.tools as OpenAIToolSchema[]
    const wiki = params.wiki as string

    // Shared state for tracking when the task is done
    const state: TaskState = { done: false, reward: 0, nextUserMessage: null }

    // Create bridged tools (bridge.py already injects the synthetic "respond" tool schema).
    // Deduplicate by name to guard against future tau-bench versions that might include respond.
    const seen = new Set<string>()
    const dedupedSchemas = toolSchemas.filter((s) => {
      if (seen.has(s.function.name)) return false
      seen.add(s.function.name)
      return true
    })
    const tools = dedupedSchemas.map((schema) => createBridgedTool(schema, bridge, state))

    // Build system prompt with wiki
    const respondInstruction =
      'IMPORTANT: You MUST use the "respond" tool to send ANY message to the user. ' +
      'Do NOT write text responses directly — they will not be delivered. ' +
      'Every reply to the user must go through the respond tool.'
    const systemPrompt = wiki
      ? `You are a helpful customer service agent. Follow these policies:\n\n${wiki}\n\n${respondInstruction}`
      : `You are a helpful customer service agent. ${respondInstruction}`

    // Create the agent
    const agent = createAgent(profiler, { systemPrompt, tools })

    // Multi-turn conversation loop
    let currentMessage = userMessage
    const timeout = Date.now() + TASK_TIMEOUT_MS

    while (!state.done && Date.now() < timeout) {
      turns++
      state.nextUserMessage = null

      profiler.recordInvocationInput(
        `[tau-bench ${options.envName}#${options.taskIndex} turn ${turns}] ${currentMessage.slice(0, 120)}`,
      )
      const result = await agent.invoke(currentMessage, { limits: { turns: 15 } })
      profiler.recordResult(result)

      // After the agent finishes an invocation, it should have called "respond"
      // which gives us the next user message (or done=true).
      if (state.done) break

      if (state.nextUserMessage) {
        currentMessage = state.nextUserMessage
      } else {
        // Agent didn't call respond explicitly — it generated bare text.
        // tau-bench treats this as an implicit respond (like its own ToolCallingAgent).
        // Extract the agent's text output and route it through the bridge.
        const agentText = (result.lastMessage?.content ?? [])
          .filter((block): block is { text: string } & typeof block => 'text' in block)
          .map((block) => (block as unknown as { text: string }).text)
          .join('')

        if (agentText) {
          const respondResult = await bridge.callTool('respond', { content: agentText })
          if (respondResult.done) {
            state.done = true
            state.reward = respondResult.reward
            break
          }
          currentMessage = respondResult.observation
        } else {
          // No text output either — truly stuck
          break
        }
      }
    }

    // Record SDK invariants
    profiler.recordInvariants(
      toolPairingIntact(agent.messages),
      historyWellFormed(agent.messages),
    )

    return { reward: state.reward, done: state.done, turns }
  } finally {
    bridge.kill()
  }
}
