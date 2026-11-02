import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AXIS_DESCRIPTIONS,
  UNSET,
  AgentSpec,
  Choice,
  Fixed,
  Inherit,
  Open,
  Option,
  Preset,
  _resolveSpecs,
  _toSchemaProperties,
  _defaultBuilder,
} from '../spec.js'
import type { ResolveSpecAxes } from '../spec.js'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { logger } from '../../logging/logger.js'
import type { Sandbox } from '../../sandbox/base.js'
import { McpClient } from '../../mcp/client.js'
import { McpTool } from '../../tools/mcp-tool.js'
import { InterventionHandler } from '../../interventions/handler.js'
import type { InterventionAction } from '../../interventions/actions.js'

const AXES: ResolveSpecAxes = {
  presets: {},
  defaultPreset: undefined,
  instructions: new Open(),
  tools: new Choice(['read', 'shell'], true),
  model: new Inherit(),
}

function resolveOne(modelInput: Record<string, unknown>, axes: ResolveSpecAxes): AgentSpec {
  return _resolveSpecs([{ name: 'a', ...modelInput }], axes)[0]!
}

describe('Choice', () => {
  describe('normalized', () => {
    it('wraps strings and fills UNSET', () => {
      const sentinel = { tag: 'sentinel' }
      const c = new Choice([new Option('alias', sentinel, 'd'), new Option('bare'), 'raw'])
      const opts = c.normalized()
      expect(opts).toHaveLength(3)
      expect(opts[0]!.value).not.toBe(UNSET)
      expect(opts[0]!.value).toBe(sentinel)
      expect(opts[0]!.description).toBe('d')
      expect(opts[1]!.value).toBe('bare') // UNSET filled from name
      expect(opts[2]!.name).toBe('raw')
      expect(opts[2]!.value).toBe('raw')
    })

    it('does not overwrite an explicit null value', () => {
      // null is the TS equivalent of Python's None — a legitimate value, distinct from UNSET.
      expect(new Choice([new Option('off', null)]).normalized()[0]!.value).toBeNull()
    })
  })

  describe('valueFor', () => {
    it('returns mapped value for known option and passthrough for unknown', () => {
      const c = new Choice([new Option('alias', 'real')])
      expect(c.valueFor('alias')).toBe('real')
      expect(c.valueFor('missing')).toBe('missing')
    })
  })
})

describe('_toSchemaProperties', () => {
  it('renders model-visible axes and an agent_type choice over the presets', () => {
    const properties = _toSchemaProperties({
      presets: { g: new Preset({ description: 'general', tools: ['a'] }) },
      defaultPreset: 'g',
      instructions: new Open(),
      tools: new Choice(['a'], true),
      model: new Fixed('x'),
    })
    expect(properties).toEqual({
      agent_type: {
        type: 'string',
        enum: ['g'],
        description: `${AXIS_DESCRIPTIONS.agent_type} Omit to use the default ('g').\nOptions:\n- g: general (sets tools: a)`,
      },
      instructions: { type: 'string', description: AXIS_DESCRIPTIONS.instructions },
      tools: { type: 'array', items: { type: 'string', enum: ['a'] }, description: AXIS_DESCRIPTIONS.tools },
    })
    // No presets → no agent_type; omitted axes are hidden.
    expect(_toSchemaProperties({ presets: {}, defaultPreset: undefined })).toEqual({})
  })

  it.each([
    [{ tools: new Choice([]) }, /offers no options/],
    [{ tools: new Choice(['read', 'shell']) }, /must set multiple to true/],
    [{ instructions: new Choice([]) }, /offers no options/],
    [{ model: new Choice([]) }, /offers no options/],
  ])('rejects invalid choice %#', (axis, message) => {
    expect(() => _toSchemaProperties({ ...AXES, ...axis })).toThrow(message)
  })
})

describe('_resolveSpecs', () => {
  it.each([
    ['abc', /must be an array/],
    [['not an object'], /must be an object/],
    [[{}], /non-empty 'name'/],
    [[{ name: '  ' }], /non-empty 'name'/],
    [[{ name: 'a' }, { name: ' a ' }], /Duplicate/],
  ])('rejects invalid input %j', (inputs, message) => {
    expect(() => _resolveSpecs(inputs, AXES)).toThrow(message)
  })

  it('reuses a preset across agents and clamps its tools to the Choice set', () => {
    const axes: ResolveSpecAxes = {
      ...AXES,
      presets: { w: new Preset({ tools: ['read', 'write'] }) },
      defaultPreset: 'w',
    }
    const specs = _resolveSpecs([{ name: 'a', agent_type: 'w' }, { name: ' b ' }], axes)
    expect(specs).toEqual([
      new AgentSpec({ name: 'a', agentType: 'w', tools: ['read'] }),
      new AgentSpec({ name: 'b', agentType: 'w', tools: ['read'] }),
    ])
    // Without a Choice to clamp to, preset tools pass through unchanged.
    expect(resolveOne({}, { ...axes, tools: new Inherit() }).tools).toEqual(['read', 'write'])
  })

  it('applies preset by default', () => {
    const axes: ResolveSpecAxes = {
      ...AXES,
      presets: { g: new Preset({ instructions: 'help' }) },
      defaultPreset: 'g',
    }
    expect(resolveOne({ task: 'x' }, axes)).toEqual(
      new AgentSpec({
        name: 'a',
        agentType: 'g',
        instructions: 'help',
        tools: ['read', 'shell'],
      })
    )
  })

  it('throws on unknown agent_type', () => {
    const axes: ResolveSpecAxes = { ...AXES, presets: { g: new Preset() }, defaultPreset: 'g' }
    expect(() => resolveOne({ task: 'x', agent_type: 'nope' }, axes)).toThrow(/Unknown agent_type/)
  })

  it('rejects prototype keys, null, and non-string agent_type values', () => {
    const axes: ResolveSpecAxes = { ...AXES, presets: { g: new Preset() }, defaultPreset: 'g' }
    for (const bad of ['constructor', 'toString', '__proto__', ['g']]) {
      expect(() => resolveOne({ task: 'x', agent_type: bad }, axes)).toThrow(/Unknown agent_type/)
    }
    // null falls back to default preset instead of throwing
    expect(resolveOne({ task: 'x', agent_type: null }, axes)).toEqual(
      new AgentSpec({ name: 'a', agentType: 'g', tools: ['read', 'shell'] })
    )
  })

  it('suppresses default preset when ad-hoc instructions provided', () => {
    const axes: ResolveSpecAxes = {
      ...AXES,
      presets: { g: new Preset({ instructions: 'default' }) },
      defaultPreset: 'g',
    }
    expect(resolveOne({ task: 'x', instructions: 'ad-hoc' }, axes)).toEqual(
      new AgentSpec({ name: 'a', instructions: 'ad-hoc', tools: ['read', 'shell'] })
    )
  })

  it('clamps tools to allowed set', () => {
    expect(resolveOne({ task: 'x', tools: ['read', 'write'] }, AXES)).toEqual(
      new AgentSpec({ name: 'a', tools: ['read'] })
    )
  })

  it('Fixed ignores model-supplied value', () => {
    const axes: ResolveSpecAxes = { ...AXES, instructions: new Fixed('pinned') }
    expect(resolveOne({ task: 'x', instructions: 'override' }, axes)).toEqual(
      new AgentSpec({ name: 'a', instructions: 'pinned', tools: ['read', 'shell'] })
    )
  })

  it('Choice maps option value', () => {
    const sentinel = { tag: 'model-sentinel' }
    const axes: ResolveSpecAxes = { ...AXES, model: new Choice([new Option('smart', sentinel)]) }
    expect(resolveOne({ task: 'x', model: 'smart' }, axes).model).toBe(sentinel)
  })

  it('resolves Fixed tools list', () => {
    const axes: ResolveSpecAxes = { ...AXES, tools: new Fixed(['a', 'b']) }
    expect(resolveOne({ task: 'x' }, axes)).toEqual(new AgentSpec({ name: 'a', tools: ['a', 'b'] }))
  })

  it('resolves Fixed([]) to empty array, not undefined', () => {
    const axes: ResolveSpecAxes = { ...AXES, tools: new Fixed([]) }
    expect(resolveOne({ task: 'x' }, axes)).toEqual(new AgentSpec({ name: 'a', tools: [] }))
  })
})

describe('Fixed', () => {
  it('is frozen', () => {
    const f = new Fixed('x')
    expect(() => {
      ;(f as { value: unknown }).value = 'y'
    }).toThrow()
  })
})

describe('_defaultBuilder', () => {
  const model = new MockMessageModel()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    [undefined, ['read', 'gh_issue']],
    [['gh_issue'], ['gh_issue']],
  ])('selects MCP tools by name like any other parent tool (tools=%j)', (tools, expected) => {
    const client = new McpClient({ applicationName: 'server', url: 'https://example.invalid/mcp' })
    const mcpTool = new McpTool({ name: 'gh_issue', description: 'Open an issue.', inputSchema: {}, client })
    const parent = new Agent({ model, tools: [createMockTool('read', () => 'ok'), mcpTool], printer: false })

    const child = _defaultBuilder(parent)(new AgentSpec(tools === undefined ? {} : { tools }))

    expect(child.toolRegistry.list().map((tool) => tool.name)).toEqual(expected)
    expect(child.toolRegistry.get('gh_issue')).toBe(mcpTool)
  })

  it('builds a child Agent that inherits the parent model and takes spec.name as its name and id', () => {
    const parent = new Agent({ model, printer: false })
    const child = _defaultBuilder(parent)(new AgentSpec({ name: 'worker' }))
    expect(child).toBeInstanceOf(Agent)
    expect(child.model).toBe(model)
    expect(child.name).toBe('worker')
    expect(child.id).toBe('worker')
  })

  it('inherits all parent tools when spec.tools is undefined', () => {
    const readTool = createMockTool('read', () => 'ok')
    const shellTool = createMockTool('shell', () => 'ok')
    const parent = new Agent({ model, tools: [readTool, shellTool], printer: false })

    const childToolNames = _defaultBuilder(parent)(new AgentSpec({}))
      .toolRegistry.list()
      .map((tool) => tool.name)

    expect(childToolNames).toEqual(['read', 'shell'])
  })

  it('resolves only matching tools and warns about unknown tools', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const readTool = createMockTool('read', () => 'ok')
    const shellTool = createMockTool('shell', () => 'ok')
    const parent = new Agent({ model, tools: [readTool, shellTool], printer: false })

    const childToolNames = _defaultBuilder(parent)(new AgentSpec({ tools: ['read', 'nonexistent'] }))
      .toolRegistry.list()
      .map((tool) => tool.name)

    expect(childToolNames).toEqual(['read'])
    expect(warn.mock.calls).toEqual([
      ['tool_name=<nonexistent> | subagent requested tool but parent does not own it, skipping'],
    ])
  })

  it("does not inherit the parent's context manager tools", async () => {
    const readTool = createMockTool('read', () => 'ok')
    const parent = new Agent({ model, tools: [readTool], printer: false, contextManager: 'auto' })
    await parent.initialize()

    const child = _defaultBuilder(parent)(new AgentSpec({}))
    await child.initialize()

    const parentRetrieve = parent.toolRegistry.list().find((tool) => tool.name === 'retrieve_context')
    expect(parentRetrieve).toBeDefined()
    expect(child.toolRegistry.list().map((tool) => tool.name)).toEqual(['read', 'retrieve_context'])
    expect(child.toolRegistry.list()).not.toContain(parentRetrieve)
  })

  it.each([
    ['gives the child an auto context manager for a stateless model', model, true],
    [
      'skips the context manager for a stateful model',
      Object.defineProperty(new MockMessageModel(), 'stateful', { value: true }),
      false,
    ],
  ])('%s', (_, parentModel, hasContextManager) => {
    const parent = new Agent({ model: parentModel, printer: false })
    expect(_defaultBuilder(parent)(new AgentSpec({})).contextManager !== undefined).toBe(hasContextManager)
  })

  it.each([true, false])(
    "propagates the parent's sandbox, trace attributes, and printer setting (printer=%s)",
    (printer) => {
      const sandbox = {} as unknown as Sandbox
      const parent = new Agent({ model, printer, sandbox, traceAttributes: { team: 'infra' } })

      const child = _defaultBuilder(parent)(new AgentSpec({}))

      expect(child.sandbox).toBe(sandbox)
      const internals = child as unknown as { _printer?: unknown; _tracer: { _traceAttributes: unknown } }
      expect(internals._tracer._traceAttributes).toEqual({ team: 'infra' })
      expect(internals._printer !== undefined).toBe(printer)
    }
  )

  class DenyToolCalls extends InterventionHandler {
    readonly name = 'deny-tool-calls'

    override beforeToolCall(): InterventionAction {
      return { type: 'deny', reason: 'not authorized' }
    }
  }

  it("shares the parent's intervention handler instances", () => {
    const handler = new DenyToolCalls()
    const parent = new Agent({ model, printer: false, interventions: [handler] })

    const child = _defaultBuilder(parent)(new AgentSpec({}))

    const internals = child as unknown as { _interventionRegistry: { handlers: readonly InterventionHandler[] } }
    expect(internals._interventionRegistry.handlers).toEqual([handler])
  })

  it("gates an inherited tool with the parent's interventions when the child's model calls it", async () => {
    const dangerTool = vi.fn(() => 'done')
    const childModel = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'dangerTool', toolUseId: 't1', input: {} })
      .addTurn({ type: 'textBlock', text: 'finished' })
    const parent = new Agent({
      model,
      printer: false,
      tools: [createMockTool('dangerTool', dangerTool)],
      interventions: [new DenyToolCalls()],
    })

    const child = _defaultBuilder(parent)(new AgentSpec({ model: childModel }))
    await child.invoke('run dangerTool')

    expect(dangerTool).not.toHaveBeenCalled()
  })
})
