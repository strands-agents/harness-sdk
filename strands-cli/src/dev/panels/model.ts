export interface EvalCase {
  readonly name: string
  readonly input: string
  readonly expected?: string
}

export type CaseField = 'input' | 'expected'

export const missingCaseField = ({ input, expected }: Pick<EvalCase, 'input' | 'expected'>): CaseField | undefined =>
  !input.trim() ? 'input' : !expected?.trim() ? 'expected' : undefined

export interface ExperimentSummary {
  readonly name: string
  readonly path: string
  readonly caseCount: number
}

export interface Experiment {
  readonly name: string
  readonly path: string
  readonly cases: readonly EvalCase[]
  readonly evaluators: readonly string[]
}

export interface EvaluatorChoice {
  readonly name: string
  readonly settings?: Readonly<Record<string, unknown>>
}

export interface GenerationSettings {
  readonly name: string
  readonly task: string
  readonly context: string
  readonly cases: number
  readonly topics: number
  readonly evaluators: readonly EvaluatorChoice[]
  readonly model: string
  readonly parallel: number
  readonly expectedTrajectory: boolean
  readonly expectedInteractions: boolean
  readonly metadata: boolean
}

export type GenerationPhase = 'preparing' | 'planning' | 'cases' | 'rubric' | 'ready' | 'failed'

export interface GenerationError {
  readonly summary: string
  readonly detail: string
}

export interface Generation {
  readonly id: string
  readonly name: string
  readonly settings: GenerationSettings
  readonly phase: GenerationPhase
  readonly made: number
  readonly failed: number
  readonly total: number
  readonly startedAt: number
  readonly endedAt?: number
  readonly status: string
  readonly log: string
  readonly caseError?: string
  readonly error?: GenerationError
}

export interface ExperimentsState {
  readonly loaded: boolean
  readonly folder: string
  readonly saved: readonly ExperimentSummary[]
  readonly generations: readonly Generation[]
  readonly error?: string
}

export const isGenerating = ({ phase }: Generation): boolean => phase !== 'ready' && phase !== 'failed'

export interface EvaluatorVerdict {
  readonly evaluator: string
  readonly score: number
  readonly passed: boolean
  readonly reason: string
}

export interface CaseResult {
  readonly name: string
  readonly input: string
  readonly expected?: string
  readonly actual?: string
  readonly passed: boolean
  readonly verdicts: readonly EvaluatorVerdict[]
}

export interface TestResults {
  readonly experiment: string
  readonly cases: readonly CaseResult[]
  readonly evaluators: readonly string[]
  readonly overall: number
  readonly report: string
  readonly seconds: number
  readonly tokens?: number
}

export type TestRun =
  | {
      readonly status: 'running'
      readonly cases: number
      readonly evaluators: readonly string[]
      readonly done: number
      readonly startedAt: number
      readonly rerun: boolean
    }
  | { readonly status: 'done'; readonly results: TestResults }
  | { readonly status: 'failed'; readonly message: string }

export interface ExperimentRun {
  readonly experiment: ExperimentSummary
  readonly run: TestRun
}

export interface TestState {
  readonly runs: readonly ExperimentRun[]
}

export type KnobKey = string

export type KnobGroup = 'prompt' | 'model' | 'tools' | 'context' | 'skills' | 'plugins'

export type KnobKind = 'text' | 'choice' | 'switches' | 'models'

export interface Knob {
  readonly key: KnobKey
  readonly label: string
  readonly detail: string
  readonly group: KnobGroup
  readonly kind: KnobKind
  readonly enabled: boolean
  readonly unavailable?: string
  /** The call leaves this option out, so the run starts from the harness default. */
  readonly notInCall?: boolean
}

export interface ModelChoices {
  readonly current: string
  readonly picked: readonly string[]
}

export interface CaseSplit {
  readonly train: number
  readonly validation: number
  readonly test: number
}

export const sameCaseSplit = (left: CaseSplit, right: CaseSplit): boolean =>
  left.train === right.train && left.validation === right.validation && left.test === right.test

export interface OptimizeObjective {
  readonly expression: string
  readonly constraints: string
}

export type CrashScore = 'worst' | 'none'

export type PickRule = 'mean' | 'lower-bound-25' | 'lower-bound-10'

export interface OptimizeDecision {
  readonly feasibility: number
  readonly crashScore: CrashScore
  readonly pickRule: PickRule
  readonly finalists: number
}

export type DecisionSetting = Exclude<keyof OptimizeDecision, 'finalists'>

export type DecisionChoices = { readonly [Setting in DecisionSetting]: readonly OptimizeDecision[Setting][] }

export interface ObjectivePreset {
  readonly label: string
  readonly objective: OptimizeObjective
}

export interface UsageRange {
  readonly low: number
  readonly high: number
}

export interface UsageEstimate {
  readonly tokens: UsageRange
  readonly seconds: UsageRange
  readonly basedOn: { readonly experiment: string; readonly runs: number }
}

export interface OptimizePlan {
  readonly experiment: ExperimentSummary
  readonly knobs: readonly Knob[]
  readonly objective: OptimizeObjective
  readonly objectivePresets: readonly ObjectivePreset[]
  readonly objectiveProblem?: string
  readonly objectiveWarning?: string
  readonly metrics: readonly string[]
  readonly split: CaseSplit
  readonly splitChoices: readonly CaseSplit[]
  readonly testShare: number
  readonly testShareChoices: readonly number[]
  readonly decision: OptimizeDecision
  readonly decisionChoices: DecisionChoices
  readonly validatedFinalists: number
  readonly repetitions: number
  readonly width: number
  readonly workers: number
  readonly iterations: number
  readonly rollouts: number
  readonly budgetProblem?: string
  readonly judgeCalls: number
  readonly usage?: UsageEstimate
  readonly warning?: string
  readonly models?: ModelChoices
}

export interface TrialProgress {
  readonly done: number
  readonly total: number
}

export interface ScoringProgress extends TrialProgress {
  readonly score?: number
}

export type OptimizeStep =
  | { readonly kind: 'baseline'; readonly trials: TrialProgress }
  | { readonly kind: 'proposing'; readonly iteration: number }
  | { readonly kind: 'scoring'; readonly iteration: number; readonly versions: number; readonly trials: TrialProgress }
  | { readonly kind: 'validating'; readonly versions: number; readonly trials: TrialProgress }
  | { readonly kind: 'testing'; readonly versions: number; readonly trials: TrialProgress }

export interface CandidateResult {
  readonly number: number
  readonly step?: number
  readonly changed: readonly string[]
  readonly summary: string
  readonly score?: number
  readonly delta?: number
  readonly kept: boolean
  readonly failed?: string
  readonly rationale?: string
  readonly trials?: readonly CaseResult[]
  readonly scoring?: ScoringProgress
}

export interface OptimizeProgress {
  readonly run: string
  readonly record: string
  readonly metric: string
  readonly iterations: number
  readonly planned: number
  readonly trainCases?: number
  readonly baseline?: number
  readonly best?: { readonly number: number; readonly score: number }
  readonly candidates: readonly CandidateResult[]
  readonly baselineCandidate?: CandidateResult
  readonly measure?: ObjectiveMeasure
  readonly step?: OptimizeStep
  /** The case runs of the whole run, done and in all: the search, the check of the finalists, and the test. */
  readonly rollouts?: TrialProgress
  readonly startedAt: number
  readonly stopping: boolean
}

export const measuredVersions = ({ candidates, baseline }: OptimizeProgress): number =>
  candidates.filter(({ scoring }) => scoring === undefined).length + (baseline === undefined ? 0 : 1)

export interface ProposedEdit {
  readonly knob: KnobKey
  readonly kind: 'text' | 'value'
  readonly label: string
  readonly target?: string
  readonly before: string
  readonly after: string
  readonly accepted: boolean
  /** The developer answered this edit, yes or no. Until then it waits, and `accepted` is only its default. */
  readonly decided?: boolean
  readonly unavailable?: string
  /** What applying writes for an option that the call does not set yet. */
  readonly added?: string
}

export interface TestCheck {
  readonly difference: number
  readonly cases: number
  readonly confidence: number
  readonly range?: readonly [number, number]
}

export type ObjectiveMeasure =
  | { readonly kind: 'score' }
  | { readonly kind: 'metric'; readonly metric: string; readonly usage: boolean; readonly lower: boolean }
  | { readonly kind: 'combined' }

export interface OptimizeReview {
  readonly run: string
  readonly record: string
  readonly baseline: number
  readonly best: number
  readonly measure?: ObjectiveMeasure
  readonly measuredOn: string
  readonly edits: readonly ProposedEdit[]
  readonly testCheck?: TestCheck
  readonly applied?: readonly string[]
  readonly applyError?: string
  /** Every edit was answered on screen, so nothing is waiting on the developer. */
  readonly reviewed?: boolean
  /** Auto-optimize answered every edit with apply when the run ended, so the developer was never asked. */
  readonly auto?: boolean
}

export type OptimizeRunState =
  | { readonly step: 'running'; readonly progress: OptimizeProgress }
  | { readonly step: 'review'; readonly review: OptimizeReview }
  | { readonly step: 'cancelled'; readonly experiment: string; readonly run?: string }
  | { readonly step: 'failed'; readonly message: string; readonly record?: string }

export interface OptimizeRun {
  readonly id: string
  readonly experiment: string
  readonly startedAt: number
  readonly record?: string
  readonly state: OptimizeRunState
}

export type OptimizePage =
  { readonly step: 'pick' } | { readonly step: 'setup'; readonly plan: OptimizePlan } | OptimizeRunState

export type OptimizeState = OptimizePage & { readonly runs?: readonly OptimizeRun[] }

export type EvalsBrowserPlace =
  | { readonly view: 'runs' }
  | { readonly view: 'opt-runs' }
  | { readonly view: 'experiment' | 'report'; readonly experiment: string; readonly case?: string }
  | { readonly view: 'optimization'; readonly record: string }

export interface EvalsBrowserNotice {
  readonly tone: 'normal' | 'muted' | 'warning'
  readonly lines: readonly string[]
}

export interface EvalsBrowserState {
  readonly status: 'off' | 'starting' | 'ready' | 'unavailable'
  readonly detail?: string
}

export interface EvalsBrowser {
  subscribe(listener: () => void): () => void
  snapshot(): EvalsBrowserState
  open(place: EvalsBrowserPlace): Promise<EvalsBrowserNotice | undefined>
  link?(place: EvalsBrowserPlace, runFolder?: string): string | undefined
}
