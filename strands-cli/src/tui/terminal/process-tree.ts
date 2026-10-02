import { execFileSync, type ChildProcess } from 'node:child_process'

const PROCESS_EXIT_POLL_INTERVAL_MS = 20

/** Return descendants deepest-first so parents cannot leave children behind while exiting. */
function descendantProcessIds(processTable: string, parentPid: number): number[] {
  const children = new Map<number, number[]>()
  for (const line of processTable.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const siblings = children.get(ppid) ?? []
    siblings.push(pid)
    children.set(ppid, siblings)
  }

  const descendants: number[] = []
  const visit = (pid: number): void => {
    for (const childPid of children.get(pid) ?? []) {
      visit(childPid)
      descendants.push(childPid)
    }
  }
  visit(parentPid)
  return descendants
}

export async function terminateProcessTree(child: ChildProcess, gracePeriodMs = 1_000): Promise<void> {
  const rootPid = child.pid
  if (!rootPid) {
    return
  }

  const processIds = signalProcessTree(rootPid, 'SIGTERM')
  if (!(await waitForProcessExit(processIds, gracePeriodMs))) {
    await waitForProcessExit(signalProcessTree(rootPid, 'SIGKILL', processIds), gracePeriodMs)
  }
}

/**
 * Terminate the CLI and any active tool subprocesses after Ink has restored the terminal.
 *
 * This is used only for a forced interactive exit after cooperative Agent cancellation
 * has already been requested.
 */
export function hardExitProcessTree(exitCode: number): never {
  try {
    for (const pid of descendantProcessIds(readProcessTable(), process.pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The process may have completed between the snapshot and the signal.
      }
    }
  } catch {
    if (process.platform !== 'win32') {
      try {
        process.kill(-process.pid, 'SIGKILL')
      } catch {
        // The CLI is not always its process-group leader.
      }
    }
  }
  process.exit(exitCode)
}

function signalProcessTree(rootPid: number, signal: NodeJS.Signals, knownProcessIds: readonly number[] = []): number[] {
  const descendants = readDescendantProcessIds(rootPid)
  const processIds = [...new Set([...knownProcessIds.filter((pid) => pid !== rootPid), ...descendants, rootPid])]

  if (process.platform !== 'win32') {
    try {
      process.kill(-rootPid, signal)
    } catch {
      // The child may not be its process-group leader or may already have exited.
    }
  }

  for (const pid of processIds) {
    try {
      process.kill(pid, signal)
    } catch {
      // The process may have completed between the snapshot and the signal.
    }
  }
  return processIds
}

function readDescendantProcessIds(parentPid: number): number[] {
  try {
    return descendantProcessIds(readProcessTable(), parentPid)
  } catch {
    return []
  }
}

function readProcessTable(): string {
  return process.platform === 'win32'
    ? execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
        ],
        { encoding: 'utf8' }
      )
    : execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
}

function waitForProcessExit(processIds: readonly number[], timeoutMs: number): Promise<boolean> {
  if (processIds.every((pid) => !isProcessRunning(pid))) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(false), timeoutMs)
    const poll = setInterval(() => {
      if (processIds.every((pid) => !isProcessRunning(pid))) {
        finish(true)
      }
    }, PROCESS_EXIT_POLL_INTERVAL_MS)

    function finish(exited: boolean): void {
      clearTimeout(timeout)
      clearInterval(poll)
      resolve(exited)
    }
  })
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}
