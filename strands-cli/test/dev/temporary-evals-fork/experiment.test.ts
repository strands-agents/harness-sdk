import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { GenerationSettings } from '../../../src/dev/panels/model.js'
import { prepareTemporaryOptimizerEnvironment } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import {
  createTemporaryExperimentCases,
  generateTemporaryExperiment,
  generatorModelId,
  generatorModelProblem,
  listTemporaryExperiments,
  readTemporaryExperimentFile,
  temporaryDropIncompleteCases,
  temporaryGenerateArguments,
  temporaryGenerationError,
  temporaryGenerationFiles,
  temporaryJudgeEvaluatorCount,
  temporaryNamedExperiment,
  temporaryRunnableExperiment,
  writeTemporaryExperimentFile,
  type TemporaryRawCase,
} from '../../../src/dev/temporary-evals-fork/experiment.js'
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
  vi.fn(async ({ args }: TemporaryEvalsProcess) => {
    await writeFileAt(flagValue(args, '--output'), JSON.stringify({ cases }))
    return { code: 0, stdout: '', stderrTail: [] }
  })

const NOW = new Date('2026-11-12T15:30:12Z')

describe('TEMPORARY experiment generation', () => {
  it('shouldRejectAnUnsupportedConnectionBeforePreparingTheEnvironment', async () => {
    const workspace = await workspaceFixture([])
    const run = vi.fn()
    const spawn = vi.fn()
    await expect(
      generateTemporaryExperiment(
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
    const args = temporaryGenerateArguments(settings({ model: 'bedrock/openai.gpt-oss-120b-1:0' }), 'context', {
      draft: 'd',
      log: 'l',
    })
    expect(args[args.indexOf('--model') + 1]).toBe('openai.gpt-oss-120b-1:0')
  })

  it('shouldPassOnlyTheFlagsOfUpstreamGenerateWhenTheSettingsSetThem', () => {
    const files = { draft: '/d/refunds.json', log: '/d/refunds.log' }

    const args = temporaryGenerateArguments(
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
    const args = temporaryGenerateArguments(settings(), 'context', { draft: 'd', log: 'l' })

    expect(args).not.toContain('--num-topics')
    expect(args).not.toContain('--model')
    expect(flagValue(args, '--evaluator')).toBe('OutputEvaluator')
  })

  it('shouldPutTheDraftAndTheLogNextToEachOtherWhenFilesAreNamed', () => {
    const files = temporaryGenerationFiles('/w/strands-dev', 'refunds', NOW)

    expect(files).toEqual({
      draft: join('/w/strands-dev', 'tmp', '.state', 'drafts', '20261112-153012-refunds.json'),
      log: join('/w/strands-dev', 'tmp', '.state', 'drafts', '20261112-153012-refunds.log'),
    })
  })

  it('shouldSayThatItWritesCasesAndReturnTheDraftWhenGenerationSucceeds', async () => {
    const workspace = await workspaceFixture([])
    const files = temporaryGenerationFiles(workspace.directory!, 'refunds', NOW)
    const onGenerating = vi.fn()

    const outcome = await generateTemporaryExperiment(
      { workspace, settings: settings(), context: 'context', files, onGenerating },
      { run: environmentRunner(), spawnGenerator: generating(completeCases(2)) }
    )

    expect(outcome).toEqual({ path: files.draft, cases: 2, dropped: 0 })
    expect(onGenerating).toHaveBeenCalledTimes(1)
  })

  it('shouldDeleteTheDraftAndSayWhyWhenEveryCaseFails', async () => {
    const workspace = await workspaceFixture([])
    const files = temporaryGenerationFiles(workspace.directory!, 'refunds', NOW)

    await expect(
      generateTemporaryExperiment(
        { workspace, settings: settings(), context: 'context', files },
        { run: environmentRunner(), spawnGenerator: generating([]) }
      )
    ).rejects.toThrow('wrote no cases, because every case failed')

    expect(existsSync(files.draft)).toBe(false)
  })

  it('shouldLeaveOutTheCasesWithABlankInputOrExpectedAnswerWhenTheGeneratorWritesThem', async () => {
    const workspace = await workspaceFixture([])
    const files = temporaryGenerationFiles(workspace.directory!, 'refunds', NOW)
    const complete = { name: 'c0', input: 'question 0', expected_output: 'answer 0' }
    const written = [
      complete,
      { name: 'c1', input: '  ', expected_output: 'answer 1' },
      { name: 'c2', input: 'question 2', expected_output: '' },
      { name: 'c3', input: 'question 3', expected_output: null },
    ]

    const outcome = await generateTemporaryExperiment(
      { workspace, settings: settings(), context: 'context', files },
      { run: environmentRunner(), spawnGenerator: generating(written) }
    )

    expect(outcome).toEqual({ path: files.draft, cases: 1, dropped: 3 })
    expect(JSON.parse(await readFile(files.draft, 'utf8')).cases).toEqual([complete])
  })

  it('shouldDeleteTheDraftAndSayWhyWhenEveryGeneratedCaseHasABlankInputOrExpectedAnswer', async () => {
    const workspace = await workspaceFixture([])
    const files = temporaryGenerationFiles(workspace.directory!, 'refunds', NOW)

    await expect(
      generateTemporaryExperiment(
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
    const rejected = vi.fn(async (_process: TemporaryEvalsProcess) => ({
      code: 2,
      stdout: '',
      stderrTail: [
        'usage: strands-evals generate [-h] ...',
        "strands-evals generate: error: argument --num-cases: invalid int value: 'many'",
      ],
    }))

    await expect(
      generateTemporaryExperiment(
        {
          workspace,
          settings: settings(),
          context: 'context',
          files: temporaryGenerationFiles(workspace.directory!, 'refunds', NOW),
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
      generateTemporaryExperiment(
        {
          workspace,
          settings: settings(),
          context: 'context',
          files: temporaryGenerationFiles(workspace.directory!, 'refunds', NOW),
          signal: abort.signal,
        },
        { run: environmentRunner(), spawnGenerator }
      )
    ).rejects.toThrow()

    expect(spawnGenerator).not.toHaveBeenCalled()
    await prepareTemporaryOptimizerEnvironment(
      { workspaceDirectory: workspace.directory!, projectRoot: workspace.root, language: 'python' },
      { run: environmentRunner() }
    )
  })

  it('shouldNameTheRejectedSettingAndPointToTheChatWhenGenerateRejectsItsFlags', () => {
    const error = new Error(
      "strands-evals generate stopped with exit code 2: argument --num-cases: invalid int value: 'many'\n" +
        'Change the setting that the error names, then try again.'
    )

    const failure = temporaryGenerationError(error, { settings: settings(), log: '/d/refunds.log' })

    expect(failure.summary).toBe("invalid int value: 'many'")
    expect(failure.detail.split('\n')[0]).toBe(
      'Change the setting that the error below names in the chat, then generate again.'
    )
    expect(failure.detail).toContain('strands-evals said: strands-evals generate stopped with exit code 2')
  })

  it.each([
    [
      'ExpiredTokenException: The security token included in the request is expired',
      'AWS credentials are missing or expired',
      'Refresh your AWS credentials',
    ],
    [
      "AccessDeniedException: You don't have access to the model",
      'Bedrock denied access to us.model',
      'choose a model that your AWS account can use',
    ],
    ['ThrottlingException: Too many requests', 'Bedrock throttled the requests', 'retry in a few minutes'],
    ['ValidationException: The provided model identifier is invalid.', 'Bedrock cannot use us.model', 'fix the Model'],
    ['EndpointConnectionError: Could not connect to the endpoint URL', 'Could not reach Bedrock', 'Check your network'],
    ['ZeroDivisionError: division by zero', 'ZeroDivisionError: division by zero', 'Read the log for the cause'],
    [
      'AccessDeniedException: not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:us-west-2:1:inference-profile/global.anthropic.claude-sonnet-4-6 because no policy allows it',
      'Bedrock denied access to global.anthropic.claude-sonnet-4-6',
      'choose a model that your AWS account can use',
    ],
  ])('shouldExplainTheFailureCleanlyWhenTheGeneratorReports%s', (reported, summary, next) => {
    const failure = temporaryGenerationError(new Error(reported), {
      settings: settings({ model: reported.includes('inference-profile') ? '' : 'us.model' }),
      log: 'strands-dev/tmp/.state/drafts/refunds.log',
    })

    expect(failure.summary).toBe(summary)
    expect(failure.detail).toContain(next)
    expect(failure.detail).toContain('Log: strands-dev/tmp/.state/drafts/refunds.log')
    expect(failure.detail.match(/strands-evals said/gu)).toHaveLength(1)
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

const experimentDocument = (...cases: TemporaryRawCase[]) => ({
  cases,
  evaluators: [{ evaluator_type: 'OutputEvaluator', rubric: 'Correct and kind.' }],
})

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, JSON.stringify(value, null, 2))
}

const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'))

const experimentFile = (folder: string, name: string): string => join(folder, name, `${name}.json`)

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

describe('TEMPORARY experiment files', () => {
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

    const experiments = await listTemporaryExperiments(folder)

    expect(experiments).toEqual([
      { name: 'billing', path: experimentFile(folder, 'billing'), caseCount: 1 },
      { name: 'billing-v2', path: experimentFile(folder, 'billing-v2'), caseCount: 0 },
      { name: 'broken', path: experimentFile(folder, 'broken'), caseCount: 0 },
      { name: 'refunds', path: experimentFile(folder, 'refunds'), caseCount: 2 },
    ])
  })

  it('shouldListNothingWhenTheFolderIsMissing', async () => {
    const folder = join(await temporaryDirectory(), 'experiments')

    await expect(listTemporaryExperiments(folder)).resolves.toEqual([])
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

    const { experiment, raw } = await readTemporaryExperimentFile(path)

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

    await expect(readTemporaryExperimentFile(path)).rejects.toThrow(
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

    await writeTemporaryExperimentFile(path, document, ['c2', 'c0'])

    expect(await readJson(path)).toEqual({ ...document, cases: [rawCase('c2'), rawCase('c0')] })
    expect(await readdir(folder)).toEqual(['refunds.json'])
  })

  it('shouldKeepBothCasesWhenTwoKeptCasesShareAName', async () => {
    const path = join(await temporaryDirectory(), 'refunds.json')
    const first = rawCase('refund')
    const second = { ...rawCase('refund', 'second question'), session_id: 'session-second' }

    await writeTemporaryExperimentFile(path, experimentDocument(first, second), ['refund', 'refund'])

    expect((await readJson(path)).cases).toEqual([first, second])
  })

  it('shouldWriteNothingWhenAKeptCaseIsNotInTheDocument', async () => {
    const folder = await temporaryDirectory()
    const path = join(folder, 'refunds.json')
    await writeJson(path, experimentDocument(rawCase('c0')))

    await expect(writeTemporaryExperimentFile(path, experimentDocument(rawCase('c0')), ['c9'])).rejects.toThrow(
      'The experiment has no case named c9, so nothing was written.'
    )
    expect(await readJson(path)).toEqual(experimentDocument(rawCase('c0')))
    expect(await readdir(folder)).toEqual(['refunds.json'])
  })

  it('shouldRefuseToReplaceAFileWhenANewExperimentIsCreated', async () => {
    const path = join(await temporaryDirectory(), 'refunds.json')
    await writeJson(path, experimentDocument(rawCase('c0')))

    await expect(createTemporaryExperimentCases(path, experimentDocument(), [rawCase('c1')])).rejects.toThrow(
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

    const checked = await temporaryDropIncompleteCases(path)

    expect(checked).toEqual({ complete: 2, dropped: 4 })
    expect(await readJson(path)).toEqual(
      experimentDocument(rawCase('c0'), rawCase('c5', { order: 7 }, { refund: true }))
    )
  })

  it('shouldLeaveTheFileAsItIsWhenEveryCaseHasAnInputAndAnExpectedAnswer', async () => {
    const path = join(await temporaryDirectory(), 'draft.json')
    const text = JSON.stringify(experimentDocument(rawCase('c0'), rawCase('c1')))
    await writeFile(path, text)

    const checked = await temporaryDropIncompleteCases(path)

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

    const named = temporaryNamedExperiment(document)

    expect(named.cases.map(({ name }) => name)).toEqual(expected)
    expect(named.cases.map(({ input }) => input)).toEqual(document.cases.map(({ input }) => input))
    expect(named.evaluators).toEqual(document.evaluators)
  })

  it('shouldRunTheExperimentItselfWhenItsCaseNamesAreUnique', async () => {
    const folder = await temporaryDirectory()
    const path = join(folder, 'refunds.json')
    await writeJson(path, experimentDocument(rawCase('c0'), rawCase('c1')))

    const runnable = await temporaryRunnableExperiment(path, join(folder, 'copy.json'))

    expect(runnable).toBe(path)
    expect(await readdir(folder)).toEqual(['refunds.json'])
  })

  it('shouldRunACopyWithUniqueNamesWhenCaseNamesRepeat', async () => {
    const folder = await temporaryDirectory()
    const path = join(folder, 'refunds.json')
    const document = experimentDocument(rawCase('refund'), rawCase('refund', 'second question'))
    await writeJson(path, document)
    const copy = join(folder, 'copy.json')

    const runnable = await temporaryRunnableExperiment(path, copy)

    expect(runnable).toBe(copy)
    expect((await readJson(copy)).cases.map(({ name, input }: TemporaryRawCase) => [name, input])).toEqual([
      ['refund', 'question for refund'],
      ['refund-2', 'second question'],
    ])
    expect(await readJson(path)).toEqual(document)
  })
})

describe('TEMPORARY expected assertions', () => {
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

    const { experiment } = await readTemporaryExperimentFile(path)

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

    const checked = await temporaryDropIncompleteCases(path)

    expect(checked).toEqual({ complete: 1, dropped: 1 })
    expect(await readJson(path)).toEqual(experimentDocument(assertionCase('c0', 'The agent refunds order 7.')))
  })
})

describe('TEMPORARY judge evaluators of an experiment', () => {
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
    expect(temporaryJudgeEvaluatorCount(evaluators)).toBe(judges)
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
