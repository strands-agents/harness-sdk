import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentOptionConflict, AgentOptionsNotEditable, saveAgentOptions } from '../../src/dev/agent-options.js'
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
