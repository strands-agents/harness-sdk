import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsExit, TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import {
  readTemporaryEvaluators,
  temporaryEvaluatorArguments,
} from '../../../src/dev/temporary-evals-fork/evaluators.js'
import type { DevWorkspace, DevWorkspaceConfig } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const writeFileAt = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const workspaceFixture = async (language: DevWorkspaceConfig['language'] = 'python'): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  await writeFileAt(temporaryVenvPython(join(root, '.venv')), 'fixture interpreter')
  const entrypoint = language === 'python' ? 'agent.py' : 'agent.ts'
  return {
    directory: join(root, 'strands-dev'),
    root,
    entrypoint: join(root, entrypoint),
    config: { version: 1, name: 'desk', language, entrypoint, origin: { kind: 'discovered' } },
  }
}

const environmentRunner = (workspace: DevWorkspace) =>
  vi.fn(async ({ args }: TemporaryCommandRequest): Promise<string> => {
    if (args[1]?.includes('platform.python_version')) return JSON.stringify({ version: '3.12.4', paths: [] })
    if (args[0] === '-m' && args[1] === 'venv') await writeFileAt(temporaryVenvPython(args[3]!), 'fixture interpreter')
    if (args[1]?.includes('site.getsitepackages()[0]')) {
      const sitePackages = join(workspace.directory!, 'tmp/optimization/.venv/lib/site-packages')
      await mkdir(sitePackages, { recursive: true })
      return sitePackages
    }
    return ''
  })

const CATALOG = [
  {
    name: 'OutputEvaluator',
    kind: 'rubric',
    description: 'Scores the final answer against the rubric.',
    reads: 'output',
    settings: [{ name: 'rubric', type: 'string', required: false, description: 'Your rubric.' }],
    agents: ['python', 'typescript'],
  },
  {
    name: 'HelpfulnessEvaluator',
    kind: 'judge',
    description: 'Scores how helpful the answer is from the point of view of the user.',
    reads: 'trace',
    settings: [],
    agents: ['python'],
    limit: 'It reads the agent trace, and strands dev records a trace only for Python agents.',
  },
  {
    name: 'Contains',
    kind: 'check',
    description: 'Passes when the answer contains the text that you set.',
    reads: 'output',
    settings: [
      { name: 'value', type: 'string', required: true, description: 'The text that the answer must contain.' },
      { name: 'case_sensitive', type: 'boolean', required: false, description: 'Set it to false.' },
    ],
    agents: ['python', 'typescript'],
  },
  {
    name: 'InteractionsEvaluator',
    kind: 'rubric',
    description: 'Scores the messages between agents or components against the rubric.',
    reads: 'interactions',
    settings: [],
    agents: [],
    limit: 'It reads the messages between agents, and strands dev runs do not record them.',
  },
]

const listing = (stdout: string, code = 0, stderrTail: string[] = []) =>
  vi.fn(async (_process: TemporaryEvalsProcess): Promise<TemporaryEvalsExit> => ({ code, stdout, stderrTail }))

const read = async (workspace: DevWorkspace, spawnEvals: ReturnType<typeof listing>) =>
  readTemporaryEvaluators(workspace, {}, { run: environmentRunner(workspace), spawnEvals })

describe('TEMPORARY evaluator catalog', () => {
  it('shouldRunTheCatalogCommandOfTheForkInTheProjectWhenItReadsTheEvaluators', async () => {
    const workspace = await workspaceFixture()
    const spawnEvals = listing(JSON.stringify(CATALOG))

    await read(workspace, spawnEvals)

    expect(spawnEvals).toHaveBeenCalledOnce()
    expect(spawnEvals.mock.calls[0]![0]).toMatchObject({
      args: ['-m', 'strands_evals.cli', 'evaluators', '--json'],
      cwd: workspace.root,
    })
  })

  it.each<[DevWorkspaceConfig['language'], Record<string, boolean>]>([
    ['python', { OutputEvaluator: true, HelpfulnessEvaluator: true, Contains: true, InteractionsEvaluator: false }],
    [
      'typescript',
      { OutputEvaluator: true, HelpfulnessEvaluator: false, Contains: true, InteractionsEvaluator: false },
    ],
  ])('shouldMarkWhichEvaluatorsCanScoreTheAgentWhenItIsWrittenIn %s', async (language, expected) => {
    const workspace = await workspaceFixture(language)

    const evaluators = await read(workspace, listing(JSON.stringify(CATALOG)))

    expect(Object.fromEntries(evaluators.map(({ name, available }) => [name, available]))).toEqual(expected)
  })

  it('shouldGiveTheLimitOnlyWhenTheEvaluatorCannotScoreTheAgent', async () => {
    const workspace = await workspaceFixture('typescript')

    const evaluators = await read(workspace, listing(JSON.stringify(CATALOG)))

    expect(evaluators.find(({ name }) => name === 'HelpfulnessEvaluator')?.limit).toBe(CATALOG[1]!.limit)
    expect(evaluators.find(({ name }) => name === 'OutputEvaluator')).not.toHaveProperty('limit')
  })

  it('shouldKeepTheDescriptionAndEverySettingWhenTheCatalogListsThem', async () => {
    const workspace = await workspaceFixture()

    const evaluators = await read(workspace, listing(JSON.stringify(CATALOG)))

    expect(evaluators.find(({ name }) => name === 'Contains')).toEqual({
      name: 'Contains',
      kind: 'check',
      description: 'Passes when the answer contains the text that you set.',
      settings: [
        { name: 'value', type: 'string', required: true, description: 'The text that the answer must contain.' },
        { name: 'case_sensitive', type: 'boolean', required: false, description: 'Set it to false.' },
      ],
      available: true,
    })
  })

  it('shouldSayWhatFailedAndWhatToDoWhenTheCatalogCommandFails', async () => {
    const workspace = await workspaceFixture()
    const spawnEvals = listing('', 2, ["strands-evals: error: argument command: invalid choice: 'evaluators'"])

    await expect(read(workspace, spawnEvals)).rejects.toThrow(
      "strands-evals evaluators stopped with exit code 2: argument command: invalid choice: 'evaluators'\n" +
        'Restart strands dev so that it installs the TEMPORARY evals fork again, then try again.'
    )
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['an object instead of a list', '{}'],
    ['an entry without a description', JSON.stringify([{ ...CATALOG[0], description: undefined }])],
    ['an unknown kind', JSON.stringify([{ ...CATALOG[0], kind: 'oracle' }])],
    ['a setting of an unknown type', JSON.stringify([{ ...CATALOG[2], settings: [{ name: 'value', type: 'list' }] }])],
  ])('shouldRefuseTheCatalogWhenTheForkPrints %s', async (_case, stdout) => {
    const workspace = await workspaceFixture()

    await expect(read(workspace, listing(stdout))).rejects.toThrow(
      'strands-evals evaluators printed a list that strands dev cannot read'
    )
  })

  it('shouldPassANameAloneWhenTheChoiceHasNoSettings', () => {
    expect(temporaryEvaluatorArguments([{ name: 'HelpfulnessEvaluator' }, { name: 'Equals', settings: {} }])).toEqual([
      '--evaluator',
      'HelpfulnessEvaluator',
      '--evaluator',
      'Equals',
    ])
  })
})
