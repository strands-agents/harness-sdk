import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  temporaryGenerateArguments,
  temporaryGenerationError,
  temporaryGenerationFiles,
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
  model: '',
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

const environmentRunner = () =>
  vi.fn(async ({ command, args }: TemporaryCommandRequest): Promise<string> => {
    if (args[1]?.includes('platform.python_version')) return JSON.stringify({ version: '3.12.4', paths: [] })
    if (args[0] === '-m' && args[1] === 'venv') await writeFileAt(temporaryVenvPython(args[3]!), 'fixture interpreter')
    if (args[1]?.includes('site.getsitepackages()[0]')) {
      const sitePackages = join(dirname(dirname(command)), 'lib/site-packages')
      await mkdir(sitePackages, { recursive: true })
      return sitePackages
    }
    return ''
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
    const workspace = await workspaceFixture()
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
    const workspace = await workspaceFixture()
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
    const workspace = await workspaceFixture()
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
    const workspace = await workspaceFixture()
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
    const workspace = await workspaceFixture()
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
    const workspace = await workspaceFixture()
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
    const workspace = await workspaceFixture()
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
