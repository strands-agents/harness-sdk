import MarkdownIt from 'markdown-it'
import path from 'node:path'
import sanitizeHtml from 'sanitize-html'
import snapshot from '../data/sample-details.json'

export interface SampleSource {
  repository: string
  commit: string
  path: string
}

export interface SampleMetadata {
  title: string
  summary: string
  language: string
  category: string
  tags: string[]
  prerequisites: string[]
}

export interface SampleFile {
  path: string
  language: string
  content: string
  sha256: string
}

export interface SampleDetail {
  id: string
  slug: string
  source: SampleSource
  metadata: SampleMetadata
  guide: {
    path: string
    markdown: string
  }
  files: SampleFile[]
}

interface SampleSnapshot {
  schemaVersion: number
  samples: SampleDetail[]
}

const data = snapshot as SampleSnapshot

if (data.schemaVersion !== 1) {
  throw new Error(`Unsupported sample detail snapshot schema: ${data.schemaVersion}`)
}

export const sampleDetails = data.samples

export function getSampleDetailPath(sampleId: string): string | undefined {
  const sample = sampleDetails.find((candidate) => candidate.id === sampleId)
  return sample ? `/examples/${sample.slug}/` : undefined
}

export function getSampleSourceUrl(sample: SampleDetail): string {
  return `https://github.com/${sample.source.repository}/tree/${sample.source.commit}/${sample.source.path}`
}

export function sampleFileId(filePath: string): string {
  return `sample-file-${filePath
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()}`
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
  return /^(?:https?:|mailto:)/i.test(href)
}

export function resolveSampleHref(
  sample: SampleDetail,
  currentPath: string,
  href: string,
  kind: 'link' | 'image'
): string {
  if (!href || href.startsWith('#') || isExternalHref(href)) return href

  const { pathname, suffix } = splitHref(href)
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return getSampleSourceUrl(sample)
  }
  const resolvedPath = path.posix.normalize(path.posix.join(path.posix.dirname(currentPath), decodedPath))

  if (path.posix.isAbsolute(resolvedPath) || resolvedPath === '..' || resolvedPath.startsWith('../')) {
    return getSampleSourceUrl(sample)
  }

  const repositoryPath = `${sample.source.path}/${resolvedPath}`
  const encodedPath = encodeRepositoryPath(repositoryPath)

  if (kind === 'image') {
    return `https://raw.githubusercontent.com/${sample.source.repository}/${sample.source.commit}/${encodedPath}${suffix}`
  }

  if (sample.files.some((file) => file.path === resolvedPath)) {
    return `#${sampleFileId(resolvedPath)}`
  }

  const view = pathname.endsWith('/') ? 'tree' : 'blob'
  return `https://github.com/${sample.source.repository}/${view}/${sample.source.commit}/${encodedPath}${suffix}`
}

function stripFirstHeading(markdown: string): string {
  return markdown.replace(/^# [^\n]+\n+/, '')
}

export function renderSampleMarkdown(
  sample: SampleDetail,
  markdown: string,
  currentPath: string,
  options: { stripTitle?: boolean } = {}
): string {
  const md = new MarkdownIt({ html: false, linkify: true })
  const defaultLinkOpen = md.renderer.rules.link_open
  const defaultImage = md.renderer.rules.image

  md.renderer.rules.link_open = (tokens, index, rendererOptions, env, self) => {
    const token = tokens[index]
    if (!token) return ''
    const href = token.attrGet('href')
    if (typeof href === 'string') {
      const resolved = resolveSampleHref(sample, currentPath, href, 'link')
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
    return defaultImage
      ? defaultImage(tokens, index, rendererOptions, env, self)
      : self.renderToken(tokens, index, rendererOptions)
  }

  const source = options.stripTitle ? stripFirstHeading(markdown) : markdown
  const rendered = md.render(source)

  return sanitizeHtml(rendered, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img'],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      code: ['class'],
      img: ['src', 'alt', 'title', 'loading'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
  })
}
