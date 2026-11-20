import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../../agent/agent.js'
import type { ToolResultBlock } from '../../../types/messages.js'

/** A fresh copy of the tool and an agent holding it, so each test resolves the Monty runtime anew. */
async function freshAgent(): Promise<Agent> {
  vi.resetModules()
  const { Agent } = await import('../../../agent/agent.js')
  const { MockMessageModel } = await import('../../../__fixtures__/mock-message-model.js')
  const { programmaticToolCaller } = await import('../programmatic-tool-caller.js')
  return new Agent({ model: new MockMessageModel(), tools: [programmaticToolCaller] })
}

async function run(agent: Agent, code: string): Promise<ToolResultBlock> {
  return agent.tool.programmatic_tool_caller!.invoke({ code }, { recordDirectToolCall: false })
}

function text(result: ToolResultBlock): string {
  return result.content.map((block) => (block as { text?: string }).text ?? '').join('\n')
}

function failToLoad(specifier: string): void {
  vi.doMock(specifier, () => {
    throw new Error(`${specifier} is unavailable`)
  })
}

describe('programmatic_tool_caller Monty runtime', () => {
  afterEach(() => {
    vi.doUnmock('@pydantic/monty')
    vi.doUnmock('@pydantic/monty/wasm')
    vi.restoreAllMocks()
  })

  it('falls back to the WebAssembly build when the native addon does not load', async () => {
    failToLoad('@pydantic/monty')
    const agent = await freshAgent()
    const { logger } = await import('../../../logging/logger.js')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const result = await run(agent, "import os\nprint(sum(range(10)))\nprint(os.listdir('/'))")

    expect(result.status).toBe('error')
    expect(text(result)).toMatch(/^Error: 45\n\nExecution error:\n[\s\S]*PermissionError/)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to the webassembly build'))
  })

  it('names the package to install when no build loads', async () => {
    failToLoad('@pydantic/monty')
    failToLoad('@pydantic/monty/wasm')
    const agent = await freshAgent()

    const result = await run(agent, 'print(1)')

    expect(result.status).toBe('error')
    expect(text(result)).toContain(
      "requires the '@pydantic/monty' package. Install it with: npm install @pydantic/monty@^1.6.0"
    )
  })
})
