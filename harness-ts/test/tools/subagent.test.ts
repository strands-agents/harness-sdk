import {
  type Agent,
  type BaseModelConfig,
  InterruptResponseContent,
  type Message,
  Model,
  type ModelStreamEvent,
  tool,
} from '@strands-agents/sdk'
import { ContextManager } from '@strands-agents/sdk/experimental'
import { AgentSpec } from '@strands-agents/sdk/multiagent'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createHarness, type HarnessAgentOptions } from '../../src/agent.js'
import { resolveBuiltinTools } from '../../src/builtin-tools.js'

type Turn = { text: string } | { tool: string; input: object }

/** Plays queued turns in order; a parent and its delegate share it, so turns interleave across both. */
class ScriptedModel extends Model {
  private _config: BaseModelConfig = { modelId: 'scripted-model' }
  private readonly _turns: Turn[]

  constructor(...turns: Turn[]) {
    super()
    this._turns = turns
  }

  updateConfig(modelConfig: BaseModelConfig): void {
    this._config = { ...this._config, ...modelConfig }
  }

  getConfig(): BaseModelConfig {
    return this._config
  }

  async *stream(_messages: Message[]): AsyncGenerator<ModelStreamEvent> {
    const turn = this._turns.shift() ?? { text: 'out of turns' }
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    if ('text' in turn) {
      yield { type: 'modelContentBlockStartEvent' }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: turn.text } }
      yield { type: 'modelContentBlockStopEvent' }
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
      return
    }
    yield {
      type: 'modelContentBlockStartEvent',
      start: { type: 'toolUseStart', name: turn.tool, toolUseId: turn.tool },
    }
    yield {
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'toolUseInputDelta', input: JSON.stringify(turn.input) },
    }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
  }
}

const QUIET: HarnessAgentOptions = {
  memory: false,
  session: false,
  skills: false,
  backgroundTasks: false,
  printer: false,
}

function subagentOf(agent: Agent): { toolSpec: { description: string; inputSchema?: unknown } } {
  return agent.tools.find((t) => t.name === 'subagent')!
}

function buildChildFrom(parent: Agent, spec: AgentSpec): Promise<Agent> {
  return (subagentOf(parent) as unknown as { _builder: (spec: AgentSpec) => Promise<Agent> })._builder(spec)
}

describe('harness subagent tool', () => {
  it('is the SDK tool with the harness description, generalist preset, and context choice', async () => {
    const agent = await createHarness({ builtinTools: ['read', 'subagent'] })
    const { description, inputSchema } = subagentOf(agent).toolSpec
    const properties = (inputSchema as { properties: Record<string, { enum?: string[]; items?: { enum: string[] } }> })
      .properties

    expect(description).toBe(
      'Delegate a self-contained task to a subagent that runs in its own context and returns a final ' +
        'report. Reach for this when a subtask would otherwise flood your context with intermediate ' +
        'work and you only need its conclusion. Do not poll for progress or redo its work.'
    )
    expect(Object.keys(properties).sort()).toEqual([
      'agent_type',
      'context',
      'instructions',
      'last_messages',
      'task',
      'tools',
    ])
    expect(properties.agent_type!.enum).toEqual(['generalist'])
    expect(properties.context!.enum).toEqual(['none', 'all', 'no_tools'])
    expect(properties.tools!.items!.enum).toEqual(['read', 'subagent'])
  })

  it.each([
    [0, false],
    [1, true],
  ])('with maxDepth %i registers the tool: %s', async (maxDepth, registered) => {
    const agent = await createHarness({ builtinTools: { subagent: { maxDepth } } })

    expect(resolveBuiltinTools({ subagent: { maxDepth } }).subagent).toEqual(registered && { maxDepth })
    expect(agent.tools.some((t) => t.name === 'subagent')).toBe(registered)
  })

  it('builds the delegate with its own context manager', async () => {
    const parent = await createHarness()
    const child = await buildChildFrom(parent, new AgentSpec({ name: 'subagent' }))

    expect(child.contextManager).toBeInstanceOf(ContextManager)
    expect(child.contextManager).not.toBe(parent.contextManager)
  })

  it('delegates to a rebuilt child and returns its answer to the parent', async () => {
    const model = new ScriptedModel(
      { tool: 'subagent', input: { task: 'add 1 and 2' } },
      { text: '3' },
      { text: 'the child said 3' }
    )
    const parent = await createHarness({ ...QUIET, model })

    const result = await parent.invoke('go')

    expect(result.toString()).toBe('the child said 3')
    expect(parent.messages.at(-2)!.content).toEqual([
      expect.objectContaining({
        toolUseId: 'subagent',
        status: 'success',
        content: [expect.objectContaining({ text: '3' })],
      }),
    ])
  })

  it('raises a delegate interrupt on the parent under the subagent namespace and resumes it', async () => {
    const executed: string[] = []
    const deploy = tool({
      name: 'deploy',
      description: 'Deploy after confirmation.',
      inputSchema: z.object({}),
      callback: (_input, context) => {
        if (context.interrupt({ name: 'confirm', reason: 'deploy?' }) !== 'yes') return 'declined'
        executed.push('deploy')
        return 'deployed'
      },
    })
    const model = new ScriptedModel(
      { tool: 'subagent', input: { task: 'deploy it' } },
      { tool: 'deploy', input: {} },
      { text: 'child deployed' },
      { text: 'parent done' }
    )
    const parent = await createHarness({ ...QUIET, model, tools: [deploy] })

    const interrupted = await parent.invoke('go')
    const [interrupt] = interrupted.interrupts ?? []
    expect(interrupted.stopReason).toBe('interrupt')
    expect(interrupt!.id).toMatch(/^subagent:subagent:/)

    const resumed = await parent.invoke([new InterruptResponseContent({ interruptId: interrupt!.id, response: 'yes' })])

    expect(resumed.toString()).toBe('parent done')
    expect(executed).toEqual(['deploy'])
  })
})
