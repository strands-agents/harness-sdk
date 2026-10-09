import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InterventionHandler } from '@strands-agents/sdk'
import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'
import { describe, expect, it, vi } from 'vitest'

import { resolveInterventions } from '../src/interventions.js'

// The HITL handler keeps its config on `_`-prefixed fields; read them to assert on the resolved
// shape without driving a full agent loop.
function hitl(handler: InterventionHandler): { allowedTools: Set<string>; classifier: unknown; ask: unknown } {
  const h = handler as unknown as { _allowedTools: Set<string>; _classifier: unknown; _ask: unknown }
  return { allowedTools: h._allowedTools, classifier: h._classifier, ask: h._ask }
}

function cedarFile(policy = 'permit(principal, action == Action::"read", resource);'): string {
  const dir = mkdtempSync(join(tmpdir(), 'strands-cedar-'))
  const path = join(dir, 'agent.cedar')
  writeFileSync(path, policy)
  return path
}

describe('resolveInterventions', () => {
  it('registers nothing for undefined or off', async () => {
    expect(await resolveInterventions(undefined)).toEqual([])
    expect(await resolveInterventions('off')).toEqual([])
    expect(await resolveInterventions(['off'])).toEqual([])
  })

  it('gates every tool for "ask"', async () => {
    const [handler] = await resolveInterventions('ask')
    expect(handler).toBeInstanceOf(HumanInTheLoop)
    expect(hitl(handler!).allowedTools).toEqual(new Set())
    expect(hitl(handler!).classifier).toBeFalsy()
  })

  it('uses the LLM classifier for "smart"', async () => {
    const [handler] = await resolveInterventions('smart')
    // No allow-list: the classifier judges every call (the harness makes no read/write assumptions).
    expect(hitl(handler!).allowedTools).toEqual(new Set())
    expect(hitl(handler!).classifier).toBeTruthy()
  })

  it('turns a natural-language string into the classifier prompt', async () => {
    const [handler] = await resolveInterventions('Read-only overall, but writes under ./out are fine')
    expect(handler).toBeInstanceOf(HumanInTheLoop)
    expect(hitl(handler!).allowedTools).toEqual(new Set())
    expect(hitl(handler!).classifier).toBeTruthy()
  })

  it('reports a clear error when the optional Cedar dependency is unavailable', async () => {
    // Cedar needs the optional @cedar-policy/cedar-wasm dep; when it's absent the loader throws a
    // clear "install it" error, which is the correct failure for a cedar value on a lean install.
    vi.doMock('@strands-agents/sdk/vended-interventions/cedar', () => {
      throw new Error('Cannot find package @cedar-policy/cedar-wasm')
    })
    try {
      await expect(resolveInterventions(cedarFile())).rejects.toThrow(/cedar/i)
    } finally {
      vi.doUnmock('@strands-agents/sdk/vended-interventions/cedar')
    }
  })

  it('loads a .cedar file path as a Cedar handler when the dependency is installed', async () => {
    const [handler] = await resolveInterventions(cedarFile())
    expect(handler?.name).toBe('cedar-authorization')
  })

  it('does not treat a non-.cedar file path as cedar', async () => {
    // Cedar detection is by `.cedar` suffix only, not file existence: an existing file whose name
    // does not end in `.cedar` is a natural-language policy, not a Cedar policy.
    const dir = mkdtempSync(join(tmpdir(), 'strands-nl-'))
    const path = join(dir, 'policy.txt')
    writeFileSync(path, 'be careful')
    const [handler] = await resolveInterventions(path)
    expect(handler).toBeInstanceOf(HumanInTheLoop)
  })

  it('throws on an invalid value', async () => {
    await expect(resolveInterventions(123 as never)).rejects.toThrow(/Invalid interventions value/)
  })

  it('passes a handler instance through untouched', async () => {
    const handler = new HumanInTheLoop({ ask: 'stdio', enableTrust: true })
    expect(await resolveInterventions(handler)).toEqual([handler])
  })

  it('throws when two human-approval handlers collide', async () => {
    await expect(resolveInterventions(['ask', 'smart'])).rejects.toThrow(/at most one/)
  })

  it('threads the ask mode into the handler', async () => {
    const [interruptHandler] = await resolveInterventions('ask')
    expect(hitl(interruptHandler!).ask).toBeUndefined()
    const [stdioHandler] = await resolveInterventions('ask', { ask: 'stdio' })
    expect(hitl(stdioHandler!).ask).toBeDefined()
  })
})
