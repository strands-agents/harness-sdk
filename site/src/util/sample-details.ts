import MarkdownIt from 'markdown-it'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import GithubSlugger from 'github-slugger'
import sanitizeHtml from 'sanitize-html'
import fallbackSnapshot from '../data/sample-details.json'
import { pathWithBase } from './links'

export interface SampleSnapshotSource {
  repository: string
  commit: string
}

export interface SampleSource extends SampleSnapshotSource {
  path: string
}

export interface SampleCategory {
  language: string
  id: string
  label: string
}

export interface SampleRunConfig {
  command?: string
  commands?: string[]
  workingDirectory?: string
  cwd?: string
}

export type SampleRun = string | string[] | SampleRunConfig

export interface SampleMetadata {
  title: string
  summary: string
  language: string
  category: string
  categoryLabel: string
  tags: string[]
  prerequisites?: string[]
  run?: SampleRun
}

export interface SampleFile {
  path: string
  language: string
  content: string
  sha256: string
}

export interface SampleGuide {
  kind?: string
  format?: string
  path: string
  markdown: string
  sha256?: string
}

export interface SampleDetail {
  id: string
  slug: string
  source: SampleSource
  metadata: SampleMetadata
  guide: SampleGuide
  files: SampleFile[]
  skippedFileCount: number
}

export type SampleMarkdownPart =
  | {
      type: 'html'
      html: string
    }
  | {
      type: 'code'
      code: string
      language: string
      meta: string
    }

interface SampleSnapshot {
  schemaVersion: 2
  source: SampleSnapshotSource
  categories: SampleCategory[]
  samples: SampleDetail[]
}

interface LegacySampleDetail extends Omit<SampleDetail, 'metadata' | 'guide' | 'skippedFileCount'> {
  metadata: Omit<SampleMetadata, 'categoryLabel'> & { category: string }
  guide: Omit<SampleGuide, 'kind' | 'format'>
}

interface LegacySampleSnapshot {
  schemaVersion: 1
  samples: LegacySampleDetail[]
}

function categoryId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function normalizeLegacySnapshot(legacy: LegacySampleSnapshot): SampleSnapshot {
  const firstSample = legacy.samples[0]
  if (!firstSample) throw new Error('Legacy sample detail snapshot contains no samples.')

  const categories = new Map<string, SampleCategory>()
  const samples = legacy.samples.map((sample) => {
    const language = sample.metadata.language.toLowerCase()
    const categoryLabel = sample.metadata.category
    const category = categoryId(categoryLabel)
    categories.set(`${language}:${category}`, { language, id: category, label: categoryLabel })

    return {
      ...sample,
      metadata: {
        ...sample.metadata,
        category,
        categoryLabel,
      },
      guide: {
        ...sample.guide,
        kind: sample.guide.path.toLowerCase().endsWith('.ipynb') ? 'notebook' : 'readme',
        format: 'markdown',
      },
      skippedFileCount: 0,
    }
  })

  return {
    schemaVersion: 2,
    source: {
      repository: firstSample.source.repository,
      commit: firstSample.source.commit,
    },
    categories: [...categories.values()],
    samples,
  }
}

function loadSnapshot(): SampleSnapshot {
  const generatedSnapshotPath = path.resolve(process.cwd(), '.build/samples/sample-details.json')
  const input: unknown = existsSync(generatedSnapshotPath)
    ? JSON.parse(readFileSync(generatedSnapshotPath, 'utf8'))
    : fallbackSnapshot
  const schemaVersion = (input as { schemaVersion?: unknown }).schemaVersion

  if (schemaVersion === 1) return normalizeLegacySnapshot(input as LegacySampleSnapshot)
  if (schemaVersion !== 2) {
    throw new Error(`Unsupported sample detail snapshot schema: ${String(schemaVersion)}`)
  }
  const candidate = input as SampleSnapshot
  if (!candidate.source?.repository || !candidate.source.commit) {
    throw new Error('Sample detail snapshot is missing its pinned source repository or commit.')
  }
  return candidate
}

const data = loadSnapshot()

export const sampleSnapshotSource = data.source
export const sampleCategories = data.categories
export const sampleDetails = data.samples

function findDefaultSample(): SampleDetail {
  const sample =
    sampleDetails.find((candidate) => candidate.slug === 'typescript/first-agent') ??
    sampleDetails.find((candidate) => candidate.metadata.language.toLowerCase() === 'typescript') ??
    sampleDetails[0]
  if (!sample) {
    throw new Error('The generated samples snapshot does not contain any examples.')
  }
  return sample
}

export const defaultSampleDetail = findDefaultSample()

export function getSampleDetailPath(sampleId: string): string | undefined {
  const sample = sampleDetails.find((candidate) => candidate.id === sampleId)
  if (!sample) return undefined
  return sample.id === defaultSampleDetail.id ? '/examples/' : `/examples/${sample.slug}/`
}

export function getSampleSourceUrl(sample: SampleDetail): string {
  return `https://github.com/${sample.source.repository}/tree/${sample.source.commit}/${encodeRepositoryPath(
    sample.source.path
  )}`
}

export function getSampleFileSourceUrl(sample: SampleDetail, filePath: string): string {
  return `https://github.com/${sample.source.repository}/blob/${sample.source.commit}/${encodeRepositoryPath(
    `${sample.source.path}/${filePath}`
  )}`
}

export function getSampleGuideKind(sample: SampleDetail): string {
  return (sample.guide.kind ?? sample.guide.format ?? 'markdown').toLowerCase()
}

export function getSampleGuideLabel(sample: SampleDetail): string {
  return getSampleGuideKind(sample) === 'notebook' ? 'Notebook' : 'Guide'
}

export function getSampleLanguageLabel(language: string): string {
  switch (language.toLowerCase()) {
    case 'python':
      return 'Python'
    case 'typescript':
      return 'TypeScript'
    default:
      return language
  }
}

export function getSampleRunCommands(sample: SampleDetail): string[] {
  const run = sample.metadata.run
  if (!run) return []
  if (typeof run === 'string') return run.trim() ? [run] : []
  if (Array.isArray(run)) return run.filter((command) => command.trim() !== '')

  const commands = run.commands ?? (run.command ? [run.command] : [])
  return commands.filter((command) => command.trim() !== '')
}

export function getSampleRunWorkingDirectory(sample: SampleDetail): string | undefined {
  const run = sample.metadata.run
  if (!run || typeof run === 'string' || Array.isArray(run)) return undefined
  return run.workingDirectory ?? run.cwd
}

export function sampleFileId(filePath: string): string {
  const readable =
    filePath
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'file'
  const digest = createHash('sha256').update(filePath).digest('hex').slice(0, 8)
  return `sample-file-${readable}-${digest}`
}

function encodeRepositoryPath(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function splitHref(href: string): { pathname: string; suffix: string } {
  const suffixIndex = href.search(/[?#]/)
  if (suffixIndex === -1) return { pathname: href, suffix: '' }
  return { pathname: href.slice(0, suffixIndex), suffix: href.slice(suffixIndex) }
}

function isExternalHref(href: string): boolean {
  return /^(?:https?:|mailto:|tel:)/i.test(href)
}

function hasExplicitScheme(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href)
}

function isSafeRepositoryPath(repositoryPath: string): boolean {
  return (
    repositoryPath !== '' &&
    repositoryPath !== '.' &&
    repositoryPath !== '..' &&
    !path.posix.isAbsolute(repositoryPath) &&
    !repositoryPath.startsWith('../') &&
    !repositoryPath.includes('\\')
  )
}

function repositoryTargetSample(repositoryPath: string): SampleDetail | undefined {
  return sampleDetails.find(
    (candidate) =>
      repositoryPath === candidate.source.path ||
      (candidate.guide.path !== '' && repositoryPath === `${candidate.source.path}/${candidate.guide.path}`)
  )
}

function looksLikeRepositoryFile(repositoryPath: string): boolean {
  const name = path.posix.basename(repositoryPath).toLowerCase()
  return (
    name.includes('.') ||
    new Set(['code_of_conduct', 'contributing', 'dockerfile', 'license', 'makefile', 'notice', 'readme']).has(name)
  )
}

export function resolveSampleHref(
  sample: SampleDetail,
  currentPath: string,
  href: string,
  kind: 'link' | 'image'
): string {
  if (!href || href.startsWith('#') || isExternalHref(href)) return href
  const examplesPath = pathWithBase('/examples/')
  if (href === examplesPath || href.startsWith(examplesPath)) return href
  if (hasExplicitScheme(href)) return getSampleSourceUrl(sample)

  const { pathname, suffix } = splitHref(href)
  if (!pathname || pathname.startsWith('/') || pathname.startsWith('//')) return getSampleSourceUrl(sample)

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return getSampleSourceUrl(sample)
  }
  if (decodedPath.startsWith('/') || decodedPath.includes('\\')) return getSampleSourceUrl(sample)

  const repositoryPath = path.posix.normalize(
    path.posix.join(sample.source.path, path.posix.dirname(currentPath), decodedPath)
  )
  if (!isSafeRepositoryPath(repositoryPath)) return getSampleSourceUrl(sample)

  const targetSample = repositoryTargetSample(repositoryPath.replace(/\/+$/, ''))
  if (kind === 'link' && targetSample) {
    const targetPath = getSampleDetailPath(targetSample.id)
    return `${targetPath ? pathWithBase(targetPath) : getSampleSourceUrl(targetSample)}${suffix}`
  }

  const sampleRelativePath = path.posix.relative(sample.source.path, repositoryPath)
  const staysWithinSample =
    sampleRelativePath !== '..' && !sampleRelativePath.startsWith('../') && !path.posix.isAbsolute(sampleRelativePath)

  const encodedPath = encodeRepositoryPath(repositoryPath)

  if (kind === 'image') {
    return `https://raw.githubusercontent.com/${sample.source.repository}/${sample.source.commit}/${encodedPath}${suffix}`
  }

  if (staysWithinSample && sample.files.some((file) => file.path === sampleRelativePath)) {
    return `#${sampleFileId(sampleRelativePath)}`
  }

  const view = pathname.endsWith('/') || !looksLikeRepositoryFile(repositoryPath) ? 'tree' : 'blob'
  return `https://github.com/${sample.source.repository}/${view}/${sample.source.commit}/${encodedPath}${suffix}`
}

function headingText(token: { children?: { content: string }[] | null; content: string }): string {
  return token.children?.map((child) => child.content).join('') ?? token.content
}

function prepareHeadingTokens(
  md: ReturnType<typeof MarkdownIt>,
  markdown: string,
  stripTitle: boolean,
  reservedIds: Set<string>
) {
  const tokens = md.parse(markdown, {})
  const slugger = new GithubSlugger()
  const anchorMap = new Map<string, string>()
  const usedIds = new Set(reservedIds)
  let titleRemoved = false
  let previousHeadingLevel = 1

  for (let index = 0; index < tokens.length; index++) {
    const opening = tokens[index]
    if (opening?.type !== 'heading_open') continue

    const inline = tokens[index + 1]
    const closing = tokens[index + 2]
    if (inline?.type !== 'inline' || closing?.type !== 'heading_close') continue

    if (stripTitle && opening.tag === 'h1' && !titleRemoved) {
      tokens.splice(index, 3)
      titleRemoved = true
      index--
      continue
    }

    // The Starlight page already owns the document h1. Preserve any additional
    // README h1 sections without introducing another top-level page heading.
    if (stripTitle && opening.tag === 'h1') {
      opening.tag = 'h2'
      closing.tag = 'h2'
    }

    if (stripTitle) {
      const requestedLevel = Number(opening.tag.slice(1))
      const normalizedLevel = Math.min(Math.max(requestedLevel, 2), previousHeadingLevel + 1)
      opening.tag = `h${normalizedLevel}`
      closing.tag = `h${normalizedLevel}`
      previousHeadingLevel = normalizedLevel
    }

    const text = headingText(inline).trim() || 'section'
    const originalSlug = slugger.slug(text)
    let headingId = originalSlug
    if (usedIds.has(headingId)) {
      const base = `sample-guide-${originalSlug}`
      headingId = base
      let suffix = 1
      while (usedIds.has(headingId)) {
        headingId = `${base}-${suffix}`
        suffix += 1
      }
    }
    usedIds.add(headingId)
    anchorMap.set(originalSlug, headingId)
    opening.attrSet('id', headingId)
  }

  return { tokens, anchorMap }
}

function rewriteHeadingFragment(href: string, anchorMap: ReadonlyMap<string, string>): string {
  if (!href.startsWith('#')) return href
  const fragment = href.slice(1)
  const replacement = anchorMap.get(fragment)
  return replacement ? `#${replacement}` : href
}

function createSampleMarkdownRenderer(
  sample: SampleDetail,
  currentPath: string,
  anchorMap: ReadonlyMap<string, string> = new Map()
) {
  const md = new MarkdownIt({ html: true, linkify: true })
  const defaultLinkOpen = md.renderer.rules.link_open
  const defaultImage = md.renderer.rules.image

  md.renderer.rules.link_open = (tokens, index, rendererOptions, env, self) => {
    const token = tokens[index]
    if (!token) return ''
    const href = token.attrGet('href')
    if (typeof href === 'string') {
      const resolved = resolveSampleHref(sample, currentPath, rewriteHeadingFragment(href, anchorMap), 'link')
      token.attrSet('href', resolved)
      if (isExternalHref(resolved)) {
        token.attrSet('target', '_blank')
        token.attrSet('rel', 'noopener')
      }
    }
    return defaultLinkOpen
      ? defaultLinkOpen(tokens, index, rendererOptions, env, self)
      : self.renderToken(tokens, index, rendererOptions)
  }

  md.renderer.rules.image = (tokens, index, rendererOptions, env, self) => {
    const token = tokens[index]
    if (!token) return ''
    const src = token.attrGet('src')
    if (typeof src === 'string') token.attrSet('src', resolveSampleHref(sample, currentPath, src, 'image'))
    token.attrSet('loading', 'lazy')
    token.attrSet('decoding', 'async')
    return defaultImage
      ? defaultImage(tokens, index, rendererOptions, env, self)
      : self.renderToken(tokens, index, rendererOptions)
  }

  return md
}

function sanitizeRenderedMarkdown(
  sample: SampleDetail,
  currentPath: string,
  rendered: string,
  anchorMap: ReadonlyMap<string, string>
): string {
  return sanitizeHtml(rendered, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'video'],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      code: ['class'],
      h1: ['id'],
      h2: ['id'],
      h3: ['id'],
      h4: ['id'],
      h5: ['id'],
      h6: ['id'],
      img: ['src', 'alt', 'title', 'loading', 'decoding'],
      video: ['src', 'poster', 'controls', 'preload'],
      th: ['align', 'colspan', 'rowspan', 'scope'],
      td: ['align', 'colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'escape',
    parseStyleAttributes: false,
    transformTags: {
      a: (tagName, attributes) => {
        const transformed = { ...attributes }
        delete transformed.target
        delete transformed.rel

        if (attributes.href) {
          const href = resolveSampleHref(
            sample,
            currentPath,
            rewriteHeadingFragment(attributes.href, anchorMap),
            'link'
          )
          transformed.href = href
          if (isExternalHref(href)) {
            transformed.target = '_blank'
            transformed.rel = 'noopener'
          }
        }

        return { tagName, attribs: transformed }
      },
      img: (tagName, attributes) => {
        const transformed: Record<string, string> = {
          ...attributes,
          alt: attributes.alt ?? '',
          loading: 'lazy',
          decoding: 'async',
        }
        if (attributes.src) {
          transformed.src = resolveSampleHref(sample, currentPath, attributes.src, 'image')
        }
        return { tagName, attribs: transformed }
      },
      video: (tagName, attributes) => {
        const transformed: Record<string, string> = {
          ...attributes,
          controls: 'controls',
          preload: 'metadata',
        }
        if (attributes.src) {
          transformed.src = resolveSampleHref(sample, currentPath, attributes.src, 'image')
        }
        if (attributes.poster) {
          transformed.poster = resolveSampleHref(sample, currentPath, attributes.poster, 'image')
        }
        return { tagName, attribs: transformed }
      },
    },
  })
}

export function normalizeSampleCodeLanguage(language: string | undefined): string {
  const normalized = language?.trim().toLowerCase() ?? ''
  switch (normalized) {
    case '':
    case 'plaintext':
    case 'txt':
      return 'text'
    case 'sh':
    case 'shell':
      return 'bash'
    case 'js':
      return 'javascript'
    case 'ts':
      return 'typescript'
    case 'md':
      return 'markdown'
    case 'yml':
      return 'yaml'
    default:
      return /^[a-z0-9_+-]+$/.test(normalized) ? normalized : 'text'
  }
}

function parseFenceInfo(info: string): { language: string; meta: string } {
  const trimmed = info.trim()
  if (!trimmed) return { language: 'text', meta: '' }

  const whitespace = trimmed.search(/\s/)
  if (whitespace === -1) {
    return { language: normalizeSampleCodeLanguage(trimmed), meta: '' }
  }

  return {
    language: normalizeSampleCodeLanguage(trimmed.slice(0, whitespace)),
    meta: trimmed.slice(whitespace).trim(),
  }
}

export function renderSampleMarkdownParts(
  sample: SampleDetail,
  markdown: string,
  currentPath: string,
  options: { stripTitle?: boolean } = {}
): SampleMarkdownPart[] {
  const reservedIds = new Set([
    '_top',
    'files',
    'files-tab',
    'guide',
    'guide-tab',
    ...sample.files.map((file) => sampleFileId(file.path)),
  ])
  const md = createSampleMarkdownRenderer(sample, currentPath)
  const { tokens, anchorMap } = prepareHeadingTokens(md, markdown, options.stripTitle === true, reservedIds)
  const renderedMd = createSampleMarkdownRenderer(sample, currentPath, anchorMap)
  const codeParts: Extract<SampleMarkdownPart, { type: 'code' }>[] = []
  for (const token of tokens) {
    if (token.type === 'fence' || token.type === 'code_block') {
      const { language, meta } = token.type === 'fence' ? parseFenceInfo(token.info) : { language: 'text', meta: '' }
      const index = codeParts.length
      codeParts.push({
        type: 'code',
        code: token.content,
        language,
        meta,
      })
      token.meta = { ...token.meta, sampleCodeIndex: index }
    }
  }

  const placeholderPrefix = `STRANDS_SAMPLE_CODE_${randomUUID()}_`
  const renderCodePlaceholder = (rendererTokens: typeof tokens, index: number) => {
    const codeIndex = rendererTokens[index]?.meta?.sampleCodeIndex
    return `${placeholderPrefix}${String(codeIndex)}`
  }
  renderedMd.renderer.rules.fence = renderCodePlaceholder
  renderedMd.renderer.rules.code_block = renderCodePlaceholder

  const rendered = renderedMd.renderer.render(tokens, renderedMd.options, {})
  const sanitized = sanitizeRenderedMarkdown(sample, currentPath, rendered, anchorMap)
  const placeholder = new RegExp(`${placeholderPrefix}(\\d+)`, 'g')
  const parts: SampleMarkdownPart[] = []
  let cursor = 0

  for (const match of sanitized.matchAll(placeholder)) {
    const offset = match.index
    const precedingHtml = sanitized.slice(cursor, offset)
    if (precedingHtml.trim()) parts.push({ type: 'html', html: precedingHtml })

    const codePart = codeParts[Number(match[1])]
    if (!codePart) throw new Error(`Missing rendered sample code block ${String(match[1])}.`)
    parts.push(codePart)
    cursor = offset + match[0].length
  }

  const trailingHtml = sanitized.slice(cursor)
  if (trailingHtml.trim()) parts.push({ type: 'html', html: trailingHtml })
  return parts
}

export function renderSampleMarkdown(
  sample: SampleDetail,
  markdown: string,
  currentPath: string,
  options: { stripTitle?: boolean } = {}
): string {
  const md = createSampleMarkdownRenderer(sample, currentPath)
  return renderSampleMarkdownParts(sample, markdown, currentPath, options)
    .map((part) => {
      if (part.type === 'html') return part.html
      const language = encodeURIComponent(part.language)
      return `<pre><code class="language-${language}">${md.utils.escapeHtml(part.code)}</code></pre>`
    })
    .join('')
}
