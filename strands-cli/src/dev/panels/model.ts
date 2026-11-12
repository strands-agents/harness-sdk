export interface EvalCase {
  readonly name: string
  readonly input: string
  readonly expected?: string
}

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

export interface DraftCase extends EvalCase {
  readonly kept: boolean
  readonly saved: boolean
}

export type EvaluatorKind = 'OutputEvaluator' | 'TrajectoryEvaluator' | 'InteractionsEvaluator'

export interface GenerationSettings {
  readonly name: string
  readonly task: string
  readonly context: string
  readonly cases: number
  readonly topics: number
  readonly evaluator: EvaluatorKind
  readonly model: string
  readonly parallel: number
  readonly expectedOutput: boolean
  readonly expectedTrajectory: boolean
  readonly expectedInteractions: boolean
  readonly metadata: boolean
}

export interface GenerationForm {
  readonly settings: GenerationSettings
  readonly agentContext: string
  readonly choices: {
    readonly cases: readonly number[]
    readonly topics: readonly number[]
    readonly parallel: readonly number[]
    readonly evaluators: readonly EvaluatorKind[]
  }
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

export interface Notice {
  readonly text: string
  readonly tone: 'success' | 'error'
}

export interface Review {
  readonly key: string
  readonly name: string
  readonly path?: string
  readonly cases: readonly DraftCase[]
  readonly notice?: Notice
}

export interface ExperimentsState {
  readonly loaded: boolean
  readonly folder: string
  readonly saved: readonly ExperimentSummary[]
  readonly generations: readonly Generation[]
  readonly review?: Review
  readonly error?: string
}

export interface CaseChange {
  readonly input?: string
  readonly expected?: string
}

export interface ExperimentSession {
  subscribe(listener: () => void): () => void
  snapshot(): ExperimentsState
  refresh(): void
  form(): GenerationForm
  generate(settings: GenerationSettings, replace?: string): string | undefined
  cancel(id: string): void
  dismiss(id: string): void
  review(id: string): void
  open(experiment: ExperimentSummary): void
  closeReview(): void
  toggle(index: number): void
  drop(index: number): void
  keepAll(): void
  edit(index: number, change: CaseChange): void
  add(change: CaseChange): void
  save(): Promise<ExperimentSummary | undefined>
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

export interface TestSession {
  readonly experiments: ExperimentSession
  subscribe(listener: () => void): () => void
  snapshot(): TestState
  run(experiments: readonly ExperimentSummary[]): void
  rerunFailed(path: string): void
}

export type KnobKey = 'instructions' | 'effort' | 'tools'

export interface Knob {
  readonly key: KnobKey
  readonly label: string
  readonly detail: string
  readonly enabled: boolean
  readonly unavailable?: string
}

export interface CaseSplit {
  readonly train: number
  readonly validation: number
  readonly test: number
}

export interface OptimizePlan {
  readonly experiment: ExperimentSummary
  readonly knobs: readonly Knob[]
  readonly split: CaseSplit
  readonly repetitions: number
  readonly width: number
  readonly iterations: number
  readonly iterationChoices: readonly number[]
  readonly rollouts: number
  readonly judgeCalls: number
  readonly warning?: string
}

export interface CandidateResult {
  readonly number: number
  readonly step?: number
  readonly changed: readonly string[]
  readonly summary: string
  readonly score?: number
  readonly ci?: readonly [number, number]
  readonly delta?: number
  readonly kept: boolean
  readonly failed?: string
}

export interface OptimizeProgress {
  readonly run: string
  readonly record: string
  readonly metric: string
  readonly iterations: number
  readonly planned: number
  readonly baseline?: number
  readonly best?: { readonly number: number; readonly score: number }
  readonly candidates: readonly CandidateResult[]
  readonly startedAt: number
  readonly stopping: boolean
}

export interface ProposedEdit {
  readonly knob: KnobKey
  readonly label: string
  readonly target?: string
  readonly before: string
  readonly after: string
  readonly accepted: boolean
  readonly unavailable?: string
}

export interface OptimizeReview {
  readonly run: string
  readonly record: string
  readonly baseline: number
  readonly best: number
  readonly measuredOn: string
  readonly edits: readonly ProposedEdit[]
  readonly applied?: readonly string[]
  readonly applyError?: string
}

export type OptimizeState =
  | { readonly step: 'pick' }
  | { readonly step: 'setup'; readonly plan: OptimizePlan }
  | { readonly step: 'running'; readonly progress: OptimizeProgress }
  | { readonly step: 'review'; readonly review: OptimizeReview }
  | { readonly step: 'failed'; readonly message: string; readonly record?: string }

export interface OptimizeSession {
  readonly experiments: ExperimentSession
  subscribe(listener: () => void): () => void
  snapshot(): OptimizeState
  plan(experiment: ExperimentSummary): void
  toggleKnob(key: KnobKey): void
  setIterations(iterations: number): void
  start(): void
  stop(): void
  accept(index: number, accepted: boolean): void
  apply(): void
  reset(): void
}
