import type { JSONValue } from '@strands-agents/sdk'

import type { DevChatPart, DevChatTool } from '../chat-extension.js'
import type {
  CaseResult,
  EvaluatorChoice,
  ExperimentRun,
  ExperimentSummary,
  Generation,
  GenerationSettings,
  Knob,
  EvalsBrowser,
  KnobKey,
  OptimizeObjective,
  OptimizeReview,
  OptimizeRunState,
  OptimizeState,
  ProposedEdit,
  TestCheck,
  TestResults,
  TestRun,
  EvalsBrowserPlace,
} from '../panels/model.js'
import { askTool } from './ask-tool.js'
import { temporaryWorkflowSkills } from './workflow-skills.js'
import { readTemporaryExperimentFile } from './experiment-files.js'
import { temporaryCreateExperimentSkill } from './create-experiment-skill.js'
import type { TemporaryEvaluator } from './evaluators.js'
import type { TemporaryStore } from './jobs.js'
import { TEMPORARY_KNOB_NAMES } from './knobs.js'
import { checkTemporaryObjective, TEMPORARY_USAGE_METRICS, temporaryObjectiveFromRequest } from './objective.js'
import {
  TEMPORARY_DECISION_CHOICES,
  TEMPORARY_ITERATION_CHOICES,
  TEMPORARY_REPETITION_CHOICES,
  TEMPORARY_WIDTH_CHOICES,
  TEMPORARY_WORKER_CHOICES,
} from './plan.js'
import type { TemporarySessionHistory } from './session-converter.js'
import type { TemporaryAppliedChange, TemporaryDevSessions } from './sessions.js'

type Input = Readonly<Record<string, JSONValue>>
type Sessions = () => TemporaryDevSessions
type Evaluators = () => Promise<readonly TemporaryEvaluator[]>

export interface TemporaryDevChatHost {
  readonly sessions: Sessions
  readonly evaluators: Evaluators
  readonly history: TemporarySessionHistory
}

const MAX_CASES = 50
const MAX_TOPICS = 10
const MAX_PARALLEL = 10
const TEXT_LIMIT = 600
const EDIT_LIMIT = 4000
const KNOB_NAMES = TEMPORARY_KNOB_NAMES.join(', ')

const INSTRUCTIONS = `strands_dev_create_experiment, strands_dev_evaluate, and strands_dev_optimize spend the developer's money the moment you call them. Two turns, never one: in the turn that asks for the work, name the experiments and case counts and stop; call the tool only in a later turn, after the developer answered. "Run my tests", "check my agent against my examples", and "make my agent better" ask for that first turn. A scope that looks obvious is still not approval, and neither is one saved experiment or one evident choice. Finish the turn with your question as the last thing you write.

Experiments, evaluations, and optimization:
- experiments/<name>/<name>.json: a saved experiment, which the developer can commit. "cases" holds the test cases (name, input, expected_output or expected_assertion, and optional expected_trajectory and metadata). "evaluators" says how each case is scored.
- experiments/<name>/<name>.report.json: the report of the latest evaluation run of that experiment.
- experiments/<name>/runs/<time>/: one evaluation run, with report.json and run.log.
- experiments/<name>/optimizations/<time>/: one optimization run, with the optimizer record in optimizer/ and run.log.
- tmp/.state/drafts/: generated cases that wait for a review in /experiment.

The developer can open a panel with /experiment or /evaluate, or ask you in plain words. Optimization has no panel: you guide it with strands_dev_ask. A plain-words request still belongs to a skill: activate manage-experiments, run-evaluations, or optimize-harness before you answer one, and use these tools:
- strands_dev_status: the experiments, the drafts, the running jobs, and the last results. Call it again in every turn that asks what exists. The developer, the panels, and finished runs change these files between turns, so an answer from an earlier turn is stale and repeating it is a false claim about the workspace.
- strands_dev_evaluators: the evaluators that can score this agent, with what each one checks and the settings it needs.
- strands_dev_create_experiment: generate test cases and save them as an experiment. Use the create-experiment skill to help the developer shape a test goal naturally; keep technical defaults in the background.
- strands_dev_session_converter: the newest session-converter skill from strands-evals, to build an experiment from past chats or traces. The create-experiment skill says when to use it.
- strands_dev_read_experiment: read saved cases and evaluator definitions without running anything. Use the manage-experiments skill for browsing and explaining them.
- strands_dev_evaluate: run this agent on one or more experiments and report each case. Use the run-evaluations skill for plain-language requests to evaluate or test the agent.
- strands_dev_evaluation_results: inspect existing evaluation results without rerunning an experiment.
- strands_dev_optimize: tune the instructions or the effort of this agent against an experiment, and report the proposed edits. Use the optimize-harness skill for optimization requests.
- strands_dev_cancel_optimization: stop the active optimization when the developer asks.
- strands_dev_reject_optimization: discard pending optimization edits without applying them when the developer asks.
- strands_dev_apply_optimization: write the edits that the developer accepts into the agent source.

The evals UI is a local browser page with larger views of experiments, reports, and optimization runs. In /experiment and /evaluate, the developer presses o to open the current item there. Never write the page address yourself; strands dev gives it to the developer.

Apply optimization edits only when the developer says which edits to apply. A run continues when the turn is cancelled; its progress shows below the chat input, and strands_dev_status gives the result.

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
  name: 'strands_dev_evaluation_results',
  readOnly: true,
  description:
    'Inspect existing progress or the last evaluation result, including inputs, outputs, and evaluator verdicts. Does not rerun evaluations.',
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

const hasPendingEdits = ({ edits, applied }: OptimizeReview): boolean =>
  edits.some((edit) => !edit.unavailable) && !applied?.length

interface ChosenReview {
  readonly id?: string
  readonly review: OptimizeReview
}

const listedReviews = ({ runs = [] }: OptimizeState): ChosenReview[] =>
  runs.flatMap(({ id, state }) => (state.step === 'review' ? [{ id, review: state.review }] : []))

const latestReview = (state: OptimizeState): ChosenReview | undefined =>
  listedReviews(state)[0] ?? (state.step === 'review' ? { review: state.review } : undefined)

const pendingReview = (state: OptimizeState): ChosenReview | undefined =>
  [...listedReviews(state), ...(state.step === 'review' ? [{ review: state.review }] : [])].find(({ review }) =>
    hasPendingEdits(review)
  )

const runState = ({ runs = [] }: OptimizeState, id: string): OptimizeRunState | undefined =>
  runs.find((run) => run.id === id)?.state

const optimizationStatus = async (state: OptimizeState, ui: EvalsBrowser): Promise<object> => {
  const withPage = async (run: OptimizeState, experiment?: string): Promise<object> => {
    const shown = pageStatus(run)
    const record = 'run' in shown && typeof shown.run === 'string' ? shown.run : undefined
    return defined({
      ...(experiment === undefined ? {} : { experiment }),
      ...shown,
      // The page of this run, so a mention of it carries the link to it rather than to the list.
      page: record === undefined ? undefined : await pageLink(ui, { view: 'optimization', record }),
    })
  }
  return defined({
    ...(await withPage(state)),
    runs: state.runs?.length
      ? await Promise.all(state.runs.map(({ experiment, state: run }) => withPage(run, experiment)))
      : undefined,
  })
}

const pageStatus = (state: OptimizeState): object => {
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
        tried: state.progress.candidates.filter(({ scoring }) => scoring === undefined).length,
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

const EVALS_UI_USE =
  "Each page link below opens in the developer's own browser. Give them the one that matches what you are " +
  'talking about, as a plain link in your message, and let them decide whether to open it. Never open it for ' +
  'them, and never write an address that is not here.'

const pageLink = async (ui: EvalsBrowser, place: EvalsBrowserPlace): Promise<string | undefined> => {
  const address = await ui.address(place).catch(() => undefined)
  return address?.status === 'ready' ? address.url : undefined
}

const evalsUiStatus = async (ui: EvalsBrowser): Promise<object> => {
  const { status, detail } = ui.snapshot()
  if (status !== 'ready') return defined({ status, detail })
  const [runs, optimizations] = await Promise.all([pageLink(ui, { view: 'runs' }), pageLink(ui, { view: 'opt-runs' })])
  return defined({ status, detail, use: EVALS_UI_USE, evaluationRuns: runs, optimizationRuns: optimizations })
}

const statusTool = (sessions: Sessions, history: TemporarySessionHistory): DevChatTool => ({
  name: 'strands_dev_status',
  readOnly: true,
  description:
    'Show the strands dev workspace: the saved experiments with their last evaluation result, the generations that run or failed, ' +
    'the optimization state, and the suggested settings for a new experiment with the number of past chats. ' +
    'Call it again in every turn that asks what exists, including a repeated question. ' +
    'An answer from an earlier turn is stale, because files and runs change in between.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async (): Promise<string> => {
    const { experiments, test, optimize, ui } = sessions()
    await test.show()
    const [saved, pastChats] = await Promise.all([experiments.reload(), history.pastChats()])
    const { folder, generations } = experiments.snapshot()
    const { runs } = test.snapshot()
    return reply({
      experimentsFolder: folder,
      experiments: await Promise.all(
        saved.map(async ({ name, caseCount, path }) =>
          defined({
            name,
            cases: caseCount,
            file: path,
            lastTest: lastRun(runs, path),
            page: await pageLink(ui, { view: 'experiment', experiment: path }),
          })
        )
      ),
      generations: generations.map(generationStatus),
      optimization: await optimizationStatus(optimize.snapshot(), ui),
      evalsUi: await evalsUiStatus(ui),
      newExperiment: {
        ...experiments.suggested(),
        pastChats,
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
    'Generates test cases with strands-evals ExperimentGenerator and saves experiments/<name>/<name>.json. ' +
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

const sessionConverterTool = (history: TemporarySessionHistory): DevChatTool => ({
  name: 'strands_dev_session_converter',
  description:
    'Load the newest session-converter skill from strands-agents/evals main, with the strands dev rules for it. ' +
    'Use it to build an experiment from past chats or traces instead of from a goal. ' +
    'It downloads the skill from GitHub, and the first call can take a minute while strands dev prepares the evals environment.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: (): Promise<string> => history.converter(),
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
  name: 'strands_dev_evaluate',
  description:
    'Start the paid evaluation run. This call starts the paid run itself and asks nothing first, so call it ' +
    'only after the developer answered yes, in an earlier turn, to the experiments and cases you named. ' +
    'Being asked to evaluate or test the agent is not that answer, and a scope that looks obvious is not that answer. ' +
    'Runs this agent on the saved experiments and reports each case. ' +
    'Set failedOnly to rerun only prior failures. Read a finished or running evaluation with strands_dev_evaluation_results instead.',
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
        throw new Error(`${experiment.name} is already running. Use strands_dev_evaluation_results for progress.`)
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

const textList = (input: Input, field: string): readonly string[] | undefined => {
  const value = input[field]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item))
    throw new Error(`${field} must be a list of names.`)
  return value as string[]
}

const tuneFrom = (input: Input): readonly KnobKey[] => {
  const tune = textList(input, 'tune') ?? ['instructions']
  const unknown = tune.filter((name) => !TEMPORARY_KNOB_NAMES.includes(name))
  if (tune.length === 0 || unknown.length > 0)
    throw new Error(
      `${unknown.length > 0 ? `${unknown.join(', ')} is not a knob. ` : ''}tune must list knobs from: ${KNOB_NAMES}.`
    )
  return tune
}

const tunedKnobs = (knobs: readonly Knob[], tune: readonly KnobKey[]): void => {
  const unknown = tune.filter((key) => !knobs.some((knob) => knob.key === key && !knob.unavailable))
  if (unknown.length === 0) return
  const available = knobs.filter((knob) => !knob.unavailable).map((knob) => knob.key)
  throw new Error(`This agent cannot tune ${unknown.join(', ')}. It can tune ${available.join(', ')}.`)
}

const objectiveFor = async (experiment: ExperimentSummary, input: Input): Promise<OptimizeObjective | undefined> => {
  const objective = text(input, 'objective') || undefined
  const constraints = textList(input, 'constraints')
  if (objective === undefined && constraints === undefined) return undefined
  const { experiment: loaded } = await readTemporaryExperimentFile(experiment.path)
  const chosen = temporaryObjectiveFromRequest(objective, constraints, loaded.evaluators)
  const { problem } = checkTemporaryObjective(chosen, loaded.evaluators)
  if (problem)
    throw new Error(`${problem} The evaluators of ${experiment.name}: ${loaded.evaluators.join(', ') || 'none'}.`)
  return chosen
}

const planTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_optimization_plan',
  description:
    'Read what an optimization of one experiment could tune, and what it would cost, without starting anything. ' +
    'Call it before you ask the developer to set up a run, so the knobs, the choices, and the estimate you show ' +
    'them are this agent’s own and not a guess. A knob with a reason cannot be tuned: show the reason and do not ' +
    'offer it. Call it again after the developer changes a setting if you want a fresh estimate.',
  inputSchema: {
    type: 'object',
    properties: { experiment: { type: 'string', description: 'The name of a saved experiment.' } },
    required: ['experiment'],
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const { optimize } = sessions()
    const experiment = await findExperiment(sessions, requiredText(input, 'experiment'))
    optimize.reset()
    optimize.plan(experiment)
    const planned = await until(optimize, (state) =>
      state.step === 'setup' || state.step === 'failed' ? state : undefined
    )
    if (planned.step === 'failed') throw new Error(planned.message)
    if (planned.step !== 'setup') throw new Error('The optimization could not be planned.')
    const { plan } = planned
    return reply(
      defined({
        experiment: { name: plan.experiment.name, cases: plan.experiment.caseCount },
        knobs: plan.knobs.map(({ key, label, detail, unavailable, enabled }) =>
          defined({
            key,
            label,
            detail: detail || undefined,
            unavailable: unavailable || undefined,
            onByDefault: enabled === true ? true : undefined,
          })
        ),
        metrics: plan.metrics,
        objective: defined({
          current: plan.objective.expression || undefined,
          constraints: plan.objective.constraints || undefined,
          presets: plan.objectivePresets.map(({ label, objective }) =>
            defined({
              label,
              objective: objective.expression || undefined,
              constraints: objective.constraints || undefined,
            })
          ),
          usageMetrics: TEMPORARY_USAGE_METRICS,
          notation:
            'Maximize(X), Minimize(X), WeightedSum(Maximize(X), Minimize(Y, scale=1000)), or ' +
            'Pareto(Maximize(X), Minimize(Y, scale=1000)). X is an evaluator of the experiment or a usage metric. ' +
            'An empty objective maximizes the mean of every evaluator.',
        }),
        cases: { split: plan.split, choices: plan.splitChoices, testShare: plan.testShare },
        budget: {
          iterations: { value: plan.iterations, choices: plan.iterationChoices },
          candidatesPerStep: { value: plan.width, choices: plan.widthChoices },
          runsPerCase: { value: plan.repetitions, choices: plan.repetitionChoices },
          parallelTrials: { value: plan.workers, choices: plan.workerChoices },
          finalists: { value: plan.decision.finalists, choices: plan.decisionChoices.finalists },
        },
        decision: {
          feasibility: { value: plan.decision.feasibility, choices: plan.decisionChoices.feasibility },
          crashes: { value: plan.decision.crashScore, choices: plan.decisionChoices.crashScore },
          pick: { value: plan.decision.pickRule, choices: plan.decisionChoices.pickRule },
        },
        estimate: defined({ rollouts: plan.rollouts, judgeCalls: plan.judgeCalls, usage: plan.usage }),
        problem: plan.budgetProblem ?? plan.objectiveProblem,
        warning: plan.warning ?? plan.objectiveWarning,
      })
    )
  },
})

const optimizeTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_optimize',
  description:
    'Start the paid optimization run. This call starts the paid run itself and asks nothing first, so call it ' +
    'only after the developer answered yes, in an earlier turn, to the experiment and tuning scope you named. ' +
    'Being asked to improve the agent is not that answer, and a scope that looks obvious is not that answer. ' +
    'Collect the settings with strands_dev_ask first and pass what the developer chose: a scope you picked for ' +
    'them in a message is not their setup, however obvious its defaults looked. ' +
    'Runs alongside the optimizations already going, so a run that is still going is not a reason to wait: say ' +
    'what is already running, and start this one when the developer wants it. ' +
    'Tunes the createHarness options of this agent (instructions, model, effort, caching, tools, and more) ' +
    'against a saved experiment with the strands-evals optimizer, ' +
    'and reports the score before and after with the proposed edits. It changes no file. It can take a long time.',
  inputSchema: {
    type: 'object',
    properties: {
      experiment: { type: 'string', description: 'The name of a saved experiment.' },
      tune: {
        type: 'array',
        items: { type: 'string' },
        description: `The knobs to tune, by option name: ${KNOB_NAMES}. Default: instructions.`,
      },
      models: {
        type: 'array',
        items: { type: 'string' },
        description: 'With model in tune: the provider-qualified model ids to try besides the current model.',
      },
      iterations: {
        type: 'integer',
        enum: [...TEMPORARY_ITERATION_CHOICES],
        description: 'How many optimizer steps to run. Default: 4.',
      },
      candidatesPerStep: {
        type: 'integer',
        enum: [...TEMPORARY_WIDTH_CHOICES],
        description: 'How many candidates each step proposes and scores. Default: 4.',
      },
      runsPerCase: {
        type: 'integer',
        enum: [...TEMPORARY_REPETITION_CHOICES],
        description:
          'How many times each candidate runs each case, to average out a noisy agent. It multiplies the cost. Default: 1.',
      },
      parallelTrials: {
        type: 'integer',
        enum: [...TEMPORARY_WORKER_CHOICES],
        description: 'How many trials run at once. Lower it when the model provider throttles. Default: 4.',
      },
      objective: {
        type: 'string',
        description:
          'What the run optimizes, in the notation of the optimization API: Maximize(Helpfulness), ' +
          'Minimize(tokens), WeightedSum(Maximize(Helpfulness), Minimize(tokens, scale=1000)), or ' +
          'Pareto(Maximize(Helpfulness), Minimize(seconds, scale=10)). The metrics are the evaluators of the ' +
          'experiment and the usage numbers tokens, input_tokens, output_tokens, cache_read_tokens, ' +
          'cache_write_tokens, seconds, and model_calls. A bare evaluator name maximizes it, and a bare usage ' +
          'name minimizes it. Default: the mean of every evaluator.',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Constraints that the chosen candidate must meet, such as "tokens <= 4000" or "Correctness >= 0.8". ' +
          'Add an evaluator floor when every goal is a usage number.',
      },
      feasibilityThreshold: {
        type: 'number',
        enum: [...TEMPORARY_DECISION_CHOICES.feasibility],
        description: 'How sure the optimizer must be that a candidate meets each constraint. Default: 0.9.',
      },
      crashes: {
        type: 'string',
        enum: [...TEMPORARY_DECISION_CHOICES.crashScore],
        description:
          'What a crashed run of the agent scores: worst gives each evaluator its worst value, none counts the ' +
          'run as no data. Default: worst.',
      },
      pick: {
        type: 'string',
        enum: [...TEMPORARY_DECISION_CHOICES.pickRule],
        description:
          'How the final pick values each finalist: mean uses the posterior mean, and lower-bound-25 or ' +
          'lower-bound-10 uses that lower bound to ship cautiously. Default: mean.',
      },
      finalists: {
        type: 'integer',
        enum: [...TEMPORARY_DECISION_CHOICES.finalists],
        description:
          'How many of the best candidates the optimizer measures on the validation cases before the pick. ' +
          'Under Pareto, at least 5 go. Default: 3.',
      },
    },
    required: ['experiment'],
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const { optimize } = sessions()
    const current = optimize.snapshot()
    const tune = tuneFrom(input)
    const models = textList(input, 'models') ?? []
    if (tune.includes('model') && models.length === 0)
      throw new Error('Tuning model needs models: the provider-qualified ids to try besides the current model.')
    const iterations = choiceOf(input, 'iterations', TEMPORARY_ITERATION_CHOICES)
    const width = choiceOf(input, 'candidatesPerStep', TEMPORARY_WIDTH_CHOICES)
    const repetitions = choiceOf(input, 'runsPerCase', TEMPORARY_REPETITION_CHOICES)
    const workers = choiceOf(input, 'parallelTrials', TEMPORARY_WORKER_CHOICES)
    const feasibility = oneOf(input, 'feasibilityThreshold', TEMPORARY_DECISION_CHOICES.feasibility)
    const crashScore = oneOf(input, 'crashes', TEMPORARY_DECISION_CHOICES.crashScore)
    const pickRule = oneOf(input, 'pick', TEMPORARY_DECISION_CHOICES.pickRule)
    const finalists = oneOf(input, 'finalists', TEMPORARY_DECISION_CHOICES.finalists)
    const experiment = await findExperiment(sessions, requiredText(input, 'experiment'))
    const objective = await objectiveFor(experiment, input)
    if (pendingReview(current))
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
    tunedKnobs(planned.plan.knobs, tune)
    if (tune.includes('model')) for (const model of models) optimize.pickModel(model, true)
    for (const knob of planned.plan.knobs)
      if (!knob.unavailable && knob.kind !== 'models' && knob.enabled !== tune.includes(knob.key))
        optimize.toggleKnob(knob.key)
    if (iterations !== undefined) optimize.setIterations(iterations)
    if (width !== undefined) optimize.setWidth(width)
    if (repetitions !== undefined) optimize.setRepetitions(repetitions)
    if (workers !== undefined) optimize.setWorkers(workers)
    if (objective) optimize.setObjective(objective)
    if (feasibility !== undefined) optimize.setDecision('feasibility', feasibility)
    if (crashScore !== undefined) optimize.setDecision('crashScore', crashScore)
    if (pickRule !== undefined) optimize.setDecision('pickRule', pickRule)
    if (finalists !== undefined) optimize.setDecision('finalists', finalists)
    const ready = optimize.snapshot()
    if (ready.step === 'setup' && ready.plan.budgetProblem) throw new Error(ready.plan.budgetProblem)
    const started = optimize.start()
    if (started === undefined) throw new Error('The optimization did not start.')
    const finished = await until(optimize, (state) => {
      const run = runState(state, started)
      return run && run.step !== 'running' ? run : undefined
    })
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

const oneOf = <Value extends JSONValue>(input: Input, key: string, choices: readonly Value[]): Value | undefined => {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  const chosen = choices.find((choice) => choice === value)
  if (chosen === undefined) throw new Error(`${key} must be one of ${choices.join(', ')}.`)
  return chosen
}

const choiceOf = (input: Input, key: string, choices: readonly number[]): number | undefined => {
  const value = whole(input, key, 1, Number.MAX_SAFE_INTEGER)
  if (value !== undefined && !choices.includes(value)) throw new Error(`${key} must be one of ${choices.join(', ')}.`)
  return value
}

const cancelOptimizationTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_cancel_optimization',
  description: 'Stop the running optimization only when the developer asks. Does not apply source changes.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async (): Promise<string> => {
    const { optimize } = sessions()
    const state = optimize.snapshot()
    const running = state.runs?.find((run) => run.state.step === 'running')
    if (!running && state.step !== 'running') throw new Error('No optimization is running.')
    optimize.stop(running?.id)
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
    const latest = latestReview(optimize.snapshot())
    if (!latest) throw new Error('There is no optimization proposal to discard.')
    if (latest.review.applied?.length)
      throw new Error('These edits were already applied. Discarding cannot undo source changes.')
    if (latest.id) optimize.discard(latest.id)
    else optimize.reset()
    return reply({ status: 'discarded', run: latest.review.run })
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
    const latest = latestReview(optimize.snapshot())
    if (!latest) throw new Error('There is no finished optimization to apply. Run one first.')
    if (latest.review.applied) throw new Error(`These edits were applied already: ${latest.review.applied.join(', ')}.`)
    const chosen = Array.isArray(input.edits) ? input.edits : []
    const edits = latest.review.edits
    for (const index of chosen) {
      if (typeof index !== 'number' || !edits[index]) throw new Error(`There is no edit ${String(index)}.`)
      if (edits[index].unavailable) throw new Error(`Edit ${index} cannot be written: ${edits[index].unavailable}`)
    }
    if (latest.id) optimize.openRun(latest.id)
    edits.forEach((_edit, index) => optimize.accept(index, chosen.includes(index)))
    optimize.apply()
    const review = await until(optimize, (next) => {
      const run = latest.id ? runState(next, latest.id) : next
      return run?.step === 'review' && run.review.applied ? run.review : undefined
    })
    if (review.applyError) throw new Error(review.applyError)
    return reply({ applied: review.applied, next: 'Run strands_dev_evaluate on the experiment to check the change.' })
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

const CHANGE_LIMIT = 600

const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`

const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const changedValue = (text: string): string => JSON.stringify(clip(text, CHANGE_LIMIT) ?? '')

const changedEdit = ({ label, kind, target, before, after }: ProposedEdit): string => {
  const where = target ? ` in ${target}` : ''
  return kind === 'text'
    ? `  - ${label}${where}: was ${changedValue(before)}, now ${changedValue(after)}`
    : `  - ${label}${where}: ${before} → ${after}`
}

const testCheckText = (check: TestCheck | undefined): string => {
  if (!check) return ''
  const range = check.range
    ? ` (${Math.round(check.confidence * 100)}% confidence range ${signed(check.range[0])} to ${signed(check.range[1])})`
    : ''
  return ` The test check gave ${signed(check.difference)} on ${counted(check.cases, 'unseen test case')}${range}.`
}

const changeSummary = (change: TemporaryAppliedChange): string =>
  `- ${new Date(change.appliedAt).toISOString()}: an optimization applied ${counted(change.edits.length, 'edit')} ` +
  `from run ${change.run} of the experiment ${change.experiment}. ` +
  `The best candidate scored ${change.baseline.toFixed(2)} → ${change.best.toFixed(2)} on the ${change.measuredOn}.` +
  testCheckText(change.testCheck) +
  (change.error ? ` Apply stopped early: ${change.error}` : '')

const changesSection = (changes: readonly TemporaryAppliedChange[]): string[] =>
  changes.length === 0
    ? []
    : [
        [
          'Changes that strands dev made to this agent in this session. The agent source has them, and strands dev reloaded the agent after each one, so this chat already runs the changed agent:',
          ...changes.flatMap((change) => [changeSummary(change), ...change.edits.map(changedEdit)]),
        ].join('\n'),
      ]

export const temporaryDevChatPart = ({ sessions, evaluators, history }: TemporaryDevChatHost): DevChatPart => ({
  instructions: [INSTRUCTIONS, ...changesSection(sessions().optimize.appliedChanges())].join('\n\n'),
  skills: [temporaryCreateExperimentSkill(), ...temporaryWorkflowSkills()],
  tools: [
    statusTool(sessions, history),
    evaluatorsTool(once(evaluators)),
    createTool(sessions),
    sessionConverterTool(history),
    readExperimentTool(sessions),
    testResultsTool(sessions),
    testTool(sessions),
    planTool(sessions),
    askTool(() => sessions().ask),
    optimizeTool(sessions),
    cancelOptimizationTool(sessions),
    rejectOptimizationTool(sessions),
    applyTool(sessions),
  ],
})
