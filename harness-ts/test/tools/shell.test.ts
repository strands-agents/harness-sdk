import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Tool, ToolContext } from '@strands-agents/sdk'

import { createHarness } from '../../src/agent.js'
import { SHELL_PROBE } from '../../src/sandbox.js'

let agent: Agent
let shell: Tool

function findShell(a: Agent): Tool {
  const tools = (a as unknown as { tools: Tool[] }).tools
  const found = tools.find((t) => t.toolSpec.name === 'shell')
  if (!found) throw new Error('shell tool not registered')
  return found
}

function invoke(input: unknown): Promise<{ output: string; error: string }> {
  return (
    shell as unknown as { invoke: (i: unknown, c: ToolContext) => Promise<{ output: string; error: string }> }
  ).invoke(input, { agent } as unknown as ToolContext)
}

beforeEach(async () => {
  agent = await createHarness({ skills: false })
  shell = findShell(agent)
})

describe('shell', () => {
  it('exposes only command and timeout, with no mode discriminator', () => {
    const schema = shell.toolSpec.inputSchema as { properties?: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['command', 'timeout'])
    expect(schema.required).toEqual(['command'])
    expect(schema.properties).not.toHaveProperty('mode')
  })

  // Each command is a fresh process (a PowerShell start on Windows): more than the default 5 s allows on a busy
  // CI runner.
  it('runs a command through the agent sandbox', { timeout: 30_000 }, async () => {
    const result = await invoke({ command: 'echo hello' })
    expect(result.output).toContain('hello')
  })

  it('is stateless: state does not persist across calls', { timeout: 30_000 }, async () => {
    // Probed directly so the probe is bounded by this test's timeout, not `shellOf`'s own.
    const { stdout } = await agent.sandbox.execute(SHELL_PROBE)
    const powershell = ['Desktop', 'Core'].includes(stdout.trim())
    const set = await invoke({ command: powershell ? "$env:STRANDS_CLI_TEST = '42'" : 'export STRANDS_CLI_TEST=42' })
    expect(set).toMatchObject({ exit_code: 0 })
    const result = await invoke({
      command: powershell ? 'echo "[$env:STRANDS_CLI_TEST]"' : 'echo "[$STRANDS_CLI_TEST]"',
    })
    expect(result.output).toContain('[]')
  })
})
