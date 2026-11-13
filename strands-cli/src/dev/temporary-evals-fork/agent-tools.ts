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

const INSTRUCTIONS = `Experiments, tests, and optimization:
- tmp/experiments/<name>.json: a saved experiment. "cases" holds the test cases (name, input, expected_output, and optional expected_trajectory and metadata). "evaluators" says how each case is scored.
- tmp/experiments/drafts/: generated cases that wait for a review in /experiment.
- tmp/reports/: test reports, one JSON file and one log for each run.
- tmp/optimization/<time>-<experiment>/: the records of optimization runs.

The developer can open a panel with /experiment, /test, or /optimize, or ask you in plain words. For a plain-words request, use these tools:
- strands_dev_status: the experiments, the drafts, the running jobs, and the last results. Use it first when you do not know what exists.
- strands_dev_evaluators: the evaluators that can score this agent, with what each one checks and the settings it needs.
- strands_dev_create_experiment: generate test cases and save them as an experiment. Use the create-experiment skill to help the developer shape a test goal naturally; keep technical defaults in the background.
- strands_dev_test: run this agent on an experiment and report each case.
- strands_dev_optimize: tune the instructions or the effort of this agent against an experiment, and report the proposed edits.
- strands_dev_apply_optimization: write the edits that the developer accepts into the agent source.

Each run takes minutes and calls models that cost money. Before you start one, say what will run and wait for the developer to agree. Apply optimization edits only when the developer says which edits to apply. A run continues when the turn is cancelled; its progress shows below the chat input, and /test or /optimize shows the result.`

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
    'the optimization state, and the suggested settings for a new experiment.',
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
    'Generate test cases for this agent with strands-evals ExperimentGenerator, and save them as tmp/experiments/<name>.json. ' +
    'Call it only after the developer confirms the settings. It takes minutes. Settings you leave out use the suggested values.',
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

const testTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_test',
  description:
    'Run this agent on every case of a saved experiment, score the answers, and report each case. ' +
    'Set failedOnly to run again only the cases that failed in the last finished run. It takes minutes.',
  inputSchema: {
    type: 'object',
    properties: {
      experiment: { type: 'string', description: 'The name of a saved experiment.' },
      failedOnly: { type: 'boolean', description: 'Run only the cases that failed last time.' },
    },
    required: ['experiment'],
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const experiment = await findExperiment(sessions, requiredText(input, 'experiment'))
    const { test } = sessions()
    await test.show()
    const ofExperiment = (): TestRun | undefined =>
      test.snapshot().runs.find((entry) => entry.experiment.path === experiment.path)?.run
    const before = ofExperiment()
    if (flag(input, 'failedOnly')) {
      if (before?.status !== 'done' || before.results.cases.every((item) => item.passed))
        throw new Error(`${experiment.name} has no failed cases from a finished run. Run the whole experiment.`)
      test.rerunFailed(experiment.path)
    } else {
      test.run([experiment])
    }
    const run = await until(test, () => {
      const current = ofExperiment()
      return current !== before && (current?.status === 'done' || current?.status === 'failed') ? current : undefined
    })
    if (run.status === 'failed') throw new Error(run.message)
    return reply(testReport(run.results))
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
    "Tune this agent's instructions, effort, or both against a saved experiment with the strands-evals optimizer, " +
    'and report the score before and after with the proposed edits. It changes no file. It can take a long time.',
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
      state.step === 'review' || state.step === 'failed' ? state : undefined
    )
    if (finished.step === 'failed') throw new Error(finished.message)
    if (finished.step !== 'review') throw new Error('The optimization stopped without a review.')
    return reply(reviewReport(finished.review))
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
  skills: [temporaryCreateExperimentSkill()],
  tools: [
    statusTool(sessions),
    evaluatorsTool(once(evaluators)),
    createTool(sessions),
    testTool(sessions),
    optimizeTool(sessions),
    applyTool(sessions),
  ],
})
