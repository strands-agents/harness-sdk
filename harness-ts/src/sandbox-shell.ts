/**
 * Which shell dialect a sandbox runs commands in. The Sandbox contract names none, so the only check that
 * holds for every sandbox is to ask: PowerShell prints its edition (`Desktop` or `Core`), `sh` expands the
 * unset variable to an empty line. Probed once per sandbox.
 */

import type { Sandbox } from '@strands-agents/sdk'

/** @internal */
export type SandboxShell = 'sh' | 'powershell'

/** @internal Exported for tests. */
export const SHELL_PROBE = 'echo "${PSEdition}"'
const shells = new WeakMap<Sandbox, SandboxShell>()

/** @internal The shell `sandbox` runs commands in, probed once per sandbox. */
export async function shellOf(sandbox: Sandbox): Promise<SandboxShell> {
  let shell = shells.get(sandbox)
  if (!shell) {
    const result = await sandbox.execute(SHELL_PROBE, { timeout: 10 })
    // A failed probe is inconclusive: answer `sh` for this call but probe again next time.
    if (result.exitCode !== 0) return 'sh'
    shell = ['Desktop', 'Core'].includes(result.stdout.trim()) ? 'powershell' : 'sh'
    shells.set(sandbox, shell)
  }
  return shell
}
