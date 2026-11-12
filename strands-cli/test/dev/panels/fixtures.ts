import type { ReactElement } from 'react'
import { vi } from 'vitest'

import type {
  ExperimentSession,
  ExperimentsState,
  Generation,
  GenerationForm,
  GenerationSettings,
} from '../../../src/dev/panels/model.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../../fixtures/terminal.js'

export const store = <State>(initial: State) => {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: (): State => state,
    set: (next: State): void => {
      state = next
      for (const listener of listeners) listener()
    },
  }
}

export const show = async (element: ReactElement, rows = 20) => {
  const input = ttyInput()
  const output = ttyOutput(100, rows)
  const frame = captureFrame(output)
  const instance = render(element, { stdin: input, stdout: output })
  await instance.waitUntilRenderFlush()
  const text = (): string => frame().join('\n')
  const press = async (key: string): Promise<void> => {
    input.write(key)
    await instance.waitUntilRenderFlush()
  }
  return { text, press, instance }
}

export const panelProps = () => ({ width: 96, height: 18, close: vi.fn(), openCommand: vi.fn(() => true) })

export const generationSettings = (overrides: Partial<GenerationSettings> = {}): GenerationSettings => ({
  name: 'experiment-1',
  task: 'Answer refund questions',
  context: '',
  cases: 10,
  topics: 0,
  evaluators: [{ name: 'OutputEvaluator' }],
  model: 'us.anthropic.claude-test',
  parallel: 4,
  expectedOutput: true,
  expectedTrajectory: false,
  expectedInteractions: false,
  metadata: false,
  ...overrides,
})

export const generation = (overrides: Partial<Generation> = {}): Generation => ({
  id: 'generation-1',
  name: 'refunds',
  settings: generationSettings({ name: 'refunds' }),
  phase: 'cases',
  made: 7,
  failed: 1,
  total: 20,
  startedAt: Date.now() - 30_000,
  status: 'Writing cases',
  log: 'strands-dev/tmp/experiments/drafts/20261112-153012-refunds.log',
  ...overrides,
})

export const generationForm = (overrides: Partial<GenerationSettings> = {}): GenerationForm => ({
  settings: generationSettings(overrides),
  agentContext: 'agent.py · 3 tools · instructions.md',
  choices: {
    cases: [5, 10, 20, 30, 50],
    topics: [0, 2, 3, 5, 8],
    parallel: [1, 2, 4, 8, 10],
    evaluators: ['OutputEvaluator', 'TrajectoryEvaluator', 'InteractionsEvaluator'],
  },
})

export const experimentsSession = (
  initial: Partial<ExperimentsState> = {},
  form: GenerationForm = generationForm()
) => {
  const states = store<ExperimentsState>({
    loaded: true,
    folder: 'strands-dev/tmp/experiments',
    saved: [],
    generations: [],
    ...initial,
  })
  const session = {
    subscribe: states.subscribe,
    snapshot: states.snapshot,
    refresh: vi.fn(),
    form: vi.fn(() => form),
    generate: vi.fn((_settings: GenerationSettings, _replace?: string): string | undefined => undefined),
    cancel: vi.fn(),
    dismiss: vi.fn(),
    review: vi.fn(),
    open: vi.fn(),
    closeReview: vi.fn(),
    toggle: vi.fn(),
    drop: vi.fn(),
    keepAll: vi.fn(),
    edit: vi.fn(),
    add: vi.fn(),
    save: vi.fn(async () => undefined),
  } satisfies ExperimentSession
  return { states, session }
}
