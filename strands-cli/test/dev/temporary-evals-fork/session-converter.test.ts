import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { temporarySessionHistory } from '../../../src/dev/temporary-evals-fork/session-converter.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const FIRST = 'a'.repeat(40)
const SECOND = 'b'.repeat(40)
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
    commit: FIRST,
    files: new Map<string, string>([
      ['SKILL.md', SKILL_MD],
      ['assets/segmenter.md', '# segmenter'],
      ['scripts/synthesize_cases.py', 'print("cases")'],
    ]),
    reachable: true,
  }
  const answer = (url: string): globalThis.Response => {
    if (url === 'https://api.github.com/repos/strands-agents/evals/commits/main')
      return new globalThis.Response(state.commit)
    if (url === `https://api.github.com/repos/strands-agents/evals/git/trees/${state.commit}?recursive=1`)
      return globalThis.Response.json({
        truncated: false,
        tree: [
          { path: 'README.md', type: 'blob' },
          { path: SKILL, type: 'tree' },
          ...[...state.files.keys()].map((file) => ({ path: `${SKILL}/${file}`, type: 'blob' })),
        ],
      })
    const raw = `https://raw.githubusercontent.com/strands-agents/evals/${state.commit}/${SKILL}/`
    const file = url.startsWith(raw) ? state.files.get(url.slice(raw.length)) : undefined
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

const setup = async (environment: NodeJS.ProcessEnv = {}) => {
  const workspace = await workspaceFixture()
  const github = fakeGitHub()
  const history = temporarySessionHistory({
    workspace,
    currentChat: () => '20261117t101500z-current',
    fetch: github.fetch,
    environment,
    python: async () => PYTHON,
  })
  const folder = join(workspace.directory!, 'tmp', '.state', 'skills', 'session-converter')
  const requested = (): string[] => github.fetch.mock.calls.map(([url]) => String(url))
  return { workspace, github, history, folder, requested }
}

const chatFolder = async (workspace: DevWorkspace, name: string, saved = true): Promise<void> => {
  const folder = join(workspace.directory!, '.strands', 'state', 'sessions', name)
  await mkdir(saved ? join(folder, 'scopes', 'agent', 'agent', 'snapshots') : folder, { recursive: true })
}

describe('TEMPORARY session-converter skill', () => {
  it('shouldDownloadTheNewestSkillAndGiveItWithTheStrandsDevRulesWhenNothingWasDownloaded', async () => {
    const { workspace, history, folder, requested } = await setup()

    const guide = await history.converter()

    expect(await readFile(join(folder, 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(await readFile(join(folder, 'assets', 'segmenter.md'), 'utf8')).toBe('# segmenter')
    expect(requested().filter((url) => url.startsWith('https://raw.githubusercontent.com/'))).toEqual(
      ['SKILL.md', 'assets/segmenter.md', 'scripts/synthesize_cases.py'].map(
        (file) => `https://raw.githubusercontent.com/strands-agents/evals/${FIRST}/${SKILL}/${file}`
      )
    )
    expect(guide).toContain(`commit ${FIRST.slice(0, 7)}, into ${folder}`)
    expect(guide).toContain(join(folder, 'scripts', 'synthesize_cases.py'))
    expect(guide).toContain(`${join(workspace.directory!, '.strands/state/sessions')} is their <directory>`)
    expect(guide).toContain('Skip 20261117t101500z-current, which is this chat.')
    expect(guide).toContain(`"${PYTHON}" -m strands_evals.cli validate <file>`)
    expect(guide).toContain(join(workspace.directory!, 'tmp', 'experiments', '<name>', '<name>.json'))
    expect(guide).toContain('call strands_dev_evaluators before you write "evaluators"')
    expect(guide).toContain("ask the skill's questions one at a time")
    expect(guide).toContain('wait for a yes')
    expect(guide).toContain('point to /experiment to review the cases and to /test to run them')
    expect(guide.endsWith('Follow [assets/segmenter.md](assets/segmenter.md).')).toBe(true)
  })

  it('shouldDownloadNothingAgainWhenMainStillHasTheSameCommit', async () => {
    const { history, requested } = await setup()
    await history.converter()
    const before = requested().length

    await history.converter()

    expect(requested().slice(before)).toEqual(['https://api.github.com/repos/strands-agents/evals/commits/main'])
  })

  it('shouldReplaceTheWholeFolderWhenMainHasANewCommit', async () => {
    const { github, history, folder } = await setup()
    await history.converter()
    github.state.commit = SECOND
    github.state.files.delete('scripts/synthesize_cases.py')
    github.state.files.set('assets/segmenter.md', '# segmenter v2')

    const guide = await history.converter()

    expect(guide).toContain(`commit ${SECOND.slice(0, 7)}`)
    expect(await readFile(join(folder, 'assets', 'segmenter.md'), 'utf8')).toBe('# segmenter v2')
    expect(existsSync(join(folder, 'scripts', 'synthesize_cases.py'))).toBe(false)
  })

  it('shouldUseTheEarlierDownloadAndSaySoWhenGitHubCannotBeReached', async () => {
    const { github, history } = await setup()
    await history.converter()
    github.state.reachable = false

    const guide = await history.converter()

    expect(guide).toContain(`commit ${FIRST.slice(0, 7)}`)
    expect(guide).toContain('A newer version could not be downloaded (fetch failed), so this is an earlier one.')
  })

  it('shouldNameTheCauseAndANextStepWhenNothingCanBeDownloaded', async () => {
    const { github, history } = await setup()
    github.state.reachable = false

    await expect(history.converter()).rejects.toThrow(
      'strands dev could not download the session-converter skill from github.com/strands-agents/evals ' +
        '(fetch failed). Check the network connection and try again, or describe what to test instead.'
    )
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
      ['api.github.com', 'Bearer token-1'],
      ['raw.githubusercontent.com', undefined],
      ['raw.githubusercontent.com', undefined],
      ['raw.githubusercontent.com', undefined],
    ])
  })
})

describe('TEMPORARY past chats', () => {
  it('shouldCountTheSavedChatsExceptThisOneWhenTheWorkspaceHasChats', async () => {
    const { workspace, history } = await setup()
    await chatFolder(workspace, '20261116t090000z-first')
    await chatFolder(workspace, '20261116t100000z-second')
    await chatFolder(workspace, '20261117t101500z-current')
    await chatFolder(workspace, '20261117t100000z-empty', false)
    await writeFile(join(workspace.directory!, '.strands', 'state', 'sessions', 'notes.txt'), 'not a chat')

    await expect(history.pastChats()).resolves.toBe(2)
  })

  it('shouldCountNoChatsWhenTheWorkspaceHasNoSessionsFolder', async () => {
    const { history } = await setup()

    await expect(history.pastChats()).resolves.toBe(0)
  })
})
