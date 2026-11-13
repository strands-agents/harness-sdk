import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  locateTemporaryEdit,
  type TemporaryEditLocation,
  type TemporaryEditTarget,
} from '../../../src/dev/temporary-evals-fork/apply.js'
import type { KnobKey } from '../../../src/dev/panels/model.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const INSTRUCTIONS = 'You are a refund desk.\nBe kind.'
const NEW_INSTRUCTIONS = 'You are a refund desk.\nBe kind.\nOffer a refund before a store credit.'

const project = async (files: Record<string, string>): Promise<string> => {
  const root = await temporaryDirectory()
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), content)
    })
  )
  return root
}

const locate = (root: string, entrypoint: string, before: string, knob: KnobKey = 'instructions') =>
  locateTemporaryEdit({ root, entrypoint: join(root, entrypoint), knob, before })

const target = (location: TemporaryEditLocation): TemporaryEditTarget => {
  if ('unavailable' in location) throw new Error(`expected a target, got: ${location.unavailable}`)
  return location
}

const read = (root: string, path: string): Promise<string> => readFile(join(root, path), 'utf8')

const PYTHON_AGENT = (instructions: string) =>
  [
    'from pathlib import Path',
    '',
    'from strands_harness import create_harness',
    '',
    `agent = create_harness(model="bedrock/model", instructions=${instructions}, skills=False)`,
    '',
  ].join('\n')

describe('TEMPORARY apply an optimized setting', () => {
  it.each([
    { ending: '\n', name: 'ANewline' },
    { ending: '\r\n', name: 'AWindowsNewline' },
    { ending: '\n\n', name: 'TwoNewlines' },
    { ending: '', name: 'NoNewline' },
  ])('shouldRewriteTheTextFileAndKeepItsEndingWhenTheFileEndsWith$name', async ({ ending }) => {
    const root = await project({
      'agent.py': PYTHON_AGENT('Path("prompts/refunds.md").read_text()'),
      'prompts/refunds.md': `${INSTRUCTIONS}${ending}`,
    })

    const location = target(await locate(root, 'agent.py', INSTRUCTIONS))
    await location.write(`${NEW_INSTRUCTIONS}\n`)

    expect(location.target).toBe(join('prompts', 'refunds.md'))
    expect(await read(root, 'prompts/refunds.md')).toBe(`${NEW_INSTRUCTIONS}${ending}`)
  })

  it('shouldSkipCopiesInToolFoldersWhenItSearchesTextFiles', async () => {
    const copies = ['node_modules/x/README.md', '.venv/notes.txt', '.git/x.md', 'dist/x.md', 'strands-dev/a.md']
    const root = await project({
      ...Object.fromEntries([...copies, 'strands-dev-2/tmp/b.txt'].map((path) => [path, INSTRUCTIONS])),
      'agent.py': PYTHON_AGENT(`"""${INSTRUCTIONS}"""`),
    })

    const location = target(await locate(root, 'agent.py', INSTRUCTIONS))

    expect(location.target).toBe('agent.py')
  })

  it('shouldNameTheFilesWhenSeveralTextFilesHoldTheOldInstructions', async () => {
    const root = await project({
      'agent.py': PYTHON_AGENT('load()'),
      'prompts/a.md': INSTRUCTIONS,
      'docs/b.txt': `\n${INSTRUCTIONS}\n`,
    })

    const location = await locate(root, 'agent.py', INSTRUCTIONS)

    expect(location).toEqual({
      unavailable: `The old instructions are in 2 files (${join('docs', 'b.txt')}, ${join('prompts', 'a.md')}). Paste the new instructions into the one the agent reads yourself.`,
    })
  })

  it('shouldAskTheUserWhenOneTextFileAndTheEntrypointBothHoldTheText', async () => {
    const root = await project({
      'agent.py': PYTHON_AGENT(`"""${INSTRUCTIONS}"""`),
      'docs/prompt-notes.md': INSTRUCTIONS,
    })

    const location = await locate(root, 'agent.py', INSTRUCTIONS)

    expect(location).toEqual({
      unavailable: `The old instructions are in ${join('docs', 'prompt-notes.md')} and in agent.py. Paste the new instructions into the one the agent reads yourself.`,
    })
  })

  it('shouldSkipFoldersItCannotReadWhenItSearchesTextFiles', async () => {
    const root = await project({ 'agent.py': PYTHON_AGENT('"Answer in one word."') })
    const locked = join(root, 'pgdata')
    await mkdir(locked, { mode: 0o700 })
    await chmod(locked, 0o000)

    const location = await locate(root, 'agent.py', 'Answer in one word.')
    await chmod(locked, 0o700)

    expect(target(location).target).toBe('agent.py')
  })

  it.each([
    { name: 'TextThatFits', after: 'Answer in two words.', expected: { target: 'agent.py' } },
    {
      name: 'TextThatCannotFit',
      after: "Answer with the capital's name\nonly.",
      expected: {
        unavailable:
          'Paste the new instructions into agent.py yourself; the string there cannot hold line breaks, quotes, or backslashes, and the new text has some.',
      },
    },
  ])('shouldCheckTheNewTextAtOnceWhenTheCallerGives$name', async ({ after, expected }) => {
    const root = await project({ 'agent.py': PYTHON_AGENT('"Answer in one word."') })

    const location = await locateTemporaryEdit({
      root,
      entrypoint: join(root, 'agent.py'),
      knob: 'instructions',
      before: 'Answer in one word.',
      after,
    })

    expect(location).toMatchObject(expected)
    expect(await read(root, 'agent.py')).toBe(PYTHON_AGENT('"Answer in one word."'))
  })

  it('shouldUseTheEntrypointStringWhenSeveralTextFilesAlsoHoldTheText', async () => {
    const root = await project({
      'agent.py': PYTHON_AGENT(`"""${INSTRUCTIONS}"""`),
      'README.md': INSTRUCTIONS,
      'docs/prompt.txt': INSTRUCTIONS,
    })

    const location = target(await locate(root, 'agent.py', INSTRUCTIONS))

    expect(location.target).toBe('agent.py')
  })

  it.each([
    {
      name: 'PythonTripleQuotes',
      file: 'agent.py',
      literal: (text: string) => `"""${text}"""`,
      before: INSTRUCTIONS,
      after: NEW_INSTRUCTIONS,
    },
    {
      name: 'PythonSingleTripleQuotes',
      file: 'agent.py',
      literal: (text: string) => `r'''${text}'''`,
      before: INSTRUCTIONS,
      after: `${NEW_INSTRUCTIONS} Say "sorry" first.`,
    },
    {
      name: 'PythonPlainQuotes',
      file: 'agent.py',
      literal: (text: string) => `"${text}"`,
      before: 'Answer in one word.',
      after: "Answer in two words, and don't explain.",
    },
    {
      name: 'TypeScriptTemplateLiterals',
      file: 'agent.ts',
      literal: (text: string) => `\`${text}\``,
      before: INSTRUCTIONS,
      after: `${NEW_INSTRUCTIONS}\nPrices are in $ and "quotes" are fine.`,
    },
    {
      name: 'TypeScriptSingleQuotes',
      file: 'agent.ts',
      literal: (text: string) => `'${text}'`,
      before: 'Answer in one word.',
      after: 'Answer in two words, said "kindly".',
    },
  ])('shouldReplaceTheStringWhenTheEntrypointUses$name', async ({ file, literal, before, after }) => {
    const source = (text: string) =>
      file === 'agent.py'
        ? PYTHON_AGENT(literal(text))
        : [
            "import { createHarness } from '@strands-agents/harness'",
            '',
            `export const agent = createHarness({ instructions: ${literal(text)}, builtinTools: [] })`,
            '',
          ].join('\n')
    const root = await project({ [file]: source(before) })

    const location = target(await locate(root, file, before))
    await location.write(after)

    expect(location.target).toBe(file)
    expect(await read(root, file)).toBe(source(after))
  })

  it.each([
    {
      name: 'ALineBreakInAOneLineString',
      file: 'agent.py',
      source: 'agent = create_harness(instructions="Answer in one word.")\n',
      before: 'Answer in one word.',
      after: 'Answer in one word.\nBe kind.',
      message: 'line breaks, quotes, or backslashes',
    },
    {
      name: 'TheQuoteOfAOneLineString',
      file: 'agent.ts',
      source: "export const agent = createHarness({ instructions: 'Answer in one word.' })\n",
      before: 'Answer in one word.',
      after: "Don't explain.",
      message: 'line breaks, quotes, or backslashes',
    },
    {
      name: 'ClosingQuotesOfATripleQuotedString',
      file: 'agent.py',
      source: 'agent = create_harness(instructions="""Say hi.""")\n',
      before: 'Say hi.',
      after: 'Say "hi"',
      message: 'backslashes or closing quotes',
    },
    {
      name: 'ABacktickInATemplate',
      file: 'agent.ts',
      source: 'export const agent = createHarness({ instructions: `Say hi.` })\n',
      before: 'Say hi.',
      after: 'Say `hi`.',
      message: 'backslashes, backticks, or ${',
    },
    {
      name: 'ANewFieldInATemplate',
      file: 'agent.ts',
      source: 'export const agent = createHarness({ instructions: `Pay {total} now.` })\n',
      before: 'Pay ',
      after: 'Pay $',
      message: 'backslashes, backticks, or ${',
    },
    {
      name: 'BracesInAnFString',
      file: 'agent.py',
      source: 'agent = create_harness(instructions=f"Answer in one word.")\n',
      before: 'Answer in one word.',
      after: 'Answer with {one} word.',
      message: 'braces or line breaks, quotes, or backslashes',
    },
  ])('shouldWriteNothingWhenTheNewTextHas$name', async ({ file, source, before, after, message }) => {
    const root = await project({ [file]: source })

    const location = target(await locate(root, file, before))

    await expect(location.write(after)).rejects.toThrow(
      `Paste the new instructions into ${file} yourself; the string there cannot hold ${message}, and the new text has some.`
    )
    expect(await read(root, file)).toBe(source)
  })

  it.each([
    {
      name: 'TwoCopiesOfTheText',
      source: 'A = "Answer in one word."\nagent = create_harness(instructions="Answer in one word.")\n',
      reason: 'the old text is there 2 times.',
    },
    {
      name: 'TheTextOnlyInAComment',
      source: '# Answer in one word.\nagent = create_harness(instructions=load())\n',
      reason: 'the old text is not a plain string there.',
    },
    {
      name: 'TheTextNowhere',
      source: 'agent = create_harness(instructions=load())\n',
      reason: 'the old text is not a plain string there.',
    },
    {
      name: 'AnFStringWithFields',
      source: 'agent = create_harness(instructions=f"Answer in one word. {SUFFIX}")\n',
      reason: 'the old text is not a plain string there.',
    },
    {
      name: 'EscapesInTheString',
      source: 'agent = create_harness(instructions="Answer in one word.\\tThen stop.")\n',
      reason: 'the old text is not a plain string there.',
    },
    {
      name: 'ABytesString',
      source: 'agent = create_harness(instructions=b"Answer in one word.")\n',
      reason: 'the old text is not a plain string there.',
    },
  ])('shouldExplainWhyWhenTheEntrypointHas$name', async ({ source, reason }) => {
    const root = await project({ 'refund_desk/agent.py': source })

    const location = await locate(root, 'refund_desk/agent.py', 'Answer in one word.')

    expect(location).toEqual({
      unavailable: `Paste the new instructions into ${join('refund_desk', 'agent.py')} yourself; ${reason}`,
    })
  })

  it('shouldFindTheStringWhenRegexCommentsAndTemplatesComeFirst', async () => {
    const source = [
      "const strip = /'/g",
      "// don't touch this comment",
      "/* or 'this' one */",
      "const greeting = `Hi ${user ?? 'friend'}, {not a field} ${`nested ${depth}`}`",
      'const ratio = total / 2 / 3',
      "export const agent = createHarness({ instructions: 'Answer in one word.' })",
      '',
    ].join('\n')
    const root = await project({ 'agent.ts': source })

    const location = target(await locate(root, 'agent.ts', 'Answer in one word.'))
    await location.write('Answer briefly.')

    expect(await read(root, 'agent.ts')).toBe(source.replace('Answer in one word.', 'Answer briefly.'))
  })

  it('shouldFindTheStringWhenPythonCommentsHoldQuotes', async () => {
    const source = "# don't use 'this'\nNAME = 'desk'  # it's fine\nagent = create_harness(instructions='Answer.')\n"
    const root = await project({ 'agent.py': source })

    const location = target(await locate(root, 'agent.py', 'Answer.'))
    await location.write('Answer briefly.')

    expect(await read(root, 'agent.py')).toBe(source.replace("'Answer.'", "'Answer briefly.'"))
  })

  it('shouldRefuseToWriteWhenTheFileChangedAfterItWasLocated', async () => {
    const root = await project({ 'agent.py': PYTHON_AGENT('"Answer in one word."') })
    const location = target(await locate(root, 'agent.py', 'Answer in one word.'))
    await writeFile(join(root, 'agent.py'), PYTHON_AGENT('load()'))

    await expect(location.write('Answer briefly.')).rejects.toThrow('the old text is not a plain string there.')
    expect(await read(root, 'agent.py')).toBe(PYTHON_AGENT('load()'))
  })

  it('shouldAskForTheTextWhenTheAgentHasNoInstructions', async () => {
    const root = await project({ 'agent.py': PYTHON_AGENT('None'), 'empty.md': '' })

    const location = await locate(root, 'agent.py', '  ')

    expect(location).toEqual({
      unavailable: 'Add the new instructions to agent.py yourself; the agent has no instructions to replace.',
    })
  })

  it.each([
    { form: 'PythonDoubleQuotes', setting: (level: string) => `effort="${level}"` },
    { form: 'PythonSingleQuotes', setting: (level: string) => `effort='${level}'` },
    { form: 'TypeScriptSingleQuotes', setting: (level: string) => `effort: '${level}'` },
    { form: 'SpacedDoubleQuotes', setting: (level: string) => `effort : "${level}"` },
  ])('shouldReplaceOnlyTheEffortWhenTheEntrypointUses$form', async ({ setting }) => {
    const source = (level: string) =>
      `agent = create_harness(model="bedrock/model", reasoning_effort="auto", ${setting(level)})\n`
    const root = await project({ 'agent.py': source('auto') })

    const location = target(await locate(root, 'agent.py', 'auto', 'effort'))
    await location.write('high')

    expect(location.target).toBe('agent.py')
    expect(await read(root, 'agent.py')).toBe(source('high'))
  })

  it.each([
    { name: 'NoEffort', source: 'agent = create_harness(model="bedrock/model")\n' },
    { name: 'TwoEfforts', source: 'A = dict(effort="auto")\nagent = create_harness(effort="auto")\n' },
    { name: 'AnEffortVariable', source: 'agent = create_harness(effort=EFFORT)\n' },
    {
      name: 'OnlyACommentedEffort',
      source: '# effort="auto" is the default\nagent = create_harness(effort=os.environ.get("EFFORT", "auto"))\n',
    },
    {
      name: 'AnEffortInsideAnotherString',
      source: 'agent = create_harness(instructions="Use effort=\'auto\' for small talk.", effort=EFFORT)\n',
    },
  ])('shouldExplainWhyWhenTheEntrypointHas$name', async ({ source }) => {
    const root = await project({ 'agent.py': source })

    const location = await locate(root, 'agent.py', 'auto', 'effort')

    expect(location).toEqual({
      unavailable: 'Set the new effort in agent.py yourself; it does not set effort to "auto" in exactly one place.',
    })
  })

  it.each([
    {
      name: 'Python',
      file: 'agent.py',
      source: (level: string) => `# effort="auto" was slow\nagent = create_harness(effort="${level}")\n`,
    },
    {
      name: 'TypeScript',
      file: 'agent.ts',
      source: (level: string) =>
        `// effort: 'auto' was slow\nexport const agent = createHarness({ effort: '${level}' })\n`,
    },
  ])('shouldReplaceTheCodeEffortWhenA$nameCommentAlsoMentionsIt', async ({ file, source }) => {
    const root = await project({ [file]: source('auto') })

    const location = target(await locate(root, file, 'auto', 'effort'))
    await location.write('high')

    expect(await read(root, file)).toBe(source('high'))
  })

  it('shouldWriteNothingWhenTheNewEffortIsNotAPlainLevel', async () => {
    const source = 'agent = create_harness(effort="auto")\n'
    const root = await project({ 'agent.py': source })
    const location = target(await locate(root, 'agent.py', 'auto', 'effort'))

    await expect(location.write('high"); import os; ("')).rejects.toThrow('is not a plain effort level.')
    expect(await read(root, 'agent.py')).toBe(source)
  })

  it('shouldSendOtherKnobsToTheUserWhenTheyChange', async () => {
    const root = await project({ 'agent.py': PYTHON_AGENT('"Answer."') })

    const location = await locate(root, 'agent.py', '["search"]', 'tools')

    expect(location).toEqual({
      unavailable: 'Change the tools in agent.py yourself; strands dev applies only instructions and effort.',
    })
  })
})
