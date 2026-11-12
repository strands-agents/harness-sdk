import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  appendTemporaryCases,
  listTemporaryExperiments,
  readTemporaryExperimentFile,
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

  it('shouldRenameAppendedCasesWhenTheirNamesAreTaken', async () => {
    const target = join(await temporaryDirectory(), 'refunds.json')
    await writeJson(target, experimentDocument(rawCase('c0'), rawCase('c0-2')))
    const source = experimentDocument(rawCase('c0', 'new question'), rawCase('c1'), rawCase('c2'))

    const names = await appendTemporaryCases(target, source, ['c0', 'c1'])

    expect(names).toEqual(['c0-3', 'c1'])
    expect(await readJson(target)).toEqual(
      experimentDocument(
        rawCase('c0'),
        rawCase('c0-2'),
        { ...rawCase('c0', 'new question'), name: 'c0-3' },
        rawCase('c1')
      )
    )
  })

  it('shouldGiveEachAppendedCaseItsOwnNameWhenTheSourceRepeatsAName', async () => {
    const target = join(await temporaryDirectory(), 'refunds.json')
    await writeJson(target, experimentDocument(rawCase('c0')))
    const source = experimentDocument(rawCase('refund', 'first'), rawCase('refund', 'second'))

    const names = await appendTemporaryCases(target, source, ['refund', 'refund'])

    expect(names).toEqual(['refund', 'refund-2'])
    expect((await readJson(target)).cases.map(({ input }: { input: string }) => input)).toEqual([
      'question for c0',
      'first',
      'second',
    ])
  })
})
