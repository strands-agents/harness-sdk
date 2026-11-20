import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { URL } from 'node:url'

import { assertPortablePathComponent } from '../../project/packaging.js'
import { errorMessage } from '../../terminal/text.js'
import { isRecord } from '../../values.js'

const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_SKILL_FILES = 50
const GITHUB_REPOSITORY = /^[\w.-]+\/[\w.-]+$/u

type Fetch = typeof globalThis.fetch

/** A pinned source of the strands-evals skills. */
export interface TemporaryEvalsSource {
  readonly repository: string
  readonly commit: string
}

export interface Download {
  readonly commit: string
  readonly files: readonly string[]
  readonly stale?: string
}

interface GitHub {
  readonly fetch: Fetch
  readonly environment: NodeJS.ProcessEnv
  readonly repository: string
}

export const githubRepository = (url: string): string => {
  const parsed = new URL(url)
  const path = parsed.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '')
  if (parsed.host !== 'github.com' || !GITHUB_REPOSITORY.test(path))
    throw new Error(`${url} is not a GitHub repository`)
  return path
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
  return fetchText(github, `https://api.github.com/repos/${github.repository}/${path}`, {
    Accept: accept,
    'User-Agent': 'strands-cli',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  })
}

const skillPath = (skill: string): string => `.agents/skills/${skill}`

const skillFiles = async (github: GitHub, skill: string, commit: string): Promise<string[]> => {
  const listing: unknown = JSON.parse(
    await githubApi(github, `git/trees/${commit}?recursive=1`, 'application/vnd.github+json')
  )
  if (!isRecord(listing) || !Array.isArray(listing.tree) || listing.truncated === true)
    throw new Error('GitHub sent a file list that strands dev cannot read')
  const prefix = `${skillPath(skill)}/`
  const files = listing.tree
    .flatMap((entry) =>
      isRecord(entry) && entry.type === 'blob' && typeof entry.path === 'string' && entry.path.startsWith(prefix)
        ? [entry.path.slice(prefix.length)]
        : []
    )
    .sort()
  if (!files.includes('SKILL.md'))
    throw new Error(`${skillPath(skill)} has no SKILL.md at commit ${commit.slice(0, 7)}`)
  if (files.length > MAX_SKILL_FILES) throw new Error(`${skillPath(skill)} has more than ${MAX_SKILL_FILES} files`)
  for (const file of files) file.split('/').forEach(assertPortablePathComponent)
  return files
}

const replaceFolder = async (skill: string, folder: string, contents: ReadonlyMap<string, string>): Promise<void> => {
  await mkdir(dirname(folder), { recursive: true })
  const staging = await mkdtemp(join(dirname(folder), `.${skill}-`))
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

const downloadPinned = async (github: GitHub, skill: string, folder: string, commit: string): Promise<Download> => {
  const earlier = await readRecord(folder)
  if (earlier?.commit === commit) return earlier
  const files = await skillFiles(github, skill, commit)
  const raw = (file: string): string =>
    `https://raw.githubusercontent.com/${github.repository}/${commit}/${skillPath(skill)}/${file}`
  const texts = await Promise.all(files.map((file) => fetchText(github, raw(file), { 'User-Agent': 'strands-cli' })))
  await replaceFolder(skill, folder, new Map(files.map((file, index) => [file, texts[index]!])))
  const download = { commit, files }
  await writeFile(recordPath(folder), `${JSON.stringify({ repository: github.repository, ...download })}\n`)
  return download
}

export interface EvalsSkillRequest {
  readonly skill: string
  readonly source: TemporaryEvalsSource
  readonly folder: string
  readonly fetch: Fetch
  readonly environment: NodeJS.ProcessEnv
  /** Appended to the failure, so each skill offers its own way forward. */
  readonly hint?: string
}

export interface EvalsSkill {
  readonly folder: string
  readonly repository: string
  readonly download: Download
}

/** Downloads one skill of the pinned strands-evals, and falls back to the last copy it kept. */
export const downloadEvalsSkill = async ({
  skill,
  source,
  folder,
  fetch,
  environment,
  hint,
}: EvalsSkillRequest): Promise<EvalsSkill> => {
  const repository = githubRepository(source.repository)
  const github = { fetch, environment, repository }
  try {
    return { folder, repository, download: await downloadPinned(github, skill, folder, source.commit) }
  } catch (error) {
    const earlier = await readRecord(folder)
    if (earlier) return { folder, repository, download: { ...earlier, stale: errorMessage(error) } }
    throw new Error(
      `strands dev could not download the ${skill} skill of strands-evals ${source.commit.slice(0, 7)} from ` +
        `github.com/${repository} (${errorMessage(error)}). Check the network connection and try again${
          hint ? `, ${hint}` : '.'
        }`,
      { cause: error }
    )
  }
}
