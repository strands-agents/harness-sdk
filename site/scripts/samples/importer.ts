import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'astro/zod'
import type { Root, RootContent } from 'mdast'
import { toString } from 'mdast-util-to-string'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import TurndownService from 'turndown'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'

const execFileAsync = promisify(execFile)

// Generated links intentionally target the canonical repository, including builds from local forks.
const CANONICAL_SAMPLES_REPOSITORY = 'strands-agents/samples'
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_GUIDE_BYTES = 2 * 1024 * 1024
const SNIPPET_DIRECTIVE_PATTERN = /^-+8<-+\s*"[^"]+"$/

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

const nonEmptyString = z.string().trim().min(1, 'must be a non-empty string')

const relativePathSchema = nonEmptyString
  .refine((value) => !value.includes('\\'), 'must use forward slashes')
  .transform((value) => path.posix.normalize(value.replace(/^\.\/+/, '')))
  .refine(
    (value) =>
      value !== '' && value !== '.' && value !== '..' && !value.startsWith('../') && !path.posix.isAbsolute(value),
    'must stay within the samples checkout'
  )

const slugSchema = nonEmptyString
  .transform((value) => value.replace(/^\/+|\/+$/g, ''))
  .pipe(relativePathSchema)
  .refine(
    (value) => /^[a-z0-9][a-z0-9/-]*$/.test(value),
    'may contain only lowercase letters, numbers, hyphens, and slashes'
  )

const categorySchema = z
  .object({
    language: nonEmptyString.transform((value) => value.toLowerCase()),
    id: nonEmptyString,
    label: nonEmptyString,
  })
  .strict()

// Other catalog consumers use the accepted metadata omitted by the rendering transform below.
const sampleSchema = z
  .object({
    id: nonEmptyString.optional(),
    slug: nonEmptyString.optional(),
    language: nonEmptyString.transform((value) => value.toLowerCase()),
    category: nonEmptyString,
    categoryLabel: nonEmptyString.optional(),
    title: nonEmptyString,
    description: nonEmptyString,
    tags: z.array(nonEmptyString).optional(),
    path: relativePathSchema,
    notebook: relativePathSchema.optional(),
    url: nonEmptyString.optional(),
  })
  .strict()
  .transform((sample, context) => {
    const segments = sample.path.split('/')
    const derivedSlug = [segments[0], ...segments.slice(2).map((segment) => segment.replace(/^\d+-/, ''))].join('/')
    const slug = slugSchema.safeParse(sample.slug ?? derivedSlug)
    if (!slug.success) {
      context.addIssue({
        code: 'custom',
        path: ['slug'],
        message: slug.error.issues.map((issue) => issue.message).join(', '),
      })
      return z.NEVER
    }
    return {
      language: sample.language,
      category: sample.category,
      title: sample.title,
      description: sample.description,
      path: sample.path,
      notebook: sample.notebook,
      slug: slug.data,
    }
  })

const manifestSchema = z
  .object({
    version: z.literal(1),
    categories: z.array(categorySchema),
    samples: z.array(sampleSchema),
  })
  .strict()
type ParsedManifest = z.infer<typeof manifestSchema>

function parseManifest(value: unknown) {
  const manifest: ParsedManifest = manifestSchema.parse(value)
  const categoryLabels = new Map<string, string>()
  for (const category of manifest.categories) {
    const key = `${category.language}/${category.id}`
    if (categoryLabels.has(key)) throw new Error(`Duplicate sample category: ${key}`)
    categoryLabels.set(key, category.label)
  }

  const paths = new Set<string>()
  const slugs = new Set<string>()
  const samples = manifest.samples.map((sample) => {
    if (paths.has(sample.path)) throw new Error(`Duplicate sample path: ${sample.path}`)
    paths.add(sample.path)
    if (slugs.has(sample.slug)) throw new Error(`Duplicate sample slug: ${sample.slug}`)
    slugs.add(sample.slug)

    const category = `${sample.language}/${sample.category}`
    const categoryLabel = categoryLabels.get(category)
    if (categoryLabel === undefined) throw new Error(`${sample.path} references unknown category ${category}`)
    return { ...sample, categoryLabel }
  })
  return { samples }
}

type SampleManifest = ReturnType<typeof parseManifest>
type ManifestSample = SampleManifest['samples'][number]

interface BuildSampleGuidesOptions {
  sourceDir: string
  outputDir: string
  requireSamples?: boolean
}

interface SampleGuideBuild {
  repository: string
  commit: string
  sampleCount: number
}

interface GuideContext {
  sourceDir: string
  repository: string
  commit: string
  guidePath: string
}

interface GuideSource {
  filePath: string
  repositoryPath: string
  kind: 'readme' | 'notebook'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
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
  const manifestPath = await realpath(path.join(sourceDir, 'samples.json'))
  if (!isInside(sourceDir, manifestPath)) throw new Error('samples.json resolves outside the samples checkout')
  return parseManifest(JSON.parse(await readTextFile(manifestPath, MAX_MANIFEST_BYTES)) as unknown)
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

async function resolveGuidePath(sourceDir: string, sample: ManifestSample): Promise<GuideSource> {
  const sampleRoot = await realpath(path.join(sourceDir, sample.path))
  if (!isInside(sourceDir, sampleRoot)) throw new Error(`${sample.path} resolves outside the samples checkout`)

  try {
    const readme = await realpath(path.join(sampleRoot, 'README.md'))
    if (!isInside(sampleRoot, readme)) throw new Error(`${sample.path} README resolves outside its sample directory`)
    return {
      filePath: readme,
      repositoryPath: path.posix.join(sample.path, 'README.md'),
      kind: 'readme',
    }
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error
  }

  if (!sample.notebook) throw new Error(`${sample.path} has no root README.md or configured notebook`)
  const notebook = await realpath(path.join(sampleRoot, sample.notebook))
  if (!isInside(sampleRoot, notebook)) throw new Error(`${sample.path} notebook resolves outside its sample directory`)
  return {
    filePath: notebook,
    repositoryPath: path.posix.join(sample.path, sample.notebook),
    kind: 'notebook',
  }
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

function renderNotebook(value: unknown, fallbackLanguage: string): string {
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
  if (/^[\\/]{2}/.test(value)) throw new Error('Sample guide contains a protocol-relative URL')
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

function repositoryRootUrl(context: GuideContext): string {
  return `https://github.com/${context.repository}/tree/${context.commit}`
}

async function repositoryUrl(context: GuideContext, value: string, image: boolean): Promise<string> {
  if (!value || value.startsWith('#')) return value
  const external = externalUrl(value, image)
  if (external) return external

  const { pathname, suffix } = splitUrl(value)
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return repositoryRootUrl(context)
  }
  if (decodedPath.includes('\\')) throw new Error('Sample guide contains an unsafe backslash URL')

  const target = path.posix.normalize(
    decodedPath.startsWith('/')
      ? decodedPath.replace(/^\/+/, '')
      : path.posix.join(path.posix.dirname(context.guidePath), decodedPath)
  )
  if (target === '' || target === '.') return `${repositoryRootUrl(context)}${suffix}`
  if (target === '..' || target.startsWith('../') || path.posix.isAbsolute(target)) {
    return repositoryRootUrl(context)
  }

  const encoded = encodeRepositoryPath(target)
  let targetStat
  try {
    targetStat = await stat(path.join(context.sourceDir, target))
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error
    if (image) throw new Error(`${context.guidePath} links to missing relative image ${value}`)
    console.warn(`${context.guidePath} links to missing relative target ${value}; keeping a pinned GitHub link`)
    return `https://github.com/${context.repository}/blob/${context.commit}/${encoded}${suffix}`
  }
  if (image) {
    if (!targetStat.isFile()) throw new Error(`${context.guidePath} uses a directory as an image: ${value}`)
    return `https://raw.githubusercontent.com/${context.repository}/${context.commit}/${encoded}${suffix}`
  }
  const kind = targetStat.isDirectory() ? 'tree' : 'blob'
  return `https://github.com/${context.repository}/${kind}/${context.commit}/${encoded}${suffix}`
}

function convertEmbeddedHtml(tree: Root): void {
  visit(tree, 'html', (node) => {
    node.value = /^<br\s*\/?>$/i.test(node.value.trim()) ? ' ' : htmlConverter.turndown(node.value)
  })
}

function removeRemainingHtml(tree: Root): void {
  visit(tree, 'html', (_node, index, parent) => {
    if (index === undefined || parent === undefined) return
    parent.children.splice(index, 1)
    return index
  })
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

function assertNoSnippetDirective(value: string): void {
  if (value.split(/\r?\n/).some((line) => SNIPPET_DIRECTIVE_PATTERN.test(line.trim()))) {
    throw new Error('Sample guide contains a prohibited --8<-- snippet directive')
  }
}

async function prepareMarkdown(context: GuideContext, markdown: string, title: string): Promise<string> {
  assertNoSnippetDirective(markdown)
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify, {
    bullet: '-',
    fences: true,
    listItemIndent: 'one',
  })
  let tree = processor.parse(markdown) as Root
  convertEmbeddedHtml(tree)
  tree = processor.parse(processor.stringify(tree)) as Root
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
    assertNoSnippetDirective(node.value)
    if (node.lang) node.lang = node.lang.toLowerCase()
  })
  for (const link of links) {
    link.node.url = await repositoryUrl(context, link.node.url, link.image)
  }
  return processor.stringify(tree).trim()
}

function sourceUrl(commit: string, samplePath: string): string {
  return `https://github.com/${CANONICAL_SAMPLES_REPOSITORY}/tree/${commit}/${encodeRepositoryPath(samplePath)}`
}

function frontmatter(sample: ManifestSample, commit: string, order: number): string {
  return [
    '---',
    `title: ${JSON.stringify(sample.title)}`,
    `description: ${JSON.stringify(sample.description)}`,
    `slug: ${JSON.stringify(sample.slug)}`,
    `language: ${JSON.stringify(sample.language)}`,
    `category: ${JSON.stringify(sample.category)}`,
    `categoryLabel: ${JSON.stringify(sample.categoryLabel)}`,
    `sourceUrl: ${JSON.stringify(sourceUrl(commit, sample.path))}`,
    `order: ${order}`,
    '---',
    '',
  ].join('\n')
}

export async function buildSampleGuides(options: BuildSampleGuidesOptions): Promise<SampleGuideBuild> {
  const sourceDir = await realpath(options.sourceDir)
  // Published builds use fresh checkouts; local previews may include unpublished content at this HEAD.
  const commit = await gitOutput(sourceDir, ['rev-parse', 'HEAD'])
  const manifest = await readManifest(sourceDir)
  if (options.requireSamples && manifest.samples.length === 0) {
    throw new Error('Samples source must contain at least one sample.')
  }

  await rm(options.outputDir, { recursive: true, force: true })
  const samples = [...manifest.samples].sort((left, right) => left.path.localeCompare(right.path))
  for (const [index, sample] of samples.entries()) {
    const guide = await resolveGuidePath(sourceDir, sample)
    const input =
      guide.kind === 'notebook'
        ? renderNotebook(JSON.parse(await readTextFile(guide.filePath, MAX_GUIDE_BYTES)) as unknown, sample.language)
        : await readTextFile(guide.filePath, MAX_GUIDE_BYTES)
    const context = {
      sourceDir,
      repository: CANONICAL_SAMPLES_REPOSITORY,
      commit,
      guidePath: guide.repositoryPath,
    }
    const body = await prepareMarkdown(context, input, sample.title)
    const outputPath = path.join(options.outputDir, `${sample.slug}.md`)
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${frontmatter(sample, commit, index)}${body}\n`)
  }

  return { repository: CANONICAL_SAMPLES_REPOSITORY, commit, sampleCount: manifest.samples.length }
}
