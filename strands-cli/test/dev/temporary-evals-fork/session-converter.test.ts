import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { STRANDS_EVALS_VERSION } from '../../../src/dev/evals-package.js'
import type { TemporaryAgentFacts } from '../../../src/dev/temporary-evals-fork/agent-context.js'
import { temporarySessionHistory } from '../../../src/dev/temporary-evals-fork/session-converter.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const CURRENT = '20261117t101500z-current'
const PYTHON = '/desk/strands-dev/tmp/.state/evals-env/bin/python'
const SKILL_MD = [
  '---',
  'name: session-converter',
  'description: Turns past chats into an experiment.',
  '---',
  '',
  '# session-converter',
  '',
  'Follow [assets/segmenter.md](assets/segmenter.md).',
].join('\n')
const SKILL_FILES: ReadonlyMap<string, string> = new Map([
  ['SKILL.md', SKILL_MD],
  ['assets/segmenter.md', '# segmenter'],
  ['scripts/synthesize_cases.py', 'print("cases")'],
  ['scripts/__pycache__/synthesize_cases.cpython-312.pyc', 'compiled'],
])

const writeFileAt = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const installedSkill = async (): Promise<string> => {
  const folder = join(await temporaryDirectory(), 'strands_evals', '.agents', 'skills', 'session-converter')
  for (const [file, text] of SKILL_FILES) await writeFileAt(join(folder, ...file.split('/')), text)
  return folder
}

const workspaceFixture = async (): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  return {
    directory: join(root, 'strands-dev'),
    root,
    entrypoint: join(root, 'agent.py'),
    config: { version: 1, name: 'desk', language: 'python', entrypoint: 'agent.py', origin: { kind: 'discovered' } },
  }
}

const setup = async (facts: TemporaryAgentFacts = { sessionId: CURRENT }) => {
  const workspace = await workspaceFixture()
  const folder = await installedSkill()
  const asked: string[] = []
  const history = temporarySessionHistory({
    workspace,
    agent: () => facts,
    python: async () => PYTHON,
    skillFolder: async (python) => {
      asked.push(python)
      return folder
    },
  })
  return { workspace, history, folder, asked }
}

const savedChat = async (folder: string, name: string, messages = 2): Promise<void> => {
  const snapshots = join(folder, name, 'scopes', 'agent', 'agent', 'snapshots')
  await mkdir(snapshots, { recursive: true })
  const turns = Array.from({ length: messages }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: [{ text: `turn ${index}` }],
  }))
  await writeFile(join(snapshots, 'snapshot_latest.json'), JSON.stringify({ data: { messages: turns } }))
}

describe('TEMPORARY session-converter skill', () => {
  it('shouldGiveTheSkillOfTheInstalledEvalsWithTheStrandsDevRulesWhenTheChatAsksForIt', async () => {
    const { workspace, history, folder, asked } = await setup()

    const guide = await history.converter()

    expect(asked).toEqual([PYTHON])
    expect(guide).toContain(
      `the skill of strands-agents-evals ${STRANDS_EVALS_VERSION}, which strands dev installed in ${folder}.`
    )
    expect(guide).toContain('strands dev runs the same version of strands-evals.')
    expect(guide).toContain(join(folder, 'scripts', 'synthesize_cases.py'))
    expect(guide).toContain(join(folder, 'assets', 'segmenter.md'))
    expect(guide).not.toContain('__pycache__')
    expect(guide).toContain(`${join(workspace.directory!, '.strands/state/sessions')} is their <directory>`)
    expect(guide).toContain('Skip 20261117t101500z-current, which is this chat.')
    expect(guide).toContain(`"${PYTHON}" -m strands_evals.cli validate <file>`)
    expect(guide).toContain(join(workspace.directory!, 'experiments', '<name>', '<name>.json'))
    expect(guide).toContain('call strands_dev_evaluators before you write "evaluators"')
    expect(guide).toContain("ask the skill's questions one at a time")
    expect(guide).toContain('wait for a yes')
    expect(guide).toContain('point to /experiment to review the cases and to run them')
    expect(guide.endsWith('Follow [assets/segmenter.md](assets/segmenter.md).')).toBe(true)
  })

  it('shouldGiveAnAgentThatWorksOnItsOwnRulesThatAskNothingAndNameTheFileAndTheEvaluators', async () => {
    const { workspace, history } = await setup()

    const guide = await history.unattendedConverter({
      name: 'history-20261123-1502',
      evaluators: ['OutputEvaluator', 'StartsWith'],
      fewestCases: 3,
    })

    expect(guide).toContain('You work for strands dev on your own')
    expect(guide).toContain('Questions: ask none.')
    expect(guide).toContain('do not wait for a yes')
    expect(guide).toContain('write only these in "evaluators": OutputEvaluator, StartsWith.')
    expect(guide).toContain(
      `save the experiment as ${join(workspace.directory!, 'experiments', 'history-20261123-1502', 'history-20261123-1502.json')}`
    )
    expect(guide).toContain('fewer than 3 cases, save no file')
    expect(guide).toContain('Start no evaluation and no optimization')
    // The chat it works for is one of the chats: the agent keeps no session of its own to skip.
    expect(guide).toContain(
      `${join(workspace.directory!, '.strands/state/sessions')} is their <directory>. Use all of them`
    )
    expect(guide).not.toContain('Skip 20261117t101500z-current')
    // None of the rules for a chat with the developer are in it.
    expect(guide).not.toContain('strands_dev_evaluators')
    expect(guide).not.toContain("ask the skill's questions one at a time")
    expect(guide).not.toContain('point to /experiment')
    expect(guide.endsWith('Follow [assets/segmenter.md](assets/segmenter.md).')).toBe(true)
  })
})

describe('TEMPORARY past chats', () => {
  it('shouldCountTheChatsWithMessagesExceptThisOneWhenATypeScriptAgentSavedThem', async () => {
    const { workspace, history } = await setup()
    const chats = join(workspace.directory!, '.strands', 'state', 'sessions')
    await savedChat(chats, '20261116t090000z-first')
    await savedChat(chats, '20261116t100000z-second')
    await savedChat(chats, CURRENT)
    await savedChat(chats, '20261117t100000z-empty', 0)
    await mkdir(join(chats, '20261117t100500z-unsaved'))
    await writeFile(join(chats, 'notes.txt'), 'not a chat')

    await expect(history.pastChats()).resolves.toBe(2)
  })

  it('shouldCountTheChatsInTheSessionFolderOfTheAgentWhenAPythonAgentSavedThem', async () => {
    const workspace = await workspaceFixture()
    const chats = join(workspace.directory!, '.strands', 'state', 'sessions', 'session')
    const { history } = await setup({ sessionId: 'c66f1c2e', sessionDirectory: chats })
    await savedChat(chats, '29726c2f')
    await savedChat(chats, 'c66f1c2e', 0)
    await savedChat(join(workspace.directory!, '.strands', 'state', 'sessions', 'context'), '29726c2f')

    await expect(history.pastChats()).resolves.toBe(1)
  })

  it('shouldNameTheSessionFolderOfTheAgentInTheRulesWhenAPythonAgentRuns', async () => {
    const chats = '/desk/strands-dev/.strands/state/sessions/session'
    const { history } = await setup({ sessionId: 'c66f1c2e', sessionDirectory: chats })

    const guide = await history.converter()

    expect(guide).toContain(`Strands CLI sessions, and ${chats} is their <directory>`)
    expect(guide).toContain('Skip c66f1c2e, which is this chat.')
  })

  it('shouldCountNoChatsWhenTheWorkspaceHasNoSessionsFolder', async () => {
    const { history } = await setup()

    await expect(history.pastChats()).resolves.toBe(0)
  })
})
