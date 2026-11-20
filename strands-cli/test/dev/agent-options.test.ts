import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AgentOptionConflict,
  AgentOptionsNotEditable,
  editAgentOptions,
  readAgentModel,
  readAgentOptions,
  saveAgentOptions,
} from '../../src/dev/agent-options.js'
import { pythonExecutable } from '../fixtures/python-runtime.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const agent = async (language: 'typescript' | 'python', source: string) => {
  const root = await temporaryDirectory()
  const entrypoint = join(root, language === 'python' ? 'agent.py' : 'agent.ts')
  await writeFile(entrypoint, source)
  return { root, entrypoint, config: { language } }
}

const GENERATED_TYPESCRIPT = `import { createHarness } from '@strands-agents/harness'

export const agent = await createHarness({
  name: 'Demo',
  model: 'bedrock/global.anthropic.claude-sonnet-5',
})
`

describe('saving agent options into TypeScript source', () => {
  it('shouldReplaceTheModelLiteralAndKeepTheRestOfTheFile', async () => {
    const workspace = await agent(
      'typescript',
      `// keep this note
import { createHarness } from '@strands-agents/harness'

export const agent = await createHarness({
  name: 'Demo', // the name
  model: "bedrock/global.anthropic.claude-sonnet-5",
  instructions: 'Be brief.',
})
`
    )

    expect(await saveAgentOptions(workspace, { model: 'bedrock/global.anthropic.claude-haiku-5' })).toBe(true)

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(`// keep this note
import { createHarness } from '@strands-agents/harness'

export const agent = await createHarness({
  name: 'Demo', // the name
  model: 'bedrock/global.anthropic.claude-haiku-5',
  instructions: 'Be brief.',
})
`)
  })

  it.each([
    [
      'a multi-line object with a trailing comma',
      GENERATED_TYPESCRIPT,
      GENERATED_TYPESCRIPT.replace(`claude-sonnet-5',\n`, `claude-sonnet-5',\n  effort: 'high',\n`),
    ],
    [
      'a multi-line object without a trailing comma',
      `export const agent = await createHarness({\n  name: 'Demo'\n})\n`,
      `export const agent = await createHarness({\n  name: 'Demo',\n  effort: 'high'\n})\n`,
    ],
    [
      'a single-line object',
      `export const agent = await createHarness({ name: 'Demo' })\n`,
      `export const agent = await createHarness({ name: 'Demo', effort: 'high' })\n`,
    ],
    [
      'an empty object',
      `export const agent = await createHarness({})\n`,
      `export const agent = await createHarness({ effort: 'high' })\n`,
    ],
    [
      'an object that spreads shared options',
      `export const agent = await createHarness({ ...shared })\n`,
      `export const agent = await createHarness({ ...shared, effort: 'high' })\n`,
    ],
  ])('shouldAddAMissingOptionWhenTheSourceHas%s', async (_case, source, expected) => {
    const workspace = await agent('typescript', source)

    await saveAgentOptions(workspace, { effort: 'high' })

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(expected)
  })

  it.each([
    ['the same model in another spelling', { model: 'global.anthropic.claude-sonnet-5' }],
    ['the harness default effort that the source does not set', { effort: 'auto' as const }],
  ])('shouldLeaveTheFileUnchangedWhenTheChangeIs%s', async (_case, change) => {
    const workspace = await agent('typescript', GENERATED_TYPESCRIPT)

    expect(await saveAgentOptions(workspace, change)).toBe(false)

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(GENERATED_TYPESCRIPT)
  })

  it.each([
    ['sets the model from a variable', `export const agent = await createHarness({ model: chosenModel })\n`],
    ['uses the shorthand form', `export const agent = await createHarness({ model })\n`],
    ['does not call createHarness', `export const agent = new Agent({ model: 'x' })\n`],
    ['calls createHarness twice', `const a = createHarness({})\nconst b = createHarness({})\n`],
    ['passes its options in a variable', `export const agent = await createHarness(options)\n`],
  ])('shouldRefuseToChangeTheSourceWhenItsCodeIs%s', async (_case, source) => {
    const workspace = await agent('typescript', source)

    await expect(saveAgentOptions(workspace, { model: 'bedrock/global.anthropic.claude-haiku-5' })).rejects.toThrow(
      AgentOptionsNotEditable
    )

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(source)
  })

  it('shouldRejectTheChangeWhenTheOptionNoLongerHasTheExpectedValue', async () => {
    const workspace = await agent('typescript', GENERATED_TYPESCRIPT)

    await expect(
      saveAgentOptions(workspace, { model: 'bedrock/global.anthropic.claude-haiku-5' }, { model: 'bedrock/other' })
    ).rejects.toThrow(AgentOptionConflict)

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(GENERATED_TYPESCRIPT)
  })

  it('shouldApplyTheChangeWhenTheOptionStillHasTheExpectedValue', async () => {
    const workspace = await agent('typescript', GENERATED_TYPESCRIPT)

    await saveAgentOptions(workspace, { effort: 'low' }, { effort: 'auto' })

    expect(await readFile(workspace.entrypoint, 'utf8')).toContain(`effort: 'low',`)
  })
})

const GENERATED_PYTHON = `from strands_harness import create_harness

agent = create_harness(
    name="Demo",
    model="bedrock/global.anthropic.claude-sonnet-5",
)
`

describe('reading Python source without an interpreter', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('shouldReportThatTheSourceCannotBeReadWhenNoPythonCanStart', async () => {
    vi.stubEnv('PYTHON', join(await temporaryDirectory(), 'missing-python'))
    const workspace = await agent('python', GENERATED_PYTHON)

    await expect(saveAgentOptions(workspace, { effort: 'high' })).rejects.toThrow(AgentOptionsNotEditable)
    expect(await readAgentModel(workspace)).toBeUndefined()

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(GENERATED_PYTHON)
  })

  it('shouldReportThatTheSourceCannotBeReadWhenThePythonPathCannotStartAProcess', async () => {
    const file = join(await temporaryDirectory(), 'notes.txt')
    await writeFile(file, '')
    vi.stubEnv('PYTHON', join(file, 'python'))
    const workspace = await agent('python', GENERATED_PYTHON)

    expect(await readAgentOptions(workspace)).toBeUndefined()
    await expect(saveAgentOptions(workspace, { effort: 'high' })).rejects.toThrow(AgentOptionsNotEditable)
  })
})

describe.skipIf(!existsSync(pythonExecutable))('saving agent options into Python source', () => {
  beforeEach(() => {
    vi.stubEnv('PYTHON', pythonExecutable)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('shouldReplaceTheModelValueAndKeepCommentsAndNonAsciiText', async () => {
    const source = GENERATED_PYTHON.replace('name="Demo",', 'name="Démo 🐸",  # the name')
    const workspace = await agent('python', source)

    await saveAgentOptions(workspace, { model: 'bedrock/global.anthropic.claude-haiku-5' })

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(source.replace('claude-sonnet-5', 'claude-haiku-5'))
  })

  it('shouldKeepNonAsciiTextWhenPythonRunsWithALegacyEightBitLocale', async () => {
    vi.stubEnv('LC_ALL', 'en_US.ISO-8859-1')
    const source = GENERATED_PYTHON.replace('name="Demo",', 'name="Démo 🐸",  # the name')
    const workspace = await agent('python', source)

    await saveAgentOptions(workspace, { model: 'bedrock/global.anthropic.claude-haiku-5' })

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(source.replace('claude-sonnet-5', 'claude-haiku-5'))
  })

  it.each([
    [
      'a multi-line call with a trailing comma',
      GENERATED_PYTHON,
      GENERATED_PYTHON.replace(`claude-sonnet-5",\n`, `claude-sonnet-5",\n    effort="high",\n`),
    ],
    [
      'a single-line call',
      `agent = create_harness(name="Demo")\n`,
      `agent = create_harness(name="Demo", effort="high")\n`,
    ],
    ['an empty call', `agent = create_harness()\n`, `agent = create_harness(effort="high")\n`],
  ])('shouldAddAMissingKeywordWhenTheSourceHas%s', async (_case, source, expected) => {
    const workspace = await agent('python', source)

    await saveAgentOptions(workspace, { effort: 'high' })

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(expected)
  })

  it.each([
    ['sets the model from a variable', `agent = create_harness(model=chosen)\n`],
    ['passes keyword arguments from a dictionary', `agent = create_harness(**options)\n`],
    ['has a syntax error', `agent = create_harness(\n`],
  ])('shouldRefuseToChangeTheSourceWhenItsCode%s', async (_case, source) => {
    const workspace = await agent('python', source)

    await expect(saveAgentOptions(workspace, { model: 'bedrock/global.anthropic.claude-haiku-5' })).rejects.toThrow(
      AgentOptionsNotEditable
    )

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(source)
  })
})

describe('reading the agent model from TypeScript source', () => {
  it.each([
    ['a provider-qualified literal', GENERATED_TYPESCRIPT, 'bedrock/global.anthropic.claude-sonnet-5'],
    [
      'a literal for another provider',
      `import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ model: 'anthropic/claude-sonnet-4-5' })\n`,
      'anthropic/claude-sonnet-4-5',
    ],
    [
      'a model set in code',
      `import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ model: process.env.MODEL })\n`,
      undefined,
    ],
    ['a file without createHarness', `export const agent = {}\n`, undefined],
  ])('shouldReadTheModelWhenTheSourceHas %s', async (_, source, model) => {
    const workspace = await agent('typescript', source)

    expect(await readAgentModel(workspace)).toBe(model)
  })

  it('shouldReadTheDefaultModelWhenCreateHarnessSetsNoModel', async () => {
    const workspace = await agent(
      'typescript',
      `import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ name: 'Demo' })\n`
    )

    expect(await readAgentModel(workspace)).toMatch(/^bedrock\//u)
  })
})

const KNOB_TYPESCRIPT = `import { createHarness } from '@strands-agents/harness'
import { lookupOrder } from './tools.js'

export const agent = await createHarness({
  model: 'bedrock/global.anthropic.claude-sonnet-5',
  caching: true,
  builtinTools: [
    'shell',
    'read',
    'web_search',
  ],
  tools: [lookupOrder],
  mcpServers: { github: { command: 'gh-mcp' }, docs: { url: 'https://docs.example' } },
  plugins: makePlugins(),
})
`

describe('reading and editing every createHarness option in TypeScript source', () => {
  it('shouldDescribeEachOptionByItsLiteralShapeWhenTheAgentFileIsRead', async () => {
    const workspace = await agent('typescript', KNOB_TYPESCRIPT)

    const options = await readAgentOptions(workspace)

    expect(Object.fromEntries(options!)).toEqual({
      model: { kind: 'string', value: 'bedrock/global.anthropic.claude-sonnet-5' },
      caching: { kind: 'boolean', value: true },
      builtinTools: {
        kind: 'list',
        items: [
          { text: "'shell'", literal: 'shell' },
          { text: "'read'", literal: 'read' },
          { text: "'web_search'", literal: 'web_search' },
        ],
      },
      tools: { kind: 'list', items: [{ text: 'lookupOrder' }] },
      mcpServers: { kind: 'map', keys: ['github', 'docs'] },
      plugins: { kind: 'code' },
    })
  })

  it('shouldWriteInstructionsTheAgentNeverSetWhenTheEditExpectsThemEmpty', async () => {
    const workspace = await agent('typescript', KNOB_TYPESCRIPT)

    expect(
      await editAgentOptions(workspace, [{ option: 'instructions', value: 'Answer briefly.', expected: '' }])
    ).toBe(true)

    expect(await readFile(workspace.entrypoint, 'utf8')).toContain("instructions: 'Answer briefly.',")
  })

  it('shouldSetScalarsRemoveItemsAndKeysAndInsertMissingOptionsWhenTheEditsApply', async () => {
    const workspace = await agent('typescript', KNOB_TYPESCRIPT)

    expect(
      await editAgentOptions(workspace, [
        { option: 'caching', value: false, expected: true },
        { option: 'contextManager', value: 'agentic', expected: 'auto' },
        { option: 'builtinTools', removeItems: [1], expectedItems: ["'shell'", "'read'", "'web_search'"] },
        { option: 'mcpServers', removeKeys: ['docs'] },
      ])
    ).toBe(true)

    const edited = await readFile(workspace.entrypoint, 'utf8')
    expect(edited).toContain('caching: false,')
    expect(edited).toContain("builtinTools: [\n    'shell',\n    'web_search',\n  ],")
    expect(edited).toContain("mcpServers: { github: { command: 'gh-mcp' } },")
    expect(edited).toContain("contextManager: 'agentic'")
    expect(edited).toContain('plugins: makePlugins(),')
  })

  it.each([
    ['a scalar that changed since the run', { option: 'caching', value: false, expected: false }, AgentOptionConflict],
    [
      'a list that changed since the run',
      { option: 'builtinTools', removeItems: [0], expectedItems: ["'shell'"] },
      AgentOptionConflict,
    ],
    ['an option that code sets', { option: 'plugins', value: false }, AgentOptionsNotEditable],
    [
      'a list edit on an option that is not a list',
      { option: 'caching', removeItems: [0], expectedItems: [] },
      AgentOptionsNotEditable,
    ],
  ] as const)('shouldRefuseAndKeepTheFileWhenTheEditTargets %s', async (_, edit, error) => {
    const workspace = await agent('typescript', KNOB_TYPESCRIPT)

    await expect(editAgentOptions(workspace, [edit])).rejects.toBeInstanceOf(error)

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(KNOB_TYPESCRIPT)
  })
})

describe.skipIf(!existsSync(pythonExecutable))(
  'reading and editing every create_harness option in Python source',
  () => {
    beforeEach(() => {
      vi.stubEnv('PYTHON', pythonExecutable)
    })

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('shouldReadAndEditPythonListsDictsAndBooleansWhenTheAgentFileIsPython', async () => {
      const workspace = await agent(
        'python',
        'agent = create_harness(model="bedrock/x", builtin_tools=["shell", "read"], mcp_servers={"github": {}, "docs": {}})\n'
      )

      expect(Object.fromEntries((await readAgentOptions(workspace))!)).toEqual({
        model: { kind: 'string', value: 'bedrock/x' },
        builtin_tools: {
          kind: 'list',
          items: [
            { text: '"shell"', literal: 'shell' },
            { text: '"read"', literal: 'read' },
          ],
        },
        mcp_servers: { kind: 'map', keys: ['github', 'docs'] },
      })

      await editAgentOptions(workspace, [
        { option: 'builtin_tools', removeItems: [0], expectedItems: ['"shell"', '"read"'] },
        { option: 'mcp_servers', removeKeys: ['github'] },
        { option: 'caching', value: false },
      ])

      expect(await readFile(workspace.entrypoint, 'utf8')).toBe(
        'agent = create_harness(model="bedrock/x", builtin_tools=["read"], mcp_servers={"docs": {}}, caching=False)\n'
      )
    })
  }
)

describe('unset createHarness options', () => {
  it('shouldTreatAnUnsetOptionAsItsHarnessDefaultWhenAnEditExpectsThatDefault', async () => {
    const workspace = await agent(
      'typescript',
      "import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ name: 'Demo' })\n"
    )

    await editAgentOptions(workspace, [
      { option: 'caching', value: true, expected: 'auto' },
      { option: 'contextManager', value: false, expected: 'auto' },
    ])

    expect(await readFile(workspace.entrypoint, 'utf8')).toContain('caching: true, contextManager: false')
  })
})
