import { join } from 'node:path'

import type { JSONValue } from '@strands-agents/sdk'

import { errorMessage } from '../../../terminal/text.js'
import { AUTO_OPTIMIZE_MAX_TURNS, autoOptimizeCadence } from '../../../config/settings.js'
import type { DevChatPart, DevChatTool } from '../../chat-extension.js'
import { STRANDS_EVALS_OPTIMIZE_SKILL, STRANDS_EVALS_SKILL } from '../package.js'
import { isGenerating, type CrashScore } from '../model.js'
import type {
  ExperimentSummary,
  Generation,
  Knob,
  EvalsBrowser,
  EvalsBrowserPlace,
  KnobKey,
  OptimizeObjective,
  OptimizePlan,
  OptimizeReview,
  OptimizeRun,
  OptimizeState,
  OptimizePhase,
  ProposedEdit,
  TestCheck,
  EvaluationRun,
} from '../model.js'
import { uiTools } from './ui-tools.js'
import { evalsWorkflowSkills } from './workflow-skills.js'
import { readEvalsExperimentFile } from '../runs/experiment.js'
import { plural } from '../host.js'
import type { EvalsStore } from '../jobs.js'
import {
  BACKGROUND_COMMANDS,
  generateFlagSettings,
  optimizeFlagSettings,
  runFlagCases,
  type BackgroundCommand,
  type OptimizeFlagSettings,
} from './background-flags.js'
import { checkEvalsObjective, EVALS_USAGE_METRICS, evalsObjectiveFromRequest } from '../tuning/objective.js'
import {
  isEvalsBudgetValue,
  EVALS_BUDGET_MINIMUMS,
  EVALS_DECISION_CHOICES,
  type EvalsBudgetSetting,
} from '../tuning/plan.js'
import {
  answerOptimizeReview,
  applyOptimizeEdits,
  showOptimizeReview,
  type AnsweredOptimizeReview,
  type AppliedOptimizeEdits,
} from '../sessions/review-run.js'
import type { EvalsSessionHistory } from '../sessions/session-converter.js'
import { evalsEditsAwaitingAnswer, type EvalsAppliedChange } from '../sessions/optimize-session.js'
import { type EvalsDevSessions } from '../sessions/sessions.js'

type Input = Readonly<Record<string, JSONValue>>
type Sessions = () => EvalsDevSessions

interface EvalsDevChatHost {
  readonly sessions: Sessions
  readonly history: EvalsSessionHistory
  /** Puts a run's waiting edits on the developer's screen. Says whether it had any to show. */
  readonly showReview?: (run: string) => boolean
  /** Picks a choice of the diff on the developer's screen in their place. Throws when that diff is not showing. */
  readonly answerReview?: (answer: Parameters<typeof answerOptimizeReview>[1]) => Promise<AnsweredOptimizeReview>
  /** Answers the named edits of a run with apply, and writes the run once every edit has its answer. */
  readonly applyEdits?: (named: Parameters<typeof applyOptimizeEdits>[1]) => Promise<AppliedOptimizeEdits>
}

const TEXT_LIMIT = 600
const EDIT_LIMIT = 4000

const INSTRUCTIONS = `For experiments, evaluations, and test cases, activate the strands-evals skill; to tune this agent against an experiment, activate the optimize skill; to run any strands-evals command, follow the background-evals skill. The developer can also type /experiment or /optimize.

Runs cost money. Name the scope in chat and end the turn; start a run only after the developer approves it in a later turn. Being asked to run, test, or improve something is not that approval. In /experiment, picking Run, or the experiments to run, on screen is the approval.

When an optimization run finishes, its edits appear on the developer's screen as a diff, and they apply or leave each edit there, unless auto-accept writes them. Do not print the edits or ask in chat which ones to apply; strands_dev_review_optimization puts a closed diff back on screen. A message that comes with a <strands_dev_screen> block was written while that diff was on their screen: when it answers the diff, such as "approve this" or "leave it", pick for them with strands_dev_answer_review as the block says, and do not ask them to confirm. Call strands_dev_apply_optimization only for edits the developer names in chat when no diff of them is on screen. strands_dev_status gives each edit's answer: one they left as it is has been answered, so a bare "yes" never applies it.

Optimization can also run by itself. Auto-optimize every N turns makes an experiment from the chats of the developer with this agent every N chat turns and tunes the agent on it, in the background and outside this chat: you take no part in it, and a notice and the line below the chat input show it; Auto-accept optimization results writes the edits of a finished run without showing them. Both are in /settings under Strands dev workspace, and strands_dev_auto_optimize reads and sets them, so do not search files for how they work. When the developer asks for it, such as "optimize every 20 turns from my history", say what it does and that every automatic run is paid. A question whether you can is not yet a request: set it once they say to.

Answer what was asked from tool output of this turn: call strands_dev_status again whenever the question is what exists, because runs and files change between turns. Ask the developer to choose or enter numbers with the strands_dev_ UI tools, and ask a free-form question in chat. When a question comes back interrupted, the developer wrote to you instead of answering: reply to that message and end the turn, and never take its unsubmitted draft as the answer. Never make up the evals UI address; pass on only what strands_dev_open_evals_ui returns, as a markdown link with a short label such as [open the run](url).`

const reply = (value: unknown): string => JSON.stringify(value, null, 2)

const clip = (text: string | undefined, limit = TEXT_LIMIT): string | undefined =>
  text === undefined || text.length <= limit
    ? text
    : `${text.slice(0, limit)}… [${text.length - limit} more characters]`

const until = <State, Result>(store: EvalsStore<State>, pick: (state: State) => Result | undefined): Promise<Result> =>
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

const flag = (input: Input, key: string): boolean | undefined => {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} must be true or false.`)
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

const PAGED_EXPERIMENT: DevChatTool['inputSchema'] = {
  type: 'object',
  properties: {
    experiment: { type: 'string' },
    offset: { type: 'integer', minimum: 0, description: 'Zero-based first case. Default 0.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Cases to return. Default 10.' },
  },
  required: ['experiment'],
  additionalProperties: false,
}

const readExperimentTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_read_experiment',
  readOnly: true,
  description:
    'Read a saved experiment, its evaluator definitions, and a page of cases. Does not run the agent or generate cases.',
  inputSchema: PAGED_EXPERIMENT,
  run: async (input): Promise<string> => {
    const selected = await findExperiment(sessions, requiredText(input, 'experiment'))
    const { experiment, raw } = await readEvalsExperimentFile(selected.path)
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

const evaluationResultsTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_evaluation_results',
  readOnly: true,
  description:
    'Inspect existing progress or the last evaluation result, including inputs, outputs, and evaluator verdicts. Does not rerun evaluations.',
  inputSchema: PAGED_EXPERIMENT,
  run: async (input): Promise<string> => {
    const experiment = await findExperiment(sessions, requiredText(input, 'experiment'))
    const { evaluate } = sessions()
    await evaluate.show()
    const run = runOf(evaluate, experiment.path)
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

const runOf = (evaluate: EvalsDevSessions['evaluate'], path: string): EvaluationRun | undefined =>
  evaluate.snapshot().runs.find(({ experiment }) => experiment.path === path)?.run

const runStatus = (run: EvaluationRun | undefined): object | undefined => {
  if (!run) return undefined
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

/**
 * What the developer answered for an edit, on screen or through the agent. An edit they were never offered has no
 * answer, and neither has one that auto-accept or an older apply wrote without asking.
 */
const answerOf = (edit: ProposedEdit, { auto, applied, reviewed }: OptimizeReview): string | undefined => {
  if (edit.unavailable !== undefined || auto) return undefined
  if (!edit.decided) return applied || reviewed ? undefined : 'waiting'
  return edit.accepted ? 'apply' : 'leave as it is'
}

const reviewReport = (review: OptimizeReview): object => {
  const { run, baseline, best, measuredOn, edits, applied, applyError, auto } = review
  return defined({
    run,
    baseline,
    best,
    measuredOn,
    edits: edits.map((edit, index) =>
      defined({
        index,
        knob: edit.knob,
        target: edit.target,
        unavailable: edit.unavailable,
        answer: answerOf(edit, review),
        before: clip(edit.before, EDIT_LIMIT),
        after: clip(edit.after, EDIT_LIMIT),
        newInCall: edit.added,
      })
    ),
    applied,
    applyError,
    // Written by the auto-accept setting as the run ended: the developer saw no diff of these edits.
    autoApplied: auto ? true : undefined,
  })
}

const AUTO_PLAN =
  'Auto-accept optimization results is on in the settings of this workspace: when this run finishes, strands dev writes its edits to ' +
  'the agent source without showing them. Say so in the review the developer approves before the run starts. A ' +
  'run they stop early is not applied. They turn the setting off in /settings, under Strands dev workspace.'

const WAITING_NEXT =
  "for the developer's yes or no. They answer on their screen, not in chat. The diff may not be showing: the run is " +
  'on the status line under the chat input, where clicking it opens the diff, and strands_dev_review_optimization ' +
  'puts it on their screen. Do not say the diff is on screen unless that call just put it there.'

const LEFT_NEXT =
  'That is their answer: apply such an edit only when they ask for that change in so many words, never on a bare ' +
  '"yes" or "ok".'

/**
 * Where a review stands with the developer, said so the agent neither calls a closed diff "on screen" nor takes an
 * edit they left as it is for one that still waits.
 */
const answersReport = (review: OptimizeReview): object => {
  if (review.applied) return {}
  const waiting = evalsEditsAwaitingAnswer(review)
  const left = review.edits.filter((edit) => answerOf(edit, review) === 'leave as it is').length
  const next = [
    ...(waiting > 0
      ? [
          `${waiting === 1 ? '1 edit of this run still waits' : `${waiting} edits of this run still wait`} ${WAITING_NEXT}`,
        ]
      : []),
    ...(left > 0 ? [`The developer left ${plural(left, 'edit')} of this run as it is. ${LEFT_NEXT}`] : []),
  ]
  return defined({
    awaitingAnswer: waiting > 0 ? waiting : undefined,
    next: next.length > 0 ? next.join(' ') : undefined,
  })
}

const optimizationStatus = (state: OptimizeState): object =>
  defined({
    ...pageStatus(state),
    runs: state.runs?.length
      ? state.runs.map(({ experiment, state: run }) => ({ experiment, ...pageStatus(run) }))
      : undefined,
  })

const RUN_PHASES: Readonly<Record<OptimizePhase, string>> = {
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
        best: state.progress.best,
        tried: state.progress.tried,
        planned: state.progress.planned,
        // Every version tried is not the end of the run: the finalists and the test are checked after the search.
        phase: state.progress.phase ? RUN_PHASES[state.progress.phase] : undefined,
        rollouts: state.progress.rollouts,
      })
    case 'review':
      return { step: 'review', ...reviewReport(state.review), ...answersReport(state.review) }
    case 'cancelled':
      return defined({ step: 'cancelled', experiment: state.experiment, run: state.run })
    case 'failed':
      return { step: 'failed', message: state.message }
  }
}

const EVALS_UI_OPENING = 'strands_dev_open_evals_ui opens an experiment, a report, or an optimization run.'

const evalsUiStatus = (ui: EvalsBrowser): object => {
  const { status, detail } = ui.snapshot()
  return defined({ status, detail, open: status === 'ready' ? EVALS_UI_OPENING : undefined })
}

const statusTool = (sessions: Sessions, history: EvalsSessionHistory): DevChatTool => ({
  name: 'strands_dev_status',
  readOnly: true,
  description:
    'Show the strands dev workspace: the saved experiments with their last evaluation result, the generations that run or failed, ' +
    'the optimization state, and the suggested settings for a new experiment with the number of past chats. ' +
    'Call it again in every turn that asks what exists, including a repeated question. ' +
    'An answer from an earlier turn is stale, because files and runs change in between.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: async (): Promise<string> => {
    const { experiments, evaluate, optimize, ui } = sessions()
    await evaluate.show()
    const [saved, pastChats] = await Promise.all([experiments.reload(), history.pastChats()])
    const { folder, generations } = experiments.snapshot()
    return reply({
      experimentsFolder: folder,
      experiments: saved.map(({ name, caseCount, path }) =>
        defined({
          name,
          cases: caseCount,
          file: path,
          evalsUi: ui.link?.({ view: 'experiment', experiment: path }),
          lastTest: runStatus(runOf(evaluate, path)),
        })
      ),
      generations: generations.map(generationStatus),
      optimization: optimizationStatus(optimize.snapshot()),
      fileChanges: sessions().fileChanges(),
      evalsUi: evalsUiStatus(ui),
      newExperiment: {
        cases: experiments.suggested().cases,
        pastChats,
        agentContext: experiments.agentSummary(),
      },
    })
  },
})

const sessionConverterTool = (history: EvalsSessionHistory): DevChatTool => ({
  name: 'strands_dev_session_converter',
  description:
    'Load the newest session-converter skill from strands-agents/evals main, with the strands dev rules for it. ' +
    'Use it to build an experiment from past chats or traces instead of from a goal. ' +
    'It downloads the skill from GitHub, and the first call can take a minute while strands dev prepares the evals environment.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  run: (): Promise<string> => history.converter(),
})

const AUTO_OPTIMIZE_TURNS = `a whole number from 0 to ${AUTO_OPTIMIZE_MAX_TURNS}`

const AUTO_OPTIMIZE_ON =
  'Every that many chat turns, strands dev works in the background, outside this chat: an agent in a process of ' +
  'its own makes an experiment from the chats of the developer with this agent, and strands dev then starts an ' +
  'optimization on it with the defaults of its plan. Nobody is asked, and you are sent nothing and start nothing. ' +
  'Each one is a paid run. A new everyTurns starts the count at 0 after the turn that set it.'

const autoOptimizeReport = async (sessions: Sessions): Promise<object> => {
  const { everyTurns, turnsSince, building, log } = await sessions().auto.status()
  const accept = sessions().settings()?.autoAcceptOptimizationResults ?? false
  return {
    autoOptimize:
      everyTurns === 0
        ? { everyTurns: 0, state: 'off: an optimization starts only when the developer asks for one' }
        : {
            everyTurns,
            turnsSinceTheLastOne: turnsSince,
            state: AUTO_OPTIMIZE_ON,
            ...(building
              ? { now: `The background agent is making the experiment ${building} from the chats. Its log: ${log}` }
              : {}),
          },
    autoAcceptOptimizationResults: accept
      ? 'on: the edits of a finished run are written to the agent source without a diff to answer'
      : 'off: the edits of a finished run show as a diff, and the developer applies or leaves each one',
    choices: { everyTurns: AUTO_OPTIMIZE_TURNS },
    where: 'Both are in /settings, under Strands dev workspace.',
  }
}

const autoOptimizeTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_auto_optimize',
  description:
    'Read or change the two settings that make optimization automatic in this workspace. everyTurns starts an ' +
    'optimization by itself every that many chat turns, from an experiment made of the chats of the developer with ' +
    'this agent: what they mean by "optimize every 20 turns from my history". acceptResults writes the edits of a ' +
    'finished run to the agent source without showing them. With no input it reads both. Change one only when the ' +
    'developer asks for that change, after you said that each automatic run is paid.',
  inputSchema: {
    type: 'object',
    properties: {
      everyTurns: {
        type: 'integer',
        minimum: 0,
        maximum: AUTO_OPTIMIZE_MAX_TURNS,
        description: 'How many chat turns pass between the automatic optimizations. 0 turns them off.',
      },
      acceptResults: {
        type: 'boolean',
        description: 'Whether the edits of a finished run are written without a diff to answer.',
      },
    },
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const every = input.everyTurns
    const cadence = autoOptimizeCadence(every)
    if (every !== undefined && every !== null && cadence === undefined)
      throw new Error(`everyTurns must be ${AUTO_OPTIMIZE_TURNS}.`)
    const accept = flag(input, 'acceptResults')
    if (cadence !== undefined || accept !== undefined)
      await sessions().setSettings({
        ...(cadence === undefined ? {} : { autoOptimize: cadence }),
        ...(accept === undefined ? {} : { autoAcceptOptimizationResults: accept }),
      })
    const stopped = await sessions().auto.settingChanged()
    return reply({
      ...(await autoOptimizeReport(sessions)),
      ...(stopped
        ? {
            stopped: `The background agent that was making ${stopped} has stopped, and no optimization starts from it.`,
          }
        : {}),
    })
  },
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

const plannedSetup = async (sessions: Sessions, experiment: ExperimentSummary): Promise<OptimizePlan> => {
  const { optimize } = sessions()
  optimize.reset()
  optimize.plan(experiment)
  const planned = await until(optimize, (state) =>
    state.step === 'setup' || state.step === 'failed' ? state : undefined
  )
  if (planned.step === 'failed') throw new Error(planned.message)
  return planned.plan
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
    const plan = await plannedSetup(sessions, await findExperiment(sessions, requiredText(input, 'experiment')))
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
          usageMetrics: EVALS_USAGE_METRICS,
          notation:
            'Maximize(X), Minimize(X), WeightedSum(Maximize(X), Minimize(Y, scale=1000)), or ' +
            'Pareto(Maximize(X), Minimize(Y, scale=1000)). X is an evaluator of the experiment or a usage metric. ' +
            'An empty objective maximizes the mean of every evaluator.',
        }),
        cases: { split: plan.split, choices: plan.splitChoices, testShare: plan.testShare },
        budget: {
          iterations: { value: plan.iterations, min: EVALS_BUDGET_MINIMUMS.iterations },
          candidatesPerStep: { value: plan.width, min: EVALS_BUDGET_MINIMUMS.width },
          runsPerCase: { value: plan.repetitions, min: EVALS_BUDGET_MINIMUMS.repetitions },
          parallelTrials: { value: plan.workers, min: EVALS_BUDGET_MINIMUMS.workers },
          finalists: { value: plan.decision.finalists, min: EVALS_BUDGET_MINIMUMS.finalists },
        },
        decision: {
          feasibility: { value: plan.decision.feasibility, choices: plan.decisionChoices.feasibility },
          crashes: { value: plan.decision.crashScore, choices: plan.decisionChoices.crashScore },
          pick: { value: plan.decision.pickRule, choices: plan.decisionChoices.pickRule },
        },
        estimate: defined({ rollouts: plan.rollouts, judgeCalls: plan.judgeCalls, usage: plan.usage }),
        problem: plan.budgetProblem ?? plan.objectiveProblem,
        warning: [plan.warning, plan.objectiveWarning, sessions().fileChanges()].filter(Boolean).join(' ') || undefined,
        autoAccept: optimize.autoApplies() ? AUTO_PLAN : undefined,
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

const budgetValue = (name: string, setting: EvalsBudgetSetting, value: number | undefined): number | undefined => {
  if (value === undefined || isEvalsBudgetValue(setting, value)) return value
  throw new Error(`${name} must be a whole number of at least ${EVALS_BUDGET_MINIMUMS[setting]}.`)
}

const objectiveFor = async (
  experiment: ExperimentSummary,
  { objective, constraints }: OptimizeFlagSettings
): Promise<OptimizeObjective | undefined> => {
  if (objective === undefined && constraints === undefined) return undefined
  const { experiment: loaded } = await readEvalsExperimentFile(experiment.path)
  const picked = evalsObjectiveFromRequest(objective, constraints, loaded.evaluators)
  const { problem } = checkEvalsObjective(picked, loaded.evaluators)
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
  const feasibility = chosen('--feasibility-threshold', settings.feasibility, EVALS_DECISION_CHOICES.feasibility)
  const crashScore = chosen(
    '--agent-failure-score',
    settings.crashScore as CrashScore | undefined,
    EVALS_DECISION_CHOICES.crashScore
  )
  if (settings.maxRollouts !== undefined && settings.maxRollouts < 1)
    throw new Error('--max-rollouts must be a whole number of at least 1.')
  const objective = await objectiveFor(experiment, settings)
  const plan = await plannedSetup(sessions, experiment)
  tunedKnobs(plan.knobs, settings.tune)
  if (settings.tune.includes('model')) for (const model of settings.models) optimize.pickModel(model, true)
  for (const knob of plan.knobs)
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
  if (settings.maxRollouts !== undefined) optimize.setMaxRollouts(settings.maxRollouts)
  if (settings.split !== undefined) optimize.setSplit(settings.split)
  optimize.setPassed(settings.passed)
  const ready = optimize.snapshot()
  if (ready.step === 'setup' && ready.plan.budgetProblem) throw new Error(ready.plan.budgetProblem)
  const started = optimize.start()
  if (started === undefined) throw new Error('The optimization did not start.')
  return started
}

/** Starts an optimization of a saved experiment as the background tool does with no flags: the defaults of its plan. */
export const startEvalsOptimizationWithDefaults = async (sessions: Sessions, experiment: string): Promise<string> =>
  startOptimization(sessions, await findExperiment(sessions, experiment), optimizeFlagSettings([]))

const caseNames = async (experiment: ExperimentSummary, names: readonly string[]): Promise<void> => {
  const { raw } = await readEvalsExperimentFile(experiment.path)
  const known = raw.cases.map((item, index) => (typeof item.name === 'string' ? item.name : String(index)))
  const unknown = names.filter((name) => !known.includes(name))
  if (unknown.length > 0) throw new Error(`${experiment.name} has no case ${unknown.join(', ')}.`)
}

const BACKGROUND_DETAIL =
  'It goes on in the background, with its progress on a line below the chat input. A notice says when it ' +
  'finishes; then strands_dev_status and strands_dev_evaluation_results read the result.'

const OPTIMIZE_DETAIL =
  `${BACKGROUND_DETAIL} When it finishes, its edits appear on the developer's screen as a diff to apply or leave, ` +
  'and an applied edit is written and hot-reloaded without you; with auto-accept on, they are written unasked.'

const backgroundTool = (sessions: Sessions): DevChatTool => ({
  name: 'strands_dev_run_background',
  description:
    'Start a paid strands-evals command in the background and return at once. This call starts the paid run ' +
    'itself, so call it only after the developer answered yes, in an earlier turn, to the scope you named. ' +
    'Pass the command and the flags the skill would pass: run evaluates the agent on an experiment ' +
    '(--case NAME, repeatable, runs only those cases), optimize run takes the flags of the optimize skill ' +
    '(--tune, --no-tune-instructions, --objective, --pareto, --constraint, --max-rollouts, --max-iterations, ' +
    '--proposals-per-iteration, --runs-per-candidate, --n-finalists, --max-workers, --feasibility-threshold, ' +
    '--agent-failure-score, --split as TRAIN,VALIDATION,TEST shares, --seed, --rerun-passes, ' +
    '--reflection-model, --custom-evaluator, --selection, --score-model, --on-iteration), and generate takes --task-description, --context, and --num-cases of ' +
    'strands-evals generate and saves experiments/<experiment>/<experiment>.json. strands dev runs it in its ' +
    'prepared evals environment with ' +
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
    const { evaluate } = sessions()
    await evaluate.show()
    if (runOf(evaluate, experiment.path)?.status === 'running')
      throw new Error(`${experiment.name} is already running. strands_dev_evaluation_results reads its progress.`)
    if (cases.length > 0) {
      await caseNames(experiment, cases)
      evaluate.runOnly(experiment, cases)
    } else evaluate.run([experiment])
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
    const { experiments, evaluate, optimize } = sessions()
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
      await evaluate.show()
      if (runOf(evaluate, experiment.path)?.status !== 'running')
        throw new Error(`No evaluation of ${experiment.name} is running.`)
      evaluate.stop(experiment.path)
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
    const waiting = (sessions().optimize.snapshot().runs ?? []).flatMap(({ id, state }) =>
      state.step === 'review' && evalsEditsAwaitingAnswer(state.review) > 0 && !state.review.applied
        ? [{ id, review: state.review }]
        : []
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

const answeredNext = ({ settled, applied, applyError, next }: AnsweredOptimizeReview, apply: boolean): string => {
  if (next)
    return (
      `The diff of edit ${next.edit} of this run took its place on the developer's screen, ${next.at + 1} of ` +
      `${next.of}: ${next.change}. If their message answered every edit of the run, such as "apply all of ` +
      'them", answer this one the same way. Otherwise it is theirs to answer: say in one line what you picked ' +
      'and that the next edit is on screen.'
    )
  if (!settled)
    return 'Another edit of this run still waits behind a question on screen. Say in one line what you picked.'
  if (applyError) return 'An edit could not be written: give applyError as it is, and say which edits were applied.'
  if (applied?.length)
    return (
      'Every edit of this run has its answer, the diff is closed, and the edits in applied are written. The agent ' +
      'reloads after your reply. Say so in one line, and offer to evaluate the experiment again to check the change.'
    )
  return apply
    ? 'Every edit of this run has its answer and the diff is closed. Say so in one line.'
    : 'Every edit of this run has its answer, the diff is closed, and nothing was written. Say so in one line.'
}

const answerReviewTool = (answerReview: NonNullable<EvalsDevChatHost['answerReview']>): DevChatTool => ({
  name: 'strands_dev_answer_review',
  description:
    "Pick a choice of the optimization diff on the developer's screen, in their place: apply the edit it shows, or " +
    'leave it as it is. Call it only when their chat message came with that diff as what is on their screen and ' +
    'the message is their answer to it, with the run and the edit named there. It does what picking the choice on ' +
    'screen does: the diff closes, the next edit of the run shows, and the accepted edits are written once every ' +
    'edit has its answer. It refuses when that diff is not the one showing.',
  inputSchema: {
    type: 'object',
    properties: {
      run: { type: 'string', description: 'The run that the diff on screen belongs to.' },
      edit: { type: 'integer', description: 'The edit that the diff on screen shows, by its index in that run.' },
      answer: {
        type: 'string',
        enum: ['apply', 'leave'],
        description: 'apply writes the edit; leave keeps the agent as it is.',
      },
    },
    required: ['run', 'edit', 'answer'],
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const edit = whole(input, 'edit', 0, Number.MAX_SAFE_INTEGER)
    if (edit === undefined) throw new Error('edit must be the index of the edit that the diff on screen shows.')
    if (input.answer !== 'apply' && input.answer !== 'leave') throw new Error('answer must be apply or leave.')
    const apply = input.answer === 'apply'
    const answered = await answerReview({ run: requiredText(input, 'run'), edit, apply })
    return reply(
      defined({
        run: answered.run,
        edit,
        picked: apply ? 'Apply this change' : 'Leave it as it is',
        applied: answered.applied,
        applyError: answered.applyError,
        next: answeredNext(answered, apply),
      })
    )
  },
})

const appliedNext = ({ settled, waiting, shown }: AppliedOptimizeEdits): string => {
  if (settled) return 'Evaluate the experiment again, after the developer approves it, to check the change.'
  const still = waiting === 1 ? '1 other edit of this run still waits' : `${waiting} other edits of this run still wait`
  return (
    `Their answer is kept, and nothing is written yet: ${still} for the developer's answer, and a run is written ` +
    'once every edit has one. ' +
    (shown
      ? 'The diff of a waiting edit is on their screen now. Say that in one line.'
      : 'The run is on the status line under the chat input, where clicking it opens the diff. Say that in one line.')
  )
}

const applyTool = (applyEdits: NonNullable<EvalsDevChatHost['applyEdits']>): DevChatTool => ({
  name: 'strands_dev_apply_optimization',
  description:
    'Answer edits of a finished optimization with apply, for a developer who named them in chat while no diff of ' +
    'them is on screen. Give the run and the index of each named edit, from the review in strands_dev_status. ' +
    'Every other edit keeps the answer it has, on screen or none yet. The run is written to the agent source once ' +
    'every edit has its answer; until then the diff of a waiting edit goes on screen.',
  inputSchema: {
    type: 'object',
    properties: {
      run: { type: 'string', description: 'The run name from strands_dev_status.' },
      edits: { type: 'array', items: { type: 'integer' }, description: 'The indexes of the edits to apply.' },
    },
    required: ['run', 'edits'],
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const edits = Array.isArray(input.edits) ? input.edits : []
    for (const index of edits)
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0)
        throw new Error(`There is no edit ${String(index)}.`)
    const applied = await applyEdits({ run: requiredText(input, 'run'), edits: edits as number[] })
    if (applied.applyError) throw new Error(applied.applyError)
    return reply(
      defined({
        run: applied.run,
        applied: applied.applied,
        awaitingAnswer: applied.waiting,
        next: appliedNext(applied),
      })
    )
  },
})

const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`

const changedValue = (text: string): string => JSON.stringify(clip(text) ?? '')

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
  return ` The test check gave ${signed(check.difference)} on ${plural(check.cases, 'unseen test case')}${range}.`
}

const changeSummary = (change: EvalsAppliedChange): string =>
  `- ${new Date(change.appliedAt).toISOString()}: ${change.auto ? 'auto-accept' : '/optimize'} applied ` +
  `${plural(change.edits.length, 'edit')} from run ${change.run} of the experiment ${change.experiment}. ` +
  (change.auto
    ? 'The developer has auto-accept on, so they were not shown these edits before they were written. '
    : '') +
  `The best candidate scored ${change.baseline.toFixed(2)} → ${change.best.toFixed(2)} on the ${change.measuredOn}.` +
  testCheckText(change.testCheck) +
  (change.error ? ` Apply stopped early: ${change.error}` : '')

const changesSection = (changes: readonly EvalsAppliedChange[]): string[] =>
  changes.length === 0
    ? []
    : [
        [
          'Changes that strands dev made to this agent in this session. The agent source has them, and strands dev reloaded the agent after each one, so this chat already runs the changed agent:',
          ...changes.flatMap((change) => [changeSummary(change), ...change.edits.map(changedEdit)]),
        ].join('\n'),
      ]

export const evalsDevChatPart = ({
  sessions,
  history,
  showReview = (run): boolean => showOptimizeReview(sessions(), run),
  answerReview = (answer): Promise<AnsweredOptimizeReview> => answerOptimizeReview(sessions(), answer),
  applyEdits = (named): Promise<AppliedOptimizeEdits> => applyOptimizeEdits(sessions(), named),
}: EvalsDevChatHost): DevChatPart => ({
  instructions: [INSTRUCTIONS, ...changesSection(sessions().optimize.appliedChanges())].join('\n\n'),
  skills: [STRANDS_EVALS_SKILL, STRANDS_EVALS_OPTIMIZE_SKILL, ...evalsWorkflowSkills()],
  tools: [
    statusTool(sessions, history),
    sessionConverterTool(history),
    readExperimentTool(sessions),
    evaluationResultsTool(sessions),
    backgroundTool(sessions),
    stopBackgroundTool(sessions),
    openEvalsUiTool(sessions),
    openFileTool(sessions),
    planTool(sessions),
    ...uiTools(() => sessions().ask),
    autoOptimizeTool(sessions),
    reviewOptimizationTool(sessions, showReview),
    answerReviewTool(answerReview),
    applyTool(applyEdits),
  ],
})
