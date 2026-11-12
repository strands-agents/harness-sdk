import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
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

interface ControlledRun {
  readonly args: readonly string[]
  readonly signal?: AbortSignal
  progress(event: object): Promise<void>
  finish(cases: readonly string[], code?: number): Promise<void>
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
          progress: async (event) => {
            const path = flagValue(args, '--temporary-progress')
            await mkdir(dirname(path), { recursive: true })
            await appendFile(path, `${JSON.stringify(event)}\n`)
          },
          finish: async (cases, code = 0) => {
            if (code === 0) await writeFileAt(flagValue(args, '--output'), JSON.stringify(experimentDocument(cases)))
            resolve({ code, stdout: '', stderrTail: code === 0 ? [] : ['strands-evals generate: error: boom'] })
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
    dependencies: { run: environmentRunner(workspace), spawnGenerator: generator.spawn },
  })
  await experiments.reload()
  const start = (overrides: Partial<GenerationSettings> = {}): string | undefined =>
    experiments.generate({ ...experiments.suggested(), ...overrides })
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
      model: 'us.anthropic.claude-test',
      cases: 10,
      evaluators: [{ name: 'OutputEvaluator' }],
    })
    expect(experiments.agentSummary()).toBe('agent.py · 1 tool · instructions.md')
  })

  it('shouldSuggestATaskFromTheAgentNameWhenTheAgentHasNoDescription', async () => {
    const workspace = await workspaceFixture()
    const { experiments } = temporaryDevSessions({ workspace, agent: () => ({}) })
    await experiments.reload()

    expect(experiments.suggested().task).toBe(
      'Handle user requests as the desk agent, with its instructions and tools.'
    )
  })

  it.each([
    ['global.anthropic.claude-sonnet-4-5-20250929-v1:0', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'],
    ['amazon.nova-pro-v1:0', 'amazon.nova-pro-v1:0'],
    ['echo', ''],
    ['openai/gpt-5', ''],
  ])('shouldSuggestTheChatModel%sOnlyWhenBedrockCanRunIt', async (model, suggested) => {
    const { experiments } = await setup(model)

    expect(experiments.suggested().model).toBe(suggested)
  })

  it('shouldShowLiveProgressAndThenADraftToReviewWhenAGenerationRuns', async () => {
    const { experiments, generator, notices, start } = await setup()

    expect(start({ name: 'refunds', cases: 3 })).toBeUndefined()
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    const [run] = generator.runs
    await run!.progress({ event: 'cases', total: 3 })
    await run!.progress({ event: 'case', ok: true, done: 1, failed: 0, total: 3 })
    await vi.waitFor(
      () => expect(onlyGeneration(experiments)).toMatchObject({ phase: 'cases', made: 1, total: 3 }),
      LIVE
    )
    const live = temporaryGenerationJobs(experiments.snapshot())
    await run!.finish(['c0', 'c1', 'c2'])
    await vi.waitFor(() => expect(onlyGeneration(experiments).phase).toBe('ready'))

    expect(live).toEqual([{ id: onlyGeneration(experiments).id, label: 'refunds', done: 1, total: 3 }])
    expect(onlyGeneration(experiments).made).toBe(3)
    expect(temporaryGenerationJobs(experiments.snapshot())).toEqual([])
    expect(notices.at(-1)).toEqual({
      status: 'success',
      text: 'experiment · refunds · 3 cases drafted · /experiment to review',
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
    ['no task', { task: '  ' }, 'Describe the task of the agent'],
  ])('shouldRefuseToStartWhenTheSettingsHave%s', async (_case, overrides, message) => {
    const { workspace, experiments, generator, start } = await setup()
    await writeFileAt(
      join(workspace.directory!, 'tmp/experiments/capital.json'),
      JSON.stringify(experimentDocument(['c0']))
    )
    await experiments.reload()

    expect(start(overrides)).toContain(message)
    expect(experiments.snapshot().generations).toEqual([])
    expect(generator.spawn).not.toHaveBeenCalled()
  })

  it('shouldExplainTheFailureCleanlyWhenEveryCaseFails', async () => {
    const { experiments, generator, notices, start } = await setup()
    start({ name: 'refunds', cases: 2, model: '' })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    const denied = 'AccessDeniedException: You do not have access to the model with the specified model ID.'

    await generator.runs[0]!.progress({ event: 'case', ok: false, done: 0, failed: 1, total: 2, error: denied })
    await generator.runs[0]!.progress({ event: 'case', ok: false, done: 0, failed: 2, total: 2, error: denied })
    await generator.runs[0]!.finish([])
    await vi.waitFor(() => expect(onlyGeneration(experiments).phase).toBe('failed'))

    const { error } = onlyGeneration(experiments)
    expect(error?.summary).toBe('Bedrock denied access to the default model')
    expect(error?.detail).toContain('choose a model that your AWS account can use')
    expect(error?.detail).toMatch(/Log: strands-dev\/tmp\/experiments\/drafts\/\d{8}-\d{6}-refunds\.log/u)
    expect(notices.at(-1)).toMatchObject({ status: 'error', text: expect.stringContaining('Bedrock denied access') })
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

    expect(experiments.generate(failed.settings, failed.id)).toBeUndefined()
    await vi.waitFor(() => expect(generator.runs).toHaveLength(2))

    expect(experiments.snapshot().generations).toHaveLength(1)
    expect(onlyGeneration(experiments)).toMatchObject({ name: 'refunds', phase: 'preparing' })
    expect(onlyGeneration(experiments).id).not.toBe(failed.id)
  })

  it('shouldSaveOnlyTheReviewedCasesWithTheirEditsWhenTheUserSaves', async () => {
    const { workspace, experiments, generator, start } = await setup()
    start({ name: 'refunds' })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    await generator.runs[0]!.finish(['c0', 'c1', 'c2'])
    await vi.waitFor(() => expect(onlyGeneration(experiments).phase).toBe('ready'))
    const draft = flagValue(generator.runs[0]!.args, '--output')

    experiments.review(onlyGeneration(experiments).id)
    expect(experiments.snapshot().review?.cases.map(({ kept }) => kept)).toEqual([false, false, false])
    experiments.toggle(0)
    experiments.edit(1, { expected: 'a better answer' })
    experiments.drop(2)
    experiments.add({ input: 'my own question', expected: 'my own answer' })
    const saved = await experiments.save()

    const path = join(workspace.directory!, 'tmp/experiments/refunds.json')
    expect(saved).toEqual({ name: 'refunds', path, caseCount: 3 })
    const written = JSON.parse(await readFile(path, 'utf8')) as ReturnType<typeof experimentDocument>
    expect(written.cases.map(({ name }) => name)).toEqual(['c0', 'c1', 'case-3'])
    expect(written.cases[0]).toEqual(experimentDocument(['c0']).cases[0])
    expect(written.cases[1]).toMatchObject({ session_id: 'session-c1', expected_output: 'a better answer' })
    expect(written.cases[2]).toMatchObject({ input: 'my own question', expected_output: 'my own answer' })
    expect(written.evaluators).toEqual(experimentDocument([]).evaluators)
    expect(experiments.snapshot().generations).toEqual([])
    expect(existsSync(draft)).toBe(false)
    expect(experiments.snapshot().review).toMatchObject({
      path,
      notice: { tone: 'success', text: 'Saved 3 cases to strands-dev/tmp/experiments/refunds.json' },
    })
  })

  it('shouldRefuseToSaveWhenNoCaseIsKept', async () => {
    const { experiments, generator, start } = await setup()
    start({ name: 'refunds' })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    await generator.runs[0]!.finish(['c0'])
    await vi.waitFor(() => expect(onlyGeneration(experiments).phase).toBe('ready'))
    experiments.review(onlyGeneration(experiments).id)

    expect(await experiments.save()).toBeUndefined()

    expect(experiments.snapshot().review?.notice).toMatchObject({ tone: 'error' })
  })

  it('shouldKeepTheReviewChoicesWhenTheReviewIsClosedAndOpenedAgain', async () => {
    const { experiments, generator, start } = await setup()
    start({ name: 'refunds' })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    await generator.runs[0]!.finish(['c0', 'c1'])
    await vi.waitFor(() => expect(onlyGeneration(experiments).phase).toBe('ready'))
    const { id } = onlyGeneration(experiments)
    experiments.review(id)
    experiments.toggle(1)

    experiments.closeReview()
    experiments.review(id)

    expect(experiments.snapshot().review?.cases.map(({ kept }) => kept)).toEqual([false, true])
  })

  it('shouldOfferADraftForReviewWhenAnEarlierSessionLeftOne', async () => {
    const { workspace, experiments } = await setup()
    await writeFileAt(
      join(workspace.directory!, 'tmp/experiments/drafts/20261112-101010-refunds.json'),
      JSON.stringify(experimentDocument(['c0', 'c1']))
    )

    await experiments.reload()

    expect(experiments.snapshot().generations).toEqual([
      expect.objectContaining({ name: 'refunds', phase: 'ready', made: 2 }),
    ])
  })

  it('shouldDeleteAnUnreadableDraftWhenItIsDismissed', async () => {
    const { workspace, experiments } = await setup()
    const draft = join(workspace.directory!, 'tmp/experiments/drafts/20261112-101010-broken.json')
    await writeFileAt(draft, '{"cases": [')
    await experiments.reload()
    expect(onlyGeneration(experiments)).toMatchObject({ name: 'broken', phase: 'failed' })

    experiments.dismiss(onlyGeneration(experiments).id)
    await vi.waitFor(() => expect(existsSync(draft)).toBe(false))
    await experiments.reload()

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

  it('shouldSaveEveryGeneratedCaseAsTheExperimentAndDropTheDraftWhenTheChatCreatesIt', async () => {
    const { workspace, experiments, generator, notices } = await setup()

    const created = experiments.createExperiment({ ...experiments.suggested(), name: 'refunds', cases: 2 })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    const draft = flagValue(generator.runs[0]!.args, '--output')
    await generator.runs[0]!.finish(['c0', 'c1'])
    const result = await created

    const path = join(workspace.directory!, 'tmp/experiments/refunds.json')
    expect(result).toMatchObject({ name: 'refunds', path, caseCount: 2, failed: 0 })
    expect(result.cases.map(({ name, input }) => [name, input])).toEqual([
      ['c0', 'question c0'],
      ['c1', 'question c1'],
    ])
    expect(JSON.parse(await readFile(path, 'utf8')).cases).toHaveLength(2)
    expect(existsSync(draft)).toBe(false)
    expect(experiments.snapshot().generations).toEqual([])
    expect(experiments.snapshot().saved).toEqual([{ name: 'refunds', path, caseCount: 2 }])
    expect(notices.at(-1)).toEqual({
      status: 'success',
      text: 'experiment · refunds · 2 cases saved to strands-dev/tmp/experiments/refunds.json',
    })
  })

  it('shouldRejectTheChatRequestWithoutGeneratingWhenTheNameIsTaken', async () => {
    const { workspace, experiments, generator } = await setup()
    await writeFileAt(
      join(workspace.directory!, 'tmp/experiments/capital.json'),
      JSON.stringify(experimentDocument(['c0']))
    )

    await expect(experiments.createExperiment({ ...experiments.suggested(), name: 'capital' })).rejects.toThrow(
      'An experiment named capital exists already'
    )
    expect(generator.spawn).not.toHaveBeenCalled()
  })

  it('shouldGiveTheCauseAndTheLogToTheChatWhenTheGenerationFails', async () => {
    const { experiments, generator } = await setup()
    const denied = 'AccessDeniedException: You do not have access to the model with the specified model ID.'

    const created = experiments.createExperiment({ ...experiments.suggested(), name: 'refunds', cases: 1 })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    await generator.runs[0]!.progress({ event: 'case', ok: false, done: 0, failed: 1, total: 1, error: denied })
    await generator.runs[0]!.finish([])

    await expect(created).rejects.toThrow(
      /stopped: Bedrock denied access to us\.anthropic\.claude-test\.\nstrands-evals said: AccessDeniedException.*\nLog: strands-dev\/tmp\/experiments\/drafts\/\d{8}-\d{6}-refunds\.log/su
    )
  })

  it('shouldReplaceAFailedChatGenerationWhenTheChatRetriesTheSameName', async () => {
    const { experiments, generator, notices } = await setup()
    const first = experiments.createExperiment({ ...experiments.suggested(), name: 'refunds', cases: 1 })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    await generator.runs[0]!.finish([], 3)
    await expect(first).rejects.toThrow('The generation of refunds stopped')

    const second = experiments.createExperiment({ ...experiments.suggested(), name: 'refunds', cases: 1 })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(2))
    await generator.runs[1]!.finish(['c0'])

    await expect(second).resolves.toMatchObject({ name: 'refunds', caseCount: 1 })
    expect(experiments.snapshot().generations).toEqual([])
    expect(notices).toEqual([
      { status: 'error', text: expect.stringMatching(/^experiment · refunds stopped: .* · \/experiment shows why$/u) },
      { status: 'success', text: expect.stringContaining('experiment · refunds · 1 case saved') },
    ])
  })

  it('shouldStartTheCreateExperimentSkillInTheChatWhenTheUserAsksForANewExperiment', async () => {
    const { experiments, context } = await setup()

    experiments.startInChat()

    expect(context.submit).toHaveBeenCalledWith('$create-experiment')
  })

  it('shouldDismissTheFailureAndSendItsCauseAndSettingsToTheChatWhenTheUserAsksForAFix', async () => {
    const { experiments, generator, context, start } = await setup()
    start({
      name: 'refunds',
      cases: 3,
      model: 'openai.gpt-6.1-sol',
      evaluators: [{ name: 'OutputEvaluator' }, { name: 'ToolCalled', settings: { tool_name: 'lookup_order' } }],
      expectedTrajectory: true,
    })
    await vi.waitFor(() => expect(generator.runs).toHaveLength(1))
    await generator.runs[0]!.progress({ event: 'failed', error: 'ValidationException: model identifier is invalid' })
    await generator.runs[0]!.finish([], 1)
    await vi.waitFor(() => expect(onlyGeneration(experiments).phase).toBe('failed'))

    experiments.retryInChat(onlyGeneration(experiments).id)

    expect(experiments.snapshot().generations).toEqual([])
    expect(context.submit).toHaveBeenCalledWith(
      '$create-experiment The experiment refunds stopped: Bedrock cannot use openai.gpt-6.1-sol. ' +
        'Its settings were: task "Answers refund questions", 3 cases, 0 topics, ' +
        'evaluators OutputEvaluator and ToolCalled {"tool_name":"lookup_order"}, expected output on, ' +
        'expected trajectory on, expected interactions off, metadata off, model openai.gpt-6.1-sol, 4 at once. ' +
        'Help me fix the settings, then generate it again.'
    )
  })
})
