import { Skill } from '@strands-agents/sdk/vended-plugins/skills'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { URL } from 'node:url'

import { assertPortablePathComponent } from '../../project/packaging.js'
import { errorMessage } from '../../terminal/text.js'
import { savedSessionCount } from '../../session/sessions.js'
import { isRecord } from '../../values.js'
import { devSessionsFolder } from '../runtime.js'
import type { DevWorkspace } from '../workspace.js'
import type { TemporaryAgentFacts } from './agent-context.js'
import { prepareTemporaryOptimizerEnvironment } from './environment.js'
import { temporaryWorkspaceDirectory } from './evals-process.js'
import { TEMPORARY_EVALS_FORK } from './fork.js'
import { temporaryExperimentFile, temporarySkillsFolder } from './layout.js'

const SKILL_NAME = 'session-converter'
const SKILL_PATH = `.agents/skills/${SKILL_NAME}`
const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_SKILL_FILES = 50
const GITHUB_REPOSITORY = /^[\w.-]+\/[\w.-]+$/u

type Fetch = typeof globalThis.fetch

export interface TemporarySessionHistory {
  pastChats(): Promise<number>
  converter(): Promise<string>
}

export interface TemporaryEvalsSource {
  readonly repository: string
  readonly commit: string
}

export interface TemporarySessionHistoryOptions {
  readonly workspace: DevWorkspace
  readonly agent: () => TemporaryAgentFacts
  readonly evals?: TemporaryEvalsSource
  readonly fetch?: Fetch
  readonly environment?: NodeJS.ProcessEnv
  readonly python?: () => Promise<string>
}

interface Download {
  readonly commit: string
  readonly files: readonly string[]
  readonly stale?: string
}

interface GitHub {
  readonly fetch: Fetch
  readonly environment: NodeJS.ProcessEnv
  readonly repository: string
}

const githubRepository = (url: string): string => {
  const parsed = new URL(url)
  const path = parsed.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '')
  if (parsed.host !== 'github.com' || !GITHUB_REPOSITORY.test(path))
    throw new Error(`${url} is not a GitHub repository`)
  return path
}

const chatsFolder = ({ sessionDirectory }: TemporaryAgentFacts, workspaceDirectory: string): string =>
  sessionDirectory ?? devSessionsFolder(workspaceDirectory)

const fetchText = async ({ fetch }: GitHub, url: string, headers: Record<string, string>): Promise<string> => {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error(response.ok ? `${url} is too large` : `${url} answered HTTP ${response.status}`)
  }
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error(`${url} is too large`)
  return text
}

const githubApi = (github: GitHub, path: string, accept: string): Promise<string> => {
  const token = github.environment.GITHUB_TOKEN || github.environment.GH_TOKEN
  return fetchText(github, `https://api.github.com/repos/${github.repository}/${path}`, {
    Accept: accept,
    'User-Agent': 'strands-cli',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  })
}

const skillFiles = async (github: GitHub, commit: string): Promise<string[]> => {
  const listing: unknown = JSON.parse(
    await githubApi(github, `git/trees/${commit}?recursive=1`, 'application/vnd.github+json')
  )
  if (!isRecord(listing) || !Array.isArray(listing.tree) || listing.truncated === true)
    throw new Error('GitHub sent a file list that strands dev cannot read')
  const prefix = `${SKILL_PATH}/`
  const files = listing.tree
    .flatMap((entry) =>
      isRecord(entry) && entry.type === 'blob' && typeof entry.path === 'string' && entry.path.startsWith(prefix)
        ? [entry.path.slice(prefix.length)]
        : []
    )
    .sort()
  if (!files.includes('SKILL.md')) throw new Error(`${SKILL_PATH} has no SKILL.md at commit ${commit.slice(0, 7)}`)
  if (files.length > MAX_SKILL_FILES) throw new Error(`${SKILL_PATH} has more than ${MAX_SKILL_FILES} files`)
  for (const file of files) file.split('/').forEach(assertPortablePathComponent)
  return files
}

const replaceFolder = async (folder: string, contents: ReadonlyMap<string, string>): Promise<void> => {
  await mkdir(dirname(folder), { recursive: true })
  const staging = await mkdtemp(join(dirname(folder), `.${SKILL_NAME}-`))
  try {
    for (const [file, text] of contents) {
      const path = join(staging, ...file.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
    }
    await rm(folder, { recursive: true, force: true })
    await rename(staging, folder)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

const recordPath = (folder: string): string => `${folder}.json`

const readRecord = async (folder: string): Promise<Download | undefined> => {
  let record: unknown
  try {
    record = JSON.parse(await readFile(recordPath(folder), 'utf8'))
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  if (!isRecord(record) || typeof record.commit !== 'string' || !Array.isArray(record.files)) return undefined
  const files = record.files.filter((file): file is string => typeof file === 'string')
  return files.length === record.files.length && existsSync(join(folder, 'SKILL.md'))
    ? { commit: record.commit, files }
    : undefined
}

const downloadPinned = async (github: GitHub, folder: string, commit: string): Promise<Download> => {
  const earlier = await readRecord(folder)
  if (earlier?.commit === commit) return earlier
  const files = await skillFiles(github, commit)
  const raw = (file: string): string =>
    `https://raw.githubusercontent.com/${github.repository}/${commit}/${SKILL_PATH}/${file}`
  const texts = await Promise.all(files.map((file) => fetchText(github, raw(file), { 'User-Agent': 'strands-cli' })))
  await replaceFolder(folder, new Map(files.map((file, index) => [file, texts[index]!])))
  const download = { commit, files }
  await writeFile(recordPath(folder), `${JSON.stringify({ repository: github.repository, ...download })}\n`)
  return download
}

const pinnedSkill = async (github: GitHub, folder: string, commit: string): Promise<Download> => {
  try {
    return await downloadPinned(github, folder, commit)
  } catch (error) {
    const earlier = await readRecord(folder)
    if (earlier) return { ...earlier, stale: errorMessage(error) }
    throw new Error(
      `strands dev could not download the ${SKILL_NAME} skill of strands-evals ${commit.slice(0, 7)} from ` +
        `github.com/${github.repository} (${errorMessage(error)}). Check the network connection and try again, ` +
        'or describe what to test instead.',
      { cause: error }
    )
  }
}

interface Guide {
  readonly folder: string
  readonly repository: string
  readonly download: Download
  readonly python: string
  readonly workspaceDirectory: string
  readonly chats: string
  readonly currentChat: string | undefined
}

const strandsDevRules = ({ python, workspaceDirectory, chats, currentChat }: Guide): string[] => [
  `Past chats: the chats with this agent are Strands CLI sessions, and ${chats} is ` +
    'their <directory>. Use only them, unless the developer asks for other harnesses, traces, or files.' +
    (currentChat ? ` Skip ${currentChat}, which is this chat.` : ''),
  "Questions: ask the skill's questions one at a time, in plain words, without numbered options. " +
    'Skip a question that the chat already answered.',
  `Commands: run strands-evals as "${python}" -m strands_evals.cli, for example "${python}" -m strands_evals.cli ` +
    `validate <file>. Run the Python scripts of the skill with "${python}". That environment has strands-evals, ` +
    'and python3 on the PATH may not.',
  'Evaluators: call strands_dev_evaluators before you write "evaluators". Replace each unavailable evaluator with ' +
    'the nearest available one, and tell the developer.',
  'Cases: give every case a non-blank input and expected_assertion.',
  `File: save the experiment as ${temporaryExperimentFile(workspaceDirectory, '<name>')}. Use a short new ` +
    'name of letters, numbers, dots, dashes, and underscores, not <timestamp>_<uuid>. Never replace a file.',
  'Cost: reading the chats in step 3 uses the chat model, and synthesizing cases calls a Bedrock model about one ' +
    'time for each case. Before each, say what it reads or makes, and wait for a yes.',
  'Handoff: point to /experiment to review the cases and to run them, not to strands-evals run. ' +
    'For a smoke test, offer to run them.',
]

const guideText = (guide: Guide): string => {
  const { folder, repository, download } = guide
  const version = `strands-evals ${download.commit.slice(0, 7)}`
  return [
    `Follow the ${SKILL_NAME} skill below. It is the skill of ${version} from github.com/${repository}, ` +
      `and strands dev saved it in ${folder}. Its links, such as assets/segmenter.md, and <skill_dir> refer to ` +
      'that folder.' +
      (download.stale
        ? ` The skill of the installed strands-evals could not be downloaded (${download.stale}), so this skill ` +
          'comes from an earlier version.'
        : ' strands dev runs the same version of strands-evals.'),
    `Files:\n${download.files.map((file) => `  ${join(folder, ...file.split('/'))}`).join('\n')}`,
    ['In this strands dev chat, these rules replace the matching parts of the skill:', ...strandsDevRules(guide)].join(
      '\n- '
    ),
    Skill.fromFile(folder).instructions,
  ].join('\n\n')
}

export const temporarySessionHistory = ({
  workspace,
  agent,
  evals = TEMPORARY_EVALS_FORK,
  fetch = globalThis.fetch,
  environment = process.env,
  python,
}: TemporarySessionHistoryOptions): TemporarySessionHistory => {
  const evalsPython = (workspaceDirectory: string): Promise<string> =>
    python?.() ??
    prepareTemporaryOptimizerEnvironment({
      workspaceDirectory,
      projectRoot: workspace.root,
      language: workspace.config.language,
    })
  return {
    pastChats: async (): Promise<number> => {
      if (!workspace.directory) return 0
      const facts = agent()
      return savedSessionCount(chatsFolder(facts, workspace.directory), facts.sessionId)
    },
    converter: async (): Promise<string> => {
      const workspaceDirectory = temporaryWorkspaceDirectory(workspace)
      const folder = join(temporarySkillsFolder(workspaceDirectory), SKILL_NAME)
      const repository = githubRepository(evals.repository)
      const [download, interpreter] = await Promise.all([
        pinnedSkill({ fetch, environment, repository }, folder, evals.commit),
        evalsPython(workspaceDirectory),
      ])
      const facts = agent()
      return guideText({
        folder,
        repository,
        download,
        python: interpreter,
        workspaceDirectory,
        chats: chatsFolder(facts, workspaceDirectory),
        currentChat: facts.sessionId,
      })
    },
  }
}
