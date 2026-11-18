import { afterEach, describe, expect, it, vi } from 'vitest'
import { DogwoodAuthorization } from '../dogwood.js'
import { Agent } from '../../../agent/agent.js'
import { AfterToolCallEvent, BeforeToolCallEvent } from '../../../hooks/events.js'
import { TextBlock, ToolResultBlock } from '../../../types/messages.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { resolve } from 'node:path'
import type { JSONValue } from '../../../types/json.js'
import type { ToolSpec } from '../../../tools/types.js'

const FIXTURES = resolve(import.meta.dirname!, 'fixtures')

const TOOLS: ToolSpec[] = [
  {
    name: 'search',
    description: 'Search for information',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'delete_file',
    description: 'Delete a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'http_request',
    description: 'Make an HTTP request',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'DELETE'] },
        url: { type: 'string' },
        retries: { type: 'number' },
      },
      required: ['method', 'url'],
    },
  },
]

/** An object parameter, which schema generation declares as an entity type of its own. */
const OBJECT_PARAMETER_TOOLS: ToolSpec[] = [
  {
    name: 'http_request',
    description: 'Make an HTTP request',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, headers: { type: 'object', properties: { auth: { type: 'string' } } } },
      required: ['url'],
    },
  },
]

const PERMIT_SEARCH = 'permit(principal, action == Action::"search", resource);'

/** The same permit, qualified for a hand-written schema that declares `namespace Drupe`. */
const PERMIT_SEARCH_NAMESPACED = 'permit(principal, action == Drupe::Action::"search", resource);'

/** Permits `search`, and `delete_file` only after a `search` has completed. */
const DELETE_AFTER_SEARCH = `
permit(principal, action == Action::"search", resource);
permit(principal, action == Action::"delete_file", resource)
when temporal { formerly within 1h Action::"search"::response{} };
`

const agent = new Agent()

function beforeEvent(
  name = 'search',
  options: { toolUseId?: string; input?: JSONValue; invocationState?: Record<string, unknown> } = {}
): BeforeToolCallEvent {
  return new BeforeToolCallEvent({
    agent,
    toolUse: {
      name,
      toolUseId: options.toolUseId ?? 'tool-1',
      input: options.input ?? { query: 'test' },
    },
    tool: undefined,
    invocationState: options.invocationState ?? {},
  })
}

function afterEvent(
  name = 'search',
  options: { toolUseId?: string; error?: Error; invocationState?: Record<string, unknown> } = {}
): AfterToolCallEvent {
  const toolUseId = options.toolUseId ?? 'tool-1'
  return new AfterToolCallEvent({
    agent,
    toolUse: { name, toolUseId, input: { query: 'test' } },
    tool: undefined,
    result: new ToolResultBlock({
      toolUseId,
      status: options.error ? 'error' : 'success',
      content: [new TextBlock('results')],
    }),
    invocationState: options.invocationState ?? {},
    ...(options.error !== undefined && { error: options.error }),
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

/** Whether `delete_file` is currently permitted, without disturbing the history. */
function deleteAllowed(dogwood: DogwoodAuthorization): boolean {
  const action = dogwood.beforeToolCall(beforeEvent('delete_file', { toolUseId: 'probe', input: { path: '/tmp/a' } }))
  return action.type === 'proceed'
}

describe('DogwoodAuthorization', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('configuration', () => {
    it('rejects configuring both a principal and a resolver', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: PERMIT_SEARCH,
            tools: TOOLS,
            principal: { type: 'User', id: 'alice' },
            principalResolver: () => undefined,
          })
      ).toThrow('not both')
    })

    it('rejects entities supplied without an action schema', () => {
      // A generated schema declares its entities bare, so an entity with attrs
      // fails conformance at decision time and denies every call.
      expect(
        () =>
          new DogwoodAuthorization({
            policies: PERMIT_SEARCH,
            tools: TOOLS,
            entities: [{ type: 'User', id: 'alice', attrs: { role: 'admin' } }],
          })
      ).toThrow('`entities` requires `actionSchema`')
    })

    it('accepts an empty entity list alongside a generated schema', () => {
      const dogwood = new DogwoodAuthorization({ policies: PERMIT_SEARCH, tools: TOOLS, entities: [] })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
    })

    it('rejects a namespace alongside a hand-written action schema', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: 'permit(principal, action, resource);',
            actionSchema: `${FIXTURES}/tools.cedarschema`,
            namespace: 'Acme',
          })
      ).toThrow('`namespace` applies to a generated schema')
    })

    // The reserved segments parse as identifiers and only fail once Cedar reads
    // the generated schema, so the guard has to name them itself.
    it.each(['my-ns', '', '9bad', 'Acme::', 'Acme Prod', 'if', 'has', '__cedar', 'Acme::in'])(
      'rejects the namespace %o',
      (namespace) => {
        expect(() => new DogwoodAuthorization({ policies: PERMIT_SEARCH, tools: TOOLS, namespace })).toThrow(
          'none of them reserved'
        )
      }
    )

    it('rejects a policy still naming the generated namespace when one is configured', () => {
      expect(
        () => new DogwoodAuthorization({ policies: PERMIT_SEARCH_NAMESPACED, tools: TOOLS, namespace: 'Acme' })
      ).toThrow('validation failed')
    })

    it('accepts the generated namespace named explicitly', () => {
      const dogwood = new DogwoodAuthorization({ policies: PERMIT_SEARCH_NAMESPACED, tools: TOOLS, namespace: 'Drupe' })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
    })

    it('rejects a config with neither an action schema nor tools', () => {
      expect(() => new DogwoodAuthorization({ policies: PERMIT_SEARCH })).toThrow(
        'Provide either `actionSchema` or `tools`'
      )
    })

    it('generates a schema from Tool instances as well as from specs', () => {
      const dogwood = new DogwoodAuthorization({
        policies: PERMIT_SEARCH,
        tools: [createMockTool('search', () => 'results')],
      })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
    })

    it('reads a policy from a .dw file on disk', () => {
      const dogwood = new DogwoodAuthorization({ policies: `${FIXTURES}/permit-search.dw`, tools: TOOLS })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
    })

    it('throws when a .dw path does not exist', () => {
      expect(() => new DogwoodAuthorization({ policies: `${FIXTURES}/missing.dw`, tools: TOOLS })).toThrow(
        'Dogwood .dw file not found'
      )
    })

    it('rejects a policy naming a tool the generated schema does not declare', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: 'permit(principal, action == Action::"not_a_tool", resource);',
            tools: TOOLS,
          })
      ).toThrow('unrecognized action')
    })

    it('rejects a misspelled action inside a temporal predicate', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: `permit(principal, action == Action::"delete_file", resource)
                       when temporal { formerly within 1h Action::"serach"::response{} };`,
            tools: TOOLS,
          })
      ).toThrow('Dogwood policy validation failed')
    })

    it('rejects a misspelled field inside a temporal predicate', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: `permit(principal, action == Action::"delete_file", resource)
                       when temporal { formerly within 1h Action::"search"::response{ input.qurey: "x" } };`,
            tools: TOOLS,
          })
      ).toThrow('Dogwood policy validation failed')
    })

    it('rejects a misspelled tool-input field', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: `${PERMIT_SEARCH.slice(0, -1)} when { context.input.qurey == "x" };`,
            tools: TOOLS,
          })
      ).toThrow('Dogwood policy validation failed')
    })

    it('rejects an enriched group when no enricher supplies it', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: `${PERMIT_SEARCH.slice(0, -1)} when { context.session.role == "admin" };`,
            tools: TOOLS,
          })
      ).toThrow('Dogwood policy validation failed')
    })

    it('accepts an enriched group a generated schema cannot declare', () => {
      const dogwood = new DogwoodAuthorization({
        policies: `${PERMIT_SEARCH.slice(0, -1)} when { context.session.role == "admin" };`,
        tools: TOOLS,
        contextEnricher: () => ({ role: 'admin' }),
      })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
    })

    it('still rejects an enriched group against a hand-written action schema', () => {
      // A hand-written schema can declare the group, so an undeclared one is a mistake.
      expect(
        () =>
          new DogwoodAuthorization({
            policies: `${PERMIT_SEARCH_NAMESPACED.slice(0, -1)} when { context.session.role == "admin" };`,
            actionSchema: `${FIXTURES}/tools.cedarschema`,
            contextEnricher: () => ({ role: 'admin' }),
          })
      ).toThrow('Dogwood policy validation failed')
    })

    it('accepts a condition comparing an enum parameter as the model emits it', () => {
      // An `enum` constraint generates as a plain `String`, so a string literal
      // is the form that both validates and matches.
      const dogwood = new DogwoodAuthorization({
        policies: `permit(principal, action == Action::"http_request", resource)
                   when { context.input.method == "GET" };`,
        tools: TOOLS,
      })

      const getInput = { method: 'GET', url: 'http://x' }
      const getDecision = dogwood.beforeToolCall(beforeEvent('http_request', { input: getInput }))
      const deleteDecision = dogwood.beforeToolCall(
        beforeEvent('http_request', { toolUseId: 'tool-2', input: { ...getInput, method: 'DELETE' } })
      )

      expect(getDecision).toEqual({ type: 'proceed' })
      expect(deleteDecision).toMatchObject({ type: 'deny' })
    })

    it('accepts a condition comparing a number parameter as the model emits it', () => {
      const dogwood = new DogwoodAuthorization({
        policies: `permit(principal, action == Action::"http_request", resource)
                   when { context has input.retries && context.input.retries == 2 };`,
        tools: TOOLS,
      })
      const input = { method: 'GET', url: 'http://x', retries: 2 }

      expect(dogwood.beforeToolCall(beforeEvent('http_request', { input }))).toEqual({ type: 'proceed' })
    })

    it('accepts an ordering comparison on a number parameter', () => {
      const dogwood = new DogwoodAuthorization({
        policies: `permit(principal, action == Action::"http_request", resource)
                   when { context has input.retries && context.input.retries > 2 };`,
        tools: TOOLS,
      })
      const input = { method: 'GET', url: 'http://x' }

      const many = dogwood.beforeToolCall(beforeEvent('http_request', { input: { ...input, retries: 5 } }))
      const few = dogwood.beforeToolCall(
        beforeEvent('http_request', { toolUseId: 'tool-2', input: { ...input, retries: 1 } })
      )

      expect(many).toEqual({ type: 'proceed' })
      expect(few).toMatchObject({ type: 'deny' })
    })

    it('accepts a set operator on an array-of-enum parameter', () => {
      const dogwood = new DogwoodAuthorization({
        policies: `permit(principal, action == Action::"tag", resource)
                   when { !context.input.tags.containsAny(["secret"]) };`,
        tools: [
          {
            name: 'tag',
            description: 'Tag a record',
            inputSchema: {
              type: 'object',
              properties: { tags: { type: 'array', items: { type: 'string', enum: ['public', 'secret'] } } },
              required: ['tags'],
            },
          },
        ],
      })

      const open = dogwood.beforeToolCall(beforeEvent('tag', { input: { tags: ['public'] } }))
      const closed = dogwood.beforeToolCall(beforeEvent('tag', { toolUseId: 'tool-2', input: { tags: ['secret'] } }))

      expect(open).toEqual({ type: 'proceed' })
      expect(closed).toMatchObject({ type: 'deny' })
    })

    it('rejects a condition whose types mismatch for any other reason', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: `permit(principal, action == Action::"http_request", resource)
                       when { context.input.url == 3 };`,
            tools: TOOLS,
          })
      ).toThrow('Dogwood policy validation failed')
    })

    it('rejects a wrong-type comparison against an enum or number parameter', () => {
      const construct = (condition: string): DogwoodAuthorization =>
        new DogwoodAuthorization({
          policies: `permit(principal, action == Action::"http_request", resource)
                     when { ${condition} };`,
          tools: TOOLS,
        })

      expect(() => construct('context.input.method == 5')).toThrow('Dogwood policy validation failed')
      expect(() => construct('context has input.retries && context.input.retries == "3"')).toThrow(
        'Dogwood policy validation failed'
      )
    })

    it('rejects reading an optional parameter without a `has` guard', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: `permit(principal, action == Action::"http_request", resource)
                       when { context.input.retries == 2 };`,
            tools: TOOLS,
          })
      ).toThrow('Dogwood policy validation failed')
    })

    it('generates the schema under a configured namespace', () => {
      const dogwood = new DogwoodAuthorization({
        policies: `
          permit(principal == Acme::User::"anonymous", action == Acme::Action::"search",
                 resource == Acme::Resource::"agent")
          when { context.input.query == "test" };

          permit(principal, action == Acme::Action::"delete_file", resource)
          when temporal { formerly within 1h Acme::Action::"search"::response{} };
        `,
        tools: TOOLS,
        namespace: 'Acme',
      })

      // The derived principal and resource follow the namespace, and a temporal
      // predicate under it still matches the history.
      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
      expect(deleteAllowed(dogwood)).toBe(false)
      dogwood.afterToolCall(afterEvent())
      expect(deleteAllowed(dogwood)).toBe(true)
    })

    it('generates the schema under a nested namespace', () => {
      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action == Acme::Prod::Action::"search", resource);',
        tools: TOOLS,
        namespace: 'Acme::Prod',
      })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
    })

    // An object parameter is generated as its own entity type and referenced
    // qualified, so the namespace rewrite has to move those references too or
    // the schema fails to resolve them.
    it.each<[string, string | undefined]>([
      ['', undefined],
      ['Acme::', 'Acme'],
      ['Drupe::', 'Drupe'],
      ['Acme::Prod::', 'Acme::Prod'],
    ])('generates a schema for an object parameter under the %o prefix', (prefix, namespace) => {
      const dogwood = new DogwoodAuthorization({
        policies: `permit(principal, action == ${prefix}Action::"http_request", resource)
                   when { context has input.headers && context.input.headers has auth };`,
        tools: OBJECT_PARAMETER_TOOLS,
        ...(namespace === undefined ? {} : { namespace }),
      })

      const authed = dogwood.beforeToolCall(
        beforeEvent('http_request', { input: { url: 'http://x', headers: { auth: 'token' } } })
      )
      const anonymous = dogwood.beforeToolCall(
        beforeEvent('http_request', { toolUseId: 'tool-2', input: { url: 'http://x' } })
      )

      expect(authed).toEqual({ type: 'proceed' })
      expect(anonymous).toMatchObject({ type: 'deny' })
    })

    // Renaming the generator's resource entity must not touch a tool that
    // carries the same word in its own name, or the action it declares becomes
    // unreachable and no rule can ever apply to it.
    it('decides a tool named after the entity the generated schema renames', () => {
      const dogwood = new DogwoodAuthorization({
        policies: `permit(principal, action == Action::"Gateway_admin", resource == Resource::"agent");
                   forbid(principal, action == Action::"Gateway_admin", resource)
                   when { context.input.Gateway == "root" };`,
        tools: [
          {
            name: 'Gateway_admin',
            description: 'Administer the gateway',
            inputSchema: { type: 'object', properties: { Gateway: { type: 'string' } }, required: ['Gateway'] },
          },
        ],
      })

      const permitted = dogwood.beforeToolCall(beforeEvent('Gateway_admin', { input: { Gateway: 'staging' } }))
      const forbidden = dogwood.beforeToolCall(
        beforeEvent('Gateway_admin', { toolUseId: 'tool-2', input: { Gateway: 'root' } })
      )

      expect(permitted).toEqual({ type: 'proceed' })
      expect(forbidden).toMatchObject({ type: 'deny' })
    })

    // An undeclared principal type passes validation and allows the call,
    // because a rule scoping the principal just never matches.
    it('rejects a static principal of a type the generated schema does not declare', () => {
      expect(
        () =>
          new DogwoodAuthorization({ policies: PERMIT_SEARCH, tools: TOOLS, principal: { type: 'Admin', id: 'alice' } })
      ).toThrow('`principal` must be of type `User`, got `Admin`')
    })

    it('rejects an unqualified static principal under a configured namespace', () => {
      expect(
        () =>
          new DogwoodAuthorization({
            policies: 'permit(principal, action == Acme::Action::"search", resource);',
            tools: TOOLS,
            namespace: 'Acme',
            principal: { type: 'User', id: 'alice' },
          })
      ).toThrow('`principal` must be of type `Acme::User`, got `User`')
    })

    it('accepts a static principal of any type a hand-written action schema may declare', () => {
      const dogwood = new DogwoodAuthorization({
        policies: PERMIT_SEARCH_NAMESPACED,
        actionSchema: `${FIXTURES}/tools.cedarschema`,
        principal: { type: 'Drupe::User', id: 'alice' },
      })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
    })

    it('reads an action schema from a .cedarschema file on disk', () => {
      const dogwood = new DogwoodAuthorization({
        policies: PERMIT_SEARCH_NAMESPACED,
        actionSchema: `${FIXTURES}/tools.cedarschema`,
      })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
    })
  })

  describe('verdicts', () => {
    it('proceeds when the policy permits the tool', () => {
      const dogwood = new DogwoodAuthorization({ policies: PERMIT_SEARCH, tools: TOOLS })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
    })

    it('denies a tool no permit covers, without naming a rule', () => {
      const dogwood = new DogwoodAuthorization({ policies: PERMIT_SEARCH, tools: TOOLS })

      expect(dogwood.beforeToolCall(beforeEvent('delete_file', { input: { path: '/tmp/a' } }))).toEqual({
        type: 'deny',
        reason: 'Access denied by Dogwood policy',
      })
    })

    it('names the determining rule when an explicit forbid denies', () => {
      const dogwood = new DogwoodAuthorization({
        policies: `${PERMIT_SEARCH}\nforbid(principal, action == Action::"search", resource);`,
        tools: TOOLS,
      })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({
        type: 'deny',
        reason: 'Access denied by Dogwood policy (rule 1)',
      })
    })

    it('denies a tool the action schema does not declare', () => {
      const dogwood = new DogwoodAuthorization({ policies: PERMIT_SEARCH, tools: TOOLS })

      expect(dogwood.beforeToolCall(beforeEvent('delete_everything'))).toEqual({
        type: 'deny',
        reason: "Tool 'delete_everything' is not declared by the Dogwood action schema; denying",
      })
    })

    it('denies when a principal resolver yields no identity', () => {
      const dogwood = new DogwoodAuthorization({
        policies: PERMIT_SEARCH,
        tools: TOOLS,
        principalResolver: () => undefined,
      })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({
        type: 'deny',
        reason: 'No principal identity found in invocation state',
      })
    })

    it('decides against the principal the resolver returns', () => {
      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal == User::"alice", action == Action::"search", resource);',
        tools: TOOLS,
        principalResolver: (state) => (state.userId ? { type: 'User', id: String(state.userId) } : undefined),
      })

      expect(dogwood.beforeToolCall(beforeEvent('search', { invocationState: { userId: 'alice' } }))).toEqual({
        type: 'proceed',
      })
      expect(
        dogwood.beforeToolCall(beforeEvent('search', { toolUseId: 'tool-2', invocationState: { userId: 'bob' } }))
      ).toEqual({ type: 'deny', reason: 'Access denied by Dogwood policy' })
    })

    it('denies when a principal resolver returns an undeclared entity type', () => {
      const dogwood = new DogwoodAuthorization({
        policies: PERMIT_SEARCH,
        tools: TOOLS,
        principalResolver: (state) => ({ type: String(state.kind), id: 'mallory' }),
      })

      expect(dogwood.beforeToolCall(beforeEvent('search', { invocationState: { kind: 'Admin' } }))).toEqual({
        type: 'deny',
        reason: "Principal type 'Admin' is not declared by the Dogwood action schema; denying",
      })
    })

    it('decides against the fields the context enricher adds', () => {
      const dogwood = new DogwoodAuthorization({
        policies: `${PERMIT_SEARCH.slice(0, -1)} when { context.session.role == "admin" };`,
        tools: TOOLS,
        contextEnricher: ({ invocationState }) => ({ role: String(invocationState.role) }),
      })

      expect(dogwood.beforeToolCall(beforeEvent('search', { invocationState: { role: 'admin' } }))).toEqual({
        type: 'proceed',
      })
      expect(
        dogwood.beforeToolCall(beforeEvent('search', { toolUseId: 'tool-2', invocationState: { role: 'viewer' } }))
      ).toEqual({ type: 'deny', reason: 'Access denied by Dogwood policy' })
    })

    it('decides only once for a tool-use id, so a resumed interrupt is not counted twice', () => {
      let enrichCount = 0
      const dogwood = new DogwoodAuthorization({
        policies: PERMIT_SEARCH,
        tools: TOOLS,
        contextEnricher: () => {
          enrichCount += 1
          return {}
        },
      })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })

      expect(enrichCount).toBe(1)
    })
  })

  describe('fail-closed behavior', () => {
    it('reports an evaluation error as the cause rather than as a policy decision', () => {
      // The policy reads a group no enricher supplies, so evaluation errors out.
      const dogwood = new DogwoodAuthorization({
        policies: `${PERMIT_SEARCH.slice(0, -1)} when { context.session.role == "admin" };`,
        tools: TOOLS,
        contextEnricher: () => ({}),
      })

      const action = dogwood.beforeToolCall(beforeEvent())

      expect(action.type).toBe('deny')
      expect(action).toMatchObject({ reason: expect.stringContaining('Dogwood evaluation failed') })
    })

    it('denies rather than throwing when model-supplied tool input is not a valid event', () => {
      const dogwood = new DogwoodAuthorization({ policies: PERMIT_SEARCH, tools: TOOLS })

      // `__decimal` is a tagged form the model can emit; its value must be a string.
      const action = dogwood.beforeToolCall(beforeEvent('search', { input: { query: { __decimal: 1.5 } } }))

      expect(action.type).toBe('deny')
      expect(action).toMatchObject({ reason: expect.stringContaining('Dogwood could not decide') })
    })

    it('stays usable after a malformed event is rejected', () => {
      const dogwood = new DogwoodAuthorization({ policies: PERMIT_SEARCH, tools: TOOLS })

      dogwood.beforeToolCall(beforeEvent('search', { input: { query: { __decimal: 1.5 } } }))

      expect(dogwood.beforeToolCall(beforeEvent('search', { toolUseId: 'tool-2' }))).toEqual({ type: 'proceed' })
    })
  })

  describe('temporal history', () => {
    it('unlocks a temporally gated tool once a response is recorded', () => {
      const dogwood = new DogwoodAuthorization({ policies: DELETE_AFTER_SEARCH, tools: TOOLS })

      expect(deleteAllowed(dogwood)).toBe(false)
      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
      expect(dogwood.afterToolCall(afterEvent())).toEqual({ type: 'proceed' })
      expect(deleteAllowed(dogwood)).toBe(true)
    })

    it('records a thrown tool failure as an error event, not a response', () => {
      const dogwood = new DogwoodAuthorization({
        policies: `
permit(principal, action == Action::"search", resource);
forbid(principal, action == Action::"search", resource)
when temporal { formerly within 1h Action::"search"::error{} };
`,
        tools: TOOLS,
      })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
      dogwood.afterToolCall(afterEvent('search', { error: new Error('tool exploded') }))

      expect(dogwood.beforeToolCall(beforeEvent('search', { toolUseId: 'tool-2' }))).toMatchObject({ type: 'deny' })
    })

    it('does not record a result for a call it denied', () => {
      const dogwood = new DogwoodAuthorization({
        policies: `
forbid(principal, action == Action::"search", resource);
permit(principal, action == Action::"search", resource);
permit(principal, action == Action::"delete_file", resource)
when temporal { formerly within 1h Action::"search"::response{} };
`,
        tools: TOOLS,
      })

      expect(dogwood.beforeToolCall(beforeEvent())).toMatchObject({ type: 'deny' })
      dogwood.afterToolCall(cancelledEvent())

      expect(deleteAllowed(dogwood)).toBe(false)
    })

    it('does not record a result for a call a later handler blocked', () => {
      const dogwood = new DogwoodAuthorization({ policies: DELETE_AFTER_SEARCH, tools: TOOLS })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
      dogwood.afterToolCall(cancelledEvent())

      expect(deleteAllowed(dogwood)).toBe(false)
    })

    it('does not record a result it never authorized', () => {
      const dogwood = new DogwoodAuthorization({ policies: DELETE_AFTER_SEARCH, tools: TOOLS })

      dogwood.afterToolCall(afterEvent())

      expect(deleteAllowed(dogwood)).toBe(false)
    })

    it('skips a result whose tool name does not match the allowed call', () => {
      const dogwood = new DogwoodAuthorization({ policies: DELETE_AFTER_SEARCH, tools: TOOLS })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
      // Same tool-use id under another tool, so this is not that call's result.
      expect(dogwood.afterToolCall(afterEvent('delete_everything'))).toEqual({ type: 'proceed' })

      expect(deleteAllowed(dogwood)).toBe(false)
    })

    it('decides a tool-use id reused by a different tool on its own terms', () => {
      const dogwood = new DogwoodAuthorization({ policies: PERMIT_SEARCH, tools: TOOLS })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
      // An abandoned interrupt leaves its allow behind; reusing the id for
      // another tool must not ride on it.
      expect(dogwood.beforeToolCall(beforeEvent('delete_file', { input: { path: '/tmp/a' } }))).toMatchObject({
        type: 'deny',
      })
    })

    it('records a result without consulting the resolver or enricher again', () => {
      let resolveCount = 0
      let enrichCount = 0
      const dogwood = new DogwoodAuthorization({
        policies: DELETE_AFTER_SEARCH,
        tools: TOOLS,
        principalResolver: (state) => {
          resolveCount += 1
          return { type: 'User', id: String(state.userId) }
        },
        contextEnricher: () => {
          enrichCount += 1
          return {}
        },
      })
      const asAlice = { invocationState: { userId: 'alice' } }

      dogwood.beforeToolCall(beforeEvent('search', asAlice))
      dogwood.afterToolCall(afterEvent('search', asAlice))

      expect({ resolveCount, enrichCount }).toEqual({ resolveCount: 1, enrichCount: 1 })
      // Recorded under the principal the request was decided for, not a re-resolved one.
      const deleteAsAlice = dogwood.beforeToolCall(
        beforeEvent('delete_file', { toolUseId: 'd-1', input: { path: '/a' }, ...asAlice })
      )

      expect(deleteAsAlice).toEqual({ type: 'proceed' })
    })

    it('correlates a temporal predicate on a recorded tool-input field', () => {
      const dogwood = new DogwoodAuthorization({
        policies: `
permit(principal, action == Action::"search", resource);
permit(principal, action == Action::"delete_file", resource)
when temporal { formerly within 1h Action::"search"::response{ input.query: "audit" } };
`,
        tools: TOOLS,
      })

      dogwood.beforeToolCall(beforeEvent('search', { input: { query: 'unrelated' } }))
      dogwood.afterToolCall(afterEvent())
      expect(deleteAllowed(dogwood)).toBe(false)
    })

    it('keeps one principal history from unlocking another principal', () => {
      // The default event schema pins every predicate to the deciding principal.
      const dogwood = new DogwoodAuthorization({
        policies: DELETE_AFTER_SEARCH,
        tools: TOOLS,
        principalResolver: (state) => ({ type: 'User', id: String(state.userId) }),
      })
      const asUser = (userId: string) => ({ invocationState: { userId } })

      dogwood.beforeToolCall(beforeEvent('search', asUser('alice')))
      dogwood.afterToolCall(afterEvent('search', asUser('alice')))

      const alice = dogwood.beforeToolCall(
        beforeEvent('delete_file', { toolUseId: 'd-1', input: { path: '/a' }, ...asUser('alice') })
      )
      const bob = dogwood.beforeToolCall(
        beforeEvent('delete_file', { toolUseId: 'd-2', input: { path: '/a' }, ...asUser('bob') })
      )

      expect(alice).toEqual({ type: 'proceed' })
      expect(bob).toMatchObject({ type: 'deny' })
    })

    it('records a result even when the system clock steps backwards', () => {
      vi.useFakeTimers()
      vi.setSystemTime(5_000_000)
      const dogwood = new DogwoodAuthorization({ policies: DELETE_AFTER_SEARCH, tools: TOOLS })

      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
      // The authorizer rejects an event dated before the previous one.
      vi.setSystemTime(4_000_000)
      dogwood.afterToolCall(afterEvent())

      expect(deleteAllowed(dogwood)).toBe(true)
    })
  })

  describe('reset', () => {
    it('drops accumulated history and keeps deciding', () => {
      const dogwood = new DogwoodAuthorization({ policies: DELETE_AFTER_SEARCH, tools: TOOLS })

      dogwood.beforeToolCall(beforeEvent())
      dogwood.afterToolCall(afterEvent())
      expect(deleteAllowed(dogwood)).toBe(true)

      dogwood.reset()

      expect(deleteAllowed(dogwood)).toBe(false)
      expect(dogwood.beforeToolCall(beforeEvent())).toEqual({ type: 'proceed' })
    })

    it('drops an in-flight call so its response misses the new history', () => {
      const dogwood = new DogwoodAuthorization({ policies: DELETE_AFTER_SEARCH, tools: TOOLS })

      dogwood.beforeToolCall(beforeEvent())
      dogwood.reset()
      dogwood.afterToolCall(afterEvent())

      expect(deleteAllowed(dogwood)).toBe(false)
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
      const dogwood = new DogwoodAuthorization({ policies: DELETE_AFTER_SEARCH, tools: TOOLS })
      const { agent: testAgent, toolRan } = searchAgent(dogwood)

      const result = await testAgent.invoke('Search')

      expect(result.stopReason).toBe('endTurn')
      expect(toolRan()).toBe(true)
      expect(deleteAllowed(dogwood)).toBe(true)
    })

    it('blocks a forbidden tool and records nothing after it', async () => {
      const dogwood = new DogwoodAuthorization({
        policies: 'permit(principal, action == Action::"delete_file", resource);',
        tools: TOOLS,
      })
      const { agent: testAgent, toolRan } = searchAgent(dogwood)

      await testAgent.invoke('Search')

      expect(toolRan()).toBe(false)
    })

    it('denies the tool call when a resolver throws and onError is deny', async () => {
      const dogwood = new DogwoodAuthorization({
        policies: PERMIT_SEARCH,
        tools: TOOLS,
        principalResolver: () => {
          throw new Error('identity lookup failed')
        },
        onError: 'deny',
      })
      const { agent: testAgent, toolRan } = searchAgent(dogwood)

      await testAgent.invoke('Search')

      expect(toolRan()).toBe(false)
    })
  })
})
