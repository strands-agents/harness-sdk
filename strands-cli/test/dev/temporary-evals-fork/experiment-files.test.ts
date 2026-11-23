import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  createTemporaryExperimentCases,
  listTemporaryExperiments,
  readTemporaryExperimentFile,
  temporaryDropIncompleteCases,
  temporaryNamedExperiment,
  temporaryRunnableExperiment,
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

const experimentFile = (folder: string, name: string): string => join(folder, name, `${name}.json`)

const writeFileAt = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

describe('TEMPORARY experiment files', () => {
  it('shouldListExperimentsByNameWithTheirCaseCountsWhenTheFolderHasFiles', async () => {
    const folder = await temporaryDirectory()
    await writeFileAt(
      experimentFile(folder, 'refunds'),
      JSON.stringify(experimentDocument(rawCase('c0'), rawCase('c1')))
    )
    await writeFileAt(experimentFile(folder, 'billing'), JSON.stringify(experimentDocument(rawCase('c0'))))
    await writeFileAt(experimentFile(folder, 'billing-v2'), JSON.stringify(experimentDocument()))
    await writeFileAt(experimentFile(folder, 'broken'), '{"cases": [')
    await writeFile(join(folder, 'notes.txt'), 'not an experiment')
    await writeJson(join(folder, 'loose.json'), experimentDocument(rawCase('c0')))
    await writeFileAt(join(folder, 'drafts', 'refunds.json'), JSON.stringify(experimentDocument(rawCase('c0'))))

    const experiments = await listTemporaryExperiments(folder)

    expect(experiments).toEqual([
      { name: 'billing', path: experimentFile(folder, 'billing'), caseCount: 1 },
      { name: 'billing-v2', path: experimentFile(folder, 'billing-v2'), caseCount: 0 },
      { name: 'broken', path: experimentFile(folder, 'broken'), caseCount: 0 },
      { name: 'refunds', path: experimentFile(folder, 'refunds'), caseCount: 2 },
    ])
  })

  it('shouldListNothingWhenTheFolderIsMissing', async () => {
    const folder = join(await temporaryDirectory(), 'experiments')

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
      new RegExp(
        `^${literal(path)} is not a usable Experiment file \\(.*${detail}.*\\)\\. Fix the file or delete it`,
        'u'
      )
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

  it('shouldDropTheCasesWithABlankInputOrExpectedAnswerWhenADraftIsChecked', async () => {
    const path = join(await temporaryDirectory(), 'draft.json')
    await writeJson(
      path,
      experimentDocument(
        rawCase('c0'),
        rawCase('c1', ' '),
        rawCase('c2', null),
        rawCase('c3', 'question', '\n'),
        rawCase('c4', 'question', null),
        rawCase('c5', { order: 7 }, { refund: true })
      )
    )

    const checked = await temporaryDropIncompleteCases(path)

    expect(checked).toEqual({ complete: 2, dropped: 4 })
    expect(await readJson(path)).toEqual(
      experimentDocument(rawCase('c0'), rawCase('c5', { order: 7 }, { refund: true }))
    )
  })

  it('shouldLeaveTheFileAsItIsWhenEveryCaseHasAnInputAndAnExpectedAnswer', async () => {
    const path = join(await temporaryDirectory(), 'draft.json')
    const text = JSON.stringify(experimentDocument(rawCase('c0'), rawCase('c1')))
    await writeFile(path, text)

    const checked = await temporaryDropIncompleteCases(path)

    expect(checked).toEqual({ complete: 2, dropped: 0 })
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it.each<[string, unknown[], string[]]>([
    ['repeat in any case', ['refund', 'refund', 'Refund'], ['refund', 'refund-2', 'Refund-3']],
    ['are missing', [null, undefined, '', 'case_1'], ['case_0', 'case_1', 'case_2', 'case_1-2']],
    [
      'contain characters that a file name cannot hold',
      ['a/b', 'a\\b', 'Step 1: why?'],
      ['a-b', 'a-b-2', 'Step 1- why-'],
    ],
  ])('shouldGiveEveryCaseAUniqueFileNameWhenNames%s', (_case, names, expected) => {
    const document = experimentDocument(...names.map((name, index) => ({ ...rawCase(`c${index}`), name })))

    const named = temporaryNamedExperiment(document)

    expect(named.cases.map(({ name }) => name)).toEqual(expected)
    expect(named.cases.map(({ input }) => input)).toEqual(document.cases.map(({ input }) => input))
    expect(named.evaluators).toEqual(document.evaluators)
  })

  it('shouldRunTheExperimentItselfWhenItsCaseNamesAreUnique', async () => {
    const folder = await temporaryDirectory()
    const path = join(folder, 'refunds.json')
    await writeJson(path, experimentDocument(rawCase('c0'), rawCase('c1')))

    const runnable = await temporaryRunnableExperiment(path, join(folder, 'copy.json'))

    expect(runnable).toBe(path)
    expect(await readdir(folder)).toEqual(['refunds.json'])
  })

  it('shouldRunACopyWithUniqueNamesWhenCaseNamesRepeat', async () => {
    const folder = await temporaryDirectory()
    const path = join(folder, 'refunds.json')
    const document = experimentDocument(rawCase('refund'), rawCase('refund', 'second question'))
    await writeJson(path, document)
    const copy = join(folder, 'copy.json')

    const runnable = await temporaryRunnableExperiment(path, copy)

    expect(runnable).toBe(copy)
    expect((await readJson(copy)).cases.map(({ name, input }: TemporaryRawCase) => [name, input])).toEqual([
      ['refund', 'question for refund'],
      ['refund-2', 'second question'],
    ])
    expect(await readJson(path)).toEqual(document)
  })
})

describe('TEMPORARY expected assertions', () => {
  const assertionCase = (name: string, assertion: unknown, expected: unknown = null) => ({
    ...rawCase(name, `question for ${name}`, expected),
    expected_assertion: assertion,
  })

  it('shouldReadTheAssertionAsTheExpectedAnswerWhenACaseHasNoExpectedOutput', async () => {
    const path = join(await temporaryDirectory(), 'from-chats.json')
    await writeJson(
      path,
      experimentDocument(
        assertionCase('c0', 'The agent refunds order 7.'),
        assertionCase('c1', 'The agent refunds order 8.', 'Refunded.'),
        assertionCase('c2', '  ', null)
      )
    )

    const { experiment } = await readTemporaryExperimentFile(path)

    expect(experiment.cases).toEqual([
      { name: 'c0', input: 'question for c0', expected: 'The agent refunds order 7.' },
      { name: 'c1', input: 'question for c1', expected: 'Refunded.' },
      { name: 'c2', input: 'question for c2' },
    ])
  })

  it('shouldKeepACaseWithOnlyAnAssertionWhenADraftIsChecked', async () => {
    const path = join(await temporaryDirectory(), 'from-chats.json')
    const document = experimentDocument(assertionCase('c0', 'The agent refunds order 7.'), assertionCase('c1', ''))
    await writeJson(path, document)

    const checked = await temporaryDropIncompleteCases(path)

    expect(checked).toEqual({ complete: 1, dropped: 1 })
    expect(await readJson(path)).toEqual(experimentDocument(assertionCase('c0', 'The agent refunds order 7.')))
  })
})
