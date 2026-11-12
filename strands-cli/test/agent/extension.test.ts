import { TextBlock, type Agent, type InvokableTool, type JSONValue, type ToolContext } from '@strands-agents/sdk'
import { AgentSkills, Skill } from '@strands-agents/sdk/vended-plugins/skills'
import { describe, expect, it, vi } from 'vitest'

import {
  addExtensionSkills,
  appendInstructions,
  extensionPolicies,
  extensionTools,
  type AgentExtension,
} from '../../src/agent/extension.js'

const EXTENSION: AgentExtension = {
  instructions: '<strands_dev>workspace</strands_dev>',
  skills: [{ name: 'create-experiment', description: 'Create an experiment', instructions: 'Ask, then call.' }],
  tools: [
    { name: 'strands_dev_status', description: 'Status', inputSchema: { type: 'object' }, readOnly: true },
    { name: 'strands_dev_test', description: 'Test', inputSchema: { type: 'object' } },
  ],
}

const agentWith = (systemPrompt: Agent['systemPrompt']): Agent => ({ systemPrompt }) as Agent

describe('appendInstructions', () => {
  it.each<[string, Agent['systemPrompt'], Agent['systemPrompt']]>([
    ['no prompt', undefined, 'extra'],
    ['an empty prompt', '', 'extra'],
    ['a text prompt', 'authored', 'authored\n\nextra'],
  ])('shouldPutTheInstructionsLastWhenTheAgentHas%s', (_case, before, after) => {
    const agent = agentWith(before)

    appendInstructions(agent, 'extra')
    appendInstructions(agent, 'extra')

    expect(agent.systemPrompt).toEqual(after)
  })

  it('shouldAddOneTextBlockWhenThePromptIsMadeOfBlocks', () => {
    const agent = agentWith([new TextBlock('authored')])

    appendInstructions(agent, 'extra')
    appendInstructions(agent, 'extra')

    expect(agent.systemPrompt).toEqual([new TextBlock('authored'), new TextBlock('extra')])
  })
})

describe('extensionTools', () => {
  it('shouldSendTheToolNameAndInputToTheHostWhenTheAgentCallsATool', async () => {
    const call = vi.fn(async (_name: string, _input: JSONValue) => 'ok')

    const tools = extensionTools({ extension: EXTENSION, call })
    const result = await (tools[1] as InvokableTool<unknown, JSONValue>).invoke({ experiment: 'refunds' })

    expect(tools.map((tool) => tool.name)).toEqual(['strands_dev_status', 'strands_dev_test'])
    expect(call).toHaveBeenCalledWith('strands_dev_test', { experiment: 'refunds' })
    expect(result).toBe('ok')
  })
})

describe('extensionTools cancellation', () => {
  it('shouldEndTheToolCallWhenTheTurnIsCancelledWhileTheHostStillRuns', async () => {
    const call = vi.fn(() => new Promise<string>(() => undefined))
    const controller = new AbortController()
    const [, test] = extensionTools({ extension: EXTENSION, call })

    const running = (test as InvokableTool<unknown, JSONValue>).invoke({}, {
      cancelSignal: controller.signal,
    } as ToolContext)
    controller.abort()

    await expect(running).rejects.toThrow('The tool call was cancelled.')
    expect(call).toHaveBeenCalledOnce()
  })
})

describe('extensionPolicies', () => {
  it('shouldPermitOnlyTheReadOnlyToolsWhenItWritesCedarPolicies', () => {
    const policies = extensionPolicies(EXTENSION)

    expect(policies).toContain('action == Action::"strands_dev_status"')
    expect(policies).not.toContain('strands_dev_test')
  })
})

describe('addExtensionSkills', () => {
  it('shouldKeepTheAuthoredSkillsAndReplaceASkillWithTheSameNameWhenItAddsTheExtensionSkills', async () => {
    const plugin = new AgentSkills({
      skills: [
        new Skill({ name: 'refunds', description: 'Authored', instructions: 'Refund rules.' }),
        new Skill({ name: 'create-experiment', description: 'Old', instructions: 'Old text.' }),
      ],
    })
    const agent = {} as Agent

    await addExtensionSkills(plugin, agent, EXTENSION)

    const skills = await plugin.getAvailableSkills()
    expect(skills.map(({ name, description }) => [name, description])).toEqual([
      ['refunds', 'Authored'],
      ['create-experiment', 'Create an experiment'],
    ])
  })
})
