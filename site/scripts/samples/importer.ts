import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, opendir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { JSON_SCHEMA, load as parseYaml } from 'js-yaml'
import MarkdownIt from 'markdown-it'

import type {
  ManifestSample,
  SampleCategory,
  SampleDetail,
  SampleFile,
  SampleGuide,
  SampleManifest,
  SampleSnapshot,
} from './types'

const execFileAsync = promisify(execFile)

export const DEFAULT_REPOSITORY = 'strands-agents/samples'
export const MAX_FILE_BYTES = 256 * 1024
export const MAX_FILES_PER_SAMPLE = 100
export const MAX_SCANNED_ENTRIES_PER_SAMPLE = 2_000
export const MAX_TOTAL_SCANNED_ENTRIES = 50_000
export const MAX_SCAN_DEPTH = 16
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
export const MAX_TOTAL_EMBEDDED_BYTES = 64 * 1024 * 1024

const MAX_MARKER_BYTES = 64 * 1024
const MAX_NOTEBOOK_BYTES = 2 * 1024 * 1024

const MARKER_SCAN_SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.venv',
  '__pycache__',
  'build',
  'cdk.out',
  'data',
  'dataset',
  'datasets',
  'dist',
  'generated',
  'node_modules',
  'output',
  'outputs',
  'target',
  'venv',
])

const SKIPPED_DIRECTORIES = new Set([
  '.astro',
  '.build',
  '.git',
  '.mypy_cache',
  '.next',
  '.pytest_cache',
  '.ruff_cache',
  '.venv',
  '__pycache__',
  'build',
  'cdk.out',
  'coverage',
  'data',
  'dataset',
  'datasets',
  'dist',
  'generated',
  'node_modules',
  'output',
  'outputs',
  'target',
  'vendor',
  'venv',
])

const LOCK_FILES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pipfile.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'uv.lock',
  'yarn.lock',
])

const LANGUAGE_BY_EXTENSION = new Map([
  ['.bash', 'bash'],
  ['.c', 'c'],
  ['.cfg', 'ini'],
  ['.conf', 'text'],
  ['.cpp', 'cpp'],
  ['.css', 'css'],
  ['.csv', 'csv'],
  ['.env', 'shell'],
  ['.gql', 'graphql'],
  ['.graphql', 'graphql'],
  ['.h', 'c'],
  ['.hcl', 'hcl'],
  ['.html', 'html'],
  ['.ini', 'ini'],
  ['.java', 'java'],
  ['.js', 'javascript'],
  ['.json', 'json'],
  ['.jsx', 'jsx'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.md', 'markdown'],
  ['.mdx', 'mdx'],
  ['.mjs', 'javascript'],
  ['.properties', 'properties'],
  ['.proto', 'protobuf'],
  ['.ps1', 'powershell'],
  ['.py', 'python'],
  ['.rb', 'ruby'],
  ['.rs', 'rust'],
  ['.scss', 'scss'],
  ['.sh', 'bash'],
  ['.sql', 'sql'],
  ['.tf', 'hcl'],
  ['.toml', 'toml'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.txt', 'text'],
  ['.xml', 'xml'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.zsh', 'bash'],
])

const LANGUAGE_BY_NAME = new Map([
  ['.dockerignore', 'text'],
  ['.gitignore', 'text'],
  ['dockerfile', 'dockerfile'],
  ['license', 'text'],
  ['makefile', 'makefile'],
  ['notice', 'text'],
])

const SAFE_ENV_TEMPLATE_NAMES = new Set(['.env.dist', '.env.example', '.env.sample', '.env.template'])
const summaryMarkdown = new MarkdownIt({ html: false, linkify: false })

interface SampleMarker {
  schemaVersion: 1
  id?: string
  slug?: string
  language?: string
  category?: string
  categoryLabel?: string
  title?: string
  description?: string
  tags?: string[]
  notebook?: string
  prerequisites?: string[]
  run?: string[]
  content?: {
    guide?: string
    featured?: string[]
  }
}

interface NotebookCell {
  cell_type?: unknown
  source?: unknown
}

interface Notebook {
  cells?: unknown
  metadata?: unknown
}

export interface LoadManifestOptions {
  sourceDir: string
  migrationManifestPath: string
  scanLimits?: Partial<SampleScanLimits>
}

export interface LoadedManifest {
  manifest: SampleManifest
  manifestLabel: string
}

export type BuildSnapshotOptions = LoadManifestOptions

export interface SampleScanLimits {
  entriesPerSample: number
  totalEntries: number
  depth: number
}

interface ScanState {
  limits: SampleScanLimits
  totalEntries: number
  sampleEntries: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, field)
}

function stringArray(value: unknown, field: string, optional = false): string[] | undefined {
  if (value === undefined && optional) return undefined
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${field} must be an array of strings`)
  }
  return value.map((entry) => entry.trim()).filter(Boolean)
}

function parseCategory(value: unknown, index: number): SampleCategory {
  if (!isRecord(value)) throw new Error(`categories[${index}] must be an object`)
  return {
    language: requireString(value.language, `categories[${index}].language`),
    id: requireString(value.id, `categories[${index}].id`),
    label: requireString(value.label, `categories[${index}].label`),
  }
}

function parseManifestSample(value: unknown, index: number): ManifestSample {
  if (!isRecord(value)) throw new Error(`samples[${index}] must be an object`)

  const sample: ManifestSample = {
    id: normalizeRelativePath(requireString(value.id, `samples[${index}].id`), `samples[${index}].id`),
    language: requireString(value.language, `samples[${index}].language`),
    category: requireString(value.category, `samples[${index}].category`),
    title: requireString(value.title, `samples[${index}].title`),
    description: requireString(value.description, `samples[${index}].description`),
    tags: stringArray(value.tags, `samples[${index}].tags`) ?? [],
    path: normalizeRelativePath(requireString(value.path, `samples[${index}].path`), `samples[${index}].path`),
  }

  const slug = optionalString(value.slug, `samples[${index}].slug`)
  const categoryLabel = optionalString(value.categoryLabel, `samples[${index}].categoryLabel`)
  const notebook = optionalString(value.notebook, `samples[${index}].notebook`)
  const prerequisites = stringArray(value.prerequisites, `samples[${index}].prerequisites`, true)
  const run = stringArray(value.run, `samples[${index}].run`, true)

  if (slug) sample.slug = normalizeSlug(slug, `samples[${index}].slug`)
  if (categoryLabel) sample.categoryLabel = categoryLabel
  if (notebook) sample.notebook = normalizeRelativePath(notebook, `samples[${index}].notebook`)
  if (prerequisites) sample.prerequisites = prerequisites
  if (run) sample.run = run

  return sample
}

export function parseManifest(value: unknown, label: string): SampleManifest {
  if (!isRecord(value)) throw new Error(`${label} must contain a JSON object`)
  if (value.version !== 1) throw new Error(`${label}.version must be 1`)
  if (!Array.isArray(value.categories)) throw new Error(`${label}.categories must be an array`)
  if (!Array.isArray(value.samples)) throw new Error(`${label}.samples must be an array`)

  const manifest: SampleManifest = {
    version: value.version,
    categories: value.categories.map(parseCategory),
    samples: value.samples.map(parseManifestSample),
  }
  const repository = optionalString(value.repository, `${label}.repository`)
  if (repository) manifest.repository = repository
  return manifest
}

function parseMarker(value: unknown, label: string): SampleMarker {
  if (!isRecord(value)) throw new Error(`${label} must contain a YAML object`)
  if (value.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`)
  const marker: SampleMarker = { schemaVersion: 1 }

  const copyString = (
    key: keyof Pick<SampleMarker, 'id' | 'slug' | 'language' | 'category' | 'categoryLabel' | 'title' | 'notebook'>
  ) => {
    const parsed = optionalString(value[key], `${label}.${key}`)
    if (parsed) marker[key] = parsed
  }

  copyString('id')
  copyString('slug')
  copyString('language')
  copyString('category')
  copyString('categoryLabel')
  copyString('title')
  copyString('notebook')

  const description = optionalString(value.description, `${label}.description`)
  const summary = optionalString(value.summary, `${label}.summary`)
  if (description && summary && description !== summary) {
    throw new Error(`${label} cannot define different description and summary values`)
  }
  const effectiveDescription = summary ?? description
  if (effectiveDescription) marker.description = effectiveDescription

  const tags = stringArray(value.tags, `${label}.tags`, true)
  const prerequisites = stringArray(value.prerequisites, `${label}.prerequisites`, true)
  const run = stringArray(value.run, `${label}.run`, true)
  if (tags) marker.tags = tags
  if (prerequisites) marker.prerequisites = prerequisites
  if (run) marker.run = run

  if (marker.id) marker.id = normalizeRelativePath(marker.id, `${label}.id`)
  if (marker.slug) marker.slug = normalizeSlug(marker.slug, `${label}.slug`)
  if (marker.notebook) marker.notebook = normalizeRelativePath(marker.notebook, `${label}.notebook`)

  if (value.content !== undefined) {
    if (!isRecord(value.content)) throw new Error(`${label}.content must be an object`)
    const guide = optionalString(value.content.guide, `${label}.content.guide`)
    const featured = stringArray(value.content.featured, `${label}.content.featured`, true)
    const content: NonNullable<SampleMarker['content']> = {}
    if (guide) {
      const normalizedGuide = normalizeRelativePath(guide, `${label}.content.guide`)
      if (!/\.(?:ipynb|md|markdown)$/i.test(normalizedGuide)) {
        throw new Error(`${label}.content.guide must be a Markdown file or notebook`)
      }
      content.guide = normalizedGuide
    }
    if (featured) {
      content.featured = [
        ...new Set(featured.map((entry) => normalizeRelativePath(entry, `${label}.content.featured`))),
      ]
    }
    marker.content = content
  }
  return marker
}

function normalizeRelativePath(value: string, field: string): string {
  if (value.includes('\\')) throw new Error(`${field} must use forward slashes`)
  const normalized = path.posix.normalize(value.replace(/^\.\/+/, ''))
  if (
    normalized === '' ||
    normalized === '.' ||
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`${field} must stay within the samples checkout`)
  }
  return normalized
}

function normalizeSlug(value: string, field: string): string {
  const slug = normalizeRelativePath(value.replace(/^\/+|\/+$/g, ''), field)
  if (!/^[a-z0-9][a-z0-9/-]*$/.test(slug)) {
    throw new Error(`${field} may contain only lowercase letters, numbers, hyphens, and slashes`)
  }
  return slug
}

function deriveSlug(sample: ManifestSample): string {
  const segments = sample.path.split('/')
  const language = segments[0]
  if (!language) throw new Error(`Cannot derive a slug for ${sample.id}`)
  const detailSegments = segments.slice(2).map((segment) => segment.replace(/^\d+-/, ''))
  return normalizeSlug([language, ...detailSegments].join('/'), `${sample.id}.slug`)
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function displayLanguage(value: string): string {
  if (value.toLowerCase() === 'typescript') return 'TypeScript'
  if (value.toLowerCase() === 'javascript') return 'JavaScript'
  return titleCase(value)
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function normalizeText(content: string): string {
  return content.replace(/\r\n?/g, '\n')
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function boundedScanLimit(value: number | undefined, maximum: number, field: string): number {
  if (value === undefined) return maximum
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`)
  return Math.min(value, maximum)
}

function resolveScanLimits(overrides: Partial<SampleScanLimits> | undefined): SampleScanLimits {
  return {
    entriesPerSample: boundedScanLimit(
      overrides?.entriesPerSample,
      MAX_SCANNED_ENTRIES_PER_SAMPLE,
      'scanLimits.entriesPerSample'
    ),
    totalEntries: boundedScanLimit(overrides?.totalEntries, MAX_TOTAL_SCANNED_ENTRIES, 'scanLimits.totalEntries'),
    depth: boundedScanLimit(overrides?.depth, MAX_SCAN_DEPTH, 'scanLimits.depth'),
  }
}

function createScanState(options: LoadManifestOptions): ScanState {
  return {
    limits: resolveScanLimits(options.scanLimits),
    totalEntries: 0,
    sampleEntries: 0,
  }
}

function assertScanDepth(state: ScanState, depth: number, sampleId?: string): void {
  if (depth <= state.limits.depth) return
  const scope = sampleId ?? 'Samples checkout'
  throw new Error(`${scope} exceeds the ${state.limits.depth}-level scan depth limit`)
}

function recordScannedEntry(state: ScanState, sampleId?: string): void {
  state.totalEntries += 1
  if (state.totalEntries > state.limits.totalEntries) {
    throw new Error(`Samples checkout exceeds the ${state.limits.totalEntries}-entry scan limit`)
  }

  if (!sampleId) return
  state.sampleEntries += 1
  if (state.sampleEntries > state.limits.entriesPerSample) {
    throw new Error(`${sampleId} exceeds the ${state.limits.entriesPerSample}-entry scan limit`)
  }
}

function decodeText(buffer: Buffer): string | undefined {
  try {
    return normalizeText(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
  } catch {
    return undefined
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const fileStat = await stat(filePath)
  if (fileStat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`${filePath} exceeds the ${MAX_MANIFEST_BYTES}-byte manifest limit`)
  }
  const buffer = await readFile(filePath)
  if (buffer.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error(`${filePath} exceeds the ${MAX_MANIFEST_BYTES}-byte manifest limit`)
  }
  const content = decodeText(buffer)
  if (content === undefined) throw new Error(`${filePath} must contain valid UTF-8 text`)
  return JSON.parse(content) as unknown
}

async function readScannedDirectory(
  directory: string,
  scanState: ScanState,
  sampleId: string,
  depth: number
): Promise<Dirent[]> {
  assertScanDepth(scanState, depth, sampleId)
  const entries: Dirent[] = []
  const directoryHandle = await opendir(directory)
  for await (const entry of directoryHandle) {
    recordScannedEntry(scanState, sampleId)
    entries.push(entry)
  }
  return entries.sort((a, b) => compareText(a.name, b.name))
}

async function findMarkerPaths(sourceDir: string, scanState: ScanState): Promise<string[]> {
  const markers: string[] = []

  async function walk(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    assertScanDepth(scanState, depth)
    const directoryHandle = await opendir(directory)
    for await (const entry of directoryHandle) {
      recordScannedEntry(scanState)
      if (entry.isSymbolicLink()) continue
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !MARKER_SCAN_SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) {
          await walk(absolutePath, relativePath, depth + 1)
        }
      } else if (entry.isFile() && entry.name === 'example.yaml') {
        markers.push(relativePath)
      }
    }
  }

  await walk(sourceDir, '', 0)
  return markers.sort(compareText)
}

async function applyMarkers(
  manifest: SampleManifest,
  sourceDir: string,
  scanState: ScanState
): Promise<SampleManifest> {
  const samples = manifest.samples.map((sample) => ({ ...sample }))
  const categories = manifest.categories.map((category) => ({ ...category }))
  const markers = await findMarkerPaths(sourceDir, scanState)

  for (const markerPath of markers) {
    const absoluteMarkerPath = path.join(sourceDir, ...markerPath.split('/'))
    const markerStat = await stat(absoluteMarkerPath)
    if (markerStat.size > MAX_MARKER_BYTES) {
      throw new Error(`${markerPath} exceeds the ${MAX_MARKER_BYTES}-byte marker limit`)
    }
    const marker = parseMarker(
      parseYaml(await readFile(absoluteMarkerPath, 'utf8'), { schema: JSON_SCHEMA }),
      markerPath
    )
    const samplePath = path.posix.dirname(markerPath)
    const existingIndex = samples.findIndex((sample) => sample.path === samplePath)

    if (existingIndex >= 0) {
      const existing = samples[existingIndex]
      if (!existing) throw new Error(`Could not resolve manifest entry for ${markerPath}`)
      if (marker.id && marker.id !== existing.id) {
        throw new Error(`${markerPath}.id cannot change immutable id ${existing.id}`)
      }
      const existingSlug = existing.slug ?? deriveSlug(existing)
      if (marker.slug && marker.slug !== existingSlug) {
        throw new Error(`${markerPath}.slug cannot change immutable slug ${existingSlug}`)
      }
      if (marker.language && marker.language !== existing.language) {
        throw new Error(`${markerPath}.language cannot change immutable language ${existing.language}`)
      }
      if (marker.category && marker.category !== existing.category) {
        throw new Error(`${markerPath}.category cannot change immutable category ${existing.category}`)
      }

      const updated: ManifestSample = { ...existing }
      if (marker.slug) updated.slug = marker.slug
      if (marker.categoryLabel) updated.categoryLabel = marker.categoryLabel
      if (marker.title) updated.title = marker.title
      if (marker.description) updated.description = marker.description
      if (marker.tags) updated.tags = marker.tags
      if (marker.notebook) updated.notebook = marker.notebook
      if (marker.prerequisites) updated.prerequisites = marker.prerequisites
      if (marker.run) updated.run = marker.run
      if (marker.content?.guide) updated.guide = marker.content.guide
      if (marker.content?.featured) updated.featured = marker.content.featured
      samples[existingIndex] = updated
      continue
    }

    if (!marker.id || !marker.slug) {
      throw new Error(`${markerPath} adds a sample, so immutable id and slug are required`)
    }
    if (!marker.title || !marker.description) {
      throw new Error(`${markerPath} adds a sample, so non-empty title and summary are required`)
    }
    if (samples.some((sample) => sample.id === marker.id)) {
      throw new Error(`${markerPath}.id duplicates existing sample ${marker.id}`)
    }
    if (samples.some((sample) => (sample.slug ?? deriveSlug(sample)) === marker.slug)) {
      throw new Error(`${markerPath}.slug duplicates existing slug ${marker.slug}`)
    }

    const pathSegments = samplePath.split('/')
    const language = marker.language ?? pathSegments[0]
    const category = marker.category ?? pathSegments[1]?.replace(/^\d+-/, '')
    if (!language || !category) {
      throw new Error(`${markerPath} must be nested beneath language and category directories`)
    }
    const categoryLabel =
      marker.categoryLabel ??
      categories.find((candidate) => candidate.language === language && candidate.id === category)?.label ??
      titleCase(category)
    const added: ManifestSample = {
      id: marker.id,
      slug: marker.slug,
      language,
      category,
      categoryLabel,
      title: marker.title,
      description: marker.description,
      tags: marker.tags ?? [],
      path: samplePath,
    }
    if (marker.notebook) added.notebook = marker.notebook
    if (marker.prerequisites) added.prerequisites = marker.prerequisites
    if (marker.run) added.run = marker.run
    if (marker.content?.guide) added.guide = marker.content.guide
    if (marker.content?.featured) added.featured = marker.content.featured
    samples.push(added)

    if (!categories.some((candidate) => candidate.language === language && candidate.id === category)) {
      categories.push({ language, id: category, label: categoryLabel })
    }
  }

  const merged: SampleManifest = {
    version: manifest.version,
    categories,
    samples,
  }
  if (manifest.repository) merged.repository = manifest.repository
  return merged
}

async function loadManifestWithScan(options: LoadManifestOptions, scanState: ScanState): Promise<LoadedManifest> {
  const sourceManifestPath = path.join(options.sourceDir, 'samples.json')
  let manifestPath = sourceManifestPath
  let manifestLabel = 'samples.json'

  try {
    const sourceManifestStat = await lstat(sourceManifestPath)
    if (sourceManifestStat.isSymbolicLink() || !sourceManifestStat.isFile()) {
      throw new Error(`${sourceManifestPath} must be a regular file, not a symlink`)
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      manifestPath = options.migrationManifestPath
      manifestLabel = 'site/src/data/samples.json'
    } else {
      throw error
    }
  }

  const manifest = parseManifest(await readJsonFile(manifestPath), manifestLabel)
  return {
    manifest: await applyMarkers(manifest, options.sourceDir, scanState),
    manifestLabel,
  }
}

export async function loadManifest(options: LoadManifestOptions): Promise<LoadedManifest> {
  return loadManifestWithScan(options, createScanState(options))
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

async function readGitCommit(sourceDir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', sourceDir, 'rev-parse', 'HEAD^{commit}'], {
    encoding: 'utf8',
  })
  const commit = stdout.trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Could not resolve a full git commit SHA for ${sourceDir}`)
  }
  return commit
}

export async function resolveGitCommit(sourceDir: string): Promise<string> {
  const commit = await readGitCommit(sourceDir)
  const { stdout: status } = await execFileAsync(
    'git',
    [
      '-C',
      sourceDir,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored=matching',
      '--ignore-submodules=none',
    ],
    { encoding: 'utf8' }
  )
  if (status.trim()) {
    throw new Error('Samples checkout must be clean before import; commit or remove local changes.')
  }

  const verifiedCommit = await readGitCommit(sourceDir)
  if (verifiedCommit !== commit) {
    throw new Error('Samples checkout changed commits while the import was starting; retry the build.')
  }
  return commit
}

async function assertSampleDirectory(sourceDir: string, samplePath: string): Promise<string> {
  const segments = samplePath.split('/')
  let currentPath = sourceDir
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment)
    const currentStat = await lstat(currentPath)
    if (currentStat.isSymbolicLink()) throw new Error(`${samplePath} traverses the symlink ${segment}`)
  }

  const sampleStat = await stat(currentPath)
  if (!sampleStat.isDirectory()) throw new Error(`${samplePath} is not a sample directory`)

  const [sourceRealPath, sampleRealPath] = await Promise.all([realpath(sourceDir), realpath(currentPath)])
  if (sampleRealPath !== sourceRealPath && !sampleRealPath.startsWith(`${sourceRealPath}${path.sep}`)) {
    throw new Error(`${samplePath} resolves outside the samples checkout`)
  }
  return currentPath
}

async function readSafeSampleFile(
  sampleRoot: string,
  relativePath: string,
  maximumBytes: number
): Promise<string | undefined> {
  const normalized = normalizeRelativePath(relativePath, relativePath)
  let currentPath = sampleRoot
  for (const segment of normalized.split('/')) {
    currentPath = path.join(currentPath, segment)
    let currentStat
    try {
      currentStat = await lstat(currentPath)
    } catch (error) {
      if (isMissingPathError(error)) return undefined
      throw error
    }
    if (currentStat.isSymbolicLink()) return undefined
  }

  const fileStat = await stat(currentPath)
  if (!fileStat.isFile() || fileStat.size > maximumBytes) return undefined
  const buffer = await readFile(currentPath)
  if (buffer.byteLength > maximumBytes) return undefined
  return decodeText(buffer)
}

function notebookCellSource(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join('')
  return ''
}

function notebookLanguage(notebook: Notebook, fallbackLanguage: string): string {
  if (isRecord(notebook.metadata)) {
    const languageInfo = notebook.metadata.language_info
    if (isRecord(languageInfo) && typeof languageInfo.name === 'string' && languageInfo.name.trim()) {
      return languageInfo.name.trim().toLowerCase()
    }
    const kernelSpec = notebook.metadata.kernelspec
    if (isRecord(kernelSpec) && typeof kernelSpec.language === 'string' && kernelSpec.language.trim()) {
      return kernelSpec.language.trim().toLowerCase()
    }
  }
  return fallbackLanguage.toLowerCase()
}

function codeFence(content: string): string {
  const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0]?.length ?? 0))
  return '`'.repeat(Math.max(3, longestRun + 1))
}

export function renderNotebook(notebook: unknown, fallbackLanguage: string): string {
  if (!isRecord(notebook) || !Array.isArray(notebook.cells)) {
    throw new Error('Notebook must contain a cells array')
  }

  const language = notebookLanguage(notebook, fallbackLanguage)
  const rendered: string[] = []
  for (const value of notebook.cells) {
    if (!isRecord(value)) continue
    const cell = value as NotebookCell
    const source = normalizeText(notebookCellSource(cell.source)).trimEnd()
    if (!source.trim()) continue

    if (cell.cell_type === 'markdown') {
      rendered.push(source)
    } else if (cell.cell_type === 'code') {
      const fence = codeFence(source)
      rendered.push(`${fence}${language}\n${source}\n${fence}`)
    }
  }
  return `${rendered.join('\n\n')}\n`
}

async function guideFromPath(
  sampleRoot: string,
  guidePath: string,
  sampleLanguage: string
): Promise<SampleGuide | undefined> {
  const guideSegments = guidePath.toLowerCase().split('/')
  if (
    isSecretLike(guidePath) ||
    guideSegments.some((segment) => SKIPPED_DIRECTORIES.has(segment) || segment.startsWith('.'))
  ) {
    return undefined
  }

  if (guidePath.toLowerCase().endsWith('.ipynb')) {
    const notebookSource = await readSafeSampleFile(sampleRoot, guidePath, MAX_NOTEBOOK_BYTES)
    if (notebookSource === undefined) return undefined
    let notebook: unknown
    try {
      notebook = JSON.parse(notebookSource) as unknown
    } catch {
      return undefined
    }
    const markdown = renderNotebook(notebook, sampleLanguage)
    if (!markdown.trim()) return undefined
    return {
      path: guidePath,
      kind: 'notebook',
      format: 'markdown',
      markdown,
      sha256: sha256(markdown),
    }
  }

  const markdown = await readSafeSampleFile(sampleRoot, guidePath, MAX_FILE_BYTES)
  if (markdown === undefined) return undefined
  return {
    path: guidePath,
    kind: 'readme',
    format: 'markdown',
    markdown,
    sha256: sha256(markdown),
  }
}

async function chooseGuide(sampleRoot: string, sample: ManifestSample, scanState: ScanState): Promise<SampleGuide> {
  if (sample.guide) {
    const configuredGuide = await guideFromPath(sampleRoot, sample.guide, sample.language)
    if (!configuredGuide) throw new Error(`${sample.id} configured guide ${sample.guide} is missing or invalid`)
    return configuredGuide
  }

  const rootEntries = await readScannedDirectory(sampleRoot, scanState, sample.id, 0)
  const readmeNames = rootEntries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^readme(?:\.md|\.markdown)?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => {
      if (a === 'README.md') return -1
      if (b === 'README.md') return 1
      return compareText(a, b)
    })

  for (const readmePath of readmeNames) {
    const readme = await guideFromPath(sampleRoot, readmePath, sample.language)
    if (readme) return readme
  }

  const notebookPaths = [
    ...(sample.notebook ? [sample.notebook] : []),
    ...rootEntries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith('.ipynb'))
      .map((entry) => entry.name),
  ].filter((value, index, values) => values.indexOf(value) === index)

  for (const notebookPath of notebookPaths) {
    const notebook = await guideFromPath(sampleRoot, notebookPath, sample.language)
    if (notebook) return notebook
  }

  const markdown = `# ${sample.title}\n\n${sample.description}\n`
  return {
    path: '',
    kind: 'generated',
    format: 'markdown',
    markdown,
    sha256: sha256(markdown),
  }
}

function isSecretLike(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split('/')
  return segments.some((segment) => {
    if (SAFE_ENV_TEMPLATE_NAMES.has(segment)) return false
    const stem = segment.replace(/\.[^.]+$/, '')
    return (
      segment === '.aws' ||
      segment === '.env' ||
      segment.startsWith('.env.') ||
      segment === 'id_ed25519' ||
      segment === 'id_rsa' ||
      segment.endsWith('.key') ||
      segment.endsWith('.pem') ||
      /(?:^|[-_.])(credential|credentials|secret|secrets|token|tokens)(?:$|[-_.])/.test(stem)
    )
  })
}

function isLockFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase()
  return LOCK_FILES.has(lowerName) || lowerName.endsWith('.lock')
}

function isGeneratedFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase()
  return lowerName.endsWith('.map') || lowerName.includes('.generated.') || lowerName.endsWith('.min.js')
}

function fileLanguage(fileName: string): string | undefined {
  const lowerName = fileName.toLowerCase()
  if (SAFE_ENV_TEMPLATE_NAMES.has(lowerName)) return 'shell'
  return LANGUAGE_BY_NAME.get(lowerName) ?? LANGUAGE_BY_EXTENSION.get(path.extname(lowerName))
}

async function collectFiles(
  sampleRoot: string,
  guidePath: string,
  featuredPaths: string[],
  sampleId: string,
  scanState: ScanState
): Promise<{
  files: SampleFile[]
  skippedFileCount: number
}> {
  const candidates: Array<{ path: string; absolutePath: string; language: string }> = []
  let skippedFileCount = 0

  async function walk(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    assertScanDepth(scanState, depth, sampleId)
    const directoryHandle = await opendir(directory)
    for await (const entry of directoryHandle) {
      recordScannedEntry(scanState, sampleId)
      const absolutePath = path.join(directory, entry.name)
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const lowerName = entry.name.toLowerCase()

      if (entry.isSymbolicLink()) {
        skippedFileCount += 1
        continue
      }
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(lowerName) || lowerName.startsWith('.')) {
          skippedFileCount += 1
        } else {
          await walk(absolutePath, relativePath, depth + 1)
        }
        continue
      }
      if (!entry.isFile()) {
        skippedFileCount += 1
        continue
      }
      if (relativePath === guidePath || entry.name === 'example.yaml') continue
      if (
        lowerName.endsWith('.ipynb') ||
        isSecretLike(relativePath) ||
        isLockFile(entry.name) ||
        isGeneratedFile(entry.name)
      ) {
        skippedFileCount += 1
        continue
      }

      const language = fileLanguage(entry.name)
      if (
        !language ||
        (entry.name.startsWith('.') && !LANGUAGE_BY_NAME.has(lowerName) && !SAFE_ENV_TEMPLATE_NAMES.has(lowerName))
      ) {
        skippedFileCount += 1
        continue
      }

      const fileStat = await stat(absolutePath)
      if (fileStat.size > MAX_FILE_BYTES) {
        skippedFileCount += 1
        continue
      }
      candidates.push({ path: relativePath, absolutePath, language })
    }
  }

  await walk(sampleRoot, '', 0)
  candidates.sort((a, b) => compareText(a.path, b.path))

  const candidateByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]))
  const prioritized: Array<{ path: string; absolutePath: string; language: string }> = []
  const prioritizedPaths = new Set<string>()
  for (const featuredPath of featuredPaths) {
    const candidate = candidateByPath.get(featuredPath)
    if (candidate && !prioritizedPaths.has(candidate.path)) {
      prioritized.push(candidate)
      prioritizedPaths.add(candidate.path)
    }
  }
  for (const candidate of candidates) {
    if (!prioritizedPaths.has(candidate.path)) prioritized.push(candidate)
  }

  const files: SampleFile[] = []
  for (const candidate of prioritized) {
    if (files.length >= MAX_FILES_PER_SAMPLE) {
      skippedFileCount += 1
      continue
    }
    const buffer = await readFile(candidate.absolutePath)
    const content = buffer.byteLength <= MAX_FILE_BYTES ? decodeText(buffer) : undefined
    if (content === undefined) {
      skippedFileCount += 1
      continue
    }
    files.push({
      path: candidate.path,
      language: candidate.language,
      content,
      sha256: sha256(content),
    })
  }

  files.sort((a, b) => compareText(a.path, b.path))
  return { files, skippedFileCount }
}

function validateUniqueManifestEntries(samples: ManifestSample[]): void {
  const ids = new Set<string>()
  const slugs = new Set<string>()
  const paths = new Set<string>()
  for (const sample of samples) {
    if (ids.has(sample.id)) throw new Error(`Duplicate sample id: ${sample.id}`)
    ids.add(sample.id)
    if (paths.has(sample.path)) throw new Error(`Duplicate sample path: ${sample.path}`)
    paths.add(sample.path)
    const slug = sample.slug ?? deriveSlug(sample)
    if (slugs.has(slug)) throw new Error(`Duplicate sample slug: ${slug}`)
    slugs.add(slug)
  }
}

function validateManifestCategories(categories: SampleCategory[], samples: ManifestSample[]): void {
  const categoryKeys = new Set<string>()
  for (const category of categories) {
    const key = `${category.language.toLowerCase()}:${category.id}`
    if (categoryKeys.has(key)) {
      throw new Error(`Duplicate sample category: ${category.language}/${category.id}`)
    }
    categoryKeys.add(key)
  }

  for (const sample of samples) {
    const key = `${sample.language.toLowerCase()}:${sample.category}`
    if (!categoryKeys.has(key)) {
      throw new Error(`${sample.id} references missing category ${sample.language}/${sample.category}`)
    }
  }
}

function plainInlineText(token: { children?: Array<{ type: string; content: string }> | null }): string {
  return (token.children ?? [])
    .filter((child) => child.type !== 'image')
    .map((child) => child.content)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateSummary(summary: string): string {
  const maximumLength = 240
  if (summary.length <= maximumLength) return summary
  const candidate = summary.slice(0, maximumLength - 3)
  const boundary = candidate.lastIndexOf(' ')
  return `${candidate.slice(0, boundary > 120 ? boundary : candidate.length).trimEnd()}...`
}

function summaryFromGuide(markdown: string): string | undefined {
  const tokens = summaryMarkdown.parse(markdown, {})
  let blockquoteDepth = 0

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token) continue
    if (token.type === 'blockquote_open') {
      blockquoteDepth += 1
      continue
    }
    if (token.type === 'blockquote_close') {
      blockquoteDepth = Math.max(0, blockquoteDepth - 1)
      continue
    }
    if (blockquoteDepth > 0 || token.type !== 'inline' || tokens[index - 1]?.type !== 'paragraph_open') continue

    const text = plainInlineText(token)
    if (text.length >= 40) return truncateSummary(text)
  }
  return undefined
}

export function prepareSampleSummary(summary: string, guideMarkdown: string): string {
  const normalized = summary.replace(/\s+/g, ' ').trim()
  const hasMarkdownArtifact = /^(?:>|#)|\[![A-Z]+\]/.test(normalized)
  const appearsTruncated = normalized.length >= 200 && !/[.!?…)"'\]]$/.test(normalized)
  if (!hasMarkdownArtifact && !appearsTruncated) return normalized
  return summaryFromGuide(guideMarkdown) ?? truncateSummary(normalized)
}

async function buildSample(
  sourceDir: string,
  repository: string,
  commit: string,
  categories: SampleCategory[],
  sample: ManifestSample,
  scanState: ScanState
): Promise<SampleDetail> {
  const sampleRoot = await assertSampleDirectory(sourceDir, sample.path)
  const guide = await chooseGuide(sampleRoot, sample, scanState)
  const { files, skippedFileCount } = await collectFiles(
    sampleRoot,
    guide.path,
    sample.featured ?? [],
    sample.id,
    scanState
  )
  const categoryLabel =
    sample.categoryLabel ??
    categories.find((candidate) => candidate.language === sample.language && candidate.id === sample.category)?.label ??
    titleCase(sample.category)

  const metadata: SampleDetail['metadata'] = {
    title: sample.title,
    summary: prepareSampleSummary(sample.description, guide.markdown),
    language: displayLanguage(sample.language),
    category: sample.category,
    categoryLabel,
    tags: [...sample.tags].sort(compareText),
    prerequisites: sample.prerequisites ? [...sample.prerequisites] : [],
  }
  if (sample.run) metadata.run = [...sample.run]

  return {
    id: sample.id,
    slug: sample.slug ?? deriveSlug(sample),
    source: {
      repository,
      commit,
      path: sample.path,
    },
    metadata,
    guide,
    files,
    skippedFileCount,
  }
}

export async function buildSampleSnapshot(options: BuildSnapshotOptions): Promise<SampleSnapshot> {
  const scanState = createScanState(options)
  const commit = await resolveGitCommit(options.sourceDir)
  const { manifest, manifestLabel } = await loadManifestWithScan(options, scanState)
  validateUniqueManifestEntries(manifest.samples)
  validateManifestCategories(manifest.categories, manifest.samples)
  const repository = manifest.repository ?? DEFAULT_REPOSITORY
  const samples: SampleDetail[] = []
  let embeddedBytes = 0

  for (const sample of [...manifest.samples].sort((a, b) => compareText(a.id, b.id))) {
    scanState.sampleEntries = 0
    const builtSample = await buildSample(options.sourceDir, repository, commit, manifest.categories, sample, scanState)
    embeddedBytes +=
      Buffer.byteLength(builtSample.guide.markdown) +
      builtSample.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0)
    if (embeddedBytes > MAX_TOTAL_EMBEDDED_BYTES) {
      throw new Error(`Samples content exceeds the ${MAX_TOTAL_EMBEDDED_BYTES}-byte embedded content limit`)
    }
    samples.push(builtSample)
  }

  const verifiedCommit = await resolveGitCommit(options.sourceDir)
  if (verifiedCommit !== commit) {
    throw new Error('Samples checkout changed commits during import; retry the build.')
  }

  const fileCount = samples.reduce((total, sample) => total + sample.files.length, 0)
  const skippedFileCount = samples.reduce((total, sample) => total + sample.skippedFileCount, 0)
  return {
    schemaVersion: 2,
    source: {
      repository,
      commit,
      manifest: manifestLabel,
    },
    categories: manifest.categories,
    stats: {
      sampleCount: samples.length,
      fileCount,
      skippedFileCount,
    },
    samples,
  }
}
