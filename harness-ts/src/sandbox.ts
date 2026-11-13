/**
 * Sandbox helpers shared by the harness tools and plugins. Internal: not exported from the package barrel.
 *
 * `shellOf` tells which shell dialect a sandbox runs commands in. The Sandbox contract names none, so it
 * asks: PowerShell prints its edition (`Desktop` or `Core`), `sh` expands the unset variable to an empty
 * line. Probed once per sandbox.
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
    // A cold powershell.exe start on a loaded Windows host can take longer than 10 s.
    const result = await sandbox.execute(SHELL_PROBE, { timeout: 30 })
    // A failed probe is inconclusive: answer `sh` for this call but probe again next time.
    if (result.exitCode !== 0) return 'sh'
    shell = ['Desktop', 'Core'].includes(result.stdout.trim()) ? 'powershell' : 'sh'
    shells.set(sandbox, shell)
  }
  return shell
}
