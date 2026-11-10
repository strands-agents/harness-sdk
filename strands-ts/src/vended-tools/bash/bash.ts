import { tool } from '../../tools/tool-factory.js'
import { z } from 'zod'
import { spawn, type ChildProcess } from 'child_process'
import { Buffer } from 'buffer'
import type { BashOutput } from './types.js'
import { BashTimeoutError, BashSessionError } from './types.js'

const bashInputSchema = z.object({
  mode: z
    .enum(['execute', 'restart'])
    .describe('Operation mode: "execute" to run a command, "restart" to restart the session'),
  command: z.string().optional().describe('The bash command to execute (required when mode is "execute")'),
  timeout: z.number().positive().optional().describe('Timeout in seconds (default: 120, applies only to execute mode)'),
})

/**
 * Internal class for managing a bash session.
 */
class BashSession {
  private _process: ChildProcess | null = null
  private _started = false
  private readonly _timeout: number
  private readonly _sentinel: string

  constructor(timeout = 120) {
    this._timeout = timeout
    this._sentinel = `__BASH_DONE_${Date.now()}_${Math.random().toString(36).slice(2)}__`
  }

  /**
   * Starts the bash process if not already started.
   */
  start(): void {
    if (this._started) {
      return
    }

    try {
      this._process = spawn('bash', [], {
        cwd: process.cwd(),
        env: { ...process.env, PS1: '', PS2: '' },
      })

      if (!this._process.stdin || !this._process.stdout || !this._process.stderr) {
        throw new BashSessionError('Failed to create bash process streams')
      }

      this._started = true
      activeSessions.add(this)

      // Handle unexpected process exits
      this._process.on('close', () => {
        this._process = null
        this._started = false
      })
    } catch (err) {
      throw new BashSessionError(`Failed to start bash session: ${(err as Error).message}`)
    }
  }

  /**
   * Stops the bash process.
   */
  stop(): void {
    if (this._process) {
      this._process.kill()
      this._process = null
      this._started = false
    }
    activeSessions.delete(this)
  }

  /**
   * Runs a command in the bash session.
   */
  async run(command: string, timeout?: number): Promise<BashOutput> {
    this.start()

    if (!this._process || !this._process.stdin || !this._process.stdout || !this._process.stderr) {
      throw new BashSessionError('Bash session not properly initialized')
    }

    const effectiveTimeout = timeout ?? this._timeout
    let stdoutData = ''
    let stderrData = ''
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    let isTimedOut = false

    return new Promise<BashOutput>((resolve, reject) => {
      const stdout = this._process!.stdout!
      const stderr = this._process!.stderr!
      const stdin = this._process!.stdin!

      // Handlers for stdout
      const onStdoutData = (chunk: unknown): void => {
        const data = Buffer.from(chunk as Parameters<typeof Buffer.from>[0]).toString('utf-8')
        stdoutData += data

        // Check for sentinel
        if (stdoutData.includes(this._sentinel)) {
          cleanup()

          // Remove sentinel from output
          const output = stdoutData.replace(this._sentinel, '').trim()
          const error = stderrData.trim()

          resolve({ output, error })
        }
      }

      // Handlers for stderr
      const onStderrData = (chunk: unknown): void => {
        stderrData += Buffer.from(chunk as Parameters<typeof Buffer.from>[0]).toString('utf-8')
      }

      // Handler for process close
      const onClose = (code: number | null): void => {
        if (!isTimedOut) {
          cleanup()
          reject(new BashSessionError(`Bash process exited unexpectedly with code ${code ?? 'unknown'}`))
        }
      }

      // Handler for process errors
      const onError = (err: Error): void => {
        cleanup()
        this.stop()
        reject(new BashSessionError(`Bash process error: ${err.message}`))
      }

      // Cleanup function - removes per-command listeners and timeout.
      // Does NOT stop the process, preserving session state between calls.
      const cleanup = (): void => {
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle)
          timeoutHandle = null
        }
        stdout.off('data', onStdoutData)
        stderr.off('data', onStderrData)
        // Check if process still exists before removing listeners
        if (this._process) {
          this._process.off('close', onClose)
          this._process.off('error', onError)
        }
      }

      // Set up timeout
      timeoutHandle = setTimeout(() => {
        isTimedOut = true
        cleanup()
        this.stop()
        reject(new BashTimeoutError(`Command timed out after ${effectiveTimeout} seconds`))
      }, effectiveTimeout * 1000)

      // Attach listeners
      stdout.on('data', onStdoutData)
      stderr.on('data', onStderrData)
      this._process!.on('close', onClose)
      this._process!.on('error', onError)

      // Send command with sentinel
      try {
        stdin.write(`${command}\necho "${this._sentinel}"\n`)
      } catch (err) {
        cleanup()
        this.stop()
        reject(new BashSessionError(`Failed to write command: ${(err as Error).message}`))
      }
    })
  }
}

/**
 * WeakMap to store bash sessions per agent instance.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessions = new WeakMap<any, BashSession>()

/**
 * Track all active sessions for cleanup on process exit.
 */
const activeSessions = new Set<BashSession>()

/**
 * Clean up bash sessions when their associated agent is garbage collected.
 */
const sessionFinalizer = new FinalizationRegistry<BashSession>((session) => {
  session.stop()
})

/**
 * Clean up all active bash sessions.
 */
function cleanupAllSessions(): void {
  for (const session of activeSessions) {
    session.stop()
  }
  activeSessions.clear()
}

// Register cleanup handlers for process exit
process.on('beforeExit', () => {
  // beforeExit fires when event loop is empty but process is still alive
  // This is our chance to clean up bash processes before they prevent exit
  cleanupAllSessions()
})
process.on('exit', cleanupAllSessions)
process.on('SIGINT', () => {
  cleanupAllSessions()
  /* c8 ignore next */
  process.exit(0)
})
/* c8 ignore start */
process.on('SIGTERM', () => {
  cleanupAllSessions()
  process.exit(0)
})
/* c8 ignore stop */

/**
 * Bash tool for executing shell commands in Node.js environments.
 *
 * This tool provides a persistent bash session that can execute commands and maintain state
 * across multiple invocations within the same agent session.
 *
 * **Security Warning**: This tool executes arbitrary bash commands without sandboxing.
 * Only use with trusted input and consider sandboxing for production deployments.
 *
 * **Node.js Only**: This tool requires Node.js and the `child_process` module.
 * It will not work in browser environments.
 *
 * @example
 * ```typescript
 * // With agent
 * const agent = new Agent({ tools: [bash] })
 * await agent.invoke('List files in the current directory')
 *
 * // Direct usage
 * const result = await bash.invoke(
 *   { mode: 'execute', command: 'echo "Hello"' },
 *   context
 * )
 * console.log(result.output) // "Hello"
 * ```
 */
const DEFAULT_DESCRIPTION =
  'Executes bash shell commands in a persistent session. Supports execute and restart modes. ' +
  'Commands persist state (variables, directory) within the session. Node.js only.'

/**
 * Host-only bash tool with a persistent session across calls.
 * State (variables, working directory) persists within the session.
 * Node.js only.
 */
export const bash = tool({
  name: 'bash',
  description: DEFAULT_DESCRIPTION,
  inputSchema: bashInputSchema,
  callback: async (input, context) => {
    if (!context) {
      throw new Error('Tool context is required for bash operations')
    }

    const agent = context.agent

    // Validate execute mode has command
    if (input.mode === 'execute' && !input.command) {
      throw new Error('command is required when mode is "execute"')
    }

    // Handle restart mode
    if (input.mode === 'restart') {
      const existingSession = sessions.get(agent)
      if (existingSession) {
        existingSession.stop()
        sessions.delete(agent)
      }
      // Create new session (will be added to activeSessions when started)
      const newSession = new BashSession(120)
      sessions.set(agent, newSession)
      sessionFinalizer.register(agent, newSession)
      return 'Bash session restarted'
    }

    // Handle execute mode
    // Get or create session
    let session = sessions.get(agent)
    if (!session) {
      session = new BashSession(input.timeout ?? 120)
      sessions.set(agent, session)
      sessionFinalizer.register(agent, session)
    }

    // Execute command
    return session.run(input.command!, input.timeout)
  },
})
