import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_AGENT_CONFIG } from '@strands-agents/harness'

import {
  readEvalsHarnessDefaults,
  readEvalsKnobs,
  evalsKnobChanges,
  evalsSpaceVariables,
  type EvalsKnob,
} from '../../../src/dev/evals/knobs.js'
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
  skills: ['./skills/refunds', './skills/orders'],
  plugins: makePlugins(),
  session: false,
  memory: true,
})
`

const workspaceWith = async (
  source: string,
  language: 'typescript' | 'python' = 'typescript'
): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  const file = language === 'python' ? 'agent.py' : 'agent.ts'
  await writeFile(join(root, file), source)
  return {
    root,
    entrypoint: join(root, file),
    config: {
      version: 1,
      name: 'desk',
      language,
      entrypoint: file,
      origin: { kind: 'discovered' },
    },
  }
}

const enabled = (knobs: readonly EvalsKnob[], keys: readonly string[]): EvalsKnob[] =>
  knobs.map((knob) => ({ ...knob, enabled: keys.includes(knob.key) }))

describe('optimization knobs', () => {
  it('shouldListEveryTunableOptionWithItsKindAndLeaveOutSessionAndMemory', async () => {
    const knobs = await readEvalsKnobs(await workspaceWith(AGENT))

    expect(
      knobs.map(({ key, kind, enabled, unavailable, notInCall }) => [
        key,
        kind,
        enabled,
        unavailable ?? null,
        notInCall === true,
      ])
    ).toEqual([
      ['instructions', 'text', true, null, false],
      [
        'systemPrompt',
        'text',
        false,
        'the call passes no system prompt, so the harness builds its own; tune the instructions instead',
        false,
      ],
      ['model', 'models', false, null, false],
      ['effort', 'choice', false, null, true],
      ['caching', 'choice', false, null, false],
      ['builtinTools', 'switches', false, null, false],
      ['tools', 'switches', false, null, false],
      ['mcpServers', 'switches', false, null, false],
      ['backgroundTasks', 'choice', false, null, true],
      ['contextManager', 'choice', false, null, false],
      ['skills', 'switches', false, null, false],
      ['builtinPlugins', 'switches', false, null, true],
      ['plugins', 'switches', false, 'set in code, so strands dev cannot read or change it', false],
      [
        'interventions',
        'switches',
        false,
        'the call passes no interventions, and the harness adds none by default',
        false,
      ],
    ])
    expect(knobs.find(({ key }) => key === 'tools')?.detail).toBe('on/off for each: lookupOrder, refund')
    expect(knobs.find(({ key }) => key === 'backgroundTasks')).toMatchObject({
      current: true,
      detail: 'on · off; not in the call, so the run starts from the harness default',
    })
    expect(knobs.find(({ key }) => key === 'contextManager')).toMatchObject({ current: 'agentic' })
  })

  it('shouldDescribeOnlyTheEnabledKnobsAsSearchVariablesWhenTheRunStarts', async () => {
    const knobs = enabled(await readEvalsKnobs(await workspaceWith(AGENT)), [
      'instructions',
      'model',
      'caching',
      'mcpServers',
      'skills',
      'builtinPlugins',
    ])

    const variables = evalsSpaceVariables(knobs, ['bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0'])

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
      { key: 'skills_0', kind: 'switch', option: 'skills', item: { index: 0 }, default: true },
      { key: 'skills_1', kind: 'switch', option: 'skills', item: { index: 1 }, default: true },
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
    const knobs = enabled(await readEvalsKnobs(await workspaceWith(AGENT)), ['model'])

    expect(evalsSpaceVariables(knobs, [])).toEqual([])
  })

  it('shouldTurnTheWinningValuesIntoAgentFileEditsWhenTheRunFinishes', async () => {
    const knobs = enabled(await readEvalsKnobs(await workspaceWith(AGENT)), [
      'caching',
      'mcpServers',
      'skills',
      'backgroundTasks',
      'builtinPlugins',
    ])
    const baseline = {
      caching: true,
      mcpServers_0: true,
      mcpServers_1: true,
      backgroundTasks: true,
      skills_0: true,
      skills_1: true,
      builtinPlugins_0: true,
    }
    const [dropped, ...kept] = DEFAULT_HARNESS_AGENT_CONFIG.builtinPlugins

    const changes = evalsKnobChanges(knobs, baseline, {
      ...baseline,
      caching: false,
      mcpServers_1: false,
      backgroundTasks: false,
      skills_1: false,
      builtinPlugins_0: false,
    })

    expect(changes.map(({ knob, added }) => [knob.key, added ?? null])).toEqual([
      ['caching', null],
      ['mcpServers', null],
      ['backgroundTasks', 'backgroundTasks is new in the call: applying writes backgroundTasks = false'],
      ['skills', null],
      ['builtinPlugins', `builtinPlugins is new in the call: applying writes builtinPlugins = ${JSON.stringify(kept)}`],
    ])
    expect(changes.map(({ knob, kind, before, after, edit }) => [knob.key, kind, before, after, edit])).toEqual([
      ['caching', 'value', 'on', 'off', { option: 'caching', value: false, expected: true }],
      ['mcpServers', 'value', 'docs on', 'docs off', { option: 'mcpServers', removeKeys: ['docs'] }],
      [
        'backgroundTasks',
        'value',
        'on (the harness default; not in the call)',
        'off',
        { option: 'backgroundTasks', value: false, absent: true },
      ],
      [
        'skills',
        'value',
        './skills/orders on',
        './skills/orders off',
        { option: 'skills', removeItems: [1], expectedItems: ["'./skills/refunds'", "'./skills/orders'"] },
      ],
      [
        'builtinPlugins',
        'value',
        `${dropped} on (the harness default; not in the call)`,
        `${dropped} off`,
        { option: 'builtinPlugins', value: kept, absent: true },
      ],
    ])
  })

  it('shouldOfferTheSystemPromptInsteadOfTheInstructionsWhenTheAgentSetsAFullSystemPrompt', async () => {
    const knobs = await readEvalsKnobs(
      await workspaceWith(
        "import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ systemPrompt: 'You are terse.' })\n"
      )
    )

    expect(knobs.slice(0, 2).map(({ key, enabled, unavailable }) => [key, enabled, unavailable ?? null])).toEqual([
      ['instructions', false, 'the full system prompt replaces the instructions; tune it instead'],
      ['systemPrompt', false, null],
    ])
  })

  it('shouldSayWhyAKnobCannotBeTunedWhenTheCallSetsItInCodeOrListsNothing', async () => {
    const knobs = await readEvalsKnobs(
      await workspaceWith(
        "import { createHarness } from '@strands-agents/harness'\n" +
          'export const agent = await createHarness({ model: makeModel(), tools: [], backgroundTasks: true, skills: [], interventions: STRICT })\n'
      )
    )

    expect(knobs.map(({ key, kind, unavailable }) => [key, kind, unavailable ?? null])).toEqual([
      ['instructions', 'text', null],
      [
        'systemPrompt',
        'text',
        'the call passes no system prompt, so the harness builds its own; tune the instructions instead',
      ],
      ['model', 'models', 'set in code, so strands dev cannot read or change it'],
      ['effort', 'choice', 'the model has no reasoning levels to choose from'],
      ['caching', 'choice', null],
      ['builtinTools', 'switches', null],
      ['tools', 'switches', 'the call lists no tools, so there is nothing to switch off'],
      ['mcpServers', 'switches', 'the call passes no MCP servers, and the harness adds none by default'],
      ['backgroundTasks', 'choice', null],
      ['contextManager', 'choice', null],
      ['skills', 'switches', 'the call lists no skills, so there is nothing to switch off'],
      ['builtinPlugins', 'switches', null],
      ['plugins', 'switches', 'the call passes no plugins, and the harness adds none by default'],
      ['interventions', 'switches', 'set in code, so strands dev cannot read or change it'],
    ])
    expect(knobs.find(({ key }) => key === 'builtinTools')?.entries?.map(({ label }) => label)).toEqual(
      (DEFAULT_HARNESS_AGENT_CONFIG.builtinTools as readonly string[]).filter((name) => name !== 'web_search')
    )
  })

  it('shouldListTheKnobsThatAPythonCallLeavesOutFromThePythonHarnessDefaults', async () => {
    const workspace = await workspaceWith(
      "from strands_harness import create_harness\nagent = create_harness(instructions='Be brief.', mcp_servers={'docs': {}}, builtin_plugins=None)\n",
      'python'
    )
    const options = {
      model: 'bedrock/py',
      effort: 'auto',
      caching: true,
      contextManager: 'auto',
      skills: true,
      builtinTools: ['shell', 'web_search'],
      interventions: { strict: true },
    }
    const read = vi.fn(async () => ({ options, webSearch: true }))

    const knobs = await readEvalsKnobs(workspace, read)

    expect(read).toHaveBeenCalledWith(workspace, { kind: 'unset' })
    expect(
      knobs.map(({ key, option, unavailable, current, entries }) => [
        key,
        option,
        unavailable ?? current ?? entries?.map(({ label }) => label) ?? null,
      ])
    ).toEqual([
      ['instructions', 'instructions', 'Be brief.'],
      ['systemPrompt', 'system_prompt', expect.stringContaining('the call passes no system prompt')],
      ['model', 'model', 'bedrock/py'],
      ['effort', 'effort', 'the model has no reasoning levels to choose from'],
      ['caching', 'caching', true],
      ['builtinTools', 'builtin_tools', ['shell', 'web_search']],
      ['tools', 'tools', 'the call passes no tools, and the harness adds none by default'],
      ['mcpServers', 'mcp_servers', ['docs']],
      ['backgroundTasks', 'background_tasks', true],
      ['contextManager', 'context_manager', 'auto'],
      ['skills', 'skills', true],
      ['builtinPlugins', 'builtin_plugins', 'set to a value that strands dev does not tune'],
      ['plugins', 'plugins', 'the call passes no plugins, and the harness adds none by default'],
      [
        'interventions',
        'interventions',
        'the harness default interventions are not a list of names that strands dev can switch',
      ],
    ])
  })

  it('shouldReadTheTypeScriptHarnessDefaultsWithNativeWebSearchOnlyForAModelThatHasIt', async () => {
    const workspace = await workspaceWith('')

    const [unset, set, code] = await Promise.all([
      readEvalsHarnessDefaults(workspace, { kind: 'unset' }),
      readEvalsHarnessDefaults(workspace, { kind: 'set', model: 'openai/gpt-5' }),
      readEvalsHarnessDefaults(workspace, { kind: 'code' }),
    ])

    expect(unset.options).toBe(DEFAULT_HARNESS_AGENT_CONFIG)
    expect([unset.webSearch, set.webSearch, code.webSearch]).toEqual([false, true, false])
  })

  it.skipIf(process.platform === 'win32')('shouldReadThePythonHarnessDefaultsFromTheProjectPython', async () => {
    const workspace = await workspaceWith('', 'python')
    const packages = join(workspace.root, 'packages', 'strands_harness')
    await mkdir(packages, { recursive: true })
    await writeFile(
      join(packages, '__init__.py'),
      'DEFAULT_HARNESS_AGENT_CONFIG = {"builtinPlugins": ("environment",)}\n' +
        'def supports_web_search(model):\n    return model == "openai/gpt-5"\n'
    )
    const python = join(workspace.root, '.venv', 'bin', 'python')
    await mkdir(join(workspace.root, '.venv', 'bin'), { recursive: true })
    // Drops -I so that the fake package on PYTHONPATH stands in for strands-harness.
    await writeFile(
      python,
      `#!/bin/sh\nshift\nexec env PYTHONPATH="${join(workspace.root, 'packages')}" ${process.env.PYTHON ?? 'python3'} "$@"\n`
    )
    await chmod(python, 0o755)

    const [set, code] = [
      await readEvalsHarnessDefaults(workspace, { kind: 'set', model: 'openai/gpt-5' }),
      await readEvalsHarnessDefaults(workspace, { kind: 'code' }),
    ]

    expect(set).toEqual({ options: { builtinPlugins: ['environment'] }, webSearch: true })
    expect(code.webSearch).toBe(false)
  })

  it('shouldSayWhyEveryKnobThatTheCallLeavesOutCannotBeTunedWhenTheHarnessDefaultsCannotBeRead', async () => {
    const workspace = await workspaceWith("export const agent = await createHarness({ model: 'bedrock/x' })\n")

    const knobs = await readEvalsKnobs(workspace, async () => {
      throw new Error('no strands_harness')
    })

    const problem = 'strands dev could not read the strands-harness defaults: no strands_harness'
    expect(knobs.filter(({ unavailable }) => unavailable === problem).map(({ key }) => key)).toEqual([
      'caching',
      'builtinTools',
      'tools',
      'mcpServers',
      'backgroundTasks',
      'contextManager',
      'skills',
      'builtinPlugins',
      'plugins',
      'interventions',
    ])
    expect(knobs.find(({ key }) => key === 'model')).toMatchObject({ current: 'bedrock/x' })
  })

  it('shouldLeaveOutAKnobThatDidNotChange', async () => {
    const knobs = enabled(await readEvalsKnobs(await workspaceWith(AGENT)), ['caching', 'contextManager', 'skills'])
    const baseline = { caching: true, contextManager: 'agentic', skills_0: true, skills_1: true }

    expect(evalsKnobChanges(knobs, baseline, { ...baseline, contextManager: undefined })).toEqual([])
  })
})
