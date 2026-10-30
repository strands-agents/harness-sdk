import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SWARM_DESCRIPTION, DEFAULT_SWARM_MAX_AGENTS, makeSwarm, swarm } from '../index.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { MockSnapshotStorage } from '../../../__fixtures__/mock-storage-provider.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { collectGenerator } from '../../../__fixtures__/model-test-helpers.js'
import { Interrupt, InterruptError, InterruptState } from '../../../interrupt.js'
import { logger } from '../../../logging/logger.js'
import { Fixed, Preset } from '../../../multiagent/spec.js'
import { MultiAgentState, Status } from '../../../multiagent/state.js'
import type { AgentSpec } from '../../../multiagent/spec.js'
import { SessionManager } from '../../../session/session-manager.js'
import type { Tool, ToolContext } from '../../../tools/tool.js'
import { InterruptResponseContent } from '../../../types/interrupt.js'
import type { JSONValue } from '../../../types/json.js'
import { serializeStateSerializable } from '../../../types/serializable.js'
import { limitStopMessage, TextBlock, ToolResultBlock } from '../../../types/messages.js'

/** Model whose turns hand off (or finish) through the swarm's structured output tool. */
function handoffModel(...handoffs: { agentId?: string; message: string }[]): MockMessageModel {
  const model = new MockMessageModel()
  for (const [index, handoff] of handoffs.entries()) {
    model.addTurn({
      type: 'toolUseBlock',
      name: 'strands_structured_output',
      toolUseId: `so-${index}`,
      input: handoff as JSONValue,
    })
  }
  return model
}

function run(
  tool: Tool,
  input: JSONValue,
  agent: Agent = new Agent({ model: new MockMessageModel(), printer: false })
) {
  const context = {
    toolUse: { name: tool.name, toolUseId: 't1', input },
    agent,
    invocationState: {},
    cancelSignal: new AbortController().signal,
  } as unknown as ToolContext
  return collectGenerator(tool.stream(context))
}

function interruptState(agent: Agent): InterruptState {
  return (agent as unknown as { _interruptState: InterruptState })._interruptState
}

function storedTurns(agent: Agent): Record<string, JSONValue> {
  return (interruptState(agent).context['subAgentInterruptedTurns'] ?? {}) as Record<string, JSONValue>
}

function errorResult(text: string | RegExp): unknown {
  return expect.objectContaining({
    status: 'error',
    content: [expect.objectContaining({ text: expect.stringMatching(text) })],
  })
}

describe('swarm tool', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('tool metadata', () => {
    it('exposes the default name, description, and agent cap', () => {
      expect(swarm.name).toBe('swarm')
      expect(swarm.toolSpec.description).toBe(DEFAULT_SWARM_DESCRIPTION)
      expect(swarm.toolSpec.inputSchema).toMatchObject({
        required: ['task', 'agents'],
        properties: { agents: { minItems: 1, maxItems: DEFAULT_SWARM_MAX_AGENTS } },
      })
      expect(makeSwarm({ name: 'team' }).name).toBe('team')
    })

    it.each([
      [{}, ['name', 'instructions']],
      [{ presets: { w: new Preset() } }, ['name']],
      [{ instructions: new Fixed('x') }, ['name']],
    ])('requires instructions only without a fallback (%#)', (options, required) => {
      expect(makeSwarm(options).toolSpec.inputSchema).toMatchObject({
        properties: { agents: { items: { required } } },
      })
    })

    it('wires presets and maxAgents into the schema, defaulting to the first preset', () => {
      const tool = makeSwarm({
        maxAgents: 3,
        presets: { writer: new Preset({ description: 'Writes.' }), editor: new Preset() },
      })
      expect(tool.toolSpec.inputSchema).toMatchObject({
        properties: {
          agents: {
            maxItems: 3,
            items: {
              properties: {
                agent_type: {
                  enum: ['writer', 'editor'],
                  description: expect.stringContaining("Omit to use the default ('writer')."),
                },
              },
            },
          },
        },
      })
    })
  })

  describe('factory validation', () => {
    it.each([
      [{ maxAgents: 0 }, 'maxAgents must be a positive integer (>= 1).'],
      [{ maxAgents: 1.5 }, 'maxAgents must be a positive integer (>= 1).'],
      [{ name: '' }, 'name must be a non-empty string.'],
      [{ description: '' }, 'description must be a non-empty string.'],
      [{ presets: { w: new Preset() }, defaultPreset: 'x' }, "defaultPreset 'x' is not one of the presets: w."],
    ])('rejects invalid options %#', (options, message) => {
      expect(() => makeSwarm(options)).toThrow(message)
    })
  })

  describe('execution', () => {
    it.each([
      [{ agents: [{ name: 'a', instructions: 'Do.' }] }, /Missing required parameter 'task'/],
      [{ task: 't', agents: [] }, /Between 1 and 2 agents required, got 0/],
      [{ task: 't', agents: ['a', 'b', 'c'].map((name) => ({ name })) }, /Between 1 and 2 agents required, got 3/],
      [{ task: 't', agents: [{ name: 'a' }], entry_point: 'z' }, /entry_point "z" does not match any agent name/],
      [{ task: 't', agents: [{ name: 'a' }, { name: 'a' }] }, /Error: Duplicate agent name "a"/],
    ])('returns an error result for invalid input %#', async (input, message) => {
      const { result } = await run(makeSwarm({ maxAgents: 2 }), input as JSONValue)
      expect(result).toEqual(errorResult(message))
    })

    it.each([undefined, 'b'])(
      'builds agents from resolved specs, strips every swarm tool, and starts at entry_point=%s',
      async (entryPoint) => {
        const specs: AgentSpec[] = []
        const agents: Agent[] = []
        const keep = createMockTool('keep', () => 'ok')
        const builder = (spec: AgentSpec): Agent => {
          specs.push(spec)
          const agent = new Agent({
            model: handoffModel({ message: `${spec.name} done` }),
            printer: false,
            id: spec.name!,
            tools: [custom, swarm, makeSwarm({ name: 'other' }), keep],
          })
          agents.push(agent)
          return agent
        }
        const custom = makeSwarm({ name: 'team', builder, instructions: new Fixed('Locked.') })

        const { result } = await run(custom, {
          task: 't',
          agents: [{ name: 'a' }, { name: 'b' }],
          ...(entryPoint && { entry_point: entryPoint }),
        })

        expect(specs.map((spec) => [spec.name, spec.instructions])).toEqual([
          ['a', 'Locked.'],
          ['b', 'Locked.'],
        ])
        for (const agent of agents) {
          expect(agent.toolRegistry.list().map((tool) => tool.name)).toEqual(['keep'])
        }
        expect(result).toEqual(
          new ToolResultBlock({
            toolUseId: 't1',
            status: 'success',
            content: [new TextBlock(`${entryPoint ?? 'a'}: ${entryPoint ?? 'a'} done`)],
          })
        )
      }
    )

    it.each([
      [
        'maxSteps',
        { maxSteps: 1 },
        /^Error: Swarm stopped before completing \(max_steps=<1> \| swarm reached step limit\)\. Partial output:\na: to b$/,
      ],
      [
        'the default step limit',
        {},
        /^Error: Swarm stopped before completing \(max_steps=<20> \| swarm reached step limit\)\. Partial output:\na: to b\nb: to a$/,
      ],
      [
        'repetitive handoff detection',
        { repetitiveHandoffDetectionWindow: 3, repetitiveHandoffMinUniqueAgents: 3 },
        /^Error: Swarm stopped before completing \(status=FAILED: Repetitive handoff.*\)\. Partial output:\na: to b\nb: to a$/,
      ],
    ])('applies %s to the swarm', async (_, limits, message) => {
      // a and b hand off to each other indefinitely; c never runs.
      const builder = (spec: AgentSpec): Agent => {
        const target = spec.name === 'a' ? 'b' : 'a'
        const handoff = { agentId: target, message: `to ${target}` }
        return new Agent({ model: handoffModel(...Array(10).fill(handoff)), printer: false, id: spec.name! })
      }
      const tool = makeSwarm({ builder, instructions: new Fixed('x'), ...limits })
      const { result } = await run(tool, { task: 't', agents: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] })
      expect(result).toEqual(errorResult(message))
    })
  })

  describe('with real agents', () => {
    it("runs a swarm built from the parent and returns the agent's text when the handoff message is empty", async () => {
      // Agents inherit the parent's model, so turns are consumed in order across all agents.
      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'swarm',
          toolUseId: 'p1',
          input: { task: 'go', agents: [{ name: 'a', instructions: 'Do.' }] },
        })
        .addTurn([
          { type: 'textBlock', text: 'Done!' },
          { type: 'toolUseBlock', name: 'strands_structured_output', toolUseId: 'c1', input: { message: '' } },
        ])
        .addTurn({ type: 'textBlock', text: 'parent final' })
      const parent = new Agent({ model, tools: [swarm], printer: false })

      const result = await parent.invoke('start')

      expect(result.toString()).toBe('parent final')
      expect(parent.messages[2]!.content).toEqual([
        new ToolResultBlock({ toolUseId: 'p1', status: 'success', content: [new TextBlock('a: Done!')] }),
      ])
    })

    it("counts the swarm's turns toward the parent's request", async () => {
      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'swarm',
          toolUseId: 'p1',
          input: { task: 'go', agents: [{ name: 'a', instructions: 'Do.' }] },
        })
        .addTurn({ type: 'toolUseBlock', name: 'strands_structured_output', toolUseId: 'c1', input: { message: 'ok' } })
        .addTurn({ type: 'textBlock', text: 'parent final' })
      const parent = new Agent({ model, tools: [swarm], printer: false })

      const result = await parent.invoke('start')

      expect(result.invocationContext?.usage.turnsTaken).toBe(3)
    })

    it("fails the swarm once the parent's request reaches its limit", async () => {
      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'swarm',
          toolUseId: 'p1',
          input: { task: 'go', agents: [{ name: 'a', instructions: 'Do.' }] },
        })
        .addTurn({ type: 'toolUseBlock', name: 'strands_structured_output', toolUseId: 'c1', input: { message: 'ok' } })
      const parent = new Agent({ model, tools: [swarm], printer: false })

      const result = await parent.invoke('start', { limits: { turns: 1 } })

      expect({ stopReason: result.stopReason, toolResults: parent.messages[2]!.content }).toEqual({
        stopReason: 'limitTurns',
        toolResults: [
          expect.objectContaining({
            status: 'error',
            content: [
              new TextBlock(
                `Error: Swarm stopped before completing (status=FAILED: ${limitStopMessage('a', 'limitTurns')}). Partial output:\n`
              ),
            ],
          }),
        ],
      })
    })

    it('surfaces agent interrupts on the parent and resumes the same swarm', async () => {
      let confirmed = 0
      const confirmTool = createMockTool('confirmTool', (context) => {
        context.interrupt({ name: 'confirm', reason: (context.toolUse.input as { question: string }).question })
        confirmed += 1
        return 'ok'
      })
      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'swarm',
          toolUseId: 'p1',
          input: { task: 'go', agents: [{ name: 'a', instructions: 'Do.' }] },
        })
        .addTurn(
          ['A', 'B'].map((question) => ({
            type: 'toolUseBlock' as const,
            name: 'confirmTool',
            toolUseId: `c${question}`,
            input: { question },
          }))
        )
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'so',
          input: { message: 'Done!' },
        })
        .addTurn({ type: 'textBlock', text: 'parent final' })
      const parent = new Agent({ model, tools: [swarm, confirmTool], printer: false })

      let result = await parent.invoke('start')
      expect(result.interrupts?.map((interrupt) => interrupt.id)).toEqual(
        ['A', 'B'].map((question) => `swarm:p1:tool:c${question}:confirm`)
      )
      const seen: unknown[] = []
      while (result.stopReason === 'interrupt') {
        const [interrupt] = result.interrupts!
        seen.push({ id: interrupt!.id, name: interrupt!.name, reason: interrupt!.reason })
        result = await parent.invoke([new InterruptResponseContent({ interruptId: interrupt!.id, response: 'yes' })])
      }

      expect(seen).toEqual(
        ['A', 'B'].map((question) => ({
          id: `swarm:p1:tool:c${question}:confirm`,
          name: 'confirm',
          reason: question,
        }))
      )
      expect(result.toString()).toBe('parent final')
      expect(confirmed).toBe(2)
      expect(parent.messages[2]!.content).toEqual([
        new ToolResultBlock({ toolUseId: 'p1', status: 'success', content: [new TextBlock('a: Done!')] }),
      ])
    })

    it('resumes an interrupted swarm after the parent is rebuilt', async () => {
      const storage = new MockSnapshotStorage()
      let confirmed = 0
      const build = (model: MockMessageModel): Agent => {
        const confirmTool = createMockTool('confirmTool', (context) => {
          context.interrupt({ name: 'confirm' })
          confirmed += 1
          return 'ok'
        })
        return new Agent({
          model,
          tools: [swarm, confirmTool],
          printer: false,
          sessionManager: new SessionManager({ sessionId: 's1', storage: { snapshot: storage } }),
        })
      }
      const first = build(
        new MockMessageModel()
          .addTurn({
            type: 'toolUseBlock',
            name: 'swarm',
            toolUseId: 'p1',
            input: { task: 'go', agents: [{ name: 'a', instructions: 'Do.' }] },
          })
          .addTurn({ type: 'toolUseBlock', name: 'confirmTool', toolUseId: 'c1', input: {} })
      )
      const interrupted = await first.invoke('start')
      expect(interrupted.interrupts?.map((interrupt) => interrupt.id)).toEqual(['swarm:p1:tool:c1:confirm'])
      expect(Object.keys(storedTurns(first))).toEqual(['p1'])

      // Process boundary: every agent is rebuilt and only the session survives.
      const second = build(
        new MockMessageModel()
          .addTurn({
            type: 'toolUseBlock',
            name: 'strands_structured_output',
            toolUseId: 'so',
            input: { message: 'Done!' },
          })
          .addTurn({ type: 'textBlock', text: 'parent final' })
      )
      const result = await second.invoke([
        new InterruptResponseContent({ interruptId: 'swarm:p1:tool:c1:confirm', response: 'yes' }),
      ])

      expect(result.toString()).toBe('parent final')
      expect(confirmed).toBe(1)
      expect(second.messages.at(-2)!.content).toEqual([
        new ToolResultBlock({ toolUseId: 'p1', status: 'success', content: [new TextBlock('a: Done!')] }),
      ])
    })
  })

  describe('interrupt persistence', () => {
    it('stores the interrupted swarm under a stable id and namespaces its interrupts', async () => {
      const builder = (spec: AgentSpec): Agent =>
        new Agent({
          model: new MockMessageModel().addTurn({
            type: 'toolUseBlock',
            name: 'confirmTool',
            toolUseId: 'c1',
            input: {},
          }),
          printer: false,
          id: spec.name!,
          tools: [createMockTool('confirmTool', (context) => context.interrupt({ name: 'confirm', reason: 'ok?' }))],
        })
      const parent = new Agent({ model: new MockMessageModel(), printer: false })
      const tool = makeSwarm({ builder, instructions: new Fixed('x') })

      const error = await run(tool, { task: 't', agents: [{ name: 'a' }] }, parent).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(InterruptError)
      expect((error as InterruptError).interrupts).toMatchObject([
        { id: 'swarm:t1:tool:c1:confirm', name: 'confirm', reason: 'ok?', source: 'tool' },
      ])
      expect(storedTurns(parent)['t1']).toMatchObject({ scope: 'multiAgent', data: { orchestratorId: 'swarm:t1' } })
    })

    it('raises the interrupt again and keeps the turn when an agent cannot be rebuilt on resume', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const answered = new Interrupt({ id: 'swarm:t1:approval', name: 'confirm' })
      const awaited = new MultiAgentState({ nodeIds: ['a'] })
      awaited.node('a')!.status = Status.INTERRUPTED
      awaited.node('a')!.interrupts = [new Interrupt({ id: 'approval', name: 'confirm' })]
      const turn = { scope: 'multiAgent', data: { state: serializeStateSerializable(awaited) } } as unknown as JSONValue
      const parent = new Agent({ model: new MockMessageModel(), printer: false })
      const state = interruptState(parent)
      state.registerInterrupt(answered)
      state.context['subAgentInterruptedTurns'] = { t1: turn }
      state.activate()
      state.resume([new InterruptResponseContent({ interruptId: answered.id, response: 'yes' })])
      const builder = (): Agent => {
        throw new Error('model endpoint unavailable')
      }

      const error = await run(
        makeSwarm({ builder }),
        { task: 't', agents: [{ name: 'a', instructions: 'Do.' }] },
        parent
      ).catch((caught: unknown) => caught)

      expect((error as InterruptError).interrupts.map((interrupt) => [interrupt.id, interrupt.response])).toEqual([
        [answered.id, undefined],
      ])
      expect(storedTurns(parent)).toEqual({ t1: turn })
    })
  })
})
