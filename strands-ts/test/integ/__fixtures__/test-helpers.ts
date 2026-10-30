import { inject } from 'vitest'
import { Agent, ToolResultBlock, tool } from '@strands-agents/sdk'
import type { AgentResult, InterruptResponseContentData, JSONValue, Message } from '@strands-agents/sdk'
import { z } from 'zod'

/**
 * Checks whether we're running tests in the browser.
 */
export const isInBrowser = () => {
  return inject('isBrowser')
}

export function isCI() {
  return inject('isCI')
}

/**
 * Helper to load fixture files from Vite URL imports.
 * Vite ?url imports return paths like '/test/integ/__resources__/file.png' in test environment.
 *
 * @param url - The URL from a Vite ?url import
 * @returns The file contents as a Uint8Array
 */
export async function loadFixture(url: string): Promise<Uint8Array> {
  if (isInBrowser()) {
    const response = await globalThis.fetch(url)
    const arrayBuffer = await response.arrayBuffer()
    return new Uint8Array(arrayBuffer)
  } else {
    const { join } = await import('node:path')
    const { readFile } = await import('node:fs/promises')
    const relativePath = url.startsWith('/') ? url.slice(1) : url
    const filePath = join(process.cwd(), relativePath)
    return new Uint8Array(await readFile(filePath))
  }
}

// ================================
// Async Helpers
// ================================

/**
 * Polls a (sync or async) predicate until it returns truthy, or the timeout elapses. Resolves `true`
 * on success and `false` on timeout (it does not throw), so callers assert on the result. Useful for
 * awaiting eventually-consistent or background work — e.g. a value that a fire-and-forget task writes
 * after the call that triggered it has already returned.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 45_000, intervalMs = 1_000 } = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// ================================
// Agent Message Helpers
// ================================

/**
 * Checks if any message contains a toolUseBlock with the specified tool name.
 */
export function hasToolUse(messages: Message[], toolName: string): boolean {
  return messages.some((msg) => msg.content.some((block) => block.type === 'toolUseBlock' && block.name === toolName))
}

/**
 * Counts messages containing toolResultBlocks with the specified status.
 */
export function countToolResults(messages: Message[], status: 'success' | 'error'): number {
  return messages.filter((msg) =>
    msg.content.some((block) => block.type === 'toolResultBlock' && block.status === status)
  ).length
}

/**
 * Extracts text content from tool result blocks matching the given status.
 */
export function getToolResultText(messages: Message[], status?: 'success' | 'error'): string {
  return messages
    .filter((m) => m.role === 'user')
    .flatMap((m) =>
      m.content.filter((b): b is ToolResultBlock => b.type === 'toolResultBlock' && (!status || b.status === status))
    )
    .flatMap((tr) => tr.content.filter((b) => b.type === 'textBlock').map((b) => b.text))
    .join(' ')
}

/**
 * Resumes an interrupted agent by responding to all pending interrupts,
 * looping until the agent completes or a max iteration limit is reached.
 */
export async function resumeUntilDone(
  agent: Agent,
  result: AgentResult,
  respond: (interrupt: { id: string; name: string; reason?: unknown }) => JSONValue,
  maxRounds = 10
): Promise<AgentResult> {
  let current = result
  for (let i = 0; i < maxRounds && current.stopReason === 'interrupt'; i++) {
    const responses: InterruptResponseContentData[] = current.interrupts!.map((interrupt) => ({
      interruptResponse: {
        interruptId: interrupt.id,
        response: respond(interrupt),
      },
    }))
    current = await agent.invoke(responses)
  }
  return current
}

// ================================
// Common Tool Fixtures
// ================================

export const timeTool = tool({
  name: 'time_tool',
  description: 'Returns the current time. Always call this tool when asked about time.',
  inputSchema: z.object({}),
  callback: async () => '12:00',
})

export const weatherTool = tool({
  name: 'weather_tool',
  description: 'Returns the current weather. Always call this tool when asked about weather.',
  inputSchema: z.object({}),
  callback: async () => 'sunny',
})

export const echoTool = tool({
  name: 'echo_tool',
  description: 'Echoes back the given message. Always call this tool when asked to echo.',
  inputSchema: z.object({ message: z.string().describe('The message to echo') }),
  callback: async ({ message }) => `Echo: ${message}`,
})

/**
 * Shape of a raw MCP tool result, for asserting on `McpClient.callTool` pass-through in tests.
 *
 * A type alias rather than an interface: the implicit index signature keeps the direct cast from
 * `callTool`'s `JSONValue` return legal, where an interface would force casting through `unknown`.
 */
export type McpCallToolResult = {
  content: { type: string; text?: string }[]
  isError?: boolean
}
