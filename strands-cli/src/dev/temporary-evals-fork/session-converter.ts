import { Skill } from '@strands-agents/sdk/vended-plugins/skills'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { assertPortablePathComponent } from '../../project/packaging.js'
import { errorMessage } from '../../terminal/text.js'
import { isRecord } from '../../values.js'
import { devSessionsFolder } from '../runtime.js'
import type { DevWorkspace } from '../workspace.js'
import { prepareTemporaryOptimizerEnvironment } from './environment.js'
import { temporaryWorkspaceDirectory } from './evals-process.js'
import { temporaryExperimentFile, temporarySkillsFolder } from './layout.js'

export const TEMPORARY_SESSION_CONVERTER_SOURCE = 'github.com/strands-agents/evals'

const REPOSITORY = 'strands-agents/evals'
const BRANCH = 'main'
const SKILL_NAME = 'session-converter'
const SKILL_PATH = `.agents/skills/${SKILL_NAME}`
const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_SKILL_FILES = 50
const COMMIT = /^[0-9a-f]{40}$/u

type Fetch = typeof globalThis.fetch

export interface TemporarySessionHistory {
  pastChats(): Promise<number>
  converter(): Promise<string>
}

export interface TemporarySessionHistoryOptions {
  readonly workspace: DevWorkspace
  readonly currentChat: () => string | undefined
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
}

const countPastChats = async (folder: string, current: string | undefined): Promise<number> => {
  try {
    const entries = await readdir(folder, { withFileTypes: true })
    return entries.filter(
      (entry) => entry.isDirectory() && entry.name !== current && existsSync(join(folder, entry.name, 'scopes'))
    ).length
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return 0
    throw error
  }
}

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
  return fetchText(github, `https://api.github.com/repos/${REPOSITORY}/${path}`, {
    Accept: accept,
    'User-Agent': 'strands-cli',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  })
}

const newestCommit = async (github: GitHub): Promise<string> => {
  const commit = (await githubApi(github, `commits/${BRANCH}`, 'application/vnd.github.sha')).trim()
  if (!COMMIT.test(commit)) throw new Error(`GitHub sent no commit for the ${BRANCH} branch`)
  return commit
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

const downloadNewest = async (github: GitHub, folder: string): Promise<Download> => {
  const commit = await newestCommit(github)
  const earlier = await readRecord(folder)
  if (earlier?.commit === commit) return earlier
  const files = await skillFiles(github, commit)
  const raw = (file: string): string =>
    `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${SKILL_PATH}/${file}`
  const texts = await Promise.all(files.map((file) => fetchText(github, raw(file), { 'User-Agent': 'strands-cli' })))
  await replaceFolder(folder, new Map(files.map((file, index) => [file, texts[index]!])))
  const download = { commit, files }
  await writeFile(recordPath(folder), `${JSON.stringify({ repository: REPOSITORY, branch: BRANCH, ...download })}\n`)
  return download
}

const newestSkill = async (github: GitHub, folder: string): Promise<Download> => {
  try {
    return await downloadNewest(github, folder)
  } catch (error) {
    const earlier = await readRecord(folder)
    if (earlier) return { ...earlier, stale: errorMessage(error) }
    throw new Error(
      `strands dev could not download the ${SKILL_NAME} skill from ${TEMPORARY_SESSION_CONVERTER_SOURCE} ` +
        `(${errorMessage(error)}). Check the network connection and try again, or describe what to test instead.`,
      { cause: error }
    )
  }
}

interface Guide {
  readonly folder: string
  readonly download: Download
  readonly python: string
  readonly workspaceDirectory: string
  readonly currentChat: string | undefined
}

const strandsDevRules = ({ python, workspaceDirectory, currentChat }: Guide): string[] => [
  `Past chats: the chats with this agent are Strands CLI sessions, and ${devSessionsFolder(workspaceDirectory)} is ` +
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
  'Handoff: point to /experiment to review the cases and to /test to run them, not to strands-evals run. ' +
    'For a smoke test, offer /test.',
]

const guideText = (guide: Guide): string => {
  const { folder, download } = guide
  return [
    `Follow the ${SKILL_NAME} skill below. strands dev downloaded it from ${TEMPORARY_SESSION_CONVERTER_SOURCE}, ` +
      `branch ${BRANCH}, commit ${download.commit.slice(0, 7)}, into ${folder}. Its links, such as ` +
      'assets/segmenter.md, and <skill_dir> refer to that folder.' +
      (download.stale
        ? ` A newer version could not be downloaded (${download.stale}), so this is an earlier one.`
        : ''),
    `Files:\n${download.files.map((file) => `  ${join(folder, ...file.split('/'))}`).join('\n')}`,
    ['In this strands dev chat, these rules replace the matching parts of the skill:', ...strandsDevRules(guide)].join(
      '\n- '
    ),
    Skill.fromFile(folder).instructions,
  ].join('\n\n')
}

export const temporarySessionHistory = ({
  workspace,
  currentChat,
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
    pastChats: async (): Promise<number> =>
      workspace.directory ? countPastChats(devSessionsFolder(workspace.directory), currentChat()) : 0,
    converter: async (): Promise<string> => {
      const workspaceDirectory = temporaryWorkspaceDirectory(workspace)
      const folder = join(temporarySkillsFolder(workspaceDirectory), SKILL_NAME)
      const [download, interpreter] = await Promise.all([
        newestSkill({ fetch, environment }, folder),
        evalsPython(workspaceDirectory),
      ])
      return guideText({ folder, download, python: interpreter, workspaceDirectory, currentChat: currentChat() })
    },
  }
}
