import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_AGENT_CONFIG } from '@strands-agents/harness'

import {
  readTemporaryKnobs,
  temporaryKnobChanges,
  temporarySpaceVariables,
  type TemporaryKnob,
} from '../../../src/dev/temporary-evals-fork/knobs.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const AGENT = `import { createHarness } from '@strands-agents/harness'
import { lookupOrder, refund } from './tools.js'

export const agent = await createHarness({
  instructions: 'Answer refund questions.',
  model: 'bedrock/global.anthropic.claude-sonnet-5',
  caching: true,
  builtinTools: ['shell', 'read', 'web_search'],
  tools: [lookupOrder, refund],
  mcpServers: { github: { command: 'gh-mcp' }, docs: { url: 'https://docs.example' } },
  contextManager: 'agentic',
  plugins: makePlugins(),
  session: false,
})
`

const workspaceWith = async (source: string): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  await writeFile(join(root, 'agent.ts'), source)
  return {
    root,
    entrypoint: join(root, 'agent.ts'),
    config: {
      version: 1,
      name: 'desk',
      language: 'typescript',
      entrypoint: 'agent.ts',
      origin: { kind: 'discovered' },
    },
  }
}

const enabled = (knobs: readonly TemporaryKnob[], keys: readonly string[]): TemporaryKnob[] =>
  knobs.map((knob) => ({ ...knob, enabled: keys.includes(knob.key) }))

describe('TEMPORARY optimization knobs', () => {
  it('shouldListEveryCreateHarnessOptionWithItsKindAndWhyItIsUnavailableWhenTheAgentSetsThem', async () => {
    const knobs = await readTemporaryKnobs(await workspaceWith(AGENT))

    expect(knobs.map(({ key, kind, enabled, unavailable }) => [key, kind, enabled, unavailable ?? null])).toEqual([
      ['instructions', 'text', true, null],
      ['model', 'models', false, null],
      ['effort', 'choice', false, null],
      ['caching', 'choice', false, null],
      ['builtinTools', 'switches', false, null],
      ['tools', 'switches', false, null],
      ['mcpServers', 'switches', false, null],
      ['backgroundTasks', 'choice', false, null],
      ['contextManager', 'choice', false, null],
      ['session', 'choice', false, 'every trial runs without a session'],
      ['skills', 'choice', false, null],
      ['builtinPlugins', 'switches', false, null],
      ['plugins', 'switches', false, 'set in code, so strands dev cannot read or change it'],
    ])
    expect(knobs.find(({ key }) => key === 'tools')?.detail).toBe('on/off for each: lookupOrder, refund')
    expect(knobs.find(({ key }) => key === 'contextManager')).toMatchObject({ current: 'agentic' })
  })

  it('shouldDescribeOnlyTheEnabledKnobsAsSearchVariablesWhenTheRunStarts', async () => {
    const knobs = enabled(await readTemporaryKnobs(await workspaceWith(AGENT)), [
      'instructions',
      'model',
      'caching',
      'mcpServers',
      'builtinPlugins',
    ])

    const variables = temporarySpaceVariables(knobs, ['bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0'])

    expect(variables).toEqual([
      {
        key: 'instructions',
        kind: 'text',
        option: 'instructions',
        about: expect.any(String),
        default: 'Answer refund questions.',
      },
      {
        key: 'model',
        kind: 'choice',
        option: 'model',
        values: ['bedrock/global.anthropic.claude-sonnet-5', 'bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0'],
        default: 'bedrock/global.anthropic.claude-sonnet-5',
      },
      { key: 'caching', kind: 'choice', option: 'caching', values: ['auto', true, false], default: true },
      { key: 'mcpServers_0', kind: 'switch', option: 'mcpServers', item: { key: 'github' }, default: true },
      { key: 'mcpServers_1', kind: 'switch', option: 'mcpServers', item: { key: 'docs' }, default: true },
      ...DEFAULT_HARNESS_AGENT_CONFIG.builtinPlugins.map((name, index) => ({
        key: `builtinPlugins_${index}`,
        kind: 'switch',
        option: 'builtinPlugins',
        item: { name },
        default: true,
      })),
    ])
  })

  it('shouldLeaveTheModelOutOfTheSearchWhenNoOtherModelIsPicked', async () => {
    const knobs = enabled(await readTemporaryKnobs(await workspaceWith(AGENT)), ['model'])

    expect(temporarySpaceVariables(knobs, [])).toEqual([])
  })

  it('shouldTurnTheWinningValuesIntoAgentFileEditsWhenTheRunFinishes', async () => {
    const knobs = enabled(await readTemporaryKnobs(await workspaceWith(AGENT)), [
      'caching',
      'builtinTools',
      'mcpServers',
      'builtinPlugins',
    ])
    const baseline = {
      caching: true,
      builtinTools_0: true,
      builtinTools_1: true,
      builtinTools_2: true,
      mcpServers_0: true,
      mcpServers_1: true,
      builtinPlugins_0: true,
      builtinPlugins_1: true,
    }

    const changes = temporaryKnobChanges(knobs, baseline, {
      ...baseline,
      caching: false,
      builtinTools_2: false,
      mcpServers_1: false,
      builtinPlugins_0: false,
    })

    expect(changes.map(({ knob, kind, before, after, edit }) => [knob.key, kind, before, after, edit])).toEqual([
      ['caching', 'value', 'on', 'off', { option: 'caching', value: false, expected: true }],
      [
        'builtinTools',
        'value',
        'web_search on',
        'web_search off',
        { option: 'builtinTools', removeItems: [2], expectedItems: ["'shell'", "'read'", "'web_search'"] },
      ],
      ['mcpServers', 'value', 'docs on', 'docs off', { option: 'mcpServers', removeKeys: ['docs'] }],
      [
        'builtinPlugins',
        'value',
        `${DEFAULT_HARNESS_AGENT_CONFIG.builtinPlugins[0]} on`,
        `${DEFAULT_HARNESS_AGENT_CONFIG.builtinPlugins[0]} off`,
        {
          option: 'builtinPlugins',
          value: DEFAULT_HARNESS_AGENT_CONFIG.builtinPlugins.slice(1),
          expected: [...DEFAULT_HARNESS_AGENT_CONFIG.builtinPlugins],
        },
      ],
    ])
  })

  it('shouldOfferTheSystemPromptInsteadOfTheInstructionsWhenTheAgentSetsAFullSystemPrompt', async () => {
    const knobs = await readTemporaryKnobs(
      await workspaceWith(
        "import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ systemPrompt: 'You are terse.' })\n"
      )
    )

    expect(knobs.slice(0, 2).map(({ key, enabled, unavailable }) => [key, enabled, unavailable ?? null])).toEqual([
      ['instructions', false, 'the full system prompt replaces the instructions; tune it instead'],
      ['systemPrompt', false, null],
    ])
  })
})
