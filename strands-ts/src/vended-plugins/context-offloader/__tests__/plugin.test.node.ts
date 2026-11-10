import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ContextOffloader } from '../plugin.js'
import { FileStorage } from '../storage.js'
import { AfterToolCallEvent } from '../../../hooks/events.js'
import { TextBlock, ToolResultBlock } from '../../../types/messages.js'
import type { ToolContext } from '../../../tools/tool.js'
import { createMockAgent, invokeTrackedHook, type MockAgent } from '../../../__fixtures__/agent-helpers.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { TestSandbox } from '../../../__fixtures__/test-sandbox.node.js'

const mockModel = new MockMessageModel()
let testDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'context-offloader-sandbox-'))
  testDirs.push(dir)
  return dir
}

function makeAgent(sandbox: TestSandbox): MockAgent {
  return createMockAgent({ extra: { model: mockModel, sandbox } as never })
}

function makeEvent(agent: MockAgent, toolUseId: string, content: string): AfterToolCallEvent {
  return new AfterToolCallEvent({
    agent,
    toolUse: { name: 'some_tool', toolUseId, input: {} },
    tool: undefined,
    result: new ToolResultBlock({
      toolUseId,
      status: 'success',
      content: [new TextBlock(content)],
    }),
    invocationState: {},
  })
}

function makeToolContext(agent: MockAgent, reference: string): ToolContext {
  return {
    toolUse: {
      name: 'retrieve_offloaded_content',
      toolUseId: 'retrieve-123',
      input: { reference },
    },
    agent,
    invocationState: {},
    cancelSignal: agent.cancelSignal,
    interrupt: () => {
      throw new Error('interrupt not available in mock context')
    },
  }
}

function getReference(event: AfterToolCallEvent): string {
  const preview = (event.result.content[0] as TextBlock).text
  const match = preview.match(/\b\d+_\d+_\S+\.txt/)
  expect(match).not.toBeNull()
  return match![0]
}

afterEach(() => {
  for (const dir of testDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  testDirs = []
})

describe.skipIf(process.platform === 'win32')('ContextOffloader with FileStorage', () => {
  // Drives a real PosixShellSandbox, so every FileStorage operation spawns an `sh`
  // subprocess (~9 spawns across both agents). Solo this is ~1.4s, but under the
  // parallel coverage run the spawns serialize on CPU and push wall time past the
  // 5s default, so allow extra headroom.
  it('isolates a shared storage config by agent sandbox', async () => {
    const dirA = makeTempDir()
    const dirB = makeTempDir()
    const agentA = makeAgent(new TestSandbox(dirA))
    const agentB = makeAgent(new TestSandbox(dirB))
    const plugin = new ContextOffloader({
      storage: new FileStorage(),
      maxResultTokens: 10,
      previewTokens: 5,
      includeRetrievalTool: true,
    })
    const retrievalTool = plugin.getTools()[0]! as unknown as {
      invoke(input: { reference: string }, context?: ToolContext): Promise<unknown>
    }

    plugin.initAgent(agentA)
    plugin.initAgent(agentB)

    const contentA = `agent A content\n${'a'.repeat(1000)}`
    const contentB = `agent B content\n${'b'.repeat(1000)}`
    const eventA = makeEvent(agentA, 'tool-a', contentA)
    const eventB = makeEvent(agentB, 'tool-b', contentB)

    await invokeTrackedHook(agentA, eventA)
    await invokeTrackedHook(agentB, eventB)

    const refA = getReference(eventA)
    const refB = getReference(eventB)
    expect(existsSync(join(dirA, 'artifacts', refA))).toBe(true)
    expect(existsSync(join(dirB, 'artifacts', refA))).toBe(false)
    expect(existsSync(join(dirB, 'artifacts', refB))).toBe(true)
    expect(existsSync(join(dirA, 'artifacts', refB))).toBe(false)

    await expect(retrievalTool.invoke({ reference: refA }, makeToolContext(agentA, refA))).resolves.toBe(contentA)
    await expect(retrievalTool.invoke({ reference: refB }, makeToolContext(agentB, refB))).resolves.toBe(contentB)
    await expect(retrievalTool.invoke({ reference: refA }, makeToolContext(agentB, refA))).resolves.toContain(
      'Error: reference not found'
    )
  }, 15_000)
})
