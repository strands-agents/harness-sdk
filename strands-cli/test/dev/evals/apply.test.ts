import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { locateEvalsEdit, type EvalsEditLocation, type EvalsEditTarget } from '../../../src/dev/evals/apply.js'
import { editFile } from '../../../src/dev/file-edits.js'
import { pythonExecutable } from '../../fixtures/python-runtime.js'
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

const locate = (root: string, entrypoint: string, before: string, after?: string) =>
  locateEvalsEdit({ root, entrypoint: join(root, entrypoint), before, ...(after ? { after } : {}) })

const target = (location: EvalsEditLocation): EvalsEditTarget => {
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

describe('apply an optimized setting', () => {
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
      written: 'agent = create_harness(instructions="""Answer in one word.\nBe kind.""")\n',
    },
    {
      name: 'ALineBreakInATypeScriptString',
      file: 'agent.ts',
      source: "export const agent = createHarness({ instructions: 'Answer in one word.' })\n",
      before: 'Answer in one word.',
      after: 'Answer in one word.\nSay `hi` and ${name}.',
      written:
        'export const agent = createHarness({ instructions: `Answer in one word.\nSay \\`hi\\` and \\${name}.` })\n',
    },
    {
      name: 'TheQuoteOfAOneLineString',
      file: 'agent.ts',
      source: "export const agent = createHarness({ instructions: 'Answer in one word.' })\n",
      before: 'Answer in one word.',
      after: "Don't explain.",
      written: "export const agent = createHarness({ instructions: 'Don\\'t explain.' })\n",
    },
    {
      name: 'ClosingQuotesOfATripleQuotedString',
      file: 'agent.py',
      source: 'agent = create_harness(instructions="""Say hi.""")\n',
      before: 'Say hi.',
      after: 'Say "hi"',
      written: 'agent = create_harness(instructions="""Say \\"hi\\"""")\n',
    },
    {
      name: 'ABacktickInATemplate',
      file: 'agent.ts',
      source: 'export const agent = createHarness({ instructions: `Say hi.` })\n',
      before: 'Say hi.',
      after: 'Say `hi`.',
      written: 'export const agent = createHarness({ instructions: `Say \\`hi\\`.` })\n',
    },
    {
      name: 'ANewFieldInATemplate',
      file: 'agent.ts',
      source: 'export const agent = createHarness({ instructions: `Pay {total} now.` })\n',
      before: 'Pay ',
      after: 'Pay $',
      written: 'export const agent = createHarness({ instructions: `Pay \\${total} now.` })\n',
    },
    {
      name: 'BracesInAnFString',
      file: 'agent.py',
      source: 'agent = create_harness(instructions=f"Answer in one word.")\n',
      before: 'Answer in one word.',
      after: 'Answer with {one} word.',
      written: 'agent = create_harness(instructions=f"Answer with {{one}} word.")\n',
    },
    {
      name: 'ABackslashInARawString',
      file: 'agent.py',
      source: "agent = create_harness(instructions=r'Use C:\\tmp.')\n",
      before: 'Use C:\\tmp.',
      after: "Use C:\\tmp, it's fine.",
      written: "agent = create_harness(instructions='Use C:\\\\tmp, it\\'s fine.')\n",
    },
  ])('shouldEscapeTheNewTextWhenItHas$name', async ({ file, source, before, after, written }) => {
    const root = await project({ [file]: source })

    await target(await locate(root, file, before)).write(after)

    expect(await read(root, file)).toBe(written)
  })

  it.each([
    {
      name: 'EscapesInThePythonString',
      file: 'agent.py',
      source: 'agent = create_harness(instructions="Answer in one word.\\tThen stop.")\n',
      written: 'agent = create_harness(instructions="Answer in two words.\\tThen stop.")\n',
    },
    {
      name: 'EscapesInTheTypeScriptString',
      file: 'agent.ts',
      source: "export const agent = createHarness({ instructions: 'Answer in one word.\\nThen stop.' })\n",
      written: 'export const agent = createHarness({ instructions: `Answer in two words.\nThen stop.` })\n',
    },
    {
      name: 'TypeScriptStringsJoinedByPlus',
      file: 'agent.ts',
      source: "export const agent = createHarness({\n  instructions: 'Answer in ' +\n    'one word.',\n})\n",
      written: "export const agent = createHarness({\n  instructions: 'Answer in two words.',\n})\n",
    },
    {
      name: 'PythonStringsSideBySideInParentheses',
      file: 'agent.py',
      source: 'agent = create_harness(\n    instructions=(\n        "Answer in "\n        "one word."\n    )\n)\n',
      written: 'agent = create_harness(\n    instructions=(\n        "Answer in two words."\n    )\n)\n',
    },
  ])('shouldReplaceTheOldTextWhenTheEntrypointHas$name', async ({ file, source, written }) => {
    const root = await project({ [file]: source })

    await target(await locate(root, file, 'Answer in one word.')).write('Answer in two words.')

    expect(await read(root, file)).toBe(written)
  })

  it('shouldFindTheTextAgainWhenAnEarlierApplyWroteItWithEscapes', async () => {
    const root = await project({
      'agent.ts': "export const agent = createHarness({ instructions: 'Answer in one word.' })\n",
    })
    await target(await locate(root, 'agent.ts', 'Answer in one word.')).write("Don't explain.\nBe `brief`.")

    await target(await locate(root, 'agent.ts', "Don't explain.\nBe `brief`.")).write('Answer in two words.')

    expect(await read(root, 'agent.ts')).toBe(
      'export const agent = createHarness({ instructions: `Answer in two words.` })\n'
    )
  })

  it.each([
    ['ALineThatEndsTheStatement', 'A = "Answer in "\n"one word."\nagent = create_harness(instructions=A)\n'],
    ['AVariableBetweenTheStrings', 'agent = create_harness(instructions="Answer in " + NAME + "one word.")\n'],
  ])('shouldNotJoinStringsThatAreNotOneValueWhenTheSourceHas%s', async (_case, source) => {
    const root = await project({ 'agent.py': source })

    const location = await locate(root, 'agent.py', 'Answer in one word.')

    expect(location).toEqual({
      unavailable: 'Paste the new instructions into agent.py yourself; the old text is not a plain string there.',
    })
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

    await expect(location.write('Answer briefly.')).rejects.toThrow(
      'agent.py changed after this edit was proposed, and the text it replaces is no longer there.'
    )
    expect(await read(root, 'agent.py')).toBe(PYTHON_AGENT('load()'))
  })

  const NEW_TYPESCRIPT_AGENT = [
    "import { createHarness } from '@strands-agents/harness'",
    '',
    'export const agent = await createHarness({',
    "  name: 'fresh',",
    "  effort: 'medium',",
    '  skills: false,',
    '})',
    '',
  ].join('\n')

  it('shouldAddTheInstructionsWhenTheAgentSetsNone', async () => {
    const root = await project({ 'agent.ts': NEW_TYPESCRIPT_AGENT, 'empty.md': '' })

    const location = target(await locate(root, 'agent.ts', '  ', 'Answer briefly.'))
    await location.write("Answer briefly, and don't explain.")

    expect(location.target).toBe('agent.ts')
    expect(await read(root, 'agent.ts')).toBe(
      NEW_TYPESCRIPT_AGENT.replace(
        '  skills: false,\n',
        "  skills: false,\n  instructions: 'Answer briefly, and don\\'t explain.',\n"
      )
    )
  })

  it('shouldAddInstructionsOfSeveralLinesAsATemplateLiteral', async () => {
    const root = await project({ 'agent.ts': NEW_TYPESCRIPT_AGENT })

    await target(await locate(root, 'agent.ts', '')).write(`${NEW_INSTRUCTIONS}\nPrices are in \${USD}.`)

    expect(await read(root, 'agent.ts')).toContain(
      `  instructions: \`${NEW_INSTRUCTIONS}\nPrices are in \\\${USD}.\`,\n`
    )
  })

  it('shouldAskForTheTextWhenTheAgentWithoutInstructionsPassesOptionsItCannotExtend', async () => {
    const root = await project({
      'agent.ts': "import { options } from './options.js'\nexport const agent = await createHarness(options)\n",
    })

    const location = await locate(root, 'agent.ts', '')

    expect(location).toEqual({
      unavailable:
        'Add the new instructions to agent.ts yourself. agent.ts passes createHarness options that are not an object literal.',
    })
  })

  it('shouldRefuseToAddInstructionsWhenTheAgentGainedSomeAfterTheRun', async () => {
    const root = await project({ 'agent.ts': NEW_TYPESCRIPT_AGENT })
    const location = target(await locate(root, 'agent.ts', ''))
    const edited = NEW_TYPESCRIPT_AGENT.replace("  name: 'fresh',", "  name: 'fresh',\n  instructions: 'Be kind.',")
    await writeFile(join(root, 'agent.ts'), edited)

    await expect(location.write('Answer briefly.')).rejects.toThrow(
      'agent.ts now sets instructions to "Be kind.", not "". Review the change again.'
    )
    expect(await read(root, 'agent.ts')).toBe(edited)
  })

  describe.skipIf(!existsSync(pythonExecutable))('in a Python agent', () => {
    beforeEach(() => {
      vi.stubEnv('PYTHON', pythonExecutable)
    })

    afterEach(() => vi.unstubAllEnvs())

    it.each([
      {
        form: 'SetsThemToNone',
        source: 'agent = create_harness(model="bedrock/model", instructions=None, skills=False)\n',
        written: 'agent = create_harness(model="bedrock/model", instructions="Answer briefly.", skills=False)\n',
      },
      {
        form: 'LeavesThemOut',
        source: 'agent = create_harness(model="bedrock/model", skills=False)\n',
        written: 'agent = create_harness(model="bedrock/model", skills=False, instructions="Answer briefly.")\n',
      },
    ])('shouldAddTheInstructionsWhenTheAgent$form', async ({ source, written }) => {
      const root = await project({ 'agent.py': source })

      await target(await locate(root, 'agent.py', '')).write('Answer briefly.')

      expect(await read(root, 'agent.py')).toBe(written)
    })

    it('shouldAddInstructionsOfSeveralLinesAsATripleQuotedString', async () => {
      const root = await project({ 'agent.py': 'agent = create_harness(model="bedrock/model")\n' })

      await target(await locate(root, 'agent.py', '')).write(NEW_INSTRUCTIONS)

      expect(await read(root, 'agent.py')).toBe(
        `agent = create_harness(model="bedrock/model", instructions="""${NEW_INSTRUCTIONS}""")\n`
      )
    })
  })
})

describe('apply next to option saves', () => {
  it('shouldKeepBothChangesWhenAnOptimizationAndAModelChangeSaveTheAgentAtTheSameTime', async () => {
    const root = await project({ 'agent.py': PYTHON_AGENT(`"""${INSTRUCTIONS}"""`) })
    const location = target(await locate(root, 'agent.py', INSTRUCTIONS))
    const modelChange = editFile(root, join(root, 'agent.py'), (content) =>
      content.replace('model="bedrock/model"', 'model="bedrock/next-model"')
    )

    await Promise.all([location.write(NEW_INSTRUCTIONS), modelChange])

    const source = await read(root, 'agent.py')
    expect(source).toContain('model="bedrock/next-model"')
    expect(source).toContain(`"""${NEW_INSTRUCTIONS}"""`)
  })
})
