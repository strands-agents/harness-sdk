/**
 * Shared setup for end-to-end integration tests: a real agent built by `createHarness` against a live model.
 *
 * These need AWS credentials and cost money/latency. They're excluded from the default vitest run
 * (see `vitest.config.ts`) and run via `npm run test:integ`. Assertions read the conversation to
 * confirm a tool actually ran (`toolSucceeded`), or read the answer for features that aren't tools.
 */

import type { Agent } from '@strands-agents/sdk'

import { createHarness, type HarnessAgentOptions } from '../../src/agent.js'

// A small, fast model keeps these cheap; override with STRANDS_INTEG_MODEL. Thinking is off because the
// Haiku default rejects the reasoning-effort field and it isn't needed for these checks.
export const INTEG_MODEL = process.env.STRANDS_INTEG_MODEL ?? 'bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0'

/**
 * A real, integ-configured agent: the small model, thinking off, plugins disabled, and sessions off
 * by default, so a test exercises exactly what it sets up.
 *
 * Any override wins over these defaults.
 */
export function buildAgent(overrides: HarnessAgentOptions = {}): Promise<Agent> {
  return createHarness({
    model: INTEG_MODEL,
    effort: 'off',
    builtinPlugins: [],
    builtinTools: ['shell', 'read', 'write', 'edit', 'web_fetch', 'programmatic_tool_caller'],
    session: false,
    ...overrides,
  })
}

/**
 * Did the agent call the named tool and get a successful result? Inspects the conversation, matching
 * a `toolUse` of `name` to a `toolResult` with `status === 'success'`, so a test asserts a tool was
 * actually exercised end to end. Handles both the wrapped (`block.toolUse`) and class-instance
 * (`block.name`) shapes the SDK may hold in memory.
 */
export function toolSucceeded(agent: Agent, name: string): boolean {
  const used = new Set<string>()
  const ok = new Set<string>()
  const messages = (agent as unknown as { messages: Array<{ content: Array<Record<string, any>> }> }).messages ?? []
  for (const message of messages) {
    for (const block of message.content ?? []) {
      const use = block.toolUse ?? (typeof block.name === 'string' && block.toolUseId ? block : undefined)
      const result = block.toolResult ?? (typeof block.status === 'string' && block.toolUseId ? block : undefined)
      if (use && use.name === name) {
        used.add(use.toolUseId as string)
      }
      if (result && result.status === 'success') {
        ok.add(result.toolUseId as string)
      }
    }
  }
  return [...used].some((id) => ok.has(id))
}

/**
 * Did the agent emit a `toolUse` for the named tool at all, regardless of outcome? Lets a test prove
 * a blocked call was actually attempted (then denied) rather than silently skipped, so a passing
 * "did not succeed" assertion can't be a false pass.
 */
export function toolAttempted(agent: Agent, name: string): boolean {
  const messages = (agent as unknown as { messages: Array<{ content: Array<Record<string, any>> }> }).messages ?? []
  for (const message of messages) {
    for (const block of message.content ?? []) {
      const use = block.toolUse ?? (typeof block.name === 'string' && block.toolUseId ? block : undefined)
      if (use && use.name === name) {
        return true
      }
    }
  }
  return false
}

/**
 * Did the named tool return a result whose content contains `needle`? Checks the tool's own output
 * (matched via toolUseId), not the model's closing prose — so a test can assert a tool produced the
 * right value (e.g. `read` returned the file's contents) robustly.
 */
export function toolResultContains(agent: Agent, name: string, needle: string): boolean {
  const messages = (agent as unknown as { messages: Array<{ content: Array<Record<string, any>> }> }).messages ?? []
  const ids = new Set<string>()
  for (const message of messages) {
    for (const block of message.content ?? []) {
      const use = block.toolUse ?? (typeof block.name === 'string' && block.toolUseId ? block : undefined)
      if (use && use.name === name) {
        ids.add(use.toolUseId as string)
      }
    }
  }
  for (const message of messages) {
    for (const block of message.content ?? []) {
      const result = block.toolResult ?? (typeof block.status === 'string' && block.toolUseId ? block : undefined)
      if (result && ids.has(result.toolUseId as string) && JSON.stringify(result.content ?? result).includes(needle)) {
        return true
      }
    }
  }
  return false
}
