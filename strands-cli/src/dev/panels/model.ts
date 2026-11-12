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

export type DatasetState =
  | { readonly step: 'loading' }
  | { readonly step: 'empty'; readonly folder: string }
  | { readonly step: 'pick'; readonly experiments: readonly ExperimentSummary[] }
  | { readonly step: 'drafting'; readonly startedAt: number; readonly count: number; readonly into?: string }
  | {
      readonly step: 'draft'
      readonly name: string
      readonly path?: string
      readonly cases: readonly DraftCase[]
      readonly drafted: number
      readonly notice?: { readonly text: string; readonly tone: 'success' | 'error' }
    }
  | { readonly step: 'failed'; readonly message: string }

export interface DatasetSession {
  subscribe(listener: () => void): () => void
  snapshot(): DatasetState
  refresh(): void
  open(experiment: ExperimentSummary): void
  generate(): void
  toggle(index: number): void
  drop(index: number): void
  keepAll(): void
  save(): Promise<ExperimentSummary | undefined>
}

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

export type TestState =
  | { readonly step: 'dataset' }
  | {
      readonly step: 'running'
      readonly experiment: string
      readonly cases: number
      readonly evaluators: readonly string[]
      readonly done: number
      readonly startedAt: number
      readonly rerun: boolean
    }
  | { readonly step: 'results'; readonly results: TestResults }
  | { readonly step: 'failed'; readonly message: string }

export interface TestSession {
  readonly dataset: DatasetSession
  subscribe(listener: () => void): () => void
  snapshot(): TestState
  run(experiment: ExperimentSummary): void
  rerunFailed(): void
  reset(): void
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
  | { readonly step: 'dataset' }
  | { readonly step: 'setup'; readonly plan: OptimizePlan }
  | { readonly step: 'running'; readonly progress: OptimizeProgress }
  | { readonly step: 'review'; readonly review: OptimizeReview }
  | { readonly step: 'failed'; readonly message: string; readonly record?: string }

export interface OptimizeSession {
  readonly dataset: DatasetSession
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
