import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  createTemporaryExperimentCases,
  listTemporaryExperiments,
  readTemporaryExperimentFile,
  temporaryBlankCase,
  writeTemporaryExperimentCases,
  writeTemporaryExperimentFile,
  type TemporaryRawCase,
} from '../../../src/dev/temporary-evals-fork/experiment-files.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const rawCase = (name: string, input: unknown = `question for ${name}`, expected: unknown = `answer for ${name}`) => ({
  name,
  session_id: `session-${name}`,
  input,
  expected_output: expected,
  expected_assertion: null,
  expected_trajectory: null,
  expected_interactions: null,
  expected_environment_state: null,
  metadata: { source: 'generator' },
})

const experimentDocument = (...cases: TemporaryRawCase[]) => ({
  cases,
  evaluators: [{ evaluator_type: 'OutputEvaluator', rubric: 'Correct and kind.' }],
})

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, JSON.stringify(value, null, 2))
}

const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'))

describe('TEMPORARY experiment files', () => {
  it('shouldListExperimentsByNameWithTheirCaseCountsWhenTheFolderHasFiles', async () => {
    const folder = await temporaryDirectory()
    await writeJson(join(folder, 'refunds.json'), experimentDocument(rawCase('c0'), rawCase('c1')))
    await writeJson(join(folder, 'billing.json'), experimentDocument(rawCase('c0')))
    await writeJson(join(folder, 'billing-v2.json'), experimentDocument())
    await writeFile(join(folder, 'broken.json'), '{"cases": [')
    await writeFile(join(folder, 'notes.txt'), 'not an experiment')
    await mkdir(join(folder, 'drafts'))

    const experiments = await listTemporaryExperiments(folder)

    expect(experiments).toEqual([
      { name: 'billing', path: join(folder, 'billing.json'), caseCount: 1 },
      { name: 'billing-v2', path: join(folder, 'billing-v2.json'), caseCount: 0 },
      { name: 'broken', path: join(folder, 'broken.json'), caseCount: 0 },
      { name: 'refunds', path: join(folder, 'refunds.json'), caseCount: 2 },
    ])
  })

  it('shouldListNothingWhenTheFolderIsMissing', async () => {
    const folder = join(await temporaryDirectory(), 'tmp', 'experiments')

    await expect(listTemporaryExperiments(folder)).resolves.toEqual([])
  })

  it('shouldReadCasesAndEvaluatorsWhenTheFileIsAnExperiment', async () => {
    const path = join(await temporaryDirectory(), 'refunds.json')
    const document = {
      ...experimentDocument(rawCase('c0'), rawCase('c1', { order: 7, items: ['shoe'] }, null), {
        input: 'unnamed',
      }),
      evaluators: [{ evaluator_type: 'Equals' }, { evaluator_type: 'OutputEvaluator', name: 'judge' }],
    }
    await writeJson(path, document)

    const { experiment, raw } = await readTemporaryExperimentFile(path)

    expect(experiment).toEqual({
      name: 'refunds',
      path,
      cases: [
        { name: 'c0', input: 'question for c0', expected: 'answer for c0' },
        { name: 'c1', input: '{"order":7,"items":["shoe"]}' },
        { name: 'case_2', input: 'unnamed' },
      ],
      evaluators: ['Equals', 'judge'],
    })
    expect(raw).toEqual(document)
  })

  it.each([
    { content: '{"cases": [', detail: 'JSON' },
    { content: '[]', detail: 'it has no list of cases' },
    { content: '{"cases": 3}', detail: 'it has no list of cases' },
    { content: '{"cases": ["c0"]}', detail: 'it has no list of cases' },
  ])('shouldNameTheFileAndTheFixWhenTheFileHolds$content', async ({ content, detail }) => {
    const path = join(await temporaryDirectory(), 'refunds.json')
    await writeFile(path, content)

    await expect(readTemporaryExperimentFile(path)).rejects.toThrow(
      new RegExp(`^${path} is not a usable Experiment file \\(.*${detail}.*\\)\\. Fix the file or delete it`, 'u')
    )
  })

  it('shouldWriteOnlyTheKeptCasesInTheGivenOrderWhenADraftIsSaved', async () => {
    const folder = await temporaryDirectory()
    const path = join(folder, 'refunds.json')
    const document = { ...experimentDocument(rawCase('c0'), rawCase('c1'), rawCase('c2')), version: 'kept field' }

    await writeTemporaryExperimentFile(path, document, ['c2', 'c0'])

    expect(await readJson(path)).toEqual({ ...document, cases: [rawCase('c2'), rawCase('c0')] })
    expect(await readdir(folder)).toEqual(['refunds.json'])
  })

  it('shouldKeepBothCasesWhenTwoKeptCasesShareAName', async () => {
    const path = join(await temporaryDirectory(), 'refunds.json')
    const first = rawCase('refund')
    const second = { ...rawCase('refund', 'second question'), session_id: 'session-second' }

    await writeTemporaryExperimentFile(path, experimentDocument(first, second), ['refund', 'refund'])

    expect((await readJson(path)).cases).toEqual([first, second])
  })

  it('shouldWriteNothingWhenAKeptCaseIsNotInTheDocument', async () => {
    const folder = await temporaryDirectory()
    const path = join(folder, 'refunds.json')
    await writeJson(path, experimentDocument(rawCase('c0')))

    await expect(writeTemporaryExperimentFile(path, experimentDocument(rawCase('c0')), ['c9'])).rejects.toThrow(
      'The experiment has no case named c9, so nothing was written.'
    )
    expect(await readJson(path)).toEqual(experimentDocument(rawCase('c0')))
    expect(await readdir(folder)).toEqual(['refunds.json'])
  })

  it('shouldWriteTheGivenCasesAndKeepTheOtherFieldsWhenCasesAreWritten', async () => {
    const path = join(await temporaryDirectory(), 'refunds.json')
    const raw = experimentDocument(rawCase('c0'), rawCase('c1'))

    await writeTemporaryExperimentCases(path, raw, [{ ...rawCase('c1'), expected_output: 'edited' }])

    expect(await readJson(path)).toEqual(experimentDocument({ ...rawCase('c1'), expected_output: 'edited' }))
  })

  it('shouldRefuseToReplaceAFileWhenANewExperimentIsCreated', async () => {
    const path = join(await temporaryDirectory(), 'refunds.json')
    await writeJson(path, experimentDocument(rawCase('c0')))

    await expect(createTemporaryExperimentCases(path, experimentDocument(), [rawCase('c1')])).rejects.toThrow(
      'exists already, so nothing was saved'
    )

    expect(await readJson(path)).toEqual(experimentDocument(rawCase('c0')))
    expect(await readdir(join(path, '..'))).toEqual(['refunds.json'])
  })

  it.each([
    ['an expected outcome', 'Refund it', 'Refund it'],
    ['no expected outcome', '', null],
  ])('shouldMakeACompleteCaseWhenABlankCaseHas%s', (_case, expected, stored) => {
    const blank = temporaryBlankCase('case-3', 'Refund order 7', expected)

    expect(blank).toMatchObject({ name: 'case-3', input: 'Refund order 7', expected_output: stored, metadata: null })
    expect(blank.session_id).toMatch(/^[0-9a-f-]{36}$/u)
  })
})
