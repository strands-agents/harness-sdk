import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { GenerationSettings } from '../../../src/dev/panels/model.js'
import { temporaryVenvPython, type TemporaryCommandRequest } from '../../../src/dev/temporary-evals-fork/environment.js'
import type { TemporaryEvalsExit, TemporaryEvalsProcess } from '../../../src/dev/temporary-evals-fork/evals-process.js'
import { temporaryGenerationJobs } from '../../../src/dev/temporary-evals-fork/experiments-session.js'
import { temporaryDevSessions } from '../../../src/dev/temporary-evals-fork/sessions.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import type { ChatNotice, DevChatCommandContext } from '../../../src/ui/chat/types.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const LIVE = { timeout: 4000 }

const writeFileAt = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const flagValue = (args: readonly string[], flag: string): string => args[args.indexOf(flag) + 1]!

const experimentDocument = (names: readonly string[]) => ({
  cases: names.map((name) => ({
    name,
    session_id: `session-${name}`,
    input: `question ${name}`,
    expected_output: `answer ${name}`,
    metadata: null,
  })),
  evaluators: [{ evaluator_type: 'OutputEvaluator', rubric: 'Correct answers pass.' }],
})

const workspaceFixture = async (): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  await writeFileAt(temporaryVenvPython(join(root, '.venv')), 'fixture interpreter')
  await writeFileAt(join(root, 'agent.py'), 'agent = create_harness(instructions=open("instructions.md").read())\n')
  await writeFileAt(join(root, 'instructions.md'), 'Refund orders within 30 days.\n')
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

interface ControlledRun {
  readonly args: readonly string[]
  readonly signal?: AbortSignal
  finish(cases: readonly string[], code?: number, stderrTail?: readonly string[]): Promise<void>
  finishWith(document: object): Promise<void>
}

const controlledGenerator = () => {
  const runs: ControlledRun[] = []
  const spawn = vi.fn(
    ({ args, signal }: TemporaryEvalsProcess) =>
      new Promise<TemporaryEvalsExit>((resolve) => {
        signal?.addEventListener('abort', () => resolve({ code: 143, stdout: '', stderrTail: [] }), { once: true })
        runs.push({
          args,
          ...(signal ? { signal } : {}),
          finish: async (cases, code = 0, stderrTail) => {
            if (code === 0) await writeFileAt(flagValue(args, '--output'), JSON.stringify(experimentDocument(cases)))
            resolve({
              code,
              stdout: '',
              stderrTail: [...(stderrTail ?? (code === 0 ? [] : ['strands-evals generate: error: boom']))],
            })
          },
          finishWith: async (document) => {
            await writeFileAt(flagValue(args, '--output'), JSON.stringify(document))
            resolve({ code: 0, stdout: '', stderrTail: [] })
          },
        })
      })
  )
  return { spawn, runs }
}

const chat = () => {
  const notices: { status: ChatNotice['status']; text: string }[] = []
  const context: DevChatCommandContext = {
    signal: new AbortController().signal,
    report: (status, text) => {
      notices.push({ status, text })
      return { update: vi.fn() }
    },
    fail: vi.fn(),
    submit: vi.fn(),
    openPanel: vi.fn(() => true),
  }
  return { context, notices }
}

const setup = async (model = 'bedrock/us.anthropic.claude-test') => {
  const workspace = await workspaceFixture()
  const generator = controlledGenerator()
  const { context, notices } = chat()
  const { experiments } = temporaryDevSessions({
    workspace,
    agent: () => ({
      description: 'Answers refund questions',
      model,
      tools: [{ name: 'lookup_order', description: 'Find an order' }],
    }),
    context,
    dependencies: { run: environmentRunner(), spawnGenerator: generator.spawn },
  })
  await experiments.reload()
  const start = (overrides: Partial<GenerationSettings> = {}): string | undefined =>
    experiments.generateInBackground({ ...experiments.suggested(), ...overrides })
  return { workspace, experiments, generator, notices, start, context }
}

const onlyGeneration = (experiments: Awaited<ReturnType<typeof setup>>['experiments']) =>
  experiments.snapshot().generations[0]!

describe('TEMPORARY experiment generation session', () => {
  it('shouldSuggestAFreeNameTheChatModelAndTheAgentContextWhenANewExperimentStarts', async () => {
    const { experiments } = await setup()

    const settings = experiments.suggested()

    expect(settings).toMatchObject({
      name: 'experiment-1',
      task: 'Answers refund questions',
      model: '',
      cases: 20,
    })
    expect(experiments.agentSummary()).toBe('agent.py · 1 tool · instructions.md')
  })

  it('shouldLeaveTheTaskOpenWhenTheAgentHasNoDescription', async () => {
    const workspace = await workspaceFixture()
    const { experiments } = temporaryDevSessions({ workspace, agent: () => ({}) })
    await experiments.reload()

    expect(experiments.suggested().task).toBe('')
  })

  it.each([
    'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'amazon.nova-pro-v1:0',
    'echo',
    'openai/gpt-5',
    'openai.gpt-6.1-sol',
  ])('shouldNotInferTheGeneratorConnectionFromChatModel%s', async (model) => {
    const workspace = await workspaceFixture()
    const { experiments } = temporaryDevSessions({ workspace, agent: () => ({ model }) })
    await experiments.reload()
    expect(experiments.suggested().model).toBe('')
  })

  it('shouldShowThatItWritesCasesAndThenSaveTheExperimentWhenAGenerationRuns', async () => {
    const { workspace, experiments, generator, notices, start } = await setup()

    expect(start({ name: 'refunds', cases: 3 })).toBeUndefined()
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    const [run] = generator.runs
    await vi.waitFor(() => expect(onlyGeneration(experiments)).toMatchObject({ phase: 'cases', total: 3 }), LIVE)
    const live = temporaryGenerationJobs(experiments.snapshot())
    const { id } = onlyGeneration(experiments)
    const draft = flagValue(run!.args, '--output')
    await run!.finish(['c0', 'c1', 'c2'])
    await vi.waitFor(() => expect(experiments.snapshot().generations).toEqual([]))

    const path = join(workspace.directory!, 'experiments/refunds/refunds.json')
    expect(live).toEqual([{ id, label: 'refunds writing cases' }])
    expect(JSON.parse(await readFile(path, 'utf8')).cases).toHaveLength(3)
    await vi.waitFor(() => expect(existsSync(draft)).toBe(false))
    expect(experiments.snapshot().saved).toEqual([{ name: 'refunds', path, caseCount: 3 }])
    expect(notices.at(-1)).toEqual({
      status: 'success',
      text: `experiment · refunds · 3 cases saved to ${path}`,
    })
  })

  it('shouldRunSeveralGenerationsAtOnceWhenTheyHaveDifferentNames', async () => {
    const { experiments, generator, start } = await setup()

    start({ name: 'refunds' })
    start({ name: 'billing' })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(2))

    expect(experiments.snapshot().generations.map(({ name }) => name)).toEqual(['billing', 'refunds'])
    expect(temporaryGenerationJobs(experiments.snapshot())).toHaveLength(2)
  })

  it('shouldPassTheAgentContextAndTheDeveloperContextWhenItGenerates', async () => {
    const { generator, start } = await setup()

    start({ name: 'refunds', context: 'Refunds need a receipt.' })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))

    const context = flagValue(generator.runs[0]!.args, '--context')
    expect(context).toContain('Its source file agent.py')
    expect(context).toContain('Refund orders within 30 days.')
    expect(context).toContain('- lookup_order: Find an order')
    expect(context).toContain('More context from the developer:\nRefunds need a receipt.')
    expect(flagValue(generator.runs[0]!.args, '--task-description')).toBe('Answers refund questions')
  })

  it.each<[string, Partial<GenerationSettings>, string]>([
    ['a name with a space', { name: 'my cases' }, 'letters, numbers, dots, dashes, and underscores'],
    ['a saved name', { name: 'capital' }, 'An experiment named capital exists already'],
    ['the name of a folder that keeps only runs', { name: 'retired' }, 'An experiment named retired exists already'],
    ['no task', { task: '  ' }, 'Describe the task of the agent'],
  ])('shouldRefuseToStartWhenTheSettingsHave%s', async (_case, overrides, message) => {
    const { workspace, experiments, generator, start } = await setup()
    await writeFileAt(
      join(workspace.directory!, 'experiments/capital/capital.json'),
      JSON.stringify(experimentDocument(['c0']))
    )
    await mkdir(join(workspace.directory!, 'experiments/retired/runs'), { recursive: true })
    await experiments.reload()

    expect(start(overrides)).toContain(message)
    expect(experiments.snapshot().generations).toEqual([])
    expect(generator.spawn).not.toHaveBeenCalled()
  })

  it('shouldExplainTheFailureCleanlyWhenEveryCaseFails', async () => {
    const { experiments, generator, notices, start, workspace } = await setup()
    start({ name: 'refunds', cases: 2, model: '' })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    const denied = 'AccessDeniedException: You do not have access to the model with the specified model ID.'

    await generator.runs[0]!.finish([], 0, [`botocore.errorfactory.${denied}`, 'generated 0 case(s), 1 evaluator(s)'])
    await vi.waitFor(() => expect(onlyGeneration(experiments).phase).toBe('failed'))

    const { error } = onlyGeneration(experiments)
    expect(error?.summary).toBe('Bedrock denied access to the default model')
    expect(error?.detail).toContain('choose a model that your AWS account can use')
    const drafts = join(workspace.directory!, 'tmp', '.state', 'drafts')
    expect(error?.detail).toContain(`Log: ${drafts}`)
    expect(onlyGeneration(experiments).log).toMatch(/refunds\.log$/u)
    expect(onlyGeneration(experiments).log.startsWith(drafts)).toBe(true)
    expect(notices.at(-1)?.text).toMatch(
      /^experiment · refunds stopped: Bedrock denied access to the default model · strands-evals said: strands-evals generate wrote no cases, because every case failed: botocore\.errorfactory\.AccessDeniedException/u
    )
    expect(notices.at(-1)?.text).toContain(`· log in ${drafts}`)
  })

  it('shouldStopTheProcessAndForgetTheGenerationWhenItIsCancelled', async () => {
    const { experiments, generator, notices, start } = await setup()
    start({ name: 'refunds' })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))

    experiments.cancel(onlyGeneration(experiments).id)

    expect(generator.runs[0]!.signal?.aborted).toBe(true)
    expect(experiments.snapshot().generations).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(notices).toEqual([])
  })

  it('shouldStartAgainUnderTheSameNameWhenAFailedGenerationIsRetried', async () => {
    const { experiments, generator, start } = await setup()
    start({ name: 'refunds' })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    await generator.runs[0]!.finish([], 3)
    await vi.waitFor(() => expect(onlyGeneration(experiments).phase).toBe('failed'))
    const failed = onlyGeneration(experiments)

    expect(experiments.generateInBackground(failed.settings)).toBeUndefined()
    await vi.waitFor(() => expect(generator.runs).toHaveLength(2))

    expect(experiments.snapshot().generations).toHaveLength(1)
    expect(onlyGeneration(experiments)).toMatchObject({ name: 'refunds', phase: 'cases' })
    expect(onlyGeneration(experiments).id).not.toBe(failed.id)
  })

  it('shouldLeaveOutAndCountAsFailedTheGeneratedCasesWithABlankInputOrExpectedAnswer', async () => {
    const { workspace, experiments, generator, notices, start } = await setup()
    start({ name: 'refunds', cases: 3 })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    const [complete, blankInput, blankAnswer] = experimentDocument(['c0', 'c1', 'c2']).cases

    await generator.runs[0]!.finishWith({
      ...experimentDocument([]),
      cases: [complete, { ...blankInput, input: ' ' }, { ...blankAnswer, expected_output: '' }],
    })
    await vi.waitFor(() => expect(experiments.snapshot().generations).toEqual([]))

    const saved = JSON.parse(await readFile(join(workspace.directory!, 'experiments/refunds/refunds.json'), 'utf8'))
    expect(saved.cases.map(({ name }: { name: string }) => name)).toEqual(['c0'])
    expect(notices.at(-1)?.text).toContain('experiment · refunds · 1 case saved')
  })

  it('shouldSaveUniqueCaseNamesWhenTheGeneratorRepeatsANameOrLeavesOneOut', async () => {
    const { workspace, experiments, generator, start } = await setup()

    start({ name: 'refunds', cases: 3 })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    await generator.runs[0]!.finish(['refund', 'refund', ''])
    await vi.waitFor(() => expect(experiments.snapshot().generations).toEqual([]))

    const saved = JSON.parse(
      await readFile(join(workspace.directory!, 'experiments/refunds/refunds.json'), 'utf8')
    ) as {
      cases: { name: string }[]
    }
    expect(saved.cases.map(({ name }) => name)).toEqual(['refund', 'refund-2', 'case_2'])
  })

  it('shouldKeepTheDraftAndSayWhereWhenTheExperimentFileAppearedDuringTheGeneration', async () => {
    const { workspace, generator, notices, start } = await setup()
    start({ name: 'refunds' })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    const draft = flagValue(generator.runs[0]!.args, '--output')
    await writeFileAt(
      join(workspace.directory!, 'experiments/refunds/refunds.json'),
      JSON.stringify(experimentDocument(['x']))
    )

    await generator.runs[0]!.finish(['c0'])

    await vi.waitFor(() => expect(notices.at(-1)?.text).toContain('exists already, so the cases stay in'))
    expect(existsSync(draft)).toBe(true)
  })

  it('shouldRejectTheAmbiguousChatModelBeforeSchedulingAnyGeneration', async () => {
    const { experiments, generator, start } = await setup()

    expect(start({ name: 'diagnostic', model: 'openai.gpt-6.1-sol' })).toContain('not the chat provider')
    expect(generator.spawn).not.toHaveBeenCalled()
    expect(experiments.snapshot().generations).toEqual([])
  })

  it('shouldDeleteTheDraftWhenTheGenerationIsCancelledAfterTheDraftWasWritten', async () => {
    const { experiments, generator, start } = await setup()
    start({ name: 'refunds' })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    const draft = flagValue(generator.runs[0]!.args, '--output')
    await writeFileAt(draft, JSON.stringify(experimentDocument(['c0'])))

    experiments.cancel(onlyGeneration(experiments).id)

    await vi.waitFor(() => expect(existsSync(draft)).toBe(false))
    await experiments.reload()
    expect(experiments.snapshot().generations).toEqual([])
  })
})
