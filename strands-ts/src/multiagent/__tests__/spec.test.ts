import { describe, expect, it } from 'vitest'
import {
  UNSET,
  AgentSpec,
  Choice,
  Fixed,
  Inherit,
  Open,
  Option,
  Preset,
  _resolveSpec,
  _defaultBuilder,
} from '../spec.js'
import type { ResolveSpecAxes } from '../spec.js'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'

const AXES: ResolveSpecAxes = {
  presets: {},
  defaultPreset: undefined,
  instructions: new Open(),
  tools: new Choice(['read', 'shell'], true),
  mcpServers: new Inherit(),
  model: new Inherit(),
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

  describe('toSchemaProperty', () => {
    it('produces single enum and array enum', () => {
      expect(new Choice(['a', 'b']).toSchemaProperty()).toEqual({ type: 'string', enum: ['a', 'b'] })
      const prop = new Choice(['a'], true).toSchemaProperty('desc')
      expect(prop['type']).toBe('array')
      expect(prop['description']).toBe('desc')
    })

    it('folds option descriptions', () => {
      const prop = new Choice([new Option('x', UNSET, 'info'), 'y']).toSchemaProperty()
      expect(prop['description']).toContain('- x: info')
      expect(prop['description']).not.toContain('y:')
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

describe('_resolveSpec', () => {
  it('applies preset by default', () => {
    const axes: ResolveSpecAxes = {
      ...AXES,
      presets: { g: new Preset({ instructions: 'help' }) },
      defaultPreset: 'g',
    }
    expect(_resolveSpec({ task: 'x' }, axes)).toEqual(
      new AgentSpec({
        agentType: 'g',
        instructions: 'help',
        tools: ['read', 'shell'],
      })
    )
  })

  it('throws on unknown agent_type', () => {
    const axes: ResolveSpecAxes = { ...AXES, presets: { g: new Preset() }, defaultPreset: 'g' }
    expect(() => _resolveSpec({ task: 'x', agent_type: 'nope' }, axes)).toThrow(/Unknown agent_type/)
  })

  it('rejects prototype keys, null, and non-string agent_type values', () => {
    const axes: ResolveSpecAxes = { ...AXES, presets: { g: new Preset() }, defaultPreset: 'g' }
    for (const bad of ['constructor', 'toString', '__proto__', ['g']]) {
      expect(() => _resolveSpec({ task: 'x', agent_type: bad }, axes)).toThrow(/Unknown agent_type/)
    }
    // null falls back to default preset instead of throwing
    expect(_resolveSpec({ task: 'x', agent_type: null }, axes)).toEqual(
      new AgentSpec({ agentType: 'g', tools: ['read', 'shell'] })
    )
  })

  it('suppresses default preset when ad-hoc instructions provided', () => {
    const axes: ResolveSpecAxes = {
      ...AXES,
      presets: { g: new Preset({ instructions: 'default' }) },
      defaultPreset: 'g',
    }
    expect(_resolveSpec({ task: 'x', instructions: 'ad-hoc' }, axes)).toEqual(
      new AgentSpec({ instructions: 'ad-hoc', tools: ['read', 'shell'] })
    )
  })

  it('clamps tools to allowed set', () => {
    expect(_resolveSpec({ task: 'x', tools: ['read', 'write'] }, AXES)).toEqual(new AgentSpec({ tools: ['read'] }))
  })

  it('Fixed ignores model-supplied value', () => {
    const axes: ResolveSpecAxes = { ...AXES, instructions: new Fixed('pinned') }
    expect(_resolveSpec({ task: 'x', instructions: 'override' }, axes)).toEqual(
      new AgentSpec({ instructions: 'pinned', tools: ['read', 'shell'] })
    )
  })

  it('Choice maps option value', () => {
    const sentinel = { tag: 'model-sentinel' }
    const axes: ResolveSpecAxes = { ...AXES, model: new Choice([new Option('smart', sentinel)]) }
    expect(_resolveSpec({ task: 'x', model: 'smart' }, axes).model).toBe(sentinel)
  })

  it('clamps preset tools to Choice set', () => {
    const axes: ResolveSpecAxes = {
      ...AXES,
      presets: { worker: new Preset({ tools: ['read', 'write'] }) },
      defaultPreset: 'worker',
      tools: new Choice(['read', 'shell'], true),
    }
    expect(_resolveSpec({ task: 'x' }, axes)).toEqual(new AgentSpec({ agentType: 'worker', tools: ['read'] }))
  })

  it('resolves Fixed tools list', () => {
    const axes: ResolveSpecAxes = { ...AXES, tools: new Fixed(['a', 'b']) }
    expect(_resolveSpec({ task: 'x' }, axes)).toEqual(new AgentSpec({ tools: ['a', 'b'] }))
  })

  it('resolves Fixed([]) to empty array, not undefined', () => {
    const axes: ResolveSpecAxes = { ...AXES, mcpServers: new Fixed([]) }
    expect(_resolveSpec({ task: 'x' }, axes)).toEqual(new AgentSpec({ tools: ['read', 'shell'], mcpServers: [] }))
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

  it('builds a child Agent that inherits the parent model and forwards spec.name', () => {
    const parent = new Agent({ model, printer: false })
    const child = _defaultBuilder(parent)(new AgentSpec({ name: 'worker' }))
    expect(child).toBeInstanceOf(Agent)
    expect(child.model).toBe(model)
    expect(child.name).toBe('worker')
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

  it('resolves only matching tools and silently skips unknown names', () => {
    const readTool = createMockTool('read', () => 'ok')
    const shellTool = createMockTool('shell', () => 'ok')
    const parent = new Agent({ model, tools: [readTool, shellTool], printer: false })

    const childToolNames = _defaultBuilder(parent)(new AgentSpec({ tools: ['read', 'nonexistent'] }))
      .toolRegistry.list()
      .map((tool) => tool.name)

    expect(childToolNames).toEqual(['read'])
  })
})
