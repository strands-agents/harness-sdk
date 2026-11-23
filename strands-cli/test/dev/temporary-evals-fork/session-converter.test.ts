import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { TemporaryAgentFacts } from '../../../src/dev/temporary-evals-fork/agent-context.js'
import { TEMPORARY_EVALS_FORK } from '../../../src/dev/temporary-evals-fork/fork.js'
import {
  temporarySessionHistory,
  type TemporaryEvalsSource,
} from '../../../src/dev/temporary-evals-fork/session-converter.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const FIRST = 'a'.repeat(40)
const SECOND = 'b'.repeat(40)
const REPOSITORY = 'https://github.com/example/evals'
const CURRENT = '20261117t101500z-current'
const PYTHON = '/desk/strands-dev/tmp/.state/evals-env/bin/python'
const SKILL = '.agents/skills/session-converter'
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

const fakeGitHub = () => {
  const state = {
    files: new Map<string, string>([
      ['SKILL.md', SKILL_MD],
      ['assets/segmenter.md', '# segmenter'],
      ['scripts/synthesize_cases.py', 'print("cases")'],
    ]),
    reachable: true,
  }
  const answer = (url: string): globalThis.Response => {
    const tree = /^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/git\/trees\/[0-9a-f]{40}\?recursive=1$/u
    if (tree.test(url))
      return globalThis.Response.json({
        truncated: false,
        tree: [
          { path: 'README.md', type: 'blob' },
          { path: SKILL, type: 'tree' },
          ...[...state.files.keys()].map((file) => ({ path: `${SKILL}/${file}`, type: 'blob' })),
        ],
      })
    const raw = /^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[0-9a-f]{40}\/(.+)$/u.exec(url)?.[1]
    const file = raw?.startsWith(`${SKILL}/`) ? state.files.get(raw.slice(SKILL.length + 1)) : undefined
    return file === undefined ? new globalThis.Response('missing', { status: 404 }) : new globalThis.Response(file)
  }
  const fetch = vi.fn(
    async (
      url: Parameters<typeof globalThis.fetch>[0],
      _init?: Parameters<typeof globalThis.fetch>[1]
    ): Promise<globalThis.Response> => {
      if (!state.reachable) throw new TypeError('fetch failed')
      return answer(String(url))
    }
  )
  return { state, fetch }
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

const setup = async (environment: NodeJS.ProcessEnv = {}, facts: TemporaryAgentFacts = { sessionId: CURRENT }) => {
  const workspace = await workspaceFixture()
  const github = fakeGitHub()
  const historyAt = (evals?: TemporaryEvalsSource) =>
    temporarySessionHistory({
      workspace,
      agent: () => facts,
      ...(evals ? { evals } : {}),
      fetch: github.fetch,
      environment,
      python: async () => PYTHON,
    })
  const history = historyAt({ repository: REPOSITORY, commit: FIRST })
  const folder = join(workspace.directory!, 'tmp', '.state', 'skills', 'session-converter')
  const requested = (): string[] => github.fetch.mock.calls.map(([url]) => String(url))
  return { workspace, github, history, historyAt, folder, requested }
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
  it('shouldDownloadTheSkillOfThePinnedEvalsAndGiveItWithTheStrandsDevRulesWhenNothingWasDownloaded', async () => {
    const { workspace, history, folder, requested } = await setup()

    const guide = await history.converter()

    expect(await readFile(join(folder, 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(await readFile(join(folder, 'assets', 'segmenter.md'), 'utf8')).toBe('# segmenter')
    expect(requested()).toEqual([
      `https://api.github.com/repos/example/evals/git/trees/${FIRST}?recursive=1`,
      ...['SKILL.md', 'assets/segmenter.md', 'scripts/synthesize_cases.py'].map(
        (file) => `https://raw.githubusercontent.com/example/evals/${FIRST}/${SKILL}/${file}`
      ),
    ])
    expect(guide).toContain(`the skill of strands-evals ${FIRST.slice(0, 7)} from github.com/example/evals`)
    expect(guide).toContain('strands dev runs the same version of strands-evals.')
    expect(guide).toContain(join(folder, 'scripts', 'synthesize_cases.py'))
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

  it('shouldUseTheEvalsPinOfStrandsDevWhenNoVersionIsGiven', async () => {
    const { historyAt, requested } = await setup()

    await historyAt().converter()

    const repository = TEMPORARY_EVALS_FORK.repository.replace('https://github.com/', '')
    expect(requested()[0]).toBe(
      `https://api.github.com/repos/${repository}/git/trees/${TEMPORARY_EVALS_FORK.commit}?recursive=1`
    )
  })

  it('shouldDownloadNothingWhenThePinnedVersionWasDownloadedBefore', async () => {
    const { history, requested } = await setup()
    await history.converter()
    const before = requested().length

    const guide = await history.converter()

    expect(requested()).toHaveLength(before)
    expect(guide).toContain('strands dev runs the same version of strands-evals.')
  })

  it('shouldReplaceTheWholeFolderWhenThePinMovesToANewVersion', async () => {
    const { github, history, historyAt, folder } = await setup()
    await history.converter()
    github.state.files.delete('scripts/synthesize_cases.py')
    github.state.files.set('assets/segmenter.md', '# segmenter v2')

    const guide = await historyAt({ repository: REPOSITORY, commit: SECOND }).converter()

    expect(guide).toContain(`strands-evals ${SECOND.slice(0, 7)}`)
    expect(await readFile(join(folder, 'assets', 'segmenter.md'), 'utf8')).toBe('# segmenter v2')
    expect(existsSync(join(folder, 'scripts', 'synthesize_cases.py'))).toBe(false)
  })

  it('shouldUseTheEarlierDownloadAndSaySoWhenThePinMovedAndGitHubCannotBeReached', async () => {
    const { github, history, historyAt } = await setup()
    await history.converter()
    github.state.reachable = false

    const guide = await historyAt({ repository: REPOSITORY, commit: SECOND }).converter()

    expect(guide).toContain(`strands-evals ${FIRST.slice(0, 7)}`)
    expect(guide).toContain(
      'The skill of the installed strands-evals could not be downloaded (fetch failed), so this skill comes from ' +
        'an earlier version.'
    )
  })

  it('shouldNameTheCauseAndANextStepWhenNothingCanBeDownloaded', async () => {
    const { github, history } = await setup()
    github.state.reachable = false

    await expect(history.converter()).rejects.toThrow(
      `strands dev could not download the session-converter skill of strands-evals ${FIRST.slice(0, 7)} from ` +
        'github.com/example/evals (fetch failed). Check the network connection and try again, or describe what ' +
        'to test instead.'
    )
  })

  it('shouldRefuseAPinThatIsNotAGitHubRepository', async () => {
    const { historyAt } = await setup()

    await expect(
      historyAt({ repository: 'https://gitlab.com/example/evals', commit: FIRST }).converter()
    ).rejects.toThrow('https://gitlab.com/example/evals is not a GitHub repository')
  })

  it.each([
    ['a path that leaves the skill folder', '../../../outside.md', 'is not portable'],
    ['no SKILL.md', undefined, 'has no SKILL.md at commit aaaaaaa'],
  ])('shouldWriteNothingWhenTheFileListHas %s', async (_case, extra, message) => {
    const { github, history, folder } = await setup()
    if (extra) github.state.files.set(extra, 'not a skill file')
    else github.state.files.delete('SKILL.md')

    await expect(history.converter()).rejects.toThrow(message)
    expect(existsSync(folder)).toBe(false)
  })

  it('shouldSendTheGitHubTokenOnlyToTheGitHubApiWhenTheEnvironmentHasOne', async () => {
    const { github, history } = await setup({ GITHUB_TOKEN: 'token-1' })

    await history.converter()

    const authorization = github.fetch.mock.calls.map(([url, init]) => [
      String(url).split('/')[2],
      (init?.headers as Record<string, string>).Authorization,
    ])
    expect(authorization).toEqual([
      ['api.github.com', 'Bearer token-1'],
      ['raw.githubusercontent.com', undefined],
      ['raw.githubusercontent.com', undefined],
      ['raw.githubusercontent.com', undefined],
    ])
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
    const { history } = await setup({}, { sessionId: 'c66f1c2e', sessionDirectory: chats })
    await savedChat(chats, '29726c2f')
    await savedChat(chats, 'c66f1c2e', 0)
    await savedChat(join(workspace.directory!, '.strands', 'state', 'sessions', 'context'), '29726c2f')

    await expect(history.pastChats()).resolves.toBe(1)
  })

  it('shouldNameTheSessionFolderOfTheAgentInTheRulesWhenAPythonAgentRuns', async () => {
    const chats = '/desk/strands-dev/.strands/state/sessions/session'
    const { history } = await setup({}, { sessionId: 'c66f1c2e', sessionDirectory: chats })

    const guide = await history.converter()

    expect(guide).toContain(`Strands CLI sessions, and ${chats} is their <directory>`)
    expect(guide).toContain('Skip c66f1c2e, which is this chat.')
  })

  it('shouldCountNoChatsWhenTheWorkspaceHasNoSessionsFolder', async () => {
    const { history } = await setup()

    await expect(history.pastChats()).resolves.toBe(0)
  })
})
