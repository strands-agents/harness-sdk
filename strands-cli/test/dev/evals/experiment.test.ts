import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { GenerationSettings } from '../../../src/dev/evals/model.js'
import { prepareEvalsOptimizerEnvironment } from '../../../src/dev/evals/environment.js'
import type { EvalsProcess } from '../../../src/dev/evals/evals-process.js'
import {
  createEvalsExperimentCases,
  generateEvalsExperiment,
  generatorModelId,
  generatorModelProblem,
  listEvalsExperiments,
  readEvalsExperimentFile,
  evalsDropIncompleteCases,
  evalsGenerateArguments,
  evalsGenerationError,
  evalsGenerationFiles,
  evalsJudgeEvaluatorCount,
  evalsNamedExperiment,
  evalsRunnableExperiment,
  writeEvalsExperimentFile,
  type EvalsRawCase,
} from '../../../src/dev/evals/experiment.js'
import { environmentRunner, workspaceFixture, writeFileAt } from '../../fixtures/optimizer-run.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const settings = (overrides: Partial<GenerationSettings> = {}): GenerationSettings => ({
  name: 'refunds',
  task: 'Answer refund questions',
  context: '',
  cases: 3,
  topics: 0,
  model: '',
  ...overrides,
})

const flagValue = (args: readonly string[], flag: string): string => args[args.indexOf(flag) + 1]!

const completeCases = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    name: `c${index}`,
    input: `question ${index}`,
    expected_output: `answer ${index}`,
  }))

const generating = (cases: readonly object[]) =>
  vi.fn(async ({ args }: EvalsProcess) => {
    await writeFileAt(flagValue(args, '--output'), JSON.stringify({ cases }))
    return { code: 0, stdout: '', stderrTail: [] }
  })

const NOW = new Date('2026-11-12T15:30:12Z')

describe('experiment generation', () => {
  it('shouldRejectAnUnsupportedConnectionBeforePreparingTheEnvironment', async () => {
    const workspace = await workspaceFixture([])
    const run = vi.fn()
    const spawn = vi.fn()
    await expect(
      generateEvalsExperiment(
        {
          workspace,
          settings: settings({ model: 'openai.gpt-6.1-sol' }),
          context: 'diagnostic agent',
          files: { draft: '/unused/draft', log: '/unused/log' },
        },
        { run, spawnGenerator: spawn }
      )
    ).rejects.toThrow('separate AWS Bedrock connection')
    expect(run).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('shouldRemoveOnlyAnExplicitBedrockProviderPrefixForTheEvalsCli', () => {
    const args = evalsGenerateArguments(settings({ model: 'bedrock/openai.gpt-oss-120b-1:0' }), 'context', {
      draft: 'd',
      log: 'l',
    })
    expect(args[args.indexOf('--model') + 1]).toBe('openai.gpt-oss-120b-1:0')
  })

  it('shouldPassOnlyTheFlagsOfUpstreamGenerateWhenTheSettingsSetThem', () => {
    const files = { draft: '/d/refunds.json', log: '/d/refunds.log' }

    const args = evalsGenerateArguments(
      settings({ topics: 3, model: 'us.anthropic.claude-sonnet' }),
      'An agent for refunds',
      files
    )

    expect(args).toEqual([
      '-m',
      'strands_evals.cli',
      'generate',
      '--context',
      'An agent for refunds',
      '--task-description',
      'Answer refund questions',
      '--num-cases',
      '3',
      '--num-topics',
      '3',
      '--evaluator',
      'OutputEvaluator',
      '--model',
      'us.anthropic.claude-sonnet',
      '--output',
      '/d/refunds.json',
    ])
  })

  it('shouldLeaveOptionalFlagsOutWhenTheDefaultsAreUsed', () => {
    const args = evalsGenerateArguments(settings(), 'context', { draft: 'd', log: 'l' })

    expect(args).not.toContain('--num-topics')
    expect(args).not.toContain('--model')
    expect(flagValue(args, '--evaluator')).toBe('OutputEvaluator')
  })

  it('shouldPutTheDraftAndTheLogNextToEachOtherWhenFilesAreNamed', () => {
    const files = evalsGenerationFiles('/w/strands-dev', 'refunds', NOW)

    expect(files).toEqual({
      draft: join('/w/strands-dev', 'tmp', '.state', 'drafts', '20261112-153012-refunds.json'),
      log: join('/w/strands-dev', 'tmp', '.state', 'drafts', '20261112-153012-refunds.log'),
    })
  })

  it('shouldSayThatItWritesCasesAndReturnTheDraftWhenGenerationSucceeds', async () => {
    const workspace = await workspaceFixture([])
    const files = evalsGenerationFiles(workspace.directory!, 'refunds', NOW)
    const onGenerating = vi.fn()

    const outcome = await generateEvalsExperiment(
      { workspace, settings: settings(), context: 'context', files, onGenerating },
      { run: environmentRunner(), spawnGenerator: generating(completeCases(2)) }
    )

    expect(outcome).toEqual({ path: files.draft, dropped: 0 })
    expect(onGenerating).toHaveBeenCalledTimes(1)
  })

  it('shouldDeleteTheDraftAndSayWhyWhenEveryCaseFails', async () => {
    const workspace = await workspaceFixture([])
    const files = evalsGenerationFiles(workspace.directory!, 'refunds', NOW)

    await expect(
      generateEvalsExperiment(
        { workspace, settings: settings(), context: 'context', files },
        { run: environmentRunner(), spawnGenerator: generating([]) }
      )
    ).rejects.toThrow('wrote no cases, because every case failed')

    expect(existsSync(files.draft)).toBe(false)
  })

  it('shouldLeaveOutTheCasesWithABlankInputOrExpectedAnswerWhenTheGeneratorWritesThem', async () => {
    const workspace = await workspaceFixture([])
    const files = evalsGenerationFiles(workspace.directory!, 'refunds', NOW)
    const complete = { name: 'c0', input: 'question 0', expected_output: 'answer 0' }
    const written = [
      complete,
      { name: 'c1', input: '  ', expected_output: 'answer 1' },
      { name: 'c2', input: 'question 2', expected_output: '' },
      { name: 'c3', input: 'question 3', expected_output: null },
    ]

    const outcome = await generateEvalsExperiment(
      { workspace, settings: settings(), context: 'context', files },
      { run: environmentRunner(), spawnGenerator: generating(written) }
    )

    expect(outcome).toEqual({ path: files.draft, dropped: 3 })
    expect(JSON.parse(await readFile(files.draft, 'utf8')).cases).toEqual([complete])
  })

  it('shouldDeleteTheDraftAndSayWhyWhenEveryGeneratedCaseHasABlankInputOrExpectedAnswer', async () => {
    const workspace = await workspaceFixture([])
    const files = evalsGenerationFiles(workspace.directory!, 'refunds', NOW)

    await expect(
      generateEvalsExperiment(
        { workspace, settings: settings(), context: 'context', files },
        {
          run: environmentRunner(),
          spawnGenerator: generating([{ name: 'c0', input: '', expected_output: 'answer 0' }]),
        }
      )
    ).rejects.toThrow('strands-evals generate wrote no case with both an input and an expected answer')

    expect(existsSync(files.draft)).toBe(false)
  })

  it('shouldGiveTheFlagErrorAndANextStepWhenGenerateRejectsASetting', async () => {
    const workspace = await workspaceFixture([])
    const rejected = vi.fn(async (_process: EvalsProcess) => ({
      code: 2,
      stdout: '',
      stderrTail: [
        'usage: strands-evals generate [-h] ...',
        "strands-evals generate: error: argument --num-cases: invalid int value: 'many'",
      ],
    }))

    await expect(
      generateEvalsExperiment(
        {
          workspace,
          settings: settings(),
          context: 'context',
          files: evalsGenerationFiles(workspace.directory!, 'refunds', NOW),
        },
        { run: environmentRunner(), spawnGenerator: rejected }
      )
    ).rejects.toThrow(
      "strands-evals generate stopped with exit code 2: argument --num-cases: invalid int value: 'many'\n" +
        'Change the setting that the error names, then try again.'
    )
  })

  it('shouldNotStartTheGeneratorWhenItWasCancelledDuringSetup', async () => {
    const workspace = await workspaceFixture([])
    const abort = new AbortController()
    abort.abort()
    const spawnGenerator = generating(completeCases(1))

    await expect(
      generateEvalsExperiment(
        {
          workspace,
          settings: settings(),
          context: 'context',
          files: evalsGenerationFiles(workspace.directory!, 'refunds', NOW),
          signal: abort.signal,
        },
        { run: environmentRunner(), spawnGenerator }
      )
    ).rejects.toThrow()

    expect(spawnGenerator).not.toHaveBeenCalled()
    await prepareEvalsOptimizerEnvironment(
      { workspaceDirectory: workspace.directory!, projectRoot: workspace.root, language: 'python' },
      { run: environmentRunner() }
    )
  })

  it('shouldNameTheRejectedSettingAndPointToTheChatWhenGenerateRejectsItsFlags', () => {
    const error = new Error(
      "strands-evals generate stopped with exit code 2: argument --num-cases: invalid int value: 'many'\n" +
        'Change the setting that the error names, then try again.'
    )

    expect(evalsGenerationError(error, settings()).summary).toBe("invalid int value: 'many'")
  })

  it.each([
    [
      'ExpiredTokenException: The security token included in the request is expired',
      'AWS credentials are missing or expired',
    ],
    ["AccessDeniedException: You don't have access to the model", 'Bedrock denied access to us.model'],
    ['ThrottlingException: Too many requests', 'Bedrock throttled the requests'],
    ['ValidationException: The provided model identifier is invalid.', 'Bedrock cannot use us.model'],
    ['EndpointConnectionError: Could not connect to the endpoint URL', 'Could not reach Bedrock'],
    ['ZeroDivisionError: division by zero', 'ZeroDivisionError: division by zero'],
    [
      'AccessDeniedException: not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:us-west-2:1:inference-profile/global.anthropic.claude-sonnet-4-6 because no policy allows it',
      'Bedrock denied access to global.anthropic.claude-sonnet-4-6',
    ],
  ])('shouldExplainTheFailureCleanlyWhenTheGeneratorReports%s', (reported, summary) => {
    const failure = evalsGenerationError(
      new Error(reported),
      settings({ model: reported.includes('inference-profile') ? '' : 'us.model' })
    )

    expect(failure.summary).toBe(summary)
  })
})

const rawCase = (name: string, input: unknown = `question for ${name}`, expected: unknown = `answer for ${name}`) => ({
  name,
  session_id: `session-${name}`,
  input,
  expected_output: expected,
  expected_assertion: null,
  expected_trajectory: null,
  expected_interactions: null,
  expected_environment_state: null,
  metadata: { source: 'generator' },
})

const experimentDocument = (...cases: EvalsRawCase[]) => ({
  cases,
  evaluators: [{ evaluator_type: 'OutputEvaluator', rubric: 'Correct and kind.' }],
})

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, JSON.stringify(value, null, 2))
}

const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'))

const experimentFile = (folder: string, name: string): string => join(folder, name, `${name}.json`)

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

describe('experiment files', () => {
  it('shouldListExperimentsByNameWithTheirCaseCountsWhenTheFolderHasFiles', async () => {
    const folder = await temporaryDirectory()
    await writeFileAt(
      experimentFile(folder, 'refunds'),
      JSON.stringify(experimentDocument(rawCase('c0'), rawCase('c1')))
    )
    await writeFileAt(experimentFile(folder, 'billing'), JSON.stringify(experimentDocument(rawCase('c0'))))
    await writeFileAt(experimentFile(folder, 'billing-v2'), JSON.stringify(experimentDocument()))
    await writeFileAt(experimentFile(folder, 'broken'), '{"cases": [')
    await writeFile(join(folder, 'notes.txt'), 'not an experiment')
    await writeJson(join(folder, 'loose.json'), experimentDocument(rawCase('c0')))
    await writeFileAt(join(folder, 'drafts', 'refunds.json'), JSON.stringify(experimentDocument(rawCase('c0'))))

    const experiments = await listEvalsExperiments(folder)

    expect(experiments).toEqual([
      { name: 'billing', path: experimentFile(folder, 'billing'), caseCount: 1 },
      { name: 'billing-v2', path: experimentFile(folder, 'billing-v2'), caseCount: 0 },
      { name: 'broken', path: experimentFile(folder, 'broken'), caseCount: 0 },
      { name: 'refunds', path: experimentFile(folder, 'refunds'), caseCount: 2 },
    ])
  })

  it('shouldListNothingWhenTheFolderIsMissing', async () => {
    const folder = join(await temporaryDirectory(), 'experiments')

    await expect(listEvalsExperiments(folder)).resolves.toEqual([])
  })

  it('shouldReadCasesAndEvaluatorsWhenTheFileIsAnExperiment', async () => {
    const path = join(await temporaryDirectory(), 'refunds.json')
    const document = {
      ...experimentDocument(rawCase('c0'), rawCase('c1', { order: 7, items: ['shoe'] }, null), {
        input: 'unnamed',
      }),
      evaluators: [{ evaluator_type: 'Equals' }, { evaluator_type: 'OutputEvaluator', name: 'judge' }],
    }
    await writeJson(path, document)

    const { experiment, raw } = await readEvalsExperimentFile(path)

    expect(experiment).toEqual({
      name: 'refunds',
      path,
      cases: [
        { name: 'c0', input: 'question for c0', expected: 'answer for c0' },
        { name: 'c1', input: '{"order":7,"items":["shoe"]}' },
        { name: 'case_2', input: 'unnamed' },
      ],
      evaluators: ['Equals', 'judge'],
    })
    expect(raw).toEqual(document)
  })

  it.each([
    { content: '{"cases": [', detail: 'JSON' },
    { content: '[]', detail: 'it has no list of cases' },
    { content: '{"cases": 3}', detail: 'it has no list of cases' },
    { content: '{"cases": ["c0"]}', detail: 'it has no list of cases' },
  ])('shouldNameTheFileAndTheFixWhenTheFileHolds$content', async ({ content, detail }) => {
    const path = join(await temporaryDirectory(), 'refunds.json')
    await writeFile(path, content)

    await expect(readEvalsExperimentFile(path)).rejects.toThrow(
      new RegExp(
        `^${literal(path)} is not a usable Experiment file \\(.*${detail}.*\\)\\. Fix the file or delete it`,
        'u'
      )
    )
  })

  it('shouldWriteOnlyTheKeptCasesInTheGivenOrderWhenADraftIsSaved', async () => {
    const folder = await temporaryDirectory()
    const path = join(folder, 'refunds.json')
    const document = { ...experimentDocument(rawCase('c0'), rawCase('c1'), rawCase('c2')), version: 'kept field' }

    await writeEvalsExperimentFile(path, document, ['c2', 'c0'])

    expect(await readJson(path)).toEqual({ ...document, cases: [rawCase('c2'), rawCase('c0')] })
    expect(await readdir(folder)).toEqual(['refunds.json'])
  })

  it('shouldKeepBothCasesWhenTwoKeptCasesShareAName', async () => {
    const path = join(await temporaryDirectory(), 'refunds.json')
    const first = rawCase('refund')
    const second = { ...rawCase('refund', 'second question'), session_id: 'session-second' }

    await writeEvalsExperimentFile(path, experimentDocument(first, second), ['refund', 'refund'])

    expect((await readJson(path)).cases).toEqual([first, second])
  })

  it('shouldWriteNothingWhenAKeptCaseIsNotInTheDocument', async () => {
    const folder = await temporaryDirectory()
    const path = join(folder, 'refunds.json')
    await writeJson(path, experimentDocument(rawCase('c0')))

    await expect(writeEvalsExperimentFile(path, experimentDocument(rawCase('c0')), ['c9'])).rejects.toThrow(
      'The experiment has no case named c9, so nothing was written.'
    )
    expect(await readJson(path)).toEqual(experimentDocument(rawCase('c0')))
    expect(await readdir(folder)).toEqual(['refunds.json'])
  })

  it('shouldRefuseToReplaceAFileWhenANewExperimentIsCreated', async () => {
    const path = join(await temporaryDirectory(), 'refunds.json')
    await writeJson(path, experimentDocument(rawCase('c0')))

    await expect(createEvalsExperimentCases(path, experimentDocument(), [rawCase('c1')])).rejects.toThrow(
      'exists already, so nothing was saved'
    )

    expect(await readJson(path)).toEqual(experimentDocument(rawCase('c0')))
    expect(await readdir(join(path, '..'))).toEqual(['refunds.json'])
  })

  it('shouldDropTheCasesWithABlankInputOrExpectedAnswerWhenADraftIsChecked', async () => {
    const path = join(await temporaryDirectory(), 'draft.json')
    await writeJson(
      path,
      experimentDocument(
        rawCase('c0'),
        rawCase('c1', ' '),
        rawCase('c2', null),
        rawCase('c3', 'question', '\n'),
        rawCase('c4', 'question', null),
        rawCase('c5', { order: 7 }, { refund: true })
      )
    )

    const checked = await evalsDropIncompleteCases(path)

    expect(checked).toEqual({ complete: 2, dropped: 4 })
    expect(await readJson(path)).toEqual(
      experimentDocument(rawCase('c0'), rawCase('c5', { order: 7 }, { refund: true }))
    )
  })

  it('shouldLeaveTheFileAsItIsWhenEveryCaseHasAnInputAndAnExpectedAnswer', async () => {
    const path = join(await temporaryDirectory(), 'draft.json')
    const text = JSON.stringify(experimentDocument(rawCase('c0'), rawCase('c1')))
    await writeFile(path, text)

    const checked = await evalsDropIncompleteCases(path)

    expect(checked).toEqual({ complete: 2, dropped: 0 })
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it.each<[string, unknown[], string[]]>([
    ['repeat in any case', ['refund', 'refund', 'Refund'], ['refund', 'refund-2', 'Refund-3']],
    ['are missing', [null, undefined, '', 'case_1'], ['case_0', 'case_1', 'case_2', 'case_1-2']],
    [
      'contain characters that a file name cannot hold',
      ['a/b', 'a\\b', 'Step 1: why?'],
      ['a-b', 'a-b-2', 'Step 1- why-'],
    ],
  ])('shouldGiveEveryCaseAUniqueFileNameWhenNames%s', (_case, names, expected) => {
    const document = experimentDocument(...names.map((name, index) => ({ ...rawCase(`c${index}`), name })))

    const named = evalsNamedExperiment(document)

    expect(named.cases.map(({ name }) => name)).toEqual(expected)
    expect(named.cases.map(({ input }) => input)).toEqual(document.cases.map(({ input }) => input))
    expect(named.evaluators).toEqual(document.evaluators)
  })

  it('shouldRunTheExperimentItselfWhenItsCaseNamesAreUnique', async () => {
    const folder = await temporaryDirectory()
    const path = join(folder, 'refunds.json')
    await writeJson(path, experimentDocument(rawCase('c0'), rawCase('c1')))

    const runnable = await evalsRunnableExperiment(path, join(folder, 'copy.json'))

    expect(runnable).toBe(path)
    expect(await readdir(folder)).toEqual(['refunds.json'])
  })

  it('shouldRunACopyWithUniqueNamesWhenCaseNamesRepeat', async () => {
    const folder = await temporaryDirectory()
    const path = join(folder, 'refunds.json')
    const document = experimentDocument(rawCase('refund'), rawCase('refund', 'second question'))
    await writeJson(path, document)
    const copy = join(folder, 'copy.json')

    const runnable = await evalsRunnableExperiment(path, copy)

    expect(runnable).toBe(copy)
    expect((await readJson(copy)).cases.map(({ name, input }: EvalsRawCase) => [name, input])).toEqual([
      ['refund', 'question for refund'],
      ['refund-2', 'second question'],
    ])
    expect(await readJson(path)).toEqual(document)
  })
})

describe('expected assertions', () => {
  const assertionCase = (name: string, assertion: unknown, expected: unknown = null) => ({
    ...rawCase(name, `question for ${name}`, expected),
    expected_assertion: assertion,
  })

  it('shouldReadTheAssertionAsTheExpectedAnswerWhenACaseHasNoExpectedOutput', async () => {
    const path = join(await temporaryDirectory(), 'from-chats.json')
    await writeJson(
      path,
      experimentDocument(
        assertionCase('c0', 'The agent refunds order 7.'),
        assertionCase('c1', 'The agent refunds order 8.', 'Refunded.'),
        assertionCase('c2', '  ', null)
      )
    )

    const { experiment } = await readEvalsExperimentFile(path)

    expect(experiment.cases).toEqual([
      { name: 'c0', input: 'question for c0', expected: 'The agent refunds order 7.' },
      { name: 'c1', input: 'question for c1', expected: 'Refunded.' },
      { name: 'c2', input: 'question for c2' },
    ])
  })

  it('shouldKeepACaseWithOnlyAnAssertionWhenADraftIsChecked', async () => {
    const path = join(await temporaryDirectory(), 'from-chats.json')
    const document = experimentDocument(assertionCase('c0', 'The agent refunds order 7.'), assertionCase('c1', ''))
    await writeJson(path, document)

    const checked = await evalsDropIncompleteCases(path)

    expect(checked).toEqual({ complete: 1, dropped: 1 })
    expect(await readJson(path)).toEqual(experimentDocument(assertionCase('c0', 'The agent refunds order 7.')))
  })
})

describe('judge evaluators of an experiment', () => {
  it.each([
    { case: 'only Equals', evaluators: [{ evaluator_type: 'Equals' }], judges: 0 },
    {
      case: 'every check evaluator',
      evaluators: [
        'Equals',
        'Contains',
        'StartsWith',
        'ToolCalled',
        'SkillInvoked',
        'StructuredOutputSimilarity',
        'StateEquals',
      ].map((type) => ({ evaluator_type: type })),
      judges: 0,
    },
    { case: 'a labelled check', evaluators: [{ evaluator_type: 'Equals', name: 'exact' }], judges: 0 },
    {
      case: 'a rubric next to checks',
      evaluators: [{ evaluator_type: 'Contains', value: 'Paris' }, { evaluator_type: 'OutputEvaluator' }],
      judges: 1,
    },
    { case: 'a custom evaluator', evaluators: [{ evaluator_type: 'my_module:Grader' }], judges: 1 },
    { case: 'an entry without a type', evaluators: [{ name: 'unknown' }], judges: 1 },
    { case: 'no list', evaluators: undefined, judges: 0 },
  ])('shouldCountOnlyTheEvaluatorsThatCallAModelWhenTheExperimentHas $case', ({ evaluators, judges }) => {
    expect(evalsJudgeEvaluatorCount(evaluators)).toBe(judges)
  })
})

describe('separate Bedrock generator connection', () => {
  it.each(['openai.gpt-6.1-sol', 'openai/gpt-5', 'anthropic/claude-sonnet-4-6', 'ollama/local', 'made-up'])(
    'rejects ambiguous or non-Bedrock model %s before running',
    (model) => {
      expect(generatorModelProblem(model)).toContain('not the chat provider')
      expect(() => generatorModelId(model)).toThrow('Choose a Bedrock model ID')
    }
  )
  it.each([
    ['', ''],
    [
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet',
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet',
    ],
    ['global.anthropic.claude-sonnet-4-6', 'global.anthropic.claude-sonnet-4-6'],
    ['bedrock/amazon.nova-pro-v1:0', 'amazon.nova-pro-v1:0'],
    ['bedrock/openai.gpt-oss-120b-1:0', 'openai.gpt-oss-120b-1:0'],
  ])('normalizes explicit Bedrock selection %s', (model, id) => {
    expect(generatorModelProblem(model)).toBeUndefined()
    expect(generatorModelId(model)).toBe(id)
  })
})
