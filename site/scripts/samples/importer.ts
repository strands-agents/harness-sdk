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
const MIN_DESCRIPTION_LENGTH = 140
const MAX_DESCRIPTION_LENGTH = 160
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
const languageSchema = nonEmptyString.transform((value) => value.toLowerCase()).pipe(z.enum(['python', 'typescript']))

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
    language: languageSchema,
    id: nonEmptyString,
    label: nonEmptyString,
  })
  .strict()

// Other catalog consumers use the accepted metadata omitted by the rendering transform below.
const sampleSchema = z
  .object({
    id: nonEmptyString.optional(),
    slug: nonEmptyString.optional(),
    language: languageSchema,
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
    if (slug.data.split('/')[0] !== sample.language) {
      context.addIssue({
        code: 'custom',
        path: ['slug'],
        message: `must begin with the sample language "${sample.language}/"`,
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
  title: string
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
  let longest = 2
  let current = 0
  for (const character of content) {
    if (character === '`') {
      current += 1
      longest = Math.max(longest, current)
    } else {
      current = 0
    }
  }
  return '`'.repeat(longest + 1)
}

function codeLanguage(value: string, fallback: string = 'text'): string {
  const normalized = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_+#.-]*$/.test(normalized) ? normalized : fallback
}

function fileLanguage(filePath: string, fallbackLanguage: string): string {
  const languages: Record<string, string> = {
    '.bash': 'bash',
    '.css': 'css',
    '.html': 'html',
    '.js': 'javascript',
    '.json': 'json',
    '.md': 'markdown',
    '.py': 'python',
    '.sh': 'bash',
    '.sql': 'sql',
    '.toml': 'toml',
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.txt': 'text',
    '.yaml': 'yaml',
    '.yml': 'yaml',
  }
  return languages[path.posix.extname(filePath).toLowerCase()] ?? codeLanguage(fallbackLanguage)
}

function codeBlock(content: string, language: string): string {
  const fence = codeFence(content)
  return `${fence}${codeLanguage(language)}\n${content}\n${fence}`
}

function codeSpan(content: string): string {
  const delimiter = codeFence(content)
  const padding = content.startsWith('`') || content.endsWith('`') ? ' ' : ''
  return `${delimiter}${padding}${content}${padding}${delimiter}`
}

function writeFileCell(source: string, fallbackLanguage: string): string | undefined {
  const [directive, ...contentLines] = source.split('\n')
  const match = directive?.match(/^%%writefile\s+(?:(-a)\s+)?(.+?)\s*$/)
  if (!match) return undefined

  const filePath = match[2]!
  const action = match[1] ? 'Append to' : 'File'
  const content = contentLines.join('\n').trimEnd()
  return `**${action}:** ${codeSpan(filePath)}\n\n${codeBlock(content, fileLanguage(filePath, fallbackLanguage))}`
}

function shellCell(source: string): string | undefined {
  const lines = source.split('\n')
  const output: string[] = []
  let continuation = false
  let commandFound = false

  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) {
      output.push(line)
      continue
    }
    if (continuation) {
      output.push(line)
      continuation = /\\\s*$/.test(line)
      continue
    }

    const shellCommand = line.match(/^(\s*)!(.*)$/)
    const packageMagic = line.match(/^(\s*)%(pip|conda)(\s.*)?$/)
    if (!shellCommand && !packageMagic) return undefined

    const transformed = shellCommand
      ? `${shellCommand[1]}${shellCommand[2]}`
      : `${packageMagic![1]}${packageMagic![2]}${packageMagic![3] ?? ''}`
    output.push(transformed)
    commandFound = true
    continuation = /\\\s*$/.test(transformed)
  }

  return commandFound ? output.join('\n') : undefined
}

function renderNotebookCode(source: string, language: string): string {
  const writeFile = writeFileCell(source, language)
  if (writeFile) return writeFile

  const cellMagic = source.match(/^%%(?:bash|sh)(?:\s+[^\n]*)?\n([\s\S]*)$/)
  if (cellMagic) return codeBlock(cellMagic[1]!.trimEnd(), 'bash')

  const shell = shellCell(source)
  if (shell) return codeBlock(shell, 'bash')

  if (/^\s*[!%]/m.test(source)) {
    return `**Jupyter notebook cell:**\n\n${codeBlock(source, 'text')}`
  }
  return codeBlock(source, language)
}

function renderNotebook(value: unknown, fallbackLanguage: string): string {
  if (!isRecord(value) || !Array.isArray(value.cells)) throw new Error('Notebook must contain a cells array')
  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const languageInfo = isRecord(metadata.language_info) ? metadata.language_info : {}
  const language = codeLanguage(
    typeof languageInfo.name === 'string' && languageInfo.name.trim() ? languageInfo.name : fallbackLanguage
  )
  const sections: string[] = []

  for (const cell of value.cells) {
    if (!isRecord(cell)) continue
    const source = notebookSource(cell.source).trim()
    if (!source) continue
    if (cell.cell_type === 'markdown') {
      sections.push(source)
    } else if (cell.cell_type === 'code') {
      sections.push(renderNotebookCode(source, language))
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

function normalizeHeadingHierarchy(tree: Root): void {
  const hierarchy: Array<{ source: number; normalized: number }> = []
  visit(tree, 'heading', (node) => {
    const sourceDepth = Math.max(2, node.depth)
    while (hierarchy.at(-1)?.source !== undefined && hierarchy.at(-1)!.source >= sourceDepth) hierarchy.pop()
    const normalizedDepth = (hierarchy.at(-1)?.normalized ?? 1) + 1
    node.depth = normalizedDepth as typeof node.depth
    hierarchy.push({ source: sourceDepth, normalized: normalizedDepth })
  })
}

function imageAltFromUrl(value: string, title: string): string | undefined {
  const { pathname } = splitUrl(value)
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    decodedPath = pathname
  }
  const fileName = path.posix.basename(decodedPath)
  const extension = path.posix.extname(fileName)
  const stem = fileName.slice(0, extension ? -extension.length : undefined)
  const words = stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!words) return undefined
  if (
    /^(?:\d+|(?:asset|diagram|fig(?:ure)?|graphic|image|img|photo|picture|screen ?shot|untitled)(?: \d+)?)$/i.test(
      words
    )
  ) {
    return undefined
  }

  const description = /\barchitecture\b/i.test(words)
    ? words.replace(/\barchitecture\b/i, 'architecture diagram')
    : words
  const label = description.charAt(0).toUpperCase() + description.slice(1)
  return normalizedHeading(label).includes(normalizedHeading(title)) ? label : `${title}: ${label}`
}

function fillMissingImageAltText(tree: Root, context: GuideContext): void {
  const definitions = new Map<string, string>()
  visit(tree, 'definition', (node) => {
    definitions.set(node.identifier.toLowerCase(), node.url)
  })

  const fill = (node: { alt?: string | null; url?: string; identifier?: string }): void => {
    if (node.alt?.trim()) return
    const source = node.url ?? definitions.get(node.identifier?.toLowerCase() ?? '')
    const alt = source ? imageAltFromUrl(source, context.title) : undefined
    if (!alt) {
      const fallback = `${context.title} illustration`
      console.warn(
        `${context.guidePath} contains an image without alt text or a descriptive filename; using fallback alt text "${fallback}"`
      )
      node.alt = fallback
      return
    }
    node.alt = alt
  }

  visit(tree, 'image', fill)
  visit(tree, 'imageReference', fill)
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
  normalizeHeadingHierarchy(tree)
  removeRemainingHtml(tree)
  fillMissingImageAltText(tree, context)

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

function descriptionLength(value: string): number {
  return Array.from(value).length
}

function sourceUrl(commit: string, samplePath: string): string {
  return `https://github.com/${CANONICAL_SAMPLES_REPOSITORY}/tree/${commit}/${encodeRepositoryPath(samplePath)}`
}

function frontmatter(sample: ManifestSample, description: string, commit: string, order: number): string {
  return [
    '---',
    `title: ${JSON.stringify(sample.title)}`,
    `description: ${JSON.stringify(description)}`,
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
  let shortDescriptions = 0
  let longDescriptions = 0
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
      title: sample.title,
    }
    const body = await prepareMarkdown(context, input, sample.title)
    const description = sample.description
    const length = descriptionLength(description)
    if (length < MIN_DESCRIPTION_LENGTH) shortDescriptions += 1
    if (length > MAX_DESCRIPTION_LENGTH) longDescriptions += 1
    const outputPath = path.join(options.outputDir, `${sample.slug}.md`)
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${frontmatter(sample, description, commit, index)}${body}\n`)
  }

  const invalidDescriptions = shortDescriptions + longDescriptions
  if (invalidDescriptions > 0) {
    console.warn(
      `Sample description lengths outside ${MIN_DESCRIPTION_LENGTH}-${MAX_DESCRIPTION_LENGTH} characters: ${invalidDescriptions}/${samples.length} (${shortDescriptions} short, ${longDescriptions} long); preserving samples.json values; update metadata in strands-agents/samples`
    )
  }

  return { repository: CANONICAL_SAMPLES_REPOSITORY, commit, sampleCount: manifest.samples.length }
}
