import { describe, expect, it } from 'vitest'
import { DogwoodAuthorization } from '../dogwood.js'
import { Agent } from '../../../agent/agent.js'
import { AfterToolCallEvent, BeforeToolCallEvent } from '../../../hooks/events.js'
import { TextBlock, ToolResultBlock } from '../../../types/messages.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { resolve } from 'node:path'
import type { DogwoodAuthorizerInstance, DogwoodDecision, DogwoodEventInput, DogwoodModule } from '../module.js'

const FIXTURES = resolve(import.meta.dirname!, 'fixtures')

const ACTIONS = ['Drupe::Action::CallTool', 'Drupe::Action::Mcp', 'Drupe::Action::search']
const KINDS = ['error', 'request', 'response']
const POLICY = 'permit(principal, action == Drupe::Action::"search", resource);'
const TOOLS = [{ name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }]

interface StubOptions {
  /** Verdict overrides per decision event, in order. Defaults to allowing everything. */
  decisions?: Array<Partial<DogwoodDecision>>
  /** Actions the action schema declares. Defaults to {@link ACTIONS}. */
  actions?: string[]
  /** Kinds the event schema declares. Defaults to {@link KINDS}. */
  kinds?: string[]
  /** Return no decision even for a request event. */
  noVerdict?: boolean
}

interface Stub {
  module: DogwoodModule
  /** Every event the authorizer was fed, in order. */
  events: DogwoodEventInput[]
  /** Makes the next and all later `isAuthorized` calls throw, or stops them throwing. */
  throwOnDecide(error: Error | undefined): void
  resetCount(): number
  freeCount(): number
}

/**
 * A `DogwoodModule` that records the events it is fed, so the handler's event
 * mapping and verdict handling can be asserted without the wasm package present.
 */
function stubModule(options: StubOptions = {}): Stub {
  const events: DogwoodEventInput[] = []
  let decisionIndex = 0
  let resetCount = 0
  let freeCount = 0
  let lastTimestamp: number | undefined
  let thrown: Error | undefined

  class StubAuthorizer implements DogwoodAuthorizerInstance {
    isAuthorized(event: DogwoodEventInput): DogwoodDecision | undefined {
      if (thrown) throw thrown
      events.push(event)
      lastTimestamp = event.timestamp
      if (event.kind !== 'request' || options.noVerdict) return undefined
      const decision: DogwoodDecision = {
        index: decisionIndex,
        timestamp: event.timestamp ?? 0,
        verdict: 'allow',
        allowed: true,
        determining_rules: [0],
        errors: [],
        ...options.decisions?.[decisionIndex],
      }
      decisionIndex += 1
      return decision
    }

    reset(): void {
      resetCount += 1
    }

    free(): void {
      freeCount += 1
    }

    get actions(): string[] {
      return options.actions ?? ACTIONS
    }

    get eventKinds(): string[] {
      return options.kinds ?? KINDS
    }

    get decisionKinds(): string[] {
      return ['request']
    }

    get decisionCount(): number {
      return decisionIndex
    }

    get lastTimestamp(): number | undefined {
      return lastTimestamp
    }
  }

  return {
    module: {
      DogwoodAuthorizer: StubAuthorizer,
      mcpToCedarSchema: () => 'namespace Drupe { entity User; entity Gateway; }',
    },
    events,
    throwOnDecide: (error) => {
      thrown = error
    },
    resetCount: () => resetCount,
    freeCount: () => freeCount,
  }
}

const agent = new Agent()

function beforeEvent(name = 'search', invocationState: Record<string, unknown> = {}): BeforeToolCallEvent {
  return new BeforeToolCallEvent({
    agent,
    toolUse: { name, toolUseId: 'tool-1', input: { query: 'test' } },
    tool: undefined,
    invocationState,
  })
}

function afterEvent(name = 'search', error?: Error): AfterToolCallEvent {
  return new AfterToolCallEvent({
    agent,
    toolUse: { name, toolUseId: 'tool-1', input: { query: 'test' } },
    tool: undefined,
    result: new ToolResultBlock({
      toolUseId: 'tool-1',
      status: error ? 'error' : 'success',
      content: [new TextBlock('results')],
    }),
    invocationState: {},
    ...(error !== undefined && { error }),
  })
}

/** What the executor yields when a hook cancelled the call: an error status, no `Error`. */
function cancelledEvent(name = 'search'): AfterToolCallEvent {
  return new AfterToolCallEvent({
    agent,
    toolUse: { name, toolUseId: 'tool-1', input: { query: 'test' } },
    tool: undefined,
    result: new ToolResultBlock({
      toolUseId: 'tool-1',
      status: 'error',
      content: [new TextBlock('Tool cancelled by hook')],
    }),
    invocationState: {},
  })
}

describe('DogwoodAuthorization', () => {
  describe('configuration', () => {
    it('rejects configuring both a principal and a resolver', () => {
      const stub = stubModule()
      expect(
        () =>
          new DogwoodAuthorization({
            policy: POLICY,
            tools: TOOLS,
            module: stub.module,
            principal: { type: 'Drupe::User', id: 'alice' },
            principalResolver: () => undefined,
          })
      ).toThrow('not both')
    })

    it('rejects a config with neither an action schema nor tools', () => {
      const stub = stubModule()
      expect(() => new DogwoodAuthorization({ policy: POLICY, module: stub.module })).toThrow(
        'Provide either `actionSchema` or `tools`'
      )
    })

    it('points at create() when no module is supplied', () => {
      expect(() => new DogwoodAuthorization({ policy: POLICY, tools: TOOLS })).toThrow('DogwoodAuthorization.create()')
    })

    it('builds via create() without importing the package when a module is supplied', async () => {
      const stub = stubModule()
      const dogwood = await DogwoodAuthorization.create({ policy: POLICY, tools: TOOLS, module: stub.module })

      expect(dogwood.name).toBe('dogwood-authorization')
      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
    })

    it('reads a policy from a .dw file on disk', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({
        policy: `${FIXTURES}/permit-search.dw`,
        tools: TOOLS,
        module: stub.module,
      })

      expect(dogwood.actions).toEqual(ACTIONS)
    })

    it('throws when a .dw path does not exist', () => {
      const stub = stubModule()
      expect(
        () => new DogwoodAuthorization({ policy: `${FIXTURES}/missing.dw`, tools: TOOLS, module: stub.module })
      ).toThrow('Dogwood .dw file not found')
    })
  })

  describe('request events', () => {
    it('maps a tool call onto a namespaced request event with input in both halves', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module, now: () => 1000 })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
      expect(stub.events[0]).toEqual({
        action: 'Drupe::Action::search',
        kind: 'request',
        timestamp: 1000,
        principal: { type: 'Drupe::User', id: 'anonymous' },
        resource: { type: 'Drupe::Gateway', id: 'agent' },
        logged: { input: { query: 'test' } },
        context: { input: { query: 'test' } },
        entities: [],
      })
    })

    it('honors a configured namespace, principal, and resource', () => {
      const stub = stubModule({ actions: ['Acme::Action::search'] })
      const dogwood = new DogwoodAuthorization({
        policy: POLICY,
        tools: TOOLS,
        module: stub.module,
        namespace: 'Acme',
        principal: { type: 'Acme::Operator', id: 'alice' },
        resource: { type: 'Acme::Bus', id: 'prod' },
      })

      dogwood.beforeToolCall(beforeEvent())

      expect(stub.events[0]).toMatchObject({
        action: 'Acme::Action::search',
        principal: { type: 'Acme::Operator', id: 'alice' },
        resource: { type: 'Acme::Bus', id: 'prod' },
      })
    })

    it('resolves the principal from invocation state', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({
        policy: POLICY,
        tools: TOOLS,
        module: stub.module,
        principalResolver: (state) => (state.userId ? { type: 'Drupe::User', id: String(state.userId) } : undefined),
      })

      dogwood.beforeToolCall(beforeEvent('search', { userId: 'alice' }))

      expect(stub.events[0]?.principal).toEqual({ type: 'Drupe::User', id: 'alice' })
    })

    it('adds enricher groups to each half, letting the handler input group win', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({
        policy: POLICY,
        tools: TOOLS,
        module: stub.module,
        eventEnricher: ({ invocationState }) => ({
          logged: { session: { id: String(invocationState.sessionId) } },
          context: { session: { id: String(invocationState.sessionId) }, input: { query: 'ignored' } },
        }),
      })

      dogwood.beforeToolCall(beforeEvent('search', { sessionId: 's-1' }))

      expect(stub.events[0]?.logged).toEqual({ session: { id: 's-1' }, input: { query: 'test' } })
      expect(stub.events[0]?.context).toEqual({ session: { id: 's-1' }, input: { query: 'test' } })
    })
  })

  describe('verdicts', () => {
    it('proceeds when the policy allows', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
    })

    it('denies with the determining rules when the policy forbids', () => {
      const stub = stubModule({ decisions: [{ verdict: 'deny', allowed: false, determining_rules: [2, 3] }] })
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({
        type: 'deny',
        reason: 'Access denied by Dogwood policy (rule 2, 3)',
      })
    })

    it('denies without naming a rule on an implicit deny', () => {
      const stub = stubModule({ decisions: [{ verdict: 'deny', allowed: false, determining_rules: [] }] })
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({
        type: 'deny',
        reason: 'Access denied by Dogwood policy',
      })
    })

    it('denies a tool the action schema does not declare, without calling the authorizer', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      const action = dogwood.beforeToolCall(beforeEvent('delete_everything'))

      expect(action).toEqual({
        type: 'deny',
        reason: "Tool 'delete_everything' is not declared by the Dogwood action schema; denying",
      })
      expect(stub.events).toEqual([])
    })

    it('denies when a principal resolver yields no identity', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({
        policy: POLICY,
        tools: TOOLS,
        module: stub.module,
        principalResolver: () => undefined,
      })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({
        type: 'deny',
        reason: 'No principal identity found in invocation state',
      })
    })
  })

  describe('fail-closed behavior', () => {
    it('reports an evaluation error as the cause rather than as a policy decision', () => {
      const stub = stubModule({
        decisions: [
          { verdict: 'deny', allowed: false, determining_rules: [], errors: ['type error: expected string, got long'] },
        ],
      })
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({
        type: 'deny',
        reason: 'Dogwood evaluation failed: type error: expected string, got long',
      })
    })

    it('denies when a request event unexpectedly yields no verdict', () => {
      const stub = stubModule({ noVerdict: true })
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({
        type: 'deny',
        reason: "No Dogwood decision returned for 'search'; denying",
      })
    })

    it('denies on a wasm trap and stays denied for every later call', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      stub.throwOnDecide(new WebAssembly.RuntimeError('unreachable'))
      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({
        type: 'deny',
        reason: 'Dogwood evaluation trapped the wasm module; denying',
      })

      // The module is shared process-wide, so recovery is not assumed even once
      // calls stop throwing.
      stub.throwOnDecide(undefined)
      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({
        type: 'deny',
        reason: 'Dogwood module is unusable after a wasm trap; denying',
      })
      expect(stub.events).toEqual([])
    })

    it('rethrows a non-trap error so the registry applies onError', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      stub.throwOnDecide(new Error('unknown action'))

      expect(() => dogwood.beforeToolCall(beforeEvent())).toThrow('unknown action')
    })
  })

  describe('temporal history', () => {
    it('records a history-only response event after a successful tool call', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module, now: () => 1000 })

      dogwood.beforeToolCall(beforeEvent())
      expect(dogwood.afterToolCall(afterEvent())).toEqual({ type: 'proceed' })

      expect(stub.events.map((event) => event.kind)).toEqual(['request', 'response'])
      expect(stub.events[1]).toMatchObject({
        action: 'Drupe::Action::search',
        kind: 'response',
        logged: { input: { query: 'test' }, output: {} },
        context: { input: { query: 'test' }, output: {} },
      })
    })

    it('records an error event when the tool failed', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      dogwood.beforeToolCall(beforeEvent())
      dogwood.afterToolCall(afterEvent('search', new Error('tool exploded')))

      expect(stub.events.map((event) => event.kind)).toEqual(['request', 'error'])
    })

    it('does not record responses when disabled', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({
        policy: POLICY,
        tools: TOOLS,
        module: stub.module,
        recordResponses: false,
      })

      dogwood.beforeToolCall(beforeEvent())
      dogwood.afterToolCall(afterEvent())

      expect(stub.events.map((event) => event.kind)).toEqual(['request'])
    })

    it('skips recording a kind the event schema does not declare', () => {
      const stub = stubModule({ kinds: ['request'] })
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      dogwood.beforeToolCall(beforeEvent())
      dogwood.afterToolCall(afterEvent())

      expect(stub.events.map((event) => event.kind)).toEqual(['request'])
    })

    it('skips recording a response for an undeclared tool', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      dogwood.beforeToolCall(beforeEvent())
      // Same tool-use id, but a hook renamed the tool to one the schema omits.
      dogwood.afterToolCall(afterEvent('delete_everything'))

      expect(stub.events.map((event) => event.kind)).toEqual(['request'])
    })

    it('does not record a result for a call it denied', () => {
      const stub = stubModule({ decisions: [{ verdict: 'deny', allowed: false, determining_rules: [1] }] })
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      dogwood.beforeToolCall(beforeEvent())
      dogwood.afterToolCall(cancelledEvent())

      expect(stub.events.map((event) => event.kind)).toEqual(['request'])
    })

    it('does not record a result for a call a later handler blocked', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
      dogwood.afterToolCall(cancelledEvent())

      expect(stub.events.map((event) => event.kind)).toEqual(['request'])
    })

    it('does not record a result it never authorized', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      dogwood.afterToolCall(afterEvent())

      expect(stub.events).toEqual([])
    })

    it('never sends a timestamp earlier than the last event, even if the clock steps back', () => {
      const stub = stubModule()
      const clock = [5000, 4000]
      let tick = 0
      const dogwood = new DogwoodAuthorization({
        policy: POLICY,
        tools: TOOLS,
        module: stub.module,
        now: () => clock[Math.min(tick++, clock.length - 1)]!,
      })

      dogwood.beforeToolCall(beforeEvent())
      dogwood.afterToolCall(afterEvent())

      expect(stub.events.map((event) => event.timestamp)).toEqual([5000, 5000])
    })

    it('counts the decisions it has made', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      dogwood.beforeToolCall(beforeEvent())
      dogwood.afterToolCall(afterEvent())
      dogwood.beforeToolCall(beforeEvent())

      // Only request events advance the count; a recorded response does not.
      expect(dogwood.decisionCount).toBe(2)
    })
  })

  describe('lifecycle', () => {
    it('forwards reset to the authorizer and keeps deciding', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      dogwood.reset()

      expect(stub.resetCount()).toBe(1)
      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
    })

    it('denies after being freed', () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })

      dogwood.free()

      expect(stub.freeCount()).toBe(1)
      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({
        type: 'deny',
        reason: 'Dogwood module is unusable after a wasm trap; denying',
      })
    })

    it('frees at the end of a using scope', () => {
      const stub = stubModule()
      {
        using dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })
        expect(dogwood.actions).toEqual(ACTIONS)
      }
      expect(stub.freeCount()).toBe(1)
    })
  })

  describe('agent integration', () => {
    function searchAgent(dogwood: DogwoodAuthorization): { agent: Agent; toolRan: () => boolean } {
      let toolRan = false
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'search', toolUseId: 'tool-1', input: { query: 'test' } })
        .addTurn({ type: 'textBlock', text: 'Done' })
      const tool = createMockTool('search', () => {
        toolRan = true
        return 'results'
      })
      return {
        agent: new Agent({ model, tools: [tool], interventions: [dogwood], printer: false }),
        toolRan: () => toolRan,
      }
    }

    it('runs a permitted tool and records its response', async () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })
      const { agent: testAgent, toolRan } = searchAgent(dogwood)

      const result = await testAgent.invoke('Search')

      expect(result.stopReason).toBe('endTurn')
      expect(toolRan()).toBe(true)
      expect(stub.events.map((event) => event.kind)).toEqual(['request', 'response'])
    })

    it('blocks a forbidden tool and records nothing after it', async () => {
      const stub = stubModule({ decisions: [{ verdict: 'deny', allowed: false, determining_rules: [1] }] })
      const dogwood = new DogwoodAuthorization({ policy: POLICY, tools: TOOLS, module: stub.module })
      const { agent: testAgent, toolRan } = searchAgent(dogwood)

      await testAgent.invoke('Search')

      expect(toolRan()).toBe(false)
      expect(stub.events.map((event) => event.kind)).toEqual(['request'])
    })

    it('denies the tool call when onError is deny and the handler throws', async () => {
      const stub = stubModule()
      const dogwood = new DogwoodAuthorization({
        policy: POLICY,
        tools: TOOLS,
        module: stub.module,
        onError: 'deny',
      })
      stub.throwOnDecide(new Error('lowering failed'))
      const { agent: testAgent, toolRan } = searchAgent(dogwood)

      await testAgent.invoke('Search')

      expect(toolRan()).toBe(false)
    })
  })
})
