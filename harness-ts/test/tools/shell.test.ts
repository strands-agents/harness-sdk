import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Tool, ToolContext } from '@strands-agents/sdk'

import { createHarness } from '../../src/agent.js'

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

  it('runs a command through the agent sandbox', async () => {
    const result = await invoke({ command: 'echo hello' })
    expect(result.output).toContain('hello')
  })

  it('is stateless: state does not persist across calls', async () => {
    await invoke({ command: 'export STRANDS_CLI_TEST=42' })
    const result = await invoke({ command: 'echo "[$STRANDS_CLI_TEST]"' })
    expect(result.output).toContain('[]')
  })
})
