import type { JSONValue } from '@strands-agents/sdk'

import type { DevChatPart, DevChatTool } from '../chat-extension.js'
import type {
  CaseResult,
  EvaluatorChoice,
  ExperimentRun,
  ExperimentSummary,
  Generation,
  GenerationSettings,
  KnobKey,
  OptimizeReview,
  OptimizeState,
  TestResults,
  TestRun,
} from '../panels/model.js'
import { temporaryWorkflowSkills } from './workflow-skills.js'
import { readTemporaryExperimentFile } from './experiment-files.js'
import { temporaryCreateExperimentSkill } from './create-experiment-skill.js'
import type { TemporaryEvaluator } from './evaluators.js'
import type { TemporaryStore } from './jobs.js'
import { TEMPORARY_ITERATION_CHOICES } from './plan.js'
import type { TemporaryDevSessions } from './sessions.js'

type Input = Readonly<Record<string, JSONValue>>
type Sessions = () => TemporaryDevSessions
type Evaluators = () => Promise<readonly TemporaryEvaluator[]>

export interface TemporaryDevChatHost {
  readonly sessions: Sessions
  readonly evaluators: Evaluators
}

const MAX_CASES = 50
const MAX_TOPICS = 10
const MAX_PARALLEL = 10
const TEXT_LIMIT = 600
const EDIT_LIMIT = 4000
const TUNABLE: readonly KnobKey[] = ['instructions', 'effort']

const INSTRUCTIONS = `strands_dev_create_experiment, strands_dev_test, and strands_dev_optimize spend the developer's money the moment you call them. Two turns, never one: in the turn that asks for the work, name the experiments and case counts and stop; call the tool only in a later turn, after the developer answered. "Run my tests", "check my agent against my examples", and "make my agent better" ask for that first turn. A scope that looks obvious is still not approval, and neither is one saved experiment or one evident choice. Finish the turn with your question as the last thing you write.

Experiments, tests, and optimization:
- tmp/experiments/<name>.json: a saved experiment. "cases" holds the test cases (name, input, expected_output, and optional expected_trajectory and metadata). "evaluators" says how each case is scored.
- tmp/experiments/drafts/: generated cases that wait for a review in /experiment.
- tmp/reports/: test reports, one JSON file and one log for each run.
- tmp/optimization/<time>-<experiment>/: the records of optimization runs.

The developer can open a panel with /experiment, /test, or /optimize, or ask you in plain words. A plain-words request still belongs to a skill: activate manage-experiments, run-tests, or optimize-harness before you answer one, and use these tools:
- strands_dev_status: the experiments, the drafts, the running jobs, and the last results. Call it again in every turn that asks what exists. The developer, the panels, and finished runs change these files between turns, so an answer from an earlier turn is stale and repeating it is a false claim about the workspace.
- strands_dev_evaluators: the evaluators that can score this agent, with what each one checks and the settings it needs.
- strands_dev_create_experiment: generate test cases and save them as an experiment. Use the create-experiment skill to help the developer shape a test goal naturally; keep technical defaults in the background.
- strands_dev_read_experiment: read saved cases and evaluator definitions without running anything. Use the manage-experiments skill for browsing and explaining them.
- strands_dev_test: run this agent on one or more experiments and report each case. Use the run-tests skill for plain-language test requests.
- strands_dev_test_results: inspect existing test results without rerunning an experiment.
- strands_dev_optimize: tune the instructions or the effort of this agent against an experiment, and report the proposed edits. Use the optimize-harness skill for optimization requests.
- strands_dev_cancel_optimization: stop the active optimization when the developer asks.
- strands_dev_reject_optimization: discard pending optimization edits without applying them when the developer asks.
- strands_dev_apply_optimization: write the edits that the developer accepts into the agent source.

Apply optimization edits only when the developer says which edits to apply. A run continues when the turn is cancelled; its progress shows below the chat input, and /test or /optimize shows the result.

Answer the question that was asked, from the tool output of this turn. Do not add settings, defaults, generator details, or a menu of next steps that the developer did not ask for.`

const reply = (value: unknown): string => JSON.stringify(value, null, 2)

const clip = (text: string | undefined, limit = TEXT_LIMIT): string | undefined =>
  text === undefined || text.length <= limit
    ? text
    : `${text.slice(0, limit)}… [${text.length - limit} more characters]`

const until = <State, Result>(
  store: TemporaryStore<State>,
  pick: (state: State) => Result | undefined
): Promise<Result> =>
  new Promise((resolve) => {
    const found = pick(store.snapshot())
    if (found !== undefined) {
      resolve(found)
      return
    }
    const stop = store.subscribe(() => {
      const next = pick(store.snapshot())
      if (next === undefined) return
      stop()
      resolve(next)
    })
  })

const text = (input: Input, key: string): string | undefined => {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be text.`)
  return value.trim()
}

const requiredText = (input: Input, key: string): string => {
  const value = text(input, key)
  if (!value) throw new Error(`${key} is required.`)
  return value
}

const whole = (input: Input, key: string, min: number, max: number): number | undefined => {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${key} must be a whole number from ${min} to ${max}.`)
  return value
}

const flag = (input: Input, key: string): boolean | undefined => {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} must be true or false.`)
  return value
}

const isObject = (value: JSONValue | undefined): value is { [key: string]: JSONValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const evaluatorChoice = (value: JSONValue): EvaluatorChoice => {
  if (!isObject(value) || typeof value.name !== 'string' || !value.name.trim())
    throw new Error('Each evaluator needs a name, for example {"name": "OutputEvaluator"}.')
  if (value.settings !== undefined && value.settings !== null && !isObject(value.settings))
    throw new Error(`The settings of ${value.name} must be an object.`)
  return {
    name: value.name.trim(),
    ...(isObject(value.settings) && Object.keys(value.settings).length > 0 ? { settings: value.settings } : {}),
  }
}

const evaluatorsOf = (input: Input): readonly EvaluatorChoice[] | undefined => {
  const value = input.evaluators
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('evaluators must list at least one evaluator, for example [{"name": "OutputEvaluator"}].')
  return value.map(evaluatorChoice)
}

type Defined<Value> = { [Key in keyof Value]?: Exclude<Value[Key], undefined> }

const defined = <Value extends object>(value: Value): Defined<Value> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Defined<Value>

const settingsFrom = (input: Input, suggested: GenerationSettings): GenerationSettings => ({
  ...suggested,
  ...defined({
    name: requiredText(input, 'name'),
    task: requiredText(input, 'task'),
    context: text(input, 'context'),
    cases: whole(input, 'cases', 1, MAX_CASES),
    topics: whole(input, 'topics', 0, MAX_TOPICS),
    model: text(input, 'model'),
    parallel: whole(input, 'parallel', 1, MAX_PARALLEL),
    expectedOutput: flag(input, 'expectedOutput'),
    expectedTrajectory: flag(input, 'expectedTrajectory'),
    expectedInteractions: flag(input, 'expectedInteractions'),
    metadata: flag(input, 'metadata'),
    evaluators: evaluatorsOf(input),
  }),
})

const findExperiment = async (sessions: Sessions, name: string): Promise<ExperimentSummary> => {
  const saved = await sessions().experiments.reload()
  const found =
    saved.find((experiment) => experiment.name === name) ??
    saved.find((experiment) => experiment.name.toLowerCase() === name.toLowerCase())
  if (found) return found
  const names = saved.map((experiment) => experiment.name).join(', ')
  throw new Error(
    names
      ? `There is no experiment named ${name}. Saved experiments: ${names}.`
      : `There is no experiment named ${name}, and no experiment is saved yet. Create one first.`
  )
}

const pageOf = <Value>(
  items: readonly Value[],
  input: Input
): { offset: number; nextOffset?: number; items: readonly Value[] } => {
  const offset = whole(input, 'offset', 0, Number.MAX_SAFE_INTEGER) ?? 0
  const limit = whole(input, 'limit', 1, 50) ?? 10
  const next = offset + limit
  return { offset, ...(next < items.length ? { nextOffset: next } : {}), items: items.slice(offset, next) }
}

const PAGE_PROPERTIES = {
  offset: { type: 'integer' as const, minimum: 0, description: 'Zero-based first case. Default 0.' },
  limit: { type: 'integer' as const, minimum: 1, maximum: 50, description: 'Cases to return. Default 10.' },
}

const readExperimentTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_read_experiment',
  readOnly: true,
  description:
    'Read a saved experiment, its evaluator definitions, and a page of cases. Does not run the agent or generate cases.',
  inputSchema: {
    type: 'object',
    properties: { experiment: { type: 'string' }, ...PAGE_PROPERTIES },
    required: ['experiment'],
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const selected = await findExperiment(sessions, requiredText(input, 'experiment'))
    const { experiment, raw } = await readTemporaryExperimentFile(selected.path)
    const page = pageOf(raw.cases, input)
    return reply({
      name: experiment.name,
      file: experiment.path,
      total: raw.cases.length,
      evaluators: raw.evaluators ?? [],
      offset: page.offset,
      nextOffset: page.nextOffset,
      cases: page.items,
    })
  },
})

const testResultsTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_test_results',
  readOnly: true,
  description:
    'Inspect existing progress or the last test result, including inputs, outputs, and evaluator verdicts. Does not rerun tests.',
  inputSchema: {
    type: 'object',
    properties: { experiment: { type: 'string' }, ...PAGE_PROPERTIES },
    required: ['experiment'],
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const experiment = await findExperiment(sessions, requiredText(input, 'experiment'))
    const { test } = sessions()
    await test.show()
    const run = test.snapshot().runs.find((entry) => entry.experiment.path === experiment.path)?.run
    if (!run) return reply({ experiment: experiment.name, status: 'not_run' })
    if (run.status !== 'done') return reply({ experiment: experiment.name, ...runStatus(run) })
    const page = pageOf(run.results.cases, input)
    return reply({
      ...runStatus(run),
      experiment: experiment.name,
      seconds: Math.round(run.results.seconds),
      offset: page.offset,
      nextOffset: page.nextOffset,
      cases: page.items,
    })
  },
})

const caseReport = ({ name, passed, input, expected, actual, verdicts }: CaseResult): object =>
  passed
    ? { name, passed }
    : defined({
        name,
        passed,
        input: clip(input),
        expected: clip(expected),
        actual: clip(actual),
        reasons: verdicts
          .filter((verdict) => !verdict.passed)
          .map((verdict) => `${verdict.evaluator}: ${clip(verdict.reason)}`),
      })

const testReport = ({ experiment, cases, overall, report, seconds }: TestResults): object => ({
  experiment,
  passed: cases.filter((item) => item.passed).length,
  total: cases.length,
  score: overall,
  seconds: Math.round(seconds),
  report,
  cases: cases.map(caseReport),
})

const runStatus = (run: TestRun): object => {
  if (run.status === 'running') return { status: 'running', done: run.done, cases: run.cases }
  if (run.status === 'failed') return { status: 'failed', message: run.message }
  const { cases, overall, report } = run.results
  return {
    status: 'done',
    passed: cases.filter((item) => item.passed).length,
    total: cases.length,
    score: overall,
    report,
  }
}

const generationStatus = ({ name, phase, made, failed, total, error, log }: Generation): object =>
  defined({ name, phase, made, failed, total, error: error?.summary, log })

const reviewReport = ({ run, baseline, best, measuredOn, edits, applied, applyError }: OptimizeReview): object =>
  defined({
    run,
    baseline,
    best,
    measuredOn,
    edits: edits.map(({ knob, target, before, after, unavailable }, index) =>
      defined({ index, knob, target, unavailable, before: clip(before, EDIT_LIMIT), after: clip(after, EDIT_LIMIT) })
    ),
    applied,
    applyError,
  })

const optimizationStatus = (state: OptimizeState): object => {
  switch (state.step) {
    case 'pick':
      return { step: 'idle' }
    case 'setup':
      return { step: 'setup', experiment: state.plan.experiment.name }
    case 'running':
      return defined({
        step: 'running',
        run: state.progress.run,
        baseline: state.progress.baseline,
        best: state.progress.best?.score,
        tried: state.progress.candidates.length,
        planned: state.progress.planned,
      })
    case 'review':
      return { step: 'review', ...reviewReport(state.review) }
    case 'cancelled':
      return defined({ step: 'cancelled', experiment: state.experiment, run: state.run })
    case 'failed':
      return { step: 'failed', message: state.message }
  }
}

const lastRun = (runs: readonly ExperimentRun[], path: string): object | undefined => {
  const found = runs.find(({ experiment }) => experiment.path === path)
  return found ? runStatus(found.run) : undefined
}

const statusTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_status',
  readOnly: true,
  description:
    'Show the strands dev workspace: the saved experiments with their last test result, the generations that run or failed, ' +
    'the optimization state, and the suggested settings for a new experiment. ' +
    'Call it again in every turn that asks what exists, including a repeated question. ' +
    'An answer from an earlier turn is stale, because files and runs change in between.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async (): Promise<string> => {
    const { experiments, test, optimize } = sessions()
    await test.show()
    const saved = await experiments.reload()
    const { folder, generations } = experiments.snapshot()
    const { runs } = test.snapshot()
    return reply({
      experimentsFolder: folder,
      experiments: saved.map(({ name, caseCount, path }) =>
        defined({ name, cases: caseCount, file: path, lastTest: lastRun(runs, path) })
      ),
      generations: generations.map(generationStatus),
      optimization: optimizationStatus(optimize.snapshot()),
      newExperiment: {
        ...experiments.suggested(),
        agentContext: experiments.agentSummary(),
        generator: {
          provider: 'bedrock',
          connection: 'Separate AWS connection; does not inherit the chat provider, endpoint, or credentials.',
          defaultModel: 'evals Python SDK default (not the chat model)',
        },
      },
    })
  },
})

const evaluatorsTool = (evaluators: Evaluators): DevChatTool => ({
  name: 'strands_dev_evaluators',
  description:
    'List the strands-evals evaluators that can score this agent, with what each one checks and its settings. ' +
    'The first call can take a minute while strands dev prepares the evals environment.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async (): Promise<string> => {
    const catalog = await evaluators()
    return reply({
      available: catalog
        .filter(({ available }) => available)
        .map(({ name, kind, description, settings }) => ({ name, kind, description, settings })),
      unavailable: catalog
        .filter(({ available }) => !available)
        .map(({ name, description, limit }) => defined({ name, description, limit })),
    })
  },
})

const createTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_create_experiment',
  description:
    'Start the paid generation run. This call starts the paid run itself and asks nothing first, so call it ' +
    'only after the developer answered yes, in an earlier turn, to the proposal you named. ' +
    'Being asked for test cases is not that answer, and a scope that looks obvious is not that answer. ' +
    'Generates test cases with strands-evals ExperimentGenerator and saves tmp/experiments/<name>.json. ' +
    'It takes minutes. Settings you leave out use the suggested values.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A new experiment name: letters, numbers, dots, dashes, and underscores.' },
      task: { type: 'string', description: 'What the agent does in the cases.' },
      context: { type: 'string', description: 'Scenarios, users, edge cases, or failure modes the cases must cover.' },
      cases: { type: 'integer', minimum: 1, maximum: MAX_CASES, description: 'How many cases to write.' },
      topics: { type: 'integer', minimum: 0, maximum: MAX_TOPICS, description: 'Topic groups. 0 turns topics off.' },
      evaluators: {
        type: 'array',
        description:
          'How each case is scored. Two evaluators of the same type need different "name" settings. Default: OutputEvaluator.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'An evaluator name from strands_dev_evaluators.' },
            settings: {
              type: 'object',
              description:
                'The evaluator settings that strands_dev_evaluators lists, for example {"tool_name": "lookup"}.',
            },
          },
          required: ['name'],
        },
      },
      model: {
        type: 'string',
        description:
          'Separate AWS Bedrock generator model, not the chat model. Empty uses the evals Python SDK default. OpenAI-on-Bedrock IDs require bedrock/ prefix. AWS access is required.',
      },
      parallel: { type: 'integer', minimum: 1, maximum: MAX_PARALLEL, description: 'Cases written at once.' },
      expectedOutput: { type: 'boolean' },
      expectedTrajectory: { type: 'boolean' },
      expectedInteractions: { type: 'boolean' },
      metadata: { type: 'boolean' },
    },
    required: ['name', 'task'],
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const { experiments } = sessions()
    const created = await experiments.createExperiment(settingsFrom(input, experiments.suggested()))
    return reply({
      name: created.name,
      file: created.path,
      cases: created.caseCount,
      failedCases: created.failed,
      inputs: created.cases.map(({ name, input: question }) => ({ name, input: clip(question) })),
    })
  },
})

const requestedExperiments = async (sessions: Sessions, input: Input): Promise<ExperimentSummary[]> => {
  const names = input.experiments
  if (names !== undefined && input.experiment !== undefined)
    throw new Error('Give experiment or experiments, not both.')
  if (names === undefined) return [await findExperiment(sessions, requiredText(input, 'experiment'))]
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => typeof name !== 'string' || !name.trim()))
    throw new Error('experiments must be a nonempty list of saved experiment names.')
  const found = await Promise.all(names.map((name) => findExperiment(sessions, (name as string).trim())))
  return [...new Map(found.map((experiment) => [experiment.path, experiment])).values()]
}

const testTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_test',
  description:
    'Start the paid test run. This call starts the paid run itself and asks nothing first, so call it ' +
    'only after the developer answered yes, in an earlier turn, to the experiments and cases you named. ' +
    'Being asked to test the agent is not that answer, and a scope that looks obvious is not that answer. ' +
    'Runs this agent on the saved experiments and reports each case. ' +
    'Set failedOnly to rerun only prior failures. Read a finished or running test with strands_dev_test_results instead.',
  inputSchema: {
    type: 'object',
    properties: {
      experiment: { type: 'string', description: 'One saved experiment name; omit when using experiments.' },
      experiments: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'Saved experiments to run together.',
      },
      failedOnly: { type: 'boolean', description: 'Run only the cases that failed last time.' },
    },
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const experiments = await requestedExperiments(sessions, input)
    const { test } = sessions()
    await test.show()
    const before = new Map(test.snapshot().runs.map((entry) => [entry.experiment.path, entry.run]))
    const failedOnly = flag(input, 'failedOnly')
    for (const experiment of experiments) {
      const run = before.get(experiment.path)
      if (run?.status === 'running')
        throw new Error(`${experiment.name} is already running. Use strands_dev_test_results for progress.`)
      if (failedOnly && (run?.status !== 'done' || run.results.cases.every((item) => item.passed)))
        throw new Error(`${experiment.name} has no failed cases from a finished run. Run the whole experiment.`)
    }
    if (failedOnly) for (const experiment of experiments) test.rerunFailed(experiment.path)
    else test.run(experiments)
    const reports = await Promise.all(
      experiments.map(async (experiment) => {
        const run = await until(test, () => {
          const current = test.snapshot().runs.find((entry) => entry.experiment.path === experiment.path)?.run
          return current !== before.get(experiment.path) && (current?.status === 'done' || current?.status === 'failed')
            ? current
            : undefined
        })
        return run.status === 'failed'
          ? { experiment: experiment.name, status: 'failed', message: run.message }
          : testReport(run.results)
      })
    )
    const single = reports[0]!
    if (experiments.length === 1 && 'message' in single) throw new Error(String(single.message))
    return reply(experiments.length === 1 ? single : { experiments: reports })
  },
})

const tuneFrom = (input: Input): readonly KnobKey[] => {
  const value = input.tune
  if (value === undefined || value === null) return ['instructions']
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !TUNABLE.includes(item as KnobKey)))
    throw new Error('tune must list instructions, effort, or both.')
  return value as KnobKey[]
}

const optimizeTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_optimize',
  description:
    'Start the paid optimization run. This call starts the paid run itself and asks nothing first, so call it ' +
    'only after the developer answered yes, in an earlier turn, to the experiment and tuning scope you named. ' +
    'Being asked to improve the agent is not that answer, and a scope that looks obvious is not that answer. ' +
    "Tunes this agent's instructions, effort, or both against a saved experiment with the strands-evals optimizer, " +
    'and reports the score before and after with the proposed edits. It changes no file. It can take a long time.',
  inputSchema: {
    type: 'object',
    properties: {
      experiment: { type: 'string', description: 'The name of a saved experiment.' },
      tune: {
        type: 'array',
        items: { type: 'string', enum: [...TUNABLE] },
        description: 'What to tune. Default: instructions.',
      },
      iterations: {
        type: 'integer',
        enum: [...TEMPORARY_ITERATION_CHOICES],
        description: 'How many optimizer steps to run. Default: 4.',
      },
    },
    required: ['experiment'],
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const { optimize } = sessions()
    const current = optimize.snapshot()
    if (current.step === 'running')
      throw new Error(
        `The optimization ${current.progress.run} is still running. Wait for it, or stop it in /optimize.`
      )
    const tune = tuneFrom(input)
    const iterations = whole(input, 'iterations', 1, Number.MAX_SAFE_INTEGER)
    if (iterations !== undefined && !TEMPORARY_ITERATION_CHOICES.includes(iterations))
      throw new Error(`iterations must be one of ${TEMPORARY_ITERATION_CHOICES.join(', ')}.`)
    const experiment = await findExperiment(sessions, requiredText(input, 'experiment'))
    if (
      current.step === 'review' &&
      current.review.edits.some((edit) => !edit.unavailable) &&
      !current.review.applied?.length
    )
      throw new Error(
        'There are pending optimization edits. Review and apply them, or explicitly discard them with strands_dev_reject_optimization, before starting another run.'
      )
    optimize.reset()
    optimize.plan(experiment)
    const planned = await until(optimize, (state) =>
      state.step === 'setup' || state.step === 'failed' ? state : undefined
    )
    if (planned.step === 'failed') throw new Error(planned.message)
    if (planned.step !== 'setup') throw new Error('The optimization could not be planned.')
    for (const knob of planned.plan.knobs)
      if (!knob.unavailable && knob.enabled !== tune.includes(knob.key)) optimize.toggleKnob(knob.key)
    if (iterations !== undefined) optimize.setIterations(iterations)
    optimize.start()
    if (optimize.snapshot().step !== 'running') throw new Error('The optimization did not start.')
    const finished = await until(optimize, (state) =>
      state.step === 'review' || state.step === 'cancelled' || state.step === 'failed' ? state : undefined
    )
    if (finished.step === 'failed') throw new Error(finished.message)
    if (finished.step === 'cancelled')
      return reply(
        defined({
          status: 'cancelled',
          experiment: finished.experiment,
          run: finished.run,
          detail: 'The developer cancelled this optimization. No source changes were proposed or written.',
        })
      )
    if (finished.step !== 'review') throw new Error('The optimization stopped without a review.')
    return reply(reviewReport(finished.review))
  },
})

const cancelOptimizationTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_cancel_optimization',
  description: 'Stop the running optimization only when the developer asks. Does not apply source changes.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async (): Promise<string> => {
    const { optimize } = sessions()
    if (optimize.snapshot().step !== 'running') throw new Error('No optimization is running.')
    optimize.stop()
    return reply({ status: 'stopping' })
  },
})

const rejectOptimizationTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_reject_optimization',
  description:
    'Discard pending optimization proposals without writing source. Requires the developer to ask to discard them.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async (): Promise<string> => {
    const { optimize } = sessions()
    const state = optimize.snapshot()
    if (state.step !== 'review') throw new Error('There is no optimization proposal to discard.')
    if (state.review.applied?.length)
      throw new Error('These edits were already applied. Discarding cannot undo source changes.')
    optimize.reset()
    return reply({ status: 'discarded', run: state.review.run })
  },
})

const applyTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_apply_optimization',
  description:
    'Write the edits that the developer accepts from the last finished optimization into the agent source. ' +
    'Give the index of each accepted edit from strands_dev_optimize or strands_dev_status.',
  inputSchema: {
    type: 'object',
    properties: {
      edits: { type: 'array', items: { type: 'integer' }, description: 'The indexes of the accepted edits.' },
    },
    required: ['edits'],
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const { optimize } = sessions()
    const state = optimize.snapshot()
    if (state.step !== 'review') throw new Error('There is no finished optimization to apply. Run one first.')
    if (state.review.applied) throw new Error(`These edits were applied already: ${state.review.applied.join(', ')}.`)
    const chosen = Array.isArray(input.edits) ? input.edits : []
    const edits = state.review.edits
    for (const index of chosen) {
      if (typeof index !== 'number' || !edits[index]) throw new Error(`There is no edit ${String(index)}.`)
      if (edits[index].unavailable) throw new Error(`Edit ${index} cannot be written: ${edits[index].unavailable}`)
    }
    edits.forEach((_edit, index) => optimize.accept(index, chosen.includes(index)))
    optimize.apply()
    const review = await until(optimize, (next) =>
      next.step === 'review' && next.review.applied ? next.review : undefined
    )
    if (review.applyError) throw new Error(review.applyError)
    return reply({ applied: review.applied, next: 'Run strands_dev_test on the experiment to check the change.' })
  },
})

const once = (read: Evaluators): Evaluators => {
  let catalog: Promise<readonly TemporaryEvaluator[]> | undefined
  return () => {
    catalog ??= read().catch((error: unknown) => {
      catalog = undefined
      throw error
    })
    return catalog
  }
}

export const temporaryDevChatPart = ({ sessions, evaluators }: TemporaryDevChatHost): DevChatPart => ({
  instructions: INSTRUCTIONS,
  skills: [temporaryCreateExperimentSkill(), ...temporaryWorkflowSkills()],
  tools: [
    statusTool(sessions),
    evaluatorsTool(once(evaluators)),
    createTool(sessions),
    readExperimentTool(sessions),
    testResultsTool(sessions),
    testTool(sessions),
    optimizeTool(sessions),
    cancelOptimizationTool(sessions),
    rejectOptimizationTool(sessions),
    applyTool(sessions),
  ],
})
