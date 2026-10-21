import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Root, RootContent } from 'mdast'
import { toString } from 'mdast-util-to-string'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import TurndownService from 'turndown'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import type {
  BuildSampleGuidesOptions,
  ManifestSample,
  SampleCategory,
  SampleGuideBuild,
  SampleManifest,
} from './types'

const execFileAsync = promisify(execFile)

export const DEFAULT_REPOSITORY = 'strands-agents/samples'
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
export const MAX_GUIDE_BYTES = 2 * 1024 * 1024

const htmlConverter = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})
htmlConverter.remove(['script', 'style', 'iframe', 'object', 'embed', 'form'])
htmlConverter.addRule('sampleBreak', {
  filter: 'br',
  replacement: () => ' ',
})
htmlConverter.addRule('sampleVideo', {
  filter: 'video',
  replacement: (_content, node) => {
    const element = node as Element
    const src = element.getAttribute('src') ?? element.querySelector('source')?.getAttribute('src')
    return src?.trim() ? `\n\n[Watch the sample video](${src.trim()})\n\n` : ''
  },
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, field)
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`${field} must be an array of strings`)
  }
  return value.map((entry) => entry.trim()).filter(Boolean)
}

function normalizeRelativePath(value: string, field: string): string {
  if (value.includes('\\')) throw new Error(`${field} must use forward slashes`)
  const normalized = path.posix.normalize(value.replace(/^\.\/+/, ''))
  if (
    normalized === '' ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
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

function parseCategory(value: unknown, index: number): SampleCategory {
  if (!isRecord(value)) throw new Error(`categories[${index}] must be an object`)
  return {
    language: requiredString(value.language, `categories[${index}].language`),
    id: requiredString(value.id, `categories[${index}].id`),
    label: requiredString(value.label, `categories[${index}].label`),
  }
}

function parseSample(value: unknown, index: number): ManifestSample {
  if (!isRecord(value)) throw new Error(`samples[${index}] must be an object`)
  const sample: ManifestSample = {
    id: normalizeRelativePath(requiredString(value.id, `samples[${index}].id`), `samples[${index}].id`),
    language: requiredString(value.language, `samples[${index}].language`),
    category: requiredString(value.category, `samples[${index}].category`),
    title: requiredString(value.title, `samples[${index}].title`),
    description: requiredString(value.description, `samples[${index}].description`),
    tags: stringArray(value.tags, `samples[${index}].tags`),
    path: normalizeRelativePath(requiredString(value.path, `samples[${index}].path`), `samples[${index}].path`),
  }
  const slug = optionalString(value.slug, `samples[${index}].slug`)
  const categoryLabel = optionalString(value.categoryLabel, `samples[${index}].categoryLabel`)
  const notebook = optionalString(value.notebook, `samples[${index}].notebook`)
  if (slug) sample.slug = normalizeSlug(slug, `samples[${index}].slug`)
  if (categoryLabel) sample.categoryLabel = categoryLabel
  if (notebook) {
    sample.notebook = normalizeRelativePath(notebook, `samples[${index}].notebook`)
  }
  return sample
}

export function parseManifest(value: unknown): SampleManifest {
  if (!isRecord(value)) throw new Error('samples.json must contain an object')
  if (value.version !== 1) throw new Error('samples.json.version must be 1')
  if (!Array.isArray(value.categories)) throw new Error('samples.json.categories must be an array')
  if (!Array.isArray(value.samples)) throw new Error('samples.json.samples must be an array')
  return {
    version: 1,
    repository: optionalString(value.repository, 'samples.json.repository'),
    categories: value.categories.map(parseCategory),
    samples: value.samples.map(parseSample),
  }
}

function deriveSlug(sample: ManifestSample): string {
  if (sample.slug) return sample.slug
  const segments = sample.path.split('/')
  const language = segments[0]
  if (!language) throw new Error(`Cannot derive a slug for ${sample.id}`)
  return normalizeSlug(
    [language, ...segments.slice(2).map((segment) => segment.replace(/^\d+-/, ''))].join('/'),
    `${sample.id}.slug`
  )
}

function validateManifest(manifest: SampleManifest): void {
  const categories = new Set<string>()
  for (const category of manifest.categories) {
    const key = `${category.language.toLowerCase()}/${category.id}`
    if (categories.has(key)) throw new Error(`Duplicate sample category: ${key}`)
    categories.add(key)
  }

  const ids = new Set<string>()
  const slugs = new Set<string>()
  for (const sample of manifest.samples) {
    if (ids.has(sample.id)) throw new Error(`Duplicate sample id: ${sample.id}`)
    ids.add(sample.id)
    const slug = deriveSlug(sample)
    if (slugs.has(slug)) throw new Error(`Duplicate sample slug: ${slug}`)
    slugs.add(slug)
    const category = `${sample.language.toLowerCase()}/${sample.category}`
    if (!categories.has(category)) throw new Error(`${sample.id} references unknown category ${category}`)
  }
}

async function readTextFile(filePath: string, maximumBytes: number): Promise<string> {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) throw new Error(`${filePath} must be a regular file`)
  if (fileStat.size > maximumBytes) throw new Error(`${filePath} exceeds ${maximumBytes} bytes`)
  const buffer = await readFile(filePath)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/\r\n?/g, '\n')
  } catch {
    throw new Error(`${filePath} is not valid UTF-8`)
  }
}

async function readManifest(sourceDir: string): Promise<SampleManifest> {
  const manifestPath = path.join(sourceDir, 'samples.json')
  if ((await lstat(manifestPath)).isSymbolicLink()) throw new Error('samples.json must not be a symlink')
  const manifest = parseManifest(JSON.parse(await readTextFile(manifestPath, MAX_MANIFEST_BYTES)) as unknown)
  validateManifest(manifest)
  return manifest
}

async function gitOutput(sourceDir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: sourceDir, encoding: 'utf8' })
    return stdout.trim()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not inspect samples checkout: ${message}`)
  }
}

async function inspectCheckout(sourceDir: string): Promise<string> {
  const status = await gitOutput(sourceDir, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status) throw new Error('Samples checkout must be clean before it can be published')
  return gitOutput(sourceDir, ['rev-parse', 'HEAD'])
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function resolveGuidePath(sourceDir: string, sample: ManifestSample): Promise<{ path: string; kind: string }> {
  const sourceRoot = await realpath(sourceDir)
  const sampleRoot = await realpath(path.join(sourceRoot, sample.path))
  if (!isInside(sourceRoot, sampleRoot)) throw new Error(`${sample.id} resolves outside the samples checkout`)

  const readme = path.join(sampleRoot, 'README.md')
  try {
    if (!(await lstat(readme)).isSymbolicLink()) return { path: 'README.md', kind: 'readme' }
  } catch {
    // Fall through to the configured notebook.
  }

  if (!sample.notebook) throw new Error(`${sample.id} has no root README.md or configured notebook`)
  const notebook = await realpath(path.join(sampleRoot, sample.notebook))
  if (!isInside(sampleRoot, notebook)) throw new Error(`${sample.id} notebook resolves outside its sample directory`)
  if ((await lstat(path.join(sampleRoot, sample.notebook))).isSymbolicLink()) {
    throw new Error(`${sample.id} notebook must not be a symlink`)
  }
  return { path: sample.notebook, kind: 'notebook' }
}

function notebookSource(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((line) => typeof line === 'string')) return value.join('')
  return ''
}

function codeFence(content: string): string {
  const longest = Math.max(2, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length))
  return '`'.repeat(longest + 1)
}

export function renderNotebook(value: unknown, fallbackLanguage: string): string {
  if (!isRecord(value) || !Array.isArray(value.cells)) throw new Error('Notebook must contain a cells array')
  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const languageInfo = isRecord(metadata.language_info) ? metadata.language_info : {}
  const language =
    typeof languageInfo.name === 'string' && languageInfo.name.trim() ? languageInfo.name.trim() : fallbackLanguage
  const sections: string[] = []

  for (const cell of value.cells) {
    if (!isRecord(cell)) continue
    const source = notebookSource(cell.source).trim()
    if (!source) continue
    if (cell.cell_type === 'markdown') {
      sections.push(source)
    } else if (cell.cell_type === 'code') {
      const fence = codeFence(source)
      sections.push(`${fence}${language}\n${source}\n${fence}`)
    }
  }
  return sections.join('\n\n')
}

function splitUrl(value: string): { pathname: string; suffix: string } {
  const index = value.search(/[?#]/)
  return index === -1
    ? { pathname: value, suffix: '' }
    : { pathname: value.slice(0, index), suffix: value.slice(index) }
}

function externalUrl(value: string, image: boolean): string | undefined {
  if (value.startsWith('//')) return `https:${value}`
  const match = value.match(/^([a-z][a-z0-9+.-]*):/i)
  if (!match) return undefined
  const scheme = match[1]!.toLowerCase()
  const allowed = image ? scheme === 'http' || scheme === 'https' : ['http', 'https', 'mailto'].includes(scheme)
  if (!allowed) throw new Error(`Sample guide contains an unsafe ${scheme}: URL`)
  return value
}

function encodeRepositoryPath(value: string): string {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

async function repositoryUrl(
  sourceDir: string,
  repository: string,
  commit: string,
  guideRepositoryPath: string,
  value: string,
  image: boolean
): Promise<string> {
  if (!value || value.startsWith('#') || value.startsWith('/')) return value
  const external = externalUrl(value, image)
  if (external) return external
  const { pathname, suffix } = splitUrl(value)
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return `https://github.com/${repository}/tree/${commit}`
  }
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(guideRepositoryPath), decodedPath))
  if (target === '..' || target.startsWith('../') || path.posix.isAbsolute(target)) {
    return `https://github.com/${repository}/tree/${commit}`
  }
  const encoded = encodeRepositoryPath(target)
  let targetStat
  try {
    targetStat = await stat(path.join(sourceDir, target))
  } catch {
    if (image) throw new Error(`${guideRepositoryPath} links to missing relative image ${value}`)
    console.warn(`${guideRepositoryPath} links to missing relative target ${value}; keeping a pinned GitHub link`)
    return `https://github.com/${repository}/blob/${commit}/${encoded}${suffix}`
  }
  if (image) {
    if (!targetStat.isFile()) throw new Error(`${guideRepositoryPath} uses a directory as an image: ${value}`)
    return `https://raw.githubusercontent.com/${repository}/${commit}/${encoded}${suffix}`
  }
  const kind = targetStat.isDirectory() ? 'tree' : 'blob'
  return `https://github.com/${repository}/${kind}/${commit}/${encoded}${suffix}`
}

function convertEmbeddedHtml(tree: Root, processor: ReturnType<typeof unified>): Root {
  visit(tree, 'html', (node) => {
    node.value = /^<br\s*\/?>$/i.test(node.value.trim()) ? ' ' : htmlConverter.turndown(node.value)
  })
  return processor.parse(processor.stringify(tree)) as Root
}

function removeRemainingHtml(tree: Root): void {
  const clean = (node: { children?: RootContent[] }) => {
    if (!node.children) return
    node.children = node.children.filter((child) => child.type !== 'html')
    for (const child of node.children) clean(child as { children?: RootContent[] })
  }
  clean(tree)
}

function normalizedHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function containsOnlyImages(node: RootContent): boolean {
  if (node.type === 'image' || node.type === 'imageReference') return true
  if (node.type !== 'paragraph' && node.type !== 'link' && node.type !== 'linkReference') return false
  return node.children.length > 0 && node.children.every((child) => containsOnlyImages(child as RootContent))
}

function isDecorativeLead(node: RootContent): boolean {
  return node.type === 'html' || node.type === 'thematicBreak' || containsOnlyImages(node)
}

async function prepareMarkdown(
  markdown: string,
  sourceDir: string,
  repository: string,
  commit: string,
  guideRepositoryPath: string,
  title: string
): Promise<string> {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify, {
    bullet: '-',
    fences: true,
    listItemIndent: 'one',
  })
  const tree = convertEmbeddedHtml(processor.parse(markdown) as Root, processor)
  const firstHeading = tree.children.findIndex((node) => node.type === 'heading' && node.depth === 1)
  if (firstHeading !== -1) {
    const heading = tree.children[firstHeading]!
    const isSourceTitle =
      tree.children.slice(0, firstHeading).every(isDecorativeLead) ||
      normalizedHeading(toString(heading)) === normalizedHeading(title)
    if (isSourceTitle) tree.children.splice(firstHeading, 1)
  }
  visit(tree, 'heading', (node) => {
    if (node.depth === 1) node.depth = 2
  })
  removeRemainingHtml(tree)

  const links: Array<{ node: { url: string }; image: boolean }> = []
  const imageDefinitions = new Set<string>()
  visit(tree, 'imageReference', (node) => {
    imageDefinitions.add(node.identifier.toLowerCase())
  })
  visit(tree, 'link', (node) => {
    links.push({ node, image: false })
  })
  visit(tree, 'image', (node) => {
    links.push({ node, image: true })
  })
  visit(tree, 'definition', (node) => {
    links.push({ node, image: imageDefinitions.has(node.identifier.toLowerCase()) })
  })
  visit(tree, 'code', (node) => {
    if (node.lang) node.lang = node.lang.toLowerCase()
  })
  for (const link of links) {
    link.node.url = await repositoryUrl(sourceDir, repository, commit, guideRepositoryPath, link.node.url, link.image)
  }
  return processor.stringify(tree).trim()
}

function categoryLabel(manifest: SampleManifest, sample: ManifestSample): string {
  if (sample.categoryLabel) return sample.categoryLabel
  return (
    manifest.categories.find(
      (category) => category.language.toLowerCase() === sample.language.toLowerCase() && category.id === sample.category
    )?.label ?? sample.category
  )
}

function frontmatter(
  manifest: SampleManifest,
  sample: ManifestSample,
  repository: string,
  commit: string,
  guidePath: string,
  guideKind: string,
  order: number
): string {
  const categoryOrder = manifest.categories.findIndex(
    (category) => category.language.toLowerCase() === sample.language.toLowerCase() && category.id === sample.category
  )
  return [
    '---',
    `title: ${JSON.stringify(sample.title)}`,
    `description: ${JSON.stringify(sample.description)}`,
    `sampleId: ${JSON.stringify(sample.id)}`,
    `slug: ${JSON.stringify(deriveSlug(sample))}`,
    `language: ${JSON.stringify(sample.language)}`,
    `category: ${JSON.stringify(sample.category)}`,
    `categoryLabel: ${JSON.stringify(categoryLabel(manifest, sample))}`,
    `tags: ${JSON.stringify(sample.tags ?? [])}`,
    `sourceRepository: ${JSON.stringify(repository)}`,
    `sourceCommit: ${JSON.stringify(commit)}`,
    `sourcePath: ${JSON.stringify(sample.path)}`,
    `guidePath: ${JSON.stringify(guidePath)}`,
    `guideKind: ${JSON.stringify(guideKind)}`,
    `categoryOrder: ${categoryOrder}`,
    `sampleOrder: ${order}`,
    '---',
    '',
  ].join('\n')
}

export async function buildSampleGuides(options: BuildSampleGuidesOptions): Promise<SampleGuideBuild> {
  const sourceDir = await realpath(options.sourceDir)
  const commit = await inspectCheckout(sourceDir)
  const manifest = await readManifest(sourceDir)
  const repository = manifest.repository ?? DEFAULT_REPOSITORY

  await rm(options.outputDir, { recursive: true, force: true })
  for (const [index, sample] of manifest.samples.entries()) {
    const guide = await resolveGuidePath(sourceDir, sample)
    const guideFile = path.join(sourceDir, sample.path, guide.path)
    const input =
      guide.kind === 'notebook'
        ? renderNotebook(JSON.parse(await readTextFile(guideFile, MAX_GUIDE_BYTES)) as unknown, sample.language)
        : await readTextFile(guideFile, MAX_GUIDE_BYTES)
    const guideRepositoryPath = path.posix.join(sample.path, guide.path)
    const body = await prepareMarkdown(input, sourceDir, repository, commit, guideRepositoryPath, sample.title)
    const outputPath = path.join(options.outputDir, `${deriveSlug(sample)}.md`)
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(
      outputPath,
      `${frontmatter(manifest, sample, repository, commit, guide.path, guide.kind, index)}${body}\n`
    )
  }

  const finalCommit = await inspectCheckout(sourceDir)
  if (finalCommit !== commit) throw new Error('Samples checkout changed while guides were generated')
  return { repository, commit, sampleCount: manifest.samples.length }
}
