import { describe, it, expect, vi } from 'vitest'
import { Hide, HideToolSpecsStrategy, KeywordToolSearch } from '../hide/index.js'
import { InvokeModelStage } from '../../../middleware/stages.js'
import { AfterInvocationEvent, BeforeInvocationEvent } from '../../../hooks/events.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../../tools/structured-output-tool.js'
import { RETRIEVAL_TOOL_NAME } from '../../retrieval-tool.js'
import { OFFLOADED_CONTENT_RETRIEVAL_TOOL_NAME } from '../../../vended-plugins/context-offloader/plugin.js'
import { Message, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import { createMockAgent, invokeTrackedHook } from '../../../__fixtures__/agent-helpers.js'
import { createStaticToolSearch } from '../../../__fixtures__/search-helpers.js'
import type { MockAgent } from '../../../__fixtures__/agent-helpers.js'
import type { InvokeModelContext } from '../../../middleware/stages.js'
import type { ToolSearchStrategy } from '../hide/index.js'
import type { ToolSpec } from '../../../tools/types.js'
import type { InvocationState } from '../../../types/agent.js'

type InputHandler = (context: InvokeModelContext) => InvokeModelContext | Promise<InvokeModelContext>

/** Attach a strategy to a mock agent and capture the Input handler it registers. */
function attach(strategy: HideToolSpecsStrategy): { agent: MockAgent; handler: InputHandler } {
  let handler: InputHandler | undefined
  const agent = createMockAgent({
    extra: {
      addMiddleware: ((stage: unknown, registered: InputHandler) => {
        if (stage === InvokeModelStage.Input) handler = registered
        return () => {}
      }) as never,
    },
  })
  strategy.init(agent)
  if (!handler) throw new Error('strategy did not register an Input handler')
  return { agent, handler }
}

/** A tool search strategy whose `search` is a spy returning fixed names. */
function spySearch(names: string[]): ToolSearchStrategy & { search: ReturnType<typeof vi.fn> } {
  return { search: vi.fn(async () => names.map((name, index) => ({ name, score: names.length - index }))) }
}

function spec(name: string, description = '', properties?: Record<string, { description?: string }>): ToolSpec {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: properties ?? {} },
  }
}

function user(text: string): Message {
  return new Message({ role: 'user', content: [new TextBlock(text)] })
}

function toolResultOnly(): Message {
  return new Message({
    role: 'user',
    content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('done')] })],
  })
}

function assistantWithUsage(): Message {
  return new Message({
    role: 'assistant',
    content: [new TextBlock('working')],
    metadata: { usage: { inputTokens: 500, outputTokens: 10, totalTokens: 510 } },
  })
}

/** A model whose countTokens charges a flat rate per tool spec. */
function countingModel(tokensPerSpec = 25): InvokeModelContext['model'] {
  return {
    countTokens: vi.fn(async (_messages: Message[], options?: { toolSpecs?: readonly ToolSpec[] }) => {
      return (options?.toolSpecs?.length ?? 0) * tokensPerSpec
    }),
  } as unknown as InvokeModelContext['model']
}

function context(
  agent: MockAgent,
  toolSpecs: ToolSpec[],
  overrides?: Partial<Pick<InvokeModelContext, 'messages' | 'toolChoice' | 'invocationState' | 'model'>>
): InvokeModelContext {
  const model = overrides?.model ?? countingModel()
  Object.assign(agent, { model })
  return {
    agent,
    model,
    messages: overrides?.messages ?? [user('search the billing records')],
    toolSpecs,
    invocationState: overrides?.invocationState ?? {},
    ...(overrides?.toolChoice !== undefined && { toolChoice: overrides.toolChoice }),
  }
}

const catalog = [
  spec('billing_search', 'Search billing records'),
  spec('billing_summary', 'Summarize a billing account'),
  spec('shipping_search', 'Search shipments'),
  spec('shipping_track', 'Track a shipment'),
  spec('ask_user', 'Ask the user a question'),
]

const PROTECTED = [STRUCTURED_OUTPUT_TOOL_NAME, RETRIEVAL_TOOL_NAME, OFFLOADED_CONTENT_RETRIEVAL_TOOL_NAME]
const protectedSpecs = PROTECTED.map((name) => spec(name, 'Protected'))

const names = (specs: readonly ToolSpec[]): string[] => specs.map((entry) => entry.name)

const toolSpecs = (...args: Parameters<typeof Hide.toolSpecs>): HideToolSpecsStrategy =>
  Hide.toolSpecs(...args) as HideToolSpecsStrategy

describe('Hide.toolSpecs', () => {
  describe('construction', () => {
    it('defaults the target to every tool spec', async () => {
      const search = createStaticToolSearch(['shipping_track'])
      const { agent, handler } = attach(toolSpecs(undefined, { search, keep: 1 }))
      const result = await handler(context(agent, catalog))
      expect(result.toolSpecs.map((entry) => entry.name)).toEqual(['shipping_track'])
    })

    it('when() returns a new strategy and leaves the original ungated', async () => {
      const base = toolSpecs('toolSpecs', { search: createStaticToolSearch(['shipping_track']), keep: 1 })
      const gated = base.when({ count: 20 })
      expect(gated).not.toBe(base)
      expect(gated.name).toBe('hide:toolSpecs')
      const { agent, handler } = attach(base)
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(['shipping_track'])
    })

    it('when() carries the full config across', async () => {
      const search = createStaticToolSearch(['shipping_track'])
      const config = { search, keep: 1, alwaysHide: ['billing_search'], onFailure: 'none' as const }
      const gated = toolSpecs(['toolSpec::*', '!toolSpec::ask_user'], config).when({ count: 0 })
      const { agent, handler } = attach(gated as HideToolSpecsStrategy)
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(['shipping_track', 'ask_user'])
    })

    it('throws for an empty array target', () => {
      expect(() => Hide.toolSpecs([])).toThrow('Empty array target')
    })

    it('throws for a non-positive keep', () => {
      expect(() => Hide.toolSpecs('toolSpecs', { keep: 0 })).toThrow('keep must be a positive integer')
    })

    it('throws for a negative count', () => {
      expect(() => Hide.toolSpecs().when({ count: -1 })).toThrow('count must be a non-negative integer')
    })

    it('throws for an entry without the toolSpec prefix', () => {
      expect(() => Hide.toolSpecs(['tool::billing_search'])).toThrow("must be 'toolSpec::<name>'")
      expect(() => Hide.toolSpecs(['!billing_search'])).toThrow("must be 'toolSpec::<name>'")
    })

    it('throws for an empty name or a pinned wildcard', () => {
      expect(() => Hide.toolSpecs(['toolSpec::'])).toThrow("must be 'toolSpec::<name>'")
      expect(() => Hide.toolSpecs(['!toolSpec::*'])).toThrow("must be 'toolSpec::<name>'")
    })

    it('throws when a name is both a candidate and pinned', () => {
      expect(() => Hide.toolSpecs(['toolSpec::ask_user', '!toolSpec::ask_user'])).toThrow('both a candidate and pinned')
    })
  })

  describe('message pipeline', () => {
    it('apply() is a no-op', async () => {
      const agent = createMockAgent()
      const acted = await toolSpecs().apply({ messages: agent.messages, agent, utilization: 0 })
      expect(acted).toBe(false)
    })
  })

  describe('init', () => {
    it('registers an Input handler and both invocation-boundary hooks', () => {
      const { agent } = attach(toolSpecs())
      const eventTypes = agent.trackedHooks.map((hook) => hook.eventType)
      expect(eventTypes).toEqual([AfterInvocationEvent, BeforeInvocationEvent])
    })
  })

  describe('selection', () => {
    it('keeps the top keyword matches in catalog order by default', async () => {
      const { agent, handler } = attach(toolSpecs('toolSpecs', { keep: 2 }))
      const result = await handler(context(agent, catalog, { messages: [user('summarize billing records')] }))
      expect(names(result.toolSpecs)).toEqual(['billing_search', 'billing_summary'])
    })

    it('emits in catalog order even when search ranks differently', async () => {
      const search = createStaticToolSearch(['shipping_track', 'billing_search'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 2 }))
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(['billing_search', 'shipping_track'])
    })

    it('reuses the selection for later calls in the same invocation', async () => {
      const search = spySearch(['billing_search'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const invocationState: InvocationState = {}
      const first = await handler(context(agent, catalog, { invocationState }))
      const second = await handler(context(agent, catalog, { invocationState, messages: [toolResultOnly()] }))
      expect(names(first.toolSpecs)).toEqual(['billing_search'])
      expect(names(second.toolSpecs)).toEqual(['billing_search'])
      expect(search.search).toHaveBeenCalledTimes(1)
    })

    it('intersects a stored selection with the current catalog', async () => {
      const search = createStaticToolSearch(['billing_search', 'shipping_track'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 2 }))
      const invocationState: InvocationState = {}
      await handler(context(agent, catalog, { invocationState }))
      const shrunk = catalog.filter((entry) => entry.name !== 'shipping_track')
      const result = await handler(context(agent, shrunk, { invocationState }))
      expect(names(result.toolSpecs)).toEqual(['billing_search'])
    })

    it('keeps separate selections for concurrent invocations', async () => {
      const search: ToolSearchStrategy = {
        search: async (query) => [{ name: query.includes('billing') ? 'billing_search' : 'shipping_search', score: 1 }],
      }
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const billing = await handler(context(agent, catalog, { invocationState: {} }))
      const shipping = await handler(
        context(agent, catalog, { invocationState: {}, messages: [user('track my shipping order')] })
      )
      expect(names(billing.toolSpecs)).toEqual(['billing_search'])
      expect(names(shipping.toolSpecs)).toEqual(['shipping_search'])
    })

    it('derives the query from the latest user text, skipping tool-result-only turns', async () => {
      const search = spySearch(['billing_search'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 2 }))
      const messages = [user('first'), user('  track the shipment  '), toolResultOnly()]
      await handler(context(agent, catalog, { messages }))
      expect(search.search).toHaveBeenCalledWith('track the shipment', expect.any(Array), 2)
    })

    it('passes only the eligible specs as candidates, with keep as the limit', async () => {
      const search = spySearch([])
      const { agent, handler } = attach(toolSpecs(['toolSpec::*', '!toolSpec::ask_user'], { search, keep: 3 }))
      await handler(context(agent, catalog))
      const eligible = catalog.filter((entry) => entry.name !== 'ask_user')
      expect(search.search).toHaveBeenCalledWith(expect.any(String), eligible, 3)
    })

    it('fills the keep budget from unmatched candidates in catalog order', async () => {
      const search = createStaticToolSearch(['shipping_track'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 3 }))
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(['billing_search', 'billing_summary', 'shipping_track'])
    })

    it('shows the whole catalog without searching when it fits within keep', async () => {
      const search = spySearch(['shipping_track'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 5 }))
      const input = context(agent, catalog)
      const result = await handler(input)
      expect(result).toBe(input)
      expect(search.search).not.toHaveBeenCalled()
    })
  })

  describe('target', () => {
    it('keeps pinned specs visible without consuming keep', async () => {
      const { agent, handler } = attach(toolSpecs(['toolSpec::*', '!toolSpec::ask_user'], { keep: 1 }))
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(['billing_search', 'ask_user'])
    })

    it('treats a pin-only target as every spec', async () => {
      const { agent, handler } = attach(toolSpecs(['!toolSpec::ask_user'], { keep: 1 }))
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(['billing_search', 'ask_user'])
    })

    it('narrows the candidates to named specs and leaves the rest visible', async () => {
      const search = createStaticToolSearch(['billing_summary'])
      const target = ['toolSpec::billing_search', 'toolSpec::billing_summary']
      const { agent, handler } = attach(toolSpecs(target, { search, keep: 1 }))
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(['billing_summary', 'shipping_search', 'shipping_track', 'ask_user'])
    })

    it('lets the wildcard override named candidates', async () => {
      const search = createStaticToolSearch(['shipping_track'])
      const { agent, handler } = attach(toolSpecs(['toolSpec::billing_search', 'toolSpec::*'], { search, keep: 1 }))
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(['shipping_track'])
    })

    it('always keeps the structured-output and retrieval tools', async () => {
      const { agent, handler } = attach(toolSpecs('toolSpecs', { keep: 1 }))
      const result = await handler(context(agent, [...catalog, ...protectedSpecs]))
      expect(names(result.toolSpecs)).toEqual(['billing_search', ...PROTECTED])
    })
  })

  describe('alwaysHide', () => {
    it('removes the named specs before selection', async () => {
      const search = createStaticToolSearch(['billing_search', 'ask_user'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1, alwaysHide: ['billing_search'] }))
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(['ask_user'])
    })

    it('wins over a pin', async () => {
      const target = ['toolSpec::*', '!toolSpec::ask_user']
      const { agent, handler } = attach(toolSpecs(target, { keep: 1, alwaysHide: ['ask_user'] }))
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(['billing_search'])
    })

    it('cannot hide protected tools', async () => {
      const { agent, handler } = attach(toolSpecs('toolSpecs', { keep: 1, alwaysHide: PROTECTED }))
      const result = await handler(context(agent, [...catalog, ...protectedSpecs]))
      expect(names(result.toolSpecs)).toEqual(['billing_search', ...PROTECTED])
    })

    it('applies even when count is not met', async () => {
      const strategy = toolSpecs('toolSpecs', { keep: 1, alwaysHide: ['ask_user'] }).when({ count: 20 })
      const { agent, handler } = attach(strategy as HideToolSpecsStrategy)
      const model = countingModel(25)
      const result = await handler({ ...context(agent, catalog, { model }), projectedInputTokens: 1000 })
      expect(names(result.toolSpecs)).toEqual([
        'billing_search',
        'billing_summary',
        'shipping_search',
        'shipping_track',
      ])
      expect(result.projectedInputTokens).toBe(975)
    })

    it('does not count toward the count gate', async () => {
      const strategy = toolSpecs('toolSpecs', { keep: 1, alwaysHide: ['ask_user'] }).when({ count: 5 })
      const { agent, handler } = attach(strategy as HideToolSpecsStrategy)
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual([
        'billing_search',
        'billing_summary',
        'shipping_search',
        'shipping_track',
      ])
    })
  })

  describe('onFailure', () => {
    const broken: ToolSearchStrategy = {
      search: async () => {
        throw new Error('boom')
      },
    }

    it('"none" shows only pinned and protected tools when search throws', async () => {
      const target = ['toolSpec::*', '!toolSpec::ask_user']
      const { agent, handler } = attach(toolSpecs(target, { search: broken, keep: 1, onFailure: 'none' }))
      const withProtected = [...catalog, spec(RETRIEVAL_TOOL_NAME, 'Retrieve offloaded content')]
      const result = await handler(context(agent, withProtected))
      expect(names(result.toolSpecs)).toEqual(['ask_user', RETRIEVAL_TOOL_NAME])
    })

    it('"none" shows only pinned tools when nothing matches and nothing can be carried', async () => {
      const target = ['toolSpec::*', '!toolSpec::ask_user']
      const { agent, handler } = attach(
        toolSpecs(target, { search: createStaticToolSearch([]), keep: 1, onFailure: 'none' })
      )
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(['ask_user'])
    })

    it('"none" leaves a catalog that fits within keep untouched', async () => {
      const search = spySearch([])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 10, onFailure: 'none' }))
      const input = context(agent, catalog)
      const result = await handler(input)
      expect(result).toBe(input)
      expect(search.search).not.toHaveBeenCalled()
    })

    it('"none" still carries a previous selection forward', async () => {
      const search: ToolSearchStrategy = {
        search: async (query) => (query === 'billing' ? [{ name: 'billing_search', score: 1 }] : []),
      }
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1, onFailure: 'none' }))
      await handler(context(agent, catalog, { invocationState: {}, messages: [user('billing')] }))
      const result = await handler(context(agent, catalog, { invocationState: {}, messages: [user('thanks')] }))
      expect(names(result.toolSpecs)).toEqual(['billing_search'])
    })
  })

  describe('forced calls', () => {
    it('applies the stored selection so the prefix matches the previous call', async () => {
      const search = spySearch(['billing_search'])
      const withStructured = [...catalog, spec(STRUCTURED_OUTPUT_TOOL_NAME, 'Return structured output')]
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const invocationState: InvocationState = {}
      const first = await handler(context(agent, withStructured, { invocationState }))
      const forced = await handler(
        context(agent, withStructured, {
          invocationState,
          messages: [toolResultOnly()],
          toolChoice: { tool: { name: STRUCTURED_OUTPUT_TOOL_NAME } },
        })
      )
      expect(names(forced.toolSpecs)).toEqual(names(first.toolSpecs))
      expect(names(forced.toolSpecs)).toEqual(['billing_search', STRUCTURED_OUTPUT_TOOL_NAME])
      expect(search.search).toHaveBeenCalledTimes(1)
    })

    it('keeps the forced tool visible when the selection did not pick it', async () => {
      const search = createStaticToolSearch(['billing_search'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const result = await handler(context(agent, catalog, { toolChoice: { tool: { name: 'shipping_track' } } }))
      expect(names(result.toolSpecs)).toEqual(['billing_search', 'shipping_track'])
    })

    it('decides on a forced first call like any other', async () => {
      const search = spySearch(['billing_search'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const result = await handler(context(agent, catalog, { toolChoice: { any: {} } }))
      expect(names(result.toolSpecs)).toEqual(['billing_search'])
      expect(search.search).toHaveBeenCalledTimes(1)
    })

    it('keeps a forced tool visible even when it is in alwaysHide', async () => {
      const { agent, handler } = attach(toolSpecs('toolSpecs', { alwaysHide: ['ask_user', 'shipping_track'] }))
      const result = await handler(context(agent, catalog, { toolChoice: { tool: { name: 'ask_user' } } }))
      expect(names(result.toolSpecs)).toEqual(['billing_search', 'billing_summary', 'shipping_search', 'ask_user'])
    })
  })

  describe('bypass', () => {
    it('passes the catalog through when count is not met', async () => {
      const { agent, handler } = attach(
        toolSpecs('toolSpecs', { keep: 1 }).when({ count: 20 }) as HideToolSpecsStrategy
      )
      const input = context(agent, catalog)
      const result = await handler(input)
      expect(result).toBe(input)
    })

    it('keeps passing through when the catalog grows past count mid-invocation', async () => {
      const { agent, handler } = attach(toolSpecs('toolSpecs', { keep: 1 }).when({ count: 5 }) as HideToolSpecsStrategy)
      const invocationState: InvocationState = {}
      const small = catalog.slice(0, 4)
      await handler(context(agent, small, { invocationState }))
      const result = await handler(context(agent, catalog, { invocationState, messages: [toolResultOnly()] }))
      expect(names(result.toolSpecs)).toEqual(names(catalog))
    })

    it('shows specs that join the catalog after the selection was made', async () => {
      const search = createStaticToolSearch(['billing_search'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const invocationState: InvocationState = {}
      await handler(context(agent, catalog, { invocationState }))
      const grown = [...catalog, spec('loaded_later', 'Loaded by a tool')]
      const result = await handler(context(agent, grown, { invocationState, messages: [toolResultOnly()] }))
      expect(names(result.toolSpecs)).toEqual(['billing_search', 'loaded_later'])
    })

    it('counts eligible specs, not the whole catalog', async () => {
      const strategy = toolSpecs(['toolSpec::*', '!toolSpec::ask_user'], { keep: 1 }).when({ count: 5 })
      const { agent, handler } = attach(strategy as HideToolSpecsStrategy)
      const input = context(agent, catalog)
      const result = await handler(input)
      expect(result).toBe(input)
    })
  })

  describe('continuation turns', () => {
    it('carries the previous view forward without ranking', async () => {
      const search = vi.fn(async (query: string) => [
        { name: query.includes('flight') ? 'book_flight' : 'confirm_payment', score: 1 },
      ])
      const travel = [spec('book_flight', 'Book a flight'), spec('confirm_payment', 'Confirm a payment')]
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search: { search }, keep: 1 }))
      await handler(context(agent, travel, { invocationState: {}, messages: [user('book the flight')] }))
      const result = await handler(context(agent, travel, { invocationState: {}, messages: [user('yes, confirm')] }))
      expect(names(result.toolSpecs)).toEqual(['book_flight'])
      expect(search).toHaveBeenCalledTimes(1)
    })

    it('ranks an acknowledgement word when it comes with content words', async () => {
      const search = spySearch(['confirm_payment'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      await handler(context(agent, catalog, { invocationState: {}, messages: [user('billing')] }))
      await handler(context(agent, catalog, { invocationState: {}, messages: [user('confirm the payment')] }))
      expect(search.search).toHaveBeenCalledTimes(2)
    })

    it('ranks an acknowledgement-only first turn when there is nothing to carry', async () => {
      const search = spySearch([])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      await handler(context(agent, catalog, { invocationState: {}, messages: [user('ok go')] }))
      expect(search.search).toHaveBeenCalledTimes(1)
    })
  })

  describe('no matches', () => {
    it('carries the previous invocation selection forward', async () => {
      const search: ToolSearchStrategy = {
        search: async (query) => (query === 'billing' ? [{ name: 'billing_search', score: 1 }] : []),
      }
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      await handler(context(agent, catalog, { invocationState: {}, messages: [user('billing')] }))
      const result = await handler(context(agent, catalog, { invocationState: {}, messages: [user('thanks')] }))
      expect(names(result.toolSpecs)).toEqual(['billing_search'])
    })

    it('carries what the model last saw, including a fail-open turn', async () => {
      const search: ToolSearchStrategy = {
        search: async (query) => (query === 'billing' ? [{ name: 'billing_search', score: 1 }] : []),
      }
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      await handler(context(agent, catalog, { invocationState: {}, messages: [user('billing')] }))
      await handler(context(agent, catalog, { invocationState: {}, messages: [user('plane ticket to Paris')] }))
      const result = await handler(context(agent, catalog, { invocationState: {}, messages: [user('yes go ahead')] }))
      expect(names(result.toolSpecs)).toEqual(names(catalog))
    })

    it('carries a passed-through catalog forward as the full view', async () => {
      const search: ToolSearchStrategy = {
        search: async (query) => (query === 'billing' ? [{ name: 'billing_search', score: 1 }] : []),
      }
      const strategy = toolSpecs('toolSpecs', { search, keep: 1, onFailure: 'none' }).when({ count: 5 })
      const { agent, handler } = attach(strategy as HideToolSpecsStrategy)
      await handler(context(agent, catalog.slice(0, 4), { invocationState: {}, messages: [user('billing')] }))
      const result = await handler(context(agent, catalog, { invocationState: {}, messages: [user('ok thanks')] }))
      expect(names(result.toolSpecs)).toEqual(names(catalog.slice(0, 4)))
    })

    it('does not carry forward when the turn names a new topic', async () => {
      const search: ToolSearchStrategy = {
        search: async (query) => (query === 'billing' ? [{ name: 'billing_search', score: 1 }] : []),
      }
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      await handler(context(agent, catalog, { invocationState: {}, messages: [user('billing')] }))
      const followUp = context(agent, catalog, { invocationState: {}, messages: [user('where is my package?')] })
      const result = await handler(followUp)
      expect(names(result.toolSpecs)).toEqual(names(catalog))
    })

    it('shows every spec when there is nothing to carry forward', async () => {
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search: createStaticToolSearch([]), keep: 1 }))
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(names(catalog))
    })

    it('keeps carried selections separate per agent', async () => {
      const search: ToolSearchStrategy = {
        search: async (query) => (query === 'billing' ? [{ name: 'billing_search', score: 1 }] : []),
      }
      const strategy = toolSpecs('toolSpecs', { search, keep: 1 })
      const { agent: first, handler } = attach(strategy)
      const second = createMockAgent()
      await handler(context(first, catalog, { invocationState: {}, messages: [user('billing')] }))
      const result = await handler(context(second, catalog, { invocationState: {}, messages: [user('thanks')] }))
      expect(names(result.toolSpecs)).toEqual(names(catalog))
    })

    it('skips selection when nothing is eligible', async () => {
      const search = spySearch([])
      const { agent, handler } = attach(toolSpecs(['toolSpec::ghost'], { search }))
      const input = context(agent, catalog)
      const result = await handler(input)
      expect(result).toBe(input)
      expect(search.search).not.toHaveBeenCalled()
    })

    it('shows every spec when the carried selection is no longer in the catalog', async () => {
      const search: ToolSearchStrategy = {
        search: async (query) => (query === 'billing' ? [{ name: 'billing_search', score: 1 }] : []),
      }
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      await handler(context(agent, catalog, { invocationState: {}, messages: [user('billing')] }))
      const shrunk = catalog.filter((entry) => entry.name !== 'billing_search')
      const result = await handler(context(agent, shrunk, { invocationState: {}, messages: [user('thanks')] }))
      expect(names(result.toolSpecs)).toEqual(names(shrunk))
    })
  })

  describe('fail-open', () => {
    it('shows every eligible spec when search throws', async () => {
      const search: ToolSearchStrategy = {
        search: async () => {
          throw new Error('boom')
        },
      }
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(names(catalog))
    })

    it('ignores names that are not in the catalog', async () => {
      const search = createStaticToolSearch(['ghost', 'shipping_track'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const result = await handler(context(agent, catalog))
      expect(names(result.toolSpecs)).toEqual(['shipping_track'])
    })
  })

  describe('token projection', () => {
    const search = createStaticToolSearch(['billing_search'])

    it('subtracts the removed specs on a cold start', async () => {
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const model = countingModel(25)
      const result = await handler({ ...context(agent, catalog, { model }), projectedInputTokens: 1000 })
      expect(result.projectedInputTokens).toBe(900)
      expect(model.countTokens).toHaveBeenCalledWith([], {
        toolSpecs: catalog.filter((entry) => entry.name !== 'billing_search'),
      })
    })

    it('keeps the projection once an assistant message carries usage', async () => {
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const model = countingModel(25)
      const messages = [user('search the billing records'), assistantWithUsage(), toolResultOnly()]
      const result = await handler({ ...context(agent, catalog, { model, messages }), projectedInputTokens: 1000 })
      expect(result.projectedInputTokens).toBe(1000)
      expect(model.countTokens).not.toHaveBeenCalled()
    })

    it('recounts with the agent model, not the model the call was routed to', async () => {
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const routedModel = countingModel(1000)
      const input = {
        ...context(agent, catalog, { model: countingModel(25) }),
        model: routedModel,
        projectedInputTokens: 1000,
      }
      const result = await handler(input)
      expect(result.projectedInputTokens).toBe(900)
      expect(routedModel.countTokens).not.toHaveBeenCalled()
    })

    it('leaves the projection alone when nothing was hidden', async () => {
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search: createStaticToolSearch([]), keep: 1 }))
      const model = countingModel()
      const result = await handler({ ...context(agent, catalog, { model }), projectedInputTokens: 1000 })
      expect(result.projectedInputTokens).toBe(1000)
      expect(model.countTokens).not.toHaveBeenCalled()
    })

    it('does not add a projection when the loop supplied none', async () => {
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const result = await handler(context(agent, catalog))
      expect('projectedInputTokens' in result).toBe(false)
    })

    it('keeps the original projection when the recount throws', async () => {
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const model = {
        countTokens: vi.fn(async () => {
          throw new Error('count failed')
        }),
      } as unknown as InvokeModelContext['model']
      const result = await handler({ ...context(agent, catalog, { model }), projectedInputTokens: 1000 })
      expect(result.projectedInputTokens).toBe(1000)
    })
  })

  describe('invocation state', () => {
    it('clears the selection on AfterInvocationEvent', async () => {
      const search = spySearch(['billing_search'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const invocationState: InvocationState = {}
      await handler(context(agent, catalog, { invocationState }))
      await invokeTrackedHook(agent, new AfterInvocationEvent({ agent, invocationState }))
      await handler(context(agent, catalog, { invocationState }))
      expect(search.search).toHaveBeenCalledTimes(2)
    })

    it('clears the selection on BeforeInvocationEvent when the state object is reused', async () => {
      const search = spySearch(['billing_search'])
      const { agent, handler } = attach(toolSpecs('toolSpecs', { search, keep: 1 }))
      const invocationState: InvocationState = {}
      await handler(context(agent, catalog, { invocationState }))
      await invokeTrackedHook(agent, new BeforeInvocationEvent({ agent, invocationState }))
      await handler(context(agent, catalog, { invocationState }))
      expect(search.search).toHaveBeenCalledTimes(2)
    })

    it('leaves invocationState untouched', async () => {
      const { agent, handler } = attach(toolSpecs('toolSpecs', { keep: 1 }))
      const invocationState: InvocationState = {}
      await handler(context(agent, catalog, { invocationState }))
      expect(invocationState).toEqual({})
    })

    it('keeps separate state per strategy instance within one invocation', async () => {
      const first = toolSpecs('toolSpecs', { search: createStaticToolSearch(['billing_search']), keep: 1 })
      const second = toolSpecs('toolSpecs', {
        search: createStaticToolSearch(['shipping_track']),
        keep: 1,
      })
      const { agent, handler: firstHandler } = attach(first)
      const { handler: secondHandler } = attach(second)
      const invocationState: InvocationState = {}
      const fromFirst = await firstHandler(context(agent, catalog, { invocationState }))
      const fromSecond = await secondHandler(context(agent, catalog, { invocationState }))
      expect(names(fromFirst.toolSpecs)).toEqual(['billing_search'])
      expect(names(fromSecond.toolSpecs)).toEqual(['shipping_track'])
    })
  })
})

describe('KeywordToolSearch', () => {
  const weather = [
    spec('get_weather', 'Current conditions for a city', { city: { description: 'City name' } }),
    spec('city_guide', 'Weather-independent sightseeing tips'),
    spec('bookFlight', 'Book a flight to a destination'),
  ]
  const rank = async (query: string, limit = 10): Promise<string[]> =>
    (await KeywordToolSearch.search(query, weather, limit)).map((match) => match.name)

  it('splits snake_case names and weights name hits over description hits', async () => {
    expect(await rank('weather Paris')).toEqual(['get_weather', 'city_guide'])
  })

  it('splits camelCase names', async () => {
    expect(await rank('book a flight')).toEqual(['bookFlight'])
  })

  it('ranks a tool named verbatim in the query first', async () => {
    expect(await rank('run get_weather for Seattle', 1)).toEqual(['get_weather'])
    expect(await rank('call bookFlight now', 1)).toEqual(['bookFlight'])
  })

  it('matches CamelCase words in the query against whole descriptions', async () => {
    const specs = [
      spec('order_status', 'Look up the status of an order'),
      spec('dynamodb_query', 'Run a query against a DynamoDB table'),
      spec('github_search', 'Search GitHub repositories'),
      spec('youtube_search', 'Search YouTube videos'),
    ]
    const first = async (query: string): Promise<string[]> =>
      (await KeywordToolSearch.search(query, specs, 1)).map((match) => match.name)
    expect(await first('look up the order in DynamoDB')).toEqual(['order_status'])
    expect(await first('query the DynamoDB table')).toEqual(['dynamodb_query'])
    expect(await first('search GitHub')).toEqual(['github_search'])
  })

  it('splits acronym boundaries', async () => {
    const specs = [spec('parseHTTPBody', 'Parse a request body'), spec('other', 'Unrelated')]
    const results = await KeywordToolSearch.search('http body', specs, 10)
    expect(results.map((match) => match.name)).toEqual(['parseHTTPBody'])
  })

  it('matches input-property names and descriptions', async () => {
    expect(await rank('name')).toEqual(['get_weather'])
  })

  it('ignores stop words and single characters', async () => {
    expect(await rank('the a to')).toEqual([])
    expect(await rank('is it in the city')).toEqual(['city_guide', 'get_weather'])
  })

  it('breaks ties by candidate order', async () => {
    expect(await rank('tips conditions')).toEqual(['get_weather', 'city_guide'])
  })

  it('respects the limit', async () => {
    expect(await rank('city', 1)).toEqual(['city_guide'])
  })

  it('ranks any name hit above any number of description hits', async () => {
    const specs = [
      spec('crm_note', 'Send a weather note by email about the email weather'),
      spec('send_email', 'Deliver a message'),
    ]
    const results = await KeywordToolSearch.search('send weather email', specs, 10)
    expect(results.map((match) => match.name)).toEqual(['send_email', 'crm_note'])
  })

  it('normalizes plurals on both sides', async () => {
    const specs = [
      spec('refund_invoice', 'Refund an invoice'),
      spec('create_booking', 'Create a booking'),
      spec('search_flights', 'Search flights by route'),
      spec('run_query', 'Run a query'),
    ]
    const first = async (query: string): Promise<string | undefined> =>
      (await KeywordToolSearch.search(query, specs, 1))[0]?.name
    expect(await first('refunds for customer 42')).toBe('refund_invoice')
    expect(await first('show my bookings')).toBe('create_booking')
    expect(await first('book a flight')).toBe('search_flights')
    expect(await first('my saved queries')).toBe('run_query')
  })

  it('normalizes plurals of sibilant stems in both directions', async () => {
    const specs = [
      spec('list_processes', 'Lists running processes on the host'),
      spec('validate_address', 'Validate a postal address'),
      spec('list_classes', 'List the classes in a module'),
    ]
    const first = async (query: string): Promise<string | undefined> =>
      (await KeywordToolSearch.search(query, specs, 1))[0]?.name
    expect(await first('kill a process')).toBe('list_processes')
    expect(await first('check the addresses')).toBe('validate_address')
    expect(await first('show the class')).toBe('list_classes')
  })

  it('returns scores with higher meaning more relevant', async () => {
    const results = await KeywordToolSearch.search('weather', weather, 10)
    expect(results).toEqual([
      { name: 'get_weather', score: 1 },
      { name: 'city_guide', score: 0.5 },
    ])
  })
})
