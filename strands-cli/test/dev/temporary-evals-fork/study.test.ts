import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { readTemporaryStudy, temporaryStudyReader } from '../../../src/dev/temporary-evals-fork/study.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const RUN = { run: '20261111-194750-capital', record: '/project/strands-dev/tmp/optimization/x', startedAt: 1_000 }
const BASELINE_INSTRUCTIONS = 'Answer in one word.\nBe brief.'
const BASELINE = { instructions: BASELINE_INSTRUCTIONS, effort: 'auto' }

const header = (
  objectives: Record<string, unknown>[] = [
    { kind: 'Maximize', metric: 'Equals', weight: 1.0, scale: null, tolerance: 0.0 },
  ]
) => ({
  type: 'study',
  format: 'strands_evals.optimization',
  schema: 3,
  width: 2,
  objectives,
  space: [
    { key: 'instructions', type: 'text', default: BASELINE_INSTRUCTIONS, max_chars: 8000 },
    { key: 'effort', type: 'choice', default: 'auto' },
  ],
  cases: ['c0', 'c1', 'c2', 'c3'],
  repetitions: 1,
  validation: ['c4', 'c5'],
  test: ['c6', 'c7'],
})

interface CandidateFixture {
  number: number
  params?: Record<string, unknown>
  mean?: number
  ci?: [number, number]
  bestAfter?: number[]
  status?: string
  reason?: string | null
  trials?: object[]
}

const candidate = ({
  number,
  params = BASELINE,
  mean,
  ci,
  bestAfter = [0],
  status = 'complete',
  reason = null,
  trials = [],
}: CandidateFixture) => ({
  type: 'candidate',
  number,
  params,
  status,
  reason,
  role: number === 0 ? 'baseline' : 'step',
  step: number === 0 ? null : 1,
  proposed: number === 0 ? [] : ['text'],
  drawn: {},
  origin: {},
  best_after: bestAfter,
  estimates:
    mean === undefined
      ? {}
      : { Equals: { mean, ci: ci ?? [mean, mean], n: 4 }, tokens: { mean: 12, ci: [12, 12], n: 4 } },
  trials,
})

const LONG_LINE = `Always ${'answer with the single word that names the capital city, '.repeat(2)}`.trim()

const SEARCH = [
  header(),
  { type: 'run', iterations: 2, patience: null },
  { type: 'scope', id: 1, kind: 'Joint', limit: 2 },
  candidate({ number: 0, mean: 0.5, ci: [0.25, 0.75] }),
  candidate({
    number: 1,
    params: { ...BASELINE, instructions: `${BASELINE_INSTRUCTIONS}\nNever add punctuation.` },
    mean: 0.75,
    ci: [0.5, 1],
    bestAfter: [1],
  }),
  candidate({ number: 2, params: { ...BASELINE, effort: 'high' }, mean: 0.25, bestAfter: [1] }),
  candidate({
    number: 3,
    params: { ...BASELINE, instructions: 'Reply politely.' },
    status: 'failed',
    trials: [
      { case: 'c0', error: null },
      { case: 'c1', error: 'ThrottlingException: slow down' },
    ],
    bestAfter: [1],
  }),
  candidate({
    number: 4,
    status: 'invalid',
    reason: 'instructions: 9000 characters, over max_chars=8000',
    bestAfter: [1],
  }),
  { type: 'repeat', candidate: 1, role: 'step', step: 2 },
  { type: 'model', candidates: [0, 1, 2], used: false, problem: 'fewer than 2 eligible candidates' },
  candidate({
    number: 5,
    params: { instructions: `${BASELINE_INSTRUCTIONS}\n${LONG_LINE}`, effort: 'low' },
    mean: 0.5,
    bestAfter: [1],
  }),
  { type: 'scope_end', id: 1, ran: 5 },
]

const VALIDATION = [
  { type: 'validated', number: 0, estimates: { Equals: { mean: 0.4, ci: [0.2, 0.6], n: 2 } } },
  { type: 'validated', number: 1, estimates: { Equals: { mean: 0.8, ci: [0.6, 1], n: 2 } } },
  { type: 'selected', on: 'validation', by: 'measured', best: [1] },
  { type: 'finished', best: [1], reason: 'candidates' },
]

const TESTED = [
  { type: 'test', format: 'strands-evals.optimization.test', cases: ['c6', 'c7'], repetitions: 1 },
  { type: 'tested', number: 0, role: 'baseline', means: { Equals: 0.5 }, difference: {}, ratio: {} },
  {
    type: 'tested',
    number: 1,
    role: 'selected',
    means: { Equals: 1 },
    difference: { Equals: { mean: 0.5, ci90: [0.1, 0.9], cases: 2 } },
    ratio: {},
  },
  { type: 'test_end', missing: { '0': 0, '1': 0 } },
]

const reading = (events: object[]) => {
  const reader = temporaryStudyReader(RUN)
  events.forEach((event) => reader.push(JSON.stringify(event)))
  return reader
}

const recordFolder = async (events: object[], result?: unknown): Promise<string> => {
  const record = join(await temporaryDirectory(), 'strands-dev', 'tmp', 'optimization', '20261111-194750-capital')
  await mkdir(record, { recursive: true })
  await writeFile(join(record, 'study.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
  if (result !== undefined)
    await writeFile(join(record, 'result.json'), typeof result === 'string' ? result : JSON.stringify(result, null, 1))
  return record
}

describe('TEMPORARY optimization study', () => {
  it('shouldListTheCandidatesAfterTheBaselineWhenTheSearchRuns', () => {
    const progress = reading(SEARCH).progress()

    expect(progress).toMatchObject({
      ...RUN,
      metric: 'Equals',
      iterations: 2,
      planned: 5,
      baseline: 0.5,
      best: { number: 1, score: 0.75 },
      stopping: false,
    })
    expect(progress.candidates.map(({ number }) => number)).toEqual([1, 2, 3, 4, 5])
  })

  it.each([
    { number: 1, changed: ['instructions'], summary: 'Never add punctuation.' },
    { number: 2, changed: ['effort'], summary: 'effort → high' },
    { number: 3, changed: ['instructions'], summary: 'ThrottlingException: slow down' },
    { number: 4, changed: [], summary: 'instructions: 9000 characters, over max_chars=8000' },
  ])('shouldSummarizeCandidate$numberWhenItChanges$changed', ({ number, changed, summary }) => {
    const candidate = reading(SEARCH)
      .progress()
      .candidates.find((result) => result.number === number)

    expect(candidate).toMatchObject({ number, changed, summary })
  })

  it('shouldCutTheNewInstructionLineAndJoinTheChangesWhenACandidateChangesSeveralKnobs', () => {
    const candidate = reading(SEARCH)
      .progress()
      .candidates.find(({ number }) => number === 5)

    const [line, effort] = candidate!.summary.split('; ')
    expect(Array.from(line!)).toHaveLength(80)
    expect(line).toBe(`${LONG_LINE.slice(0, 79)}…`)
    expect(effort).toBe('effort → low')
    expect(candidate!.changed).toEqual(['instructions', 'effort'])
  })

  it('shouldScoreEachCandidateAgainstTheBaselineWhenItFinishes', () => {
    const [first, second, failed, invalid] = reading(SEARCH).progress().candidates

    expect(first).toEqual({
      number: 1,
      step: 1,
      changed: ['instructions'],
      summary: 'Never add punctuation.',
      score: 0.75,
      ci: [0.5, 1],
      delta: 0.25,
      kept: true,
    })
    expect(second).toMatchObject({ score: 0.25, delta: -0.25, kept: false })
    expect(failed).toMatchObject({ failed: 'ThrottlingException: slow down', kept: false })
    expect(failed).not.toHaveProperty('score')
    expect(invalid).toMatchObject({ failed: 'instructions: 9000 characters, over max_chars=8000' })
  })

  it('shouldSayNoTrialHadAValueWhenAFailedCandidateGivesNoReason', () => {
    const progress = reading([
      header(),
      candidate({ number: 0, mean: 0.5 }),
      candidate({ number: 1, status: 'failed' }),
    ]).progress()

    expect(progress.candidates[0]).toMatchObject({ failed: 'no trial had a value for every goal metric' })
  })

  it('shouldUseTheNewScoresWhenACandidateIsRemeasured', () => {
    const remeasured = { type: 'remeasured', number: 1, estimates: { Equals: { mean: 0.7, ci: [0.6, 0.8], n: 8 } } }

    const [first] = reading([...SEARCH, remeasured]).progress().candidates

    expect(first).toMatchObject({ score: 0.7, ci: [0.6, 0.8] })
    expect(first!.delta).toBeCloseTo(0.2)
  })

  it('shouldIgnoreLinesWhenTheyAreBlankOrNotEvents', () => {
    const reader = temporaryStudyReader(RUN)
    const lines = [
      '',
      '   ',
      '{"type": "candid',
      '[1, 2]',
      '{"number": 3}',
      '{"type": "__proto__"}',
      '{"type": "toString"}',
    ]

    lines.forEach((line) => reader.push(line))

    expect(reader.progress()).toEqual({
      ...RUN,
      metric: '',
      iterations: 0,
      planned: 1,
      candidates: [],
      stopping: false,
    })
    expect(reader.outcome()).toEqual({ metric: '', ended: 'running', measuredOn: 'search', baseline: { params: {} } })
  })

  it('shouldCombineTheObjectivesByWeightWhenTheStudyHasSeveral', () => {
    const objectives = [
      { kind: 'Maximize', metric: 'Equals', weight: 1 },
      { kind: 'Maximize', metric: 'Contains', weight: 3 },
    ]
    const estimates = { Equals: { mean: 0.2, ci: [0, 0.4], n: 4 }, Contains: { mean: 0.6, ci: [0.4, 0.8], n: 4 } }

    const progress = reading([header(objectives), { ...candidate({ number: 0 }), estimates }]).progress()

    expect(progress.metric).toBe('Equals + Contains')
    expect(progress.baseline).toBeCloseTo(0.5)
  })

  it('shouldReportTheValidatedBestWhenTheStudyFinishes', () => {
    const outcome = reading([...SEARCH, ...VALIDATION]).outcome()

    expect(outcome).toEqual({
      metric: 'Equals',
      ended: 'finished',
      measuredOn: 'validation',
      baseline: { params: BASELINE, score: 0.4 },
      best: {
        number: 1,
        params: { ...BASELINE, instructions: `${BASELINE_INSTRUCTIONS}\nNever add punctuation.` },
        score: 0.8,
      },
    })
  })

  it('shouldReportTheTestDifferenceWhenTheTestEventsArrive', () => {
    const outcome = reading([...SEARCH, ...TESTED, ...VALIDATION]).outcome()

    expect(outcome).toMatchObject({
      ended: 'finished',
      measuredOn: 'test',
      baseline: { score: 0.5 },
      best: { number: 1, score: 1 },
      test: { difference: 0.5, ci: [0.1, 0.9], cases: 2 },
    })
  })

  it('shouldReportTheErrorWhenTheStudyStops', () => {
    const stopped = { type: 'stopped', error: 'RuntimeError: every trial of the baseline failed: no credentials' }

    const outcome = reading([
      header(),
      { type: 'run', iterations: 4 },
      candidate({ number: 0, mean: 0 }),
      stopped,
    ]).outcome()

    expect(outcome).toEqual({
      metric: 'Equals',
      ended: 'stopped',
      error: 'RuntimeError: every trial of the baseline failed: no credentials',
      measuredOn: 'search',
      baseline: { params: BASELINE, score: 0 },
      best: { number: 0, params: BASELINE, score: 0 },
    })
  })

  it('shouldReportRunningWhenNoEndHasArrived', () => {
    expect(reading(SEARCH).outcome()).toMatchObject({ ended: 'running', measuredOn: 'search', best: { number: 1 } })
  })

  it('shouldReadTheResultFileWhenTheRecordHasOne', async () => {
    const result = {
      format: 'strands-evals.optimization.result',
      runs: [{ index: 1, selected: [2], test: null }],
      test: {
        cases: ['c6', 'c7'],
        baseline: { number: 0, role: 'baseline', means: { Equals: 0.5 }, difference: {} },
        selected: [
          {
            number: 2,
            role: 'selected',
            means: { Equals: 0.75 },
            difference: { Equals: { mean: 0.25, ci90: null, cases: 2 } },
          },
        ],
      },
    }
    const record = await recordFolder([...SEARCH, ...VALIDATION], result)

    const outcome = await readTemporaryStudy(record)

    expect(outcome).toEqual({
      metric: 'Equals',
      ended: 'finished',
      measuredOn: 'test',
      baseline: { params: BASELINE, score: 0.5 },
      best: { number: 2, params: { ...BASELINE, effort: 'high' }, score: 0.75 },
      test: { difference: 0.25, cases: 2 },
    })
  })

  it.each([
    { name: 'NoResult', result: undefined },
    { name: 'AResultCutShort', result: '{"runs": [' },
  ])('shouldReadOnlyTheEventsWhenTheRecordHas$name', async ({ result }) => {
    const record = await recordFolder([...SEARCH, ...VALIDATION], result)

    const outcome = await readTemporaryStudy(record)

    expect(outcome).toMatchObject({ ended: 'finished', measuredOn: 'validation', best: { number: 1, score: 0.8 } })
  })

  it('shouldShipTheBaselineWhenTheStudyRanNoIterations', async () => {
    const record = await recordFolder(
      [
        { ...header(), validation: null, test: null, split: null },
        { type: 'run', iterations: 0, patience: null },
        candidate({ number: 0, mean: 0 }),
        { type: 'selected', on: 'search', best: [0] },
        { type: 'finished', best: [0], reason: 'candidates' },
      ],
      { runs: [{ index: 1, selected: [0], test: null }], test: null, tested: false }
    )

    const outcome = await readTemporaryStudy(record)

    expect(outcome).toEqual({
      metric: 'Equals',
      ended: 'finished',
      measuredOn: 'search',
      baseline: { params: BASELINE, score: 0 },
      best: { number: 0, params: BASELINE, score: 0 },
    })
  })

  it('shouldExplainTheFolderWhenItHasNoStudyFile', async () => {
    const record = await temporaryDirectory()

    await expect(readTemporaryStudy(record)).rejects.toThrow(
      `${record} has no study.jsonl, so it is not an optimization record. Pick another record, or run the optimization again.`
    )
  })
})
