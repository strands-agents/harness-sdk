/**
 * A sandbox that knows where it runs can say so via a duck-typed `environment` property
 * (`{ platform, cwd, shell }`), as the CLI's workspace sandbox does. Consumers prefer it over
 * probing with shell commands, which have no meaning on a host without a POSIX shell.
 */

import type { Sandbox } from '@strands-agents/sdk'

export interface SandboxEnvironment {
  /** Human-readable, as `uname -s` would print it: `Linux`, `Darwin`, `Windows`. */
  platform: string | undefined
  /** Absolute, in the sandbox's own path syntax. */
  cwd: string | undefined
  /** The shell `execute()` runs commands in: `sh`, or `PowerShell`/`pwsh` (matched case-insensitively). */
  shell: string | undefined
}

export function isPowerShell(shell: string | undefined): boolean {
  return shell !== undefined && /^(powershell|pwsh)/i.test(shell)
}

export function describedEnvironment(sandbox: Sandbox): SandboxEnvironment | undefined {
  const described = (sandbox as { environment?: unknown }).environment
  if (!described || typeof described !== 'object') {
    return undefined
  }
  const pick = (key: keyof SandboxEnvironment): string | undefined => {
    const value = (described as Record<string, unknown>)[key]
    return typeof value === 'string' && value ? value : undefined
  }
  return { platform: pick('platform'), cwd: pick('cwd'), shell: pick('shell') }
}
