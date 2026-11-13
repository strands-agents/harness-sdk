import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { GenerationSettings } from '../../../src/dev/panels/model.js'
import {
  prepareTemporaryOptimizerEnvironment,
  temporaryVenvPython,
  type TemporaryCommandRequest,
} from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import {
  generateTemporaryExperiment,
  parseTemporaryGenerationEvent,
  temporaryGenerateArguments,
  temporaryGenerationError,
  temporaryGenerationFiles,
  type TemporaryGenerationEvent,
} from '../../../src/dev/temporary-evals-fork/experiment.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const writeFileAt = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const settings = (overrides: Partial<GenerationSettings> = {}): GenerationSettings => ({
  name: 'refunds',
  task: 'Answer refund questions',
  context: '',
  cases: 3,
  topics: 0,
  evaluators: [{ name: 'OutputEvaluator' }],
  model: '',
  parallel: 4,
  expectedOutput: true,
  expectedTrajectory: false,
  expectedInteractions: false,
  metadata: false,
  ...overrides,
})

const workspaceFixture = async (): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  await writeFileAt(temporaryVenvPython(join(root, '.venv')), 'fixture interpreter')
  return {
    directory: join(root, 'strands-dev'),
    root,
    entrypoint: join(root, 'agent.py'),
    config: { version: 1, name: 'desk', language: 'python', entrypoint: 'agent.py', origin: { kind: 'discovered' } },
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

const flagValue = (args: readonly string[], flag: string): string => args[args.indexOf(flag) + 1]!

const generating = (cases: number, events: readonly object[] = []) =>
  vi.fn(async ({ args }: TemporaryEvalsProcess) => {
    await writeFileAt(
      flagValue(args, '--temporary-progress'),
      events.map((event) => `${JSON.stringify(event)}\n`).join('')
    )
    await writeFileAt(
      flagValue(args, '--output'),
      JSON.stringify({ cases: Array.from({ length: cases }, (_, index) => ({ name: `c${index}` })) })
    )
    return { code: 0, stdout: '', stderrTail: [] }
  })

const NOW = new Date('2026-11-12T15:30:12Z')

describe('TEMPORARY experiment generation', () => {
  it('shouldPassEveryGeneratorSettingWhenTheyDifferFromTheDefaults', () => {
    const files = { draft: '/d/refunds.json', log: '/d/refunds.log', progress: '/d/refunds.progress.jsonl' }

    const args = temporaryGenerateArguments(
      settings({
        topics: 3,
        evaluators: [{ name: 'TrajectoryEvaluator' }],
        model: 'us.anthropic.claude-sonnet',
        parallel: 2,
        expectedOutput: false,
        expectedTrajectory: true,
        expectedInteractions: true,
        metadata: true,
      }),
      'An agent for refunds',
      files,
      'python'
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
      'TrajectoryEvaluator',
      '--temporary-agent-language',
      'python',
      '--model',
      'us.anthropic.claude-sonnet',
      '--max-parallel-num-cases',
      '2',
      '--no-expected-output',
      '--expected-trajectory',
      '--expected-interactions',
      '--metadata',
      '--temporary-progress',
      '/d/refunds.progress.jsonl',
      '--output',
      '/d/refunds.json',
    ])
  })

  it('shouldLeaveOptionalFlagsOutWhenTheDefaultsAreUsed', () => {
    const args = temporaryGenerateArguments(settings(), 'context', { draft: 'd', log: 'l', progress: 'p' }, 'python')

    expect(args).not.toContain('--num-topics')
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--no-expected-output')
    expect(args).toContain('--max-parallel-num-cases')
  })

  it('shouldPassEachEvaluatorWhenSeveralAreChosen', () => {
    const evaluators = [
      { name: 'OutputEvaluator' },
      { name: 'HelpfulnessEvaluator', settings: {} },
      { name: 'ToolCalled', settings: { tool_name: 'lookup_order' } },
      { name: 'Contains', settings: { value: 'refund', case_sensitive: false, name: 'says refund' } },
    ]

    const args = temporaryGenerateArguments(
      settings({ evaluators }),
      'context',
      { draft: 'd', log: 'l', progress: 'p' },
      'typescript'
    )

    const values = args.flatMap((arg, index) => (args[index - 1] === '--evaluator' ? [arg] : []))
    expect(values).toEqual([
      'OutputEvaluator',
      'HelpfulnessEvaluator',
      JSON.stringify({ tool_name: 'lookup_order', evaluator_type: 'ToolCalled' }),
      JSON.stringify({ value: 'refund', case_sensitive: false, name: 'says refund', evaluator_type: 'Contains' }),
    ])
    expect(flagValue(args, '--temporary-agent-language')).toBe('typescript')
  })

  it('shouldNameTheEvaluatorTypeFromTheChoiceWhenItsSettingsAlsoNameOne', () => {
    const args = temporaryGenerateArguments(
      settings({ evaluators: [{ name: 'ToolCalled', settings: { evaluator_type: 'Equals', tool_name: 'search' } }] }),
      'context',
      { draft: 'd', log: 'l', progress: 'p' },
      'python'
    )

    expect(JSON.parse(flagValue(args, '--evaluator'))).toEqual({ evaluator_type: 'ToolCalled', tool_name: 'search' })
  })

  it('shouldPutTheDraftLogAndProgressNextToEachOtherWhenFilesAreNamed', () => {
    const files = temporaryGenerationFiles('/w/strands-dev', 'refunds', NOW)

    expect(files).toEqual({
      draft: '/w/strands-dev/tmp/experiments/drafts/20261112-153012-refunds.json',
      log: '/w/strands-dev/tmp/experiments/drafts/20261112-153012-refunds.log',
      progress: '/w/strands-dev/tmp/experiments/drafts/20261112-153012-refunds.progress.jsonl',
    })
  })

  it('shouldReportEachProgressEventAndReturnTheDraftWhenGenerationSucceeds', async () => {
    const workspace = await workspaceFixture()
    const files = temporaryGenerationFiles(workspace.directory!, 'refunds', NOW)
    const progress = [
      { event: 'cases', total: 3 },
      { event: 'case', ok: true, done: 1, failed: 0, total: 3 },
      { event: 'case', ok: false, done: 1, failed: 1, total: 3, error: 'ThrottlingException: slow down' },
      { event: 'case', ok: true, done: 2, failed: 1, total: 3 },
      { event: 'rubric' },
    ]
    const events: TemporaryGenerationEvent[] = []

    const outcome = await generateTemporaryExperiment(
      { workspace, settings: settings(), context: 'context', files, onEvent: (event) => events.push(event) },
      { run: environmentRunner(workspace), spawnGenerator: generating(2, progress) }
    )

    expect(outcome).toEqual({ path: files.draft, cases: 2 })
    expect(events).toEqual(progress)
  })

  it('shouldDeleteTheDraftAndSayWhyWhenEveryCaseFails', async () => {
    const workspace = await workspaceFixture()
    const files = temporaryGenerationFiles(workspace.directory!, 'refunds', NOW)

    await expect(
      generateTemporaryExperiment(
        { workspace, settings: settings(), context: 'context', files },
        { run: environmentRunner(workspace), spawnGenerator: generating(0) }
      )
    ).rejects.toThrow('wrote no cases, because every case failed')

    expect(existsSync(files.draft)).toBe(false)
  })

  it('shouldGiveTheEvaluatorErrorOfTheForkAndANextStepWhenGenerateRejectsAnEvaluator', async () => {
    const workspace = await workspaceFixture()
    const rejected = vi.fn(async (_process: TemporaryEvalsProcess) => ({
      code: 2,
      stdout: '',
      stderrTail: [
        'usage: strands-evals generate [-h] ...',
        'strands-evals generate: error: argument --evaluator: ToolCalled needs tool_name.',
      ],
    }))

    await expect(
      generateTemporaryExperiment(
        {
          workspace,
          settings: settings({ evaluators: [{ name: 'ToolCalled' }] }),
          context: 'context',
          files: temporaryGenerationFiles(workspace.directory!, 'refunds', NOW),
        },
        { run: environmentRunner(workspace), spawnGenerator: rejected }
      )
    ).rejects.toThrow(
      'strands-evals generate stopped with exit code 2: argument --evaluator: ToolCalled needs tool_name.\n' +
        'Change the evaluator or the setting that the error names, then try again.'
    )
    expect(flagValue(rejected.mock.calls[0]![0].args, '--temporary-agent-language')).toBe('python')
  })

  it('shouldNotStartTheGeneratorWhenItWasCancelledDuringSetup', async () => {
    const workspace = await workspaceFixture()
    const abort = new AbortController()
    abort.abort()
    const spawnGenerator = generating(1)

    await expect(
      generateTemporaryExperiment(
        {
          workspace,
          settings: settings(),
          context: 'context',
          files: temporaryGenerationFiles(workspace.directory!, 'refunds', NOW),
          signal: abort.signal,
        },
        { run: environmentRunner(workspace), spawnGenerator }
      )
    ).rejects.toThrow()

    expect(spawnGenerator).not.toHaveBeenCalled()
    await prepareTemporaryOptimizerEnvironment(
      { workspaceDirectory: workspace.directory!, projectRoot: workspace.root, language: 'python' },
      { run: environmentRunner(workspace) }
    )
  })

  it('shouldNameTheRejectedEvaluatorAndPointToTheChatWhenGenerateRejectsItsFlags', () => {
    const error = new Error(
      'strands-evals generate stopped with exit code 2: HelpfulnessEvaluator cannot score a TypeScript agent in ' +
        'strands dev. It reads the agent trace, and strands dev records a trace only for Python agents.\n' +
        'Change the evaluator or the setting that the error names, then try again.'
    )

    const failure = temporaryGenerationError(error, { settings: settings(), log: '/d/refunds.log' })

    expect(failure.summary).toBe('HelpfulnessEvaluator cannot score a TypeScript agent in strands dev')
    expect(failure.detail.split('\n')[0]).toBe(
      'Press Enter to change the evaluators or their settings in the chat. The error below names the problem.'
    )
    expect(failure.detail).toContain('strands-evals said: strands-evals generate stopped with exit code 2')
  })

  it('shouldDropTheArgumentPrefixFromTheSummaryWhenArgparseRejectsAnEvaluator', () => {
    const error = new Error(
      'strands-evals generate stopped with exit code 2: argument --evaluator: ToolCalled needs tool_name. ' +
        'Pass it as JSON: {"evaluator_type": "ToolCalled", "tool_name": "..."}'
    )

    expect(temporaryGenerationError(error, { settings: settings(), log: 'l' }).summary).toBe(
      'ToolCalled needs tool_name'
    )
  })

  it.each<[string, TemporaryGenerationEvent | undefined]>([
    ['{"event":"topics"}', { event: 'topics' }],
    ['{"event":"cases","total":20}', { event: 'cases', total: 20 }],
    [
      '{"event":"case","ok":true,"done":4,"failed":1,"total":20}',
      { event: 'case', ok: true, done: 4, failed: 1, total: 20 },
    ],
    ['{"event":"failed","error":"ValueError: no"}', { event: 'failed', error: 'ValueError: no' }],
    ['{"event":"unknown"}', undefined],
    ['not json', undefined],
  ])('shouldReadTheProgressLine%s', (line, event) => {
    expect(parseTemporaryGenerationEvent(line)).toEqual(event)
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
    ['ThrottlingException: Too many requests', 'Bedrock throttled the requests', 'lower Parallel'],
    ['ValidationException: The provided model identifier is invalid.', 'Bedrock cannot use us.model', 'fix the Model'],
    ['EndpointConnectionError: Could not connect to the endpoint URL', 'Could not reach Bedrock', 'Check your network'],
    ['ZeroDivisionError: division by zero', 'ZeroDivisionError: division by zero', 'Read the log for the cause'],
    [
      'AccessDeniedException: not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:us-west-2:1:inference-profile/global.anthropic.claude-sonnet-4-6 because no policy allows it',
      'Bedrock denied access to global.anthropic.claude-sonnet-4-6',
      'choose a model that your AWS account can use',
    ],
  ])('shouldExplainTheFailureCleanlyWhenTheGeneratorReports%s', (reported, summary, next) => {
    const failure = temporaryGenerationError(new Error('strands-evals generate stopped with exit code 3'), {
      settings: settings({ model: reported.includes('inference-profile') ? '' : 'us.model' }),
      reported,
      log: 'strands-dev/tmp/experiments/drafts/refunds.log',
    })

    expect(failure.summary).toBe(summary)
    expect(failure.detail).toContain(next)
    expect(failure.detail).toContain('Log: strands-dev/tmp/experiments/drafts/refunds.log')
    expect(failure.detail.match(/strands-evals said/gu)).toHaveLength(1)
  })
})
