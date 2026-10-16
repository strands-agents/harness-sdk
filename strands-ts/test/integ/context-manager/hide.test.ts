import { describe, it, expect, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { z } from 'zod'
import { Agent, tool } from '@strands-agents/sdk'
import { ContextManager } from '$/sdk/context-manager/context-manager.js'
import { Hide } from '$/sdk/context-manager/strategies/hide/index.js'
import { bedrock, anthropic } from '../__fixtures__/model-providers.js'
import { hasToolUse } from '../__fixtures__/test-helpers.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '$/sdk/tools/structured-output-tool.js'
import type { Model } from '$/sdk/models/model.js'

/**
 * What a real provider adds over the mock-model tests: whether the provider accepts the requests
 * Hide produces (a filtered `tools` list, a history that references tools no longer on the wire, a
 * forced call against a filtered list), and whether the model behaves as the filtered list implies
 * (completes a task with the reduced catalog, cannot call a tool it was not given). The selection
 * itself is deterministic and covered by the unit tests; retrieval quality is the benchmark item.
 *
 * `vi.spyOn(model, 'stream')` captures the `toolSpecs` each request carried, which is the ground
 * truth for what the provider received.
 */

/** A catalog wide enough that `keep` hides most of it; every tool answers with a fixed string. */
function catalog(): ReturnType<typeof tool>[] {
  const make = (name: string, description: string, result: string): ReturnType<typeof tool> =>
    tool({ name, description, inputSchema: z.object({}).passthrough(), callback: () => result })
  return [
    make('search_invoices', 'Search invoices by customer', 'no invoices found'),
    make('refund_invoice', 'Refund an invoice by id', 'refund issued'),
    make('void_invoice', 'Void an unpaid invoice', 'voided'),
    make('create_ticket', 'Create a support ticket', 'ticket created'),
    make('send_email', 'Send an email to a customer', 'sent'),
    make('track_package', 'Track a shipping package by tracking number', 'in transit'),
    make('schedule_meeting', 'Schedule a calendar meeting', 'scheduled'),
    make('list_calendars', 'List the available calendars', 'work, personal'),
    make('translate_text', 'Translate text between languages', 'translated'),
    make('convert_currency', 'Convert an amount between currencies', '42.00'),
    make('get_weather', 'Current weather conditions for a city', 'Sunny, 24C'),
    make('city_guide', 'Sightseeing tips for a city', 'Visit the museum'),
  ]
}

type StreamSpy = MockInstance<Model['stream']>

/** The tool names each `stream()` call carried, which is what reached the provider. */
function toolNamesPerCall(spy: StreamSpy): string[][] {
  return spy.mock.calls.map(([, options]) => (options?.toolSpecs ?? []).map((spec) => spec.name))
}

for (const provider of [bedrock, anthropic]) {
  describe.skipIf(provider.skip)(`Hide tool specs with ${provider.name}`, () => {
    const createModel = (): Model => provider.createModel({ maxTokens: 1024 })

    it('hides unrelated tools from the provider and the model still completes the task', async () => {
      const model = createModel()
      const streamSpy = vi.spyOn(model, 'stream')
      const agent = new Agent({
        model,
        tools: catalog(),
        printer: false,
        contextManager: new ContextManager({ strategies: [Hide.drop('toolSpecs', { keep: 3 })], stash: false }),
      })

      const result = await agent.invoke('What is the weather in Paris right now? Use the get_weather tool.')

      expect(result.stopReason).toBe('endTurn')
      expect(hasToolUse(agent.messages, 'get_weather')).toBe(true)
      const perCall = toolNamesPerCall(streamSpy)
      expect(perCall.length).toBeGreaterThanOrEqual(2)
      for (const names of perCall) {
        expect(names).toHaveLength(3)
        expect(names).toContain('get_weather')
      }
      expect(new Set(perCall.map((names) => names.join(','))).size).toBe(1)
      expect(agent.tools).toHaveLength(12)
    })

    it('accepts a history that references a tool no longer on the wire', async () => {
      const model = createModel()
      const streamSpy = vi.spyOn(model, 'stream')
      const agent = new Agent({
        model,
        tools: catalog(),
        printer: false,
        contextManager: new ContextManager({ strategies: [Hide.drop('toolSpecs', { keep: 1 })], stash: false }),
      })

      await agent.invoke('What is the weather in Paris right now? Use the get_weather tool.')
      const firstTurnCalls = streamSpy.mock.calls.length
      const result = await agent.invoke('Now refund invoice 42 for me. Use the refund_invoice tool.')

      expect(result.stopReason).toBe('endTurn')
      expect(hasToolUse(agent.messages, 'get_weather')).toBe(true)
      expect(hasToolUse(agent.messages, 'refund_invoice')).toBe(true)
      const secondTurn = toolNamesPerCall(streamSpy).slice(firstTurnCalls)
      for (const names of secondTurn) {
        expect(names).toEqual(['refund_invoice'])
      }
    })

    it('cannot call a tool Hide removed, even when asked for it by name', async () => {
      const model = createModel()
      const streamSpy = vi.spyOn(model, 'stream')
      const agent = new Agent({
        model,
        tools: catalog(),
        printer: false,
        contextManager: new ContextManager({
          strategies: [Hide.drop('toolSpecs', { keep: 3, alwaysHide: ['get_weather'] })],
          stash: false,
        }),
      })

      const result = await agent.invoke(
        'What is the weather in Paris right now? Use the get_weather tool. If you cannot, say so in one sentence.'
      )

      expect(result.stopReason).toBe('endTurn')
      expect(hasToolUse(agent.messages, 'get_weather')).toBe(false)
      for (const names of toolNamesPerCall(streamSpy)) {
        expect(names).not.toContain('get_weather')
      }
      expect(agent.tools.map((entry) => entry.name)).toContain('get_weather')
    })

    it('applies the selection on the forced structured-output call', async () => {
      const model = createModel()
      const streamSpy = vi.spyOn(model, 'stream')
      const agent = new Agent({
        model,
        tools: catalog(),
        printer: false,
        structuredOutputSchema: z.object({ city: z.string(), conditions: z.string() }),
        contextManager: new ContextManager({ strategies: [Hide.drop('toolSpecs', { keep: 2 })], stash: false }),
      })

      const result = await agent.invoke('What is the weather in Paris right now? Use the get_weather tool.')

      expect(result.structuredOutput).toMatchObject({ city: expect.stringContaining('Paris') })
      const perCall = toolNamesPerCall(streamSpy)
      expect(perCall.length).toBeGreaterThanOrEqual(2)
      for (const names of perCall) {
        expect(names).toHaveLength(3)
        expect(names).toContain('get_weather')
        expect(names).toContain(STRUCTURED_OUTPUT_TOOL_NAME)
      }
      expect(new Set(perCall.map((names) => names.join(','))).size).toBe(1)
    })

    it('keeps the previous view on a continuation turn', async () => {
      const model = createModel()
      const streamSpy = vi.spyOn(model, 'stream')
      const agent = new Agent({
        model,
        tools: catalog(),
        printer: false,
        contextManager: new ContextManager({ strategies: [Hide.drop('toolSpecs', { keep: 2 })], stash: false }),
      })

      await agent.invoke('What is the weather in Paris right now? Use the get_weather tool.')
      const firstTurn = toolNamesPerCall(streamSpy)
      const firstTurnCalls = streamSpy.mock.calls.length
      const result = await agent.invoke('ok thanks')

      expect(result.stopReason).toBe('endTurn')
      const secondTurn = toolNamesPerCall(streamSpy).slice(firstTurnCalls)
      expect(secondTurn.length).toBeGreaterThanOrEqual(1)
      for (const names of secondTurn) {
        expect(names).toEqual(firstTurn[0])
      }
    })

    it('leaves a catalog that fits within keep untouched', async () => {
      const model = createModel()
      const streamSpy = vi.spyOn(model, 'stream')
      const agent = new Agent({
        model,
        tools: catalog().slice(0, 4),
        printer: false,
        contextManager: new ContextManager({ strategies: [Hide.drop('toolSpecs', { keep: 10 })], stash: false }),
      })

      const result = await agent.invoke('Reply with the single word OK.')

      expect(result.stopReason).toBe('endTurn')
      for (const names of toolNamesPerCall(streamSpy)) {
        expect(names).toEqual(['search_invoices', 'refund_invoice', 'void_invoice', 'create_ticket'])
      }
    })
  })
}
