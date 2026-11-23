import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { DEV_PROJECT_PREPARED } from '../runtime.js'
import type { DevWorkspace } from '../workspace.js'
import { stopTemporaryProcessGroup, temporaryWorkspaceDirectory } from './evals-process.js'

export interface AutoOptimizeWorkerRequest {
  readonly workspace: DevWorkspace
  /** The whole task of the agent. Nobody answers it, and its reply is read by nobody but the log. */
  readonly prompt: string
  /** The file that takes everything the agent prints. */
  readonly log: string
  readonly signal: AbortSignal
}

export interface AutoOptimizeWorkerExit {
  readonly code: number
}

/** Runs the agent of the workspace on one task, in a process of its own, and resolves when that process ends. */
export type AutoOptimizeWorker = (request: AutoOptimizeWorkerRequest) => Promise<AutoOptimizeWorkerExit>

const GROUPED = process.platform !== 'win32'

/**
 * How this strands was started, so the worker is the same build: the runtime with its flags and the script it was
 * given, which may be a link without an extension. A build that is one binary has no script.
 */
export const strandsCommandOf = (
  entry: string | undefined,
  runtime: string,
  runtimeFlags: readonly string[]
): readonly string[] => (entry && entry !== runtime ? [runtime, ...runtimeFlags, entry] : [runtime])

const strandsCommand = (): readonly string[] => strandsCommandOf(process.argv[1], process.execPath, process.execArgv)

/**
 * The arguments of the worker: the agent of the workspace answers one request and exits. It keeps no session and no
 * memory, so its work is not one of the chats that the next experiment is made from.
 */
export const autoOptimizeWorkerArguments = (workspace: DevWorkspace): readonly string[] => [
  'dev',
  '--workspace',
  temporaryWorkspaceDirectory(workspace),
  '--print',
  '--session',
  'off',
  '--memory',
  'off',
]

/** A worker that is started with this command, which a test replaces with a program of its own. */
export const autoOptimizeWorker =
  (program: () => readonly string[] = strandsCommand): AutoOptimizeWorker =>
  async ({ workspace, prompt, log, signal }) => {
    await mkdir(dirname(log), { recursive: true })
    const [command, ...leading] = program()
    const output = openSync(log, 'a')
    try {
      return await new Promise<AutoOptimizeWorkerExit>((resolveExit, rejectExit) => {
        const child = spawn(command!, [...leading, ...autoOptimizeWorkerArguments(workspace)], {
          cwd: workspace.root,
          // The strands dev that starts it has the project open, so it is installed and built already.
          env: { ...process.env, [DEV_PROJECT_PREPARED]: '1' },
          // The request goes in on stdin: it is long, and a command line has a limit.
          stdio: ['pipe', output, output],
          // A group of its own, so the commands that the agent runs stop with it.
          detached: GROUPED,
          windowsHide: true,
        })
        const stop = (): void => {
          if (child.pid === undefined || child.exitCode !== null) return
          if (GROUPED) stopTemporaryProcessGroup(child.pid)
          else child.kill('SIGTERM')
        }
        // The agent works for this strands dev, so it does not outlive it.
        process.once('exit', stop)
        signal.addEventListener('abort', stop, { once: true })
        if (signal.aborted) stop()
        const settle = (): void => {
          process.removeListener('exit', stop)
          signal.removeEventListener('abort', stop)
        }
        child.once('error', (error) => {
          settle()
          rejectExit(error)
        })
        child.once('close', (code) => {
          settle()
          resolveExit({ code: code ?? 1 })
        })
        child.stdin?.on('error', () => undefined)
        child.stdin?.end(prompt)
        // It must not keep strands dev open after the developer leaves.
        child.unref()
      })
    } finally {
      closeSync(output)
    }
  }

export const spawnAutoOptimizeWorker: AutoOptimizeWorker = autoOptimizeWorker()
