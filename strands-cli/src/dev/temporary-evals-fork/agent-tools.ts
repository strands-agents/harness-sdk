import { join } from 'node:path'

import type { JSONValue } from '@strands-agents/sdk'

import { errorMessage } from '../../terminal/text.js'
import type { DevChatPart, DevChatTool } from '../chat-extension.js'
import { STRANDS_EVALS_OPTIMIZE_SKILL, STRANDS_EVALS_SKILL } from '../evals-skill.js'
import { isGenerating, type CrashScore } from '../panels/model.js'
import type {
  ExperimentRun,
  ExperimentSummary,
  Generation,
  Knob,
  EvalsBrowser,
  EvalsBrowserPlace,
  KnobKey,
  OptimizeObjective,
  OptimizeReview,
  OptimizeRun,
  OptimizeRunState,
  OptimizeState,
  OptimizeStep,
  ProposedEdit,
  TestCheck,
  TestRun,
} from '../panels/model.js'
import { uiTools } from './ui-tools.js'
import { temporaryWorkflowSkills } from './workflow-skills.js'
import { readTemporaryExperimentFile } from './experiment-files.js'
import type { TemporaryEvaluator } from './evaluators.js'
import type { TemporaryStore } from './jobs.js'
import {
  BACKGROUND_COMMANDS,
  generateFlagSettings,
  optimizeFlagSettings,
  runFlagCases,
  type BackgroundCommand,
  type OptimizeFlagSettings,
} from './background-flags.js'
import { checkTemporaryObjective, TEMPORARY_USAGE_METRICS, temporaryObjectiveFromRequest } from './objective.js'
import {
  isTemporaryBudgetValue,
  TEMPORARY_BUDGET_MINIMUMS,
  TEMPORARY_DECISION_CHOICES,
  type TemporaryBudgetSetting,
} from './plan.js'
import { showOptimizeReview } from './review-run.js'
import type { TemporarySessionHistory } from './session-converter.js'
import { temporaryEditsAwaitingAnswer, type TemporaryAppliedChange, type TemporaryDevSessions } from './sessions.js'

type Input = Readonly<Record<string, JSONValue>>
type Sessions = () => TemporaryDevSessions
type Evaluators = () => Promise<readonly TemporaryEvaluator[]>

export interface TemporaryDevChatHost {
  readonly sessions: Sessions
  readonly evaluators: Evaluators
  readonly history: TemporarySessionHistory
  /** Puts a run's waiting edits on the developer's screen. Says whether it had any to show. */
  readonly showReview?: (run: string) => boolean
}

const TEXT_LIMIT = 600
const EDIT_LIMIT = 4000

const INSTRUCTIONS = `For experiments, evaluations, and test cases, activate the strands-evals skill; to tune this agent against an experiment, activate the optimize skill; to run any strands-evals command, follow the background-evals skill. The developer can also type /experiment, /evaluate, or /optimize.

Runs cost money. Name the scope in chat and end the turn; start a run only after the developer approves it in a later turn. Being asked to run, test, or improve something is not that approval. In /evaluate, picking the experiments on screen is the approval.

When an optimization run finishes, its edits appear on the developer's screen as a diff, and they apply or leave each edit there, unless auto-optimize applies them. Do not print the edits or ask in chat which ones to apply; strands_dev_review_optimization puts a closed diff back on screen. Call strands_dev_apply_optimization only for edits the developer names in chat.

Answer what was asked from tool output of this turn: call strands_dev_status again whenever the question is what exists, because runs and files change between turns. Ask the developer to choose or type with the strands_dev_ UI tools. Never make up the evals UI address; pass on only what strands_dev_open_evals_ui returns, as a markdown link with a short label such as [open the run](url).`

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

type Defined<Value> = { [Key in keyof Value]?: Exclude<Value[Key], undefined> }

const defined = <Value extends object>(value: Value): Defined<Value> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Defined<Value>

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

const reviewReport = ({ run, baseline, best, measuredOn, edits, applied, applyError, auto }: OptimizeReview): object =>
  defined({
    run,
    baseline,
    best,
    measuredOn,
    edits: edits.map(({ knob, target, before, after, unavailable, added }, index) =>
      defined({
        index,
        knob,
        target,
        unavailable,
        before: clip(before, EDIT_LIMIT),
        after: clip(after, EDIT_LIMIT),
        newInCall: added,
      })
    ),
    applied,
    applyError,
    // Written by the auto-optimize setting as the run ended: the developer saw no diff of these edits.
    autoApplied: auto ? true : undefined,
  })

const AUTO_PLAN =
  'Auto-optimize is on in the settings of this workspace: when this run finishes, strands dev writes its edits to ' +
  'the agent source without showing them. Say so in the review the developer approves before the run starts. A ' +
  'run they stop early is not applied. They turn the setting off in /settings, under Strands dev workspace.'

// What a review still waits on, said so the agent does not call a closed diff "on screen".
const waitingReport = (review: OptimizeReview): object => {
  const waiting = temporaryEditsAwaitingAnswer(review)
  if (waiting === 0 || review.applied) return {}
  return {
    awaitingAnswer: waiting,
    next:
      `${waiting === 1 ? '1 edit of this run still waits' : `${waiting} edits of this run still wait`} for the ` +
      "developer's yes or no. They answer on their screen, not in chat. The diff may not be showing: the run is " +
      'on the status line under the chat input, where clicking it opens the diff, and strands_dev_review_optimization ' +
      'puts it on their screen. Do not say the diff is on screen unless that call just put it there.',
  }
}

interface ChosenReview {
  readonly id?: string
  readonly review: OptimizeReview
}

const listedReviews = ({ runs = [] }: OptimizeState): ChosenReview[] =>
  runs.flatMap(({ id, state }) => (state.step === 'review' ? [{ id, review: state.review }] : []))

const latestReview = (state: OptimizeState): ChosenReview | undefined =>
  listedReviews(state)[0] ?? (state.step === 'review' ? { review: state.review } : undefined)

const runState = ({ runs = [] }: OptimizeState, id: string): OptimizeRunState | undefined =>
  runs.find((run) => run.id === id)?.state

const optimizationStatus = (state: OptimizeState): object =>
  defined({
    ...pageStatus(state),
    runs: state.runs?.length
      ? state.runs.map(({ experiment, state: run }) => ({ experiment, ...pageStatus(run) }))
      : undefined,
  })

const RUN_PHASES: Readonly<Record<OptimizeStep['kind'], string>> = {
  baseline: 'measuring your agent as it is',
  proposing: 'proposing new versions',
  scoring: 'measuring the new versions',
  validating: 'checking the finalists on the validation cases',
  testing: 'checking the winner on the test cases',
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
        // Every version tried is not the end of the run: the finalists and the test are checked after the search.
        phase: state.progress.step ? RUN_PHASES[state.progress.step.kind] : undefined,
        rollouts: state.progress.rollouts,
      })
    case 'review':
      return { step: 'review', ...reviewReport(state.review), ...waitingReport(state.review) }
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

const EVALS_UI_OPENING = 'strands_dev_open_evals_ui opens an experiment, a report, or an optimization run.'

const evalsUiStatus = (ui: EvalsBrowser): object => {
  const { status, detail } = ui.snapshot()
  return defined({ status, detail, open: status === 'ready' ? EVALS_UI_OPENING : undefined })
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
      experiments: saved.map(({ name, caseCount, path }) =>
        defined({ name, cases: caseCount, file: path, lastTest: lastRun(runs, path) })
      ),
      generations: generations.map(generationStatus),
      optimization: optimizationStatus(optimize.snapshot()),
      evalsUi: evalsUiStatus(ui),
      newExperiment: {
        cases: experiments.suggested().cases,
        pastChats,
        agentContext: experiments.agentSummary(),
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

const sessionConverterTool = (history: TemporarySessionHistory): DevChatTool => ({
  name: 'strands_dev_session_converter',
  description:
    'Load the newest session-converter skill from strands-agents/evals main, with the strands dev rules for it. ' +
    'Use it to build an experiment from past chats or traces instead of from a goal. ' +
    'It downloads the skill from GitHub, and the first call can take a minute while strands dev prepares the evals environment.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: (): Promise<string> => history.converter(),
})

const textList = (input: Input, field: string): readonly string[] | undefined => {
  const value = input[field]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item))
    throw new Error(`${field} must be a list of names.`)
  return value as string[]
}

const tunedKnobs = (knobs: readonly Knob[], tune: readonly KnobKey[]): void => {
  const unknown = tune.filter((key) => !knobs.some((knob) => knob.key === key && !knob.unavailable))
  if (unknown.length === 0) return
  const available = knobs.filter((knob) => !knob.unavailable).map((knob) => knob.key)
  throw new Error(`This agent cannot tune ${unknown.join(', ')}. It can tune ${available.join(', ')}.`)
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
        // Knobs with nothing to tune for this agent are left out, so the model cannot offer them.
        knobs: plan.knobs
          .filter(({ unavailable }) => !unavailable)
          .map(({ key, label, detail, enabled, notInCall }) =>
            defined({
              key,
              label,
              detail: detail || undefined,
              onByDefault: enabled === true ? true : undefined,
              notInCall: notInCall === true ? true : undefined,
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
          iterations: { value: plan.iterations, min: TEMPORARY_BUDGET_MINIMUMS.iterations },
          candidatesPerStep: { value: plan.width, min: TEMPORARY_BUDGET_MINIMUMS.width },
          runsPerCase: { value: plan.repetitions, min: TEMPORARY_BUDGET_MINIMUMS.repetitions },
          parallelTrials: { value: plan.workers, min: TEMPORARY_BUDGET_MINIMUMS.workers },
          finalists: { value: plan.decision.finalists, min: TEMPORARY_BUDGET_MINIMUMS.finalists },
        },
        decision: {
          feasibility: { value: plan.decision.feasibility, choices: plan.decisionChoices.feasibility },
          crashes: { value: plan.decision.crashScore, choices: plan.decisionChoices.crashScore },
          pick: { value: plan.decision.pickRule, choices: plan.decisionChoices.pickRule },
        },
        estimate: defined({ rollouts: plan.rollouts, judgeCalls: plan.judgeCalls, usage: plan.usage }),
        problem: plan.budgetProblem ?? plan.objectiveProblem,
        warning: plan.warning ?? plan.objectiveWarning,
        autoOptimize: optimize.autoApplies() ? AUTO_PLAN : undefined,
      })
    )
  },
})

const chosen = <Value extends JSONValue>(
  name: string,
  value: Value | undefined,
  choices: readonly Value[]
): Value | undefined => {
  if (value === undefined) return undefined
  if (!choices.includes(value)) throw new Error(`${name} must be one of ${choices.join(', ')}.`)
  return value
}

const budgetValue = (name: string, setting: TemporaryBudgetSetting, value: number | undefined): number | undefined => {
  if (value === undefined || isTemporaryBudgetValue(setting, value)) return value
  throw new Error(`${name} must be a whole number of at least ${TEMPORARY_BUDGET_MINIMUMS[setting]}.`)
}

const objectiveFor = async (
  experiment: ExperimentSummary,
  { objective, constraints }: OptimizeFlagSettings
): Promise<OptimizeObjective | undefined> => {
  if (objective === undefined && constraints === undefined) return undefined
  const { experiment: loaded } = await readTemporaryExperimentFile(experiment.path)
  const picked = temporaryObjectiveFromRequest(objective, constraints, loaded.evaluators)
  const { problem } = checkTemporaryObjective(picked, loaded.evaluators)
  if (problem)
    throw new Error(`${problem} The evaluators of ${experiment.name}: ${loaded.evaluators.join(', ') || 'none'}.`)
  return picked
}

// Plans a fresh run, applies the flags of the skill, and starts it without waiting.
const startOptimization = async (
  sessions: Sessions,
  experiment: ExperimentSummary,
  settings: OptimizeFlagSettings
): Promise<string> => {
  const { optimize } = sessions()
  const iterations = budgetValue('--max-iterations', 'iterations', settings.iterations)
  const width = budgetValue('--proposals-per-iteration', 'width', settings.width)
  const repetitions = budgetValue('--runs-per-candidate', 'repetitions', settings.repetitions)
  const workers = budgetValue('--max-workers', 'workers', settings.workers)
  const finalists = budgetValue('--n-finalists', 'finalists', settings.finalists)
  const feasibility = chosen('--feasibility-threshold', settings.feasibility, TEMPORARY_DECISION_CHOICES.feasibility)
  const crashScore = chosen(
    '--agent-failure-score',
    settings.crashScore as CrashScore | undefined,
    TEMPORARY_DECISION_CHOICES.crashScore
  )
  const objective = await objectiveFor(experiment, settings)
  optimize.reset()
  optimize.plan(experiment)
  const planned = await until(optimize, (state) =>
    state.step === 'setup' || state.step === 'failed' ? state : undefined
  )
  if (planned.step === 'failed') throw new Error(planned.message)
  if (planned.step !== 'setup') throw new Error('The optimization could not be planned.')
  tunedKnobs(planned.plan.knobs, settings.tune)
  if (settings.tune.includes('model')) for (const model of settings.models) optimize.pickModel(model, true)
  for (const knob of planned.plan.knobs)
    if (!knob.unavailable && knob.kind !== 'models' && knob.enabled !== settings.tune.includes(knob.key))
      optimize.toggleKnob(knob.key)
  if (iterations !== undefined) optimize.setIterations(iterations)
  if (width !== undefined) optimize.setWidth(width)
  if (repetitions !== undefined) optimize.setRepetitions(repetitions)
  if (workers !== undefined) optimize.setWorkers(workers)
  if (objective) optimize.setObjective(objective)
  if (feasibility !== undefined) optimize.setDecision('feasibility', feasibility)
  if (crashScore !== undefined) optimize.setDecision('crashScore', crashScore)
  if (finalists !== undefined) optimize.setDecision('finalists', finalists)
  const ready = optimize.snapshot()
  if (ready.step === 'setup' && ready.plan.budgetProblem) throw new Error(ready.plan.budgetProblem)
  const started = optimize.start()
  if (started === undefined) throw new Error('The optimization did not start.')
  return started
}

const caseNames = async (experiment: ExperimentSummary, names: readonly string[]): Promise<void> => {
  const { raw } = await readTemporaryExperimentFile(experiment.path)
  const known = raw.cases.map((item, index) => (typeof item.name === 'string' ? item.name : String(index)))
  const unknown = names.filter((name) => !known.includes(name))
  if (unknown.length > 0) throw new Error(`${experiment.name} has no case ${unknown.join(', ')}.`)
}

const BACKGROUND_DETAIL =
  'It goes on in the background, with its progress on a line below the chat input. A notice says when it ' +
  'finishes; then strands_dev_status and strands_dev_evaluation_results read the result.'

const OPTIMIZE_DETAIL =
  `${BACKGROUND_DETAIL} When it finishes, its edits appear on the developer's screen as a diff to apply or leave, ` +
  'and an applied edit is written and hot-reloaded without you; with auto-optimize on, they are written unasked.'

const backgroundTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_run_background',
  description:
    'Start a paid strands-evals command in the background and return at once. This call starts the paid run ' +
    'itself, so call it only after the developer answered yes, in an earlier turn, to the scope you named. ' +
    'Pass the command and the flags the skill would pass: run evaluates the agent on an experiment ' +
    '(--case NAME, repeatable, runs only those cases), optimize run takes the flags of the optimize skill ' +
    '(--tune, --no-tune-instructions, --objective, --pareto, --constraint, --max-iterations, ' +
    '--proposals-per-iteration, --runs-per-candidate, --n-finalists, --max-workers, --feasibility-threshold, ' +
    '--agent-failure-score), and generate takes the flags of strands-evals generate (--task-description, ' +
    '--context, --num-cases, --num-topics, --evaluator, --model, --expected-trajectory, and more) and saves ' +
    'experiments/<experiment>/<experiment>.json. strands dev runs it in its prepared evals environment with ' +
    'this agent, writes run.log and the records under strands-dev/experiments/<experiment>/, and continues ' +
    'a run that stopped when strands dev closed. Flags that strands dev sets itself come back as ignored.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', enum: [...BACKGROUND_COMMANDS], description: 'The strands-evals command.' },
      experiment: {
        type: 'string',
        description: 'A saved experiment name, or with generate the name of the new experiment.',
      },
      args: { type: 'array', items: { type: 'string' }, description: 'The flags, one argument per item.' },
    },
    required: ['command', 'experiment'],
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const command = chosen('command', text(input, 'command') as BackgroundCommand, BACKGROUND_COMMANDS)
    const args = textList(input, 'args') ?? []
    const name = requiredText(input, 'experiment')
    const started = (fields: object, ignored: readonly string[]): string =>
      reply(
        defined({
          status: 'started',
          command,
          experiment: name,
          ...fields,
          ignored: ignored.length > 0 ? ignored : undefined,
          detail: command === 'optimize run' ? OPTIMIZE_DETAIL : BACKGROUND_DETAIL,
        })
      )
    if (command === 'generate') {
      const { experiments } = sessions()
      await experiments.reload()
      const { settings, ignored } = generateFlagSettings(name, args, experiments.suggested())
      const problem = experiments.generateInBackground(settings)
      if (problem) throw new Error(problem)
      const { folder, generations } = experiments.snapshot()
      const log = generations.find((generation) => generation.name === settings.name)?.log
      return started(
        { cases: settings.cases, file: join(folder, settings.name, `${settings.name}.json`), log },
        ignored
      )
    }
    const experiment = await findExperiment(sessions, name)
    if (command === 'optimize run') {
      const settings = optimizeFlagSettings(args)
      const run = await startOptimization(sessions, experiment, settings)
      return started({ run, file: experiment.path }, settings.ignored)
    }
    const { cases, ignored } = runFlagCases(args)
    const { test } = sessions()
    await test.show()
    if (
      test.snapshot().runs.some((entry) => entry.experiment.path === experiment.path && entry.run.status === 'running')
    )
      throw new Error(`${experiment.name} is already running. strands_dev_evaluation_results reads its progress.`)
    if (cases.length > 0) {
      await caseNames(experiment, cases)
      test.runOnly(experiment, cases)
    } else test.run([experiment])
    return started({ cases: cases.length > 0 ? cases.length : experiment.caseCount, file: experiment.path }, ignored)
  },
})

const stopBackgroundTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_stop_background',
  description:
    'Stop a command that strands_dev_run_background started, only when the developer asks. A stopped ' +
    'optimization keeps the best candidate so far. Cancelling the chat turn does not stop it.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', enum: [...BACKGROUND_COMMANDS] },
      experiment: { type: 'string', description: 'The experiment of the run.' },
    },
    required: ['command', 'experiment'],
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const command = chosen('command', text(input, 'command') as BackgroundCommand, BACKGROUND_COMMANDS)
    const name = requiredText(input, 'experiment')
    const { experiments, test, optimize } = sessions()
    if (command === 'generate') {
      const job = experiments
        .snapshot()
        .generations.find((generation) => generation.name === name && isGenerating(generation))
      if (!job) throw new Error(`No generation of ${name} is running.`)
      experiments.cancel(job.id)
      return reply({ command, experiment: name, status: 'stopped' })
    }
    const experiment = await findExperiment(sessions, name)
    if (command === 'run') {
      await test.show()
      const run = test.snapshot().runs.find((entry) => entry.experiment.path === experiment.path)?.run
      if (run?.status !== 'running') throw new Error(`No evaluation of ${experiment.name} is running.`)
      test.stop(experiment.path)
      return reply({ command, experiment: experiment.name, status: 'stopping' })
    }
    const running = optimize
      .snapshot()
      .runs?.find((run) => run.experiment === experiment.name && run.state.step === 'running')
    if (!running) throw new Error(`No optimization of ${experiment.name} is running.`)
    optimize.stop(running.id)
    return reply({ command, experiment: experiment.name, status: 'stopping' })
  },
})

const runRecord = ({ record, state }: OptimizeRun): string | undefined =>
  record ||
  (state.step === 'running'
    ? state.progress.record
    : state.step === 'review'
      ? state.review.record
      : state.step === 'failed'
        ? state.record
        : undefined) ||
  undefined

// The newest optimization run of the experiment that has a record, else the list of optimization runs.
const optimizationPlace = ({ runs = [] }: OptimizeState, experiment: string): EvalsBrowserPlace => {
  const record = runs
    .filter((run) => run.experiment === experiment)
    .map(runRecord)
    .find((found) => found !== undefined)
  return record ? { view: 'optimization', record } : { view: 'opt-runs' }
}

const openEvalsUiTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_open_evals_ui',
  readOnly: true,
  description:
    'Open the evals UI in the browser of the developer: an experiment with its cases, the last report of an experiment, ' +
    'the latest optimization run of an experiment, or the list of runs when no experiment is given. ' +
    'Returns what to tell the developer when it cannot open the browser.',
  inputSchema: {
    type: 'object',
    properties: {
      experiment: { type: 'string', description: 'A saved experiment name; omit to open the list of runs.' },
      view: { type: 'string', enum: ['experiment', 'report', 'optimization'], description: 'Default experiment.' },
      case: { type: 'string', description: 'A case name to open in the experiment or report view.' },
    },
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const name = text(input, 'experiment')
    const view = text(input, 'view')
    const item = text(input, 'case')
    const place = async (): Promise<EvalsBrowserPlace> => {
      if (!name) return { view: view === 'optimization' ? 'opt-runs' : 'runs' }
      const experiment = await findExperiment(sessions, name)
      if (view === 'optimization') return optimizationPlace(sessions().optimize.snapshot(), experiment.name)
      return {
        view: view === 'report' ? 'report' : 'experiment',
        experiment: experiment.path,
        ...(item ? { case: item } : {}),
      }
    }
    const notice = await sessions().ui.open(await place())
    return reply(notice ? { opened: false, tell: notice.lines } : { opened: true })
  },
})

const openFileTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_open_file',
  readOnly: true,
  description:
    'Open a file in the editor of the developer, the way /config opens the agent: $STRANDS_EDITOR, $VISUAL, or ' +
    '$EDITOR, else the app of the system for the file. A terminal editor takes the screen and gives it back when ' +
    'it closes. Pass experiment for a saved experiment, or path for any other file. Do not print the file in chat.',
  inputSchema: {
    type: 'object',
    properties: {
      experiment: { type: 'string', description: 'A saved experiment name; opens its file.' },
      path: { type: 'string', description: 'Any file path, absolute or relative to the agent folder.' },
    },
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const experiment = text(input, 'experiment')
    const given = text(input, 'path')
    if (Boolean(experiment) === Boolean(given)) throw new Error('Give experiment or path, one of them.')
    const path = experiment ? (await findExperiment(sessions, experiment)).path : given!
    try {
      await sessions().openFile(path)
      return reply({ opened: true, file: path })
    } catch (error) {
      return reply({
        opened: false,
        file: path,
        detail: `${errorMessage(error)} Give the path${experiment ? ', offer strands_dev_open_evals_ui,' : ''} and ask in chat what to change.`,
      })
    }
  },
})

const NOTHING_WAITS = 'No finished optimization has an edit waiting for an answer.'

const reviewOptimizationTool = (sessions: Sessions, show: (run: string) => boolean): DevChatTool => ({
  name: 'strands_dev_review_optimization',
  description:
    "Put the diff of a finished optimization back on the developer's screen, where they apply each edit or leave " +
    'it. Use it when they ask to see a run or its change again while an edit of it still waits for their answer. ' +
    'It writes nothing and decides nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      run: {
        type: 'string',
        description: 'The run name from strands_dev_status. Leave it out for the latest run with an edit waiting.',
      },
    },
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const wanted = text(input, 'run')
    const waiting = listedReviews(sessions().optimize.snapshot()).filter(
      ({ review }) => temporaryEditsAwaitingAnswer(review) > 0 && !review.applied
    )
    const found = wanted ? waiting.find(({ review }) => review.run === wanted) : waiting[0]
    if (!found?.id) throw new Error(wanted ? `Run ${wanted} has no edit waiting for an answer.` : NOTHING_WAITS)
    if (!show(found.id))
      throw new Error(
        'The diff could not be put on screen. The developer can open it from its line under the chat input.'
      )
    return reply({
      run: found.review.run,
      shown: true,
      next:
        "The diff is on the developer's screen again, where they apply it or leave it. Say so in one line. " +
        'Do not print the edit, and do not ask whether to apply it.',
    })
  },
})

const applyTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_apply_optimization',
  description:
    'Write the edits that the developer accepts from the last finished optimization into the agent source. ' +
    'Give the index of each accepted edit from the review in strands_dev_status.',
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
    edits.forEach((_edit, index) => optimize.accept(index, chosen.includes(index), latest.id))
    optimize.apply(latest.id)
    const review = await until(optimize, (next) => {
      const run = latest.id ? runState(next, latest.id) : next
      return run?.step === 'review' && run.review.applied ? run.review : undefined
    })
    if (review.applyError) throw new Error(review.applyError)
    return reply({
      applied: review.applied,
      next: 'Evaluate the experiment again, after the developer approves it, to check the change.',
    })
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

const changedEdit = ({ label, kind, target, before, after, added }: ProposedEdit): string => {
  const where = target ? ` in ${target}` : ''
  return kind === 'text'
    ? `  - ${label}${where}: was ${changedValue(before)}, now ${changedValue(after)}`
    : `  - ${label}${where}: ${before} → ${after}${added ? `; ${added}` : ''}`
}

const testCheckText = (check: TestCheck | undefined): string => {
  if (!check) return ''
  const range = check.range
    ? ` (${Math.round(check.confidence * 100)}% confidence range ${signed(check.range[0])} to ${signed(check.range[1])})`
    : ''
  return ` The test check gave ${signed(check.difference)} on ${counted(check.cases, 'unseen test case')}${range}.`
}

const changeSummary = (change: TemporaryAppliedChange): string =>
  `- ${new Date(change.appliedAt).toISOString()}: ${change.auto ? 'auto-optimize' : '/optimize'} applied ` +
  `${counted(change.edits.length, 'edit')} from run ${change.run} of the experiment ${change.experiment}. ` +
  (change.auto
    ? 'The developer has auto-optimize on, so they were not shown these edits before they were written. '
    : '') +
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

export const temporaryDevChatPart = ({
  sessions,
  evaluators,
  history,
  showReview = (run): boolean => showOptimizeReview(sessions(), run),
}: TemporaryDevChatHost): DevChatPart => ({
  instructions: [INSTRUCTIONS, ...changesSection(sessions().optimize.appliedChanges())].join('\n\n'),
  skills: [STRANDS_EVALS_SKILL, STRANDS_EVALS_OPTIMIZE_SKILL, ...temporaryWorkflowSkills()],
  tools: [
    statusTool(sessions, history),
    evaluatorsTool(once(evaluators)),
    sessionConverterTool(history),
    readExperimentTool(sessions),
    testResultsTool(sessions),
    backgroundTool(sessions),
    stopBackgroundTool(sessions),
    openEvalsUiTool(sessions),
    openFileTool(sessions),
    planTool(sessions),
    ...uiTools(() => sessions().ask),
    reviewOptimizationTool(sessions, showReview),
    applyTool(sessions),
  ],
})
