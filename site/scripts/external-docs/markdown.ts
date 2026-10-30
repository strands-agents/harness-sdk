import path from 'node:path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { visit } from 'unist-util-visit'
import type { Definition, Image, Link, Root } from 'mdast'

interface MarkdownContext {
  sourcePath: string
  repository: string
  revision: string
  publishedRoutes: ReadonlyMap<string, string>
}

interface Edit {
  start: number
  end: number
  value: string
}

type UrlNode = Link | Image | Definition

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const MKDOCS_SNIPPET_DIRECTIVE = /^-+8<-+\s*"[^"]+"$/
const SAFE_RAW_HTML =
  /^(?:(?:<\/?details>)|(?:<summary>[^<]*<\/summary>)|(?:<a id="[a-z0-9][a-z0-9-]*">)|(?:<\/a>)|\s)+$/

export function transformExternalMarkdown(markdown: string, context: MarkdownContext): string {
  if (/^---\r?\n/.test(markdown)) {
    throw new Error(`${context.sourcePath}: upstream frontmatter is not allowed`)
  }

  const preparedMarkdown = normalizeFenceLanguages(pinSameRepositoryUrls(markdown, context))
  const tree = unified().use(remarkParse).parse(preparedMarkdown) as Root
  const heading = tree.children[0]
  if (heading?.type !== 'heading' || heading.depth !== 1 || heading.position?.start.offset !== 0) {
    throw new Error(`${context.sourcePath}: the first line must be an H1 heading`)
  }

  validateMarkdown(tree, preparedMarkdown, context.sourcePath)

  const headingEnd = consumeHeadingBreak(
    preparedMarkdown,
    requiredOffset(heading.position.end.offset, context.sourcePath)
  )
  const edits: Edit[] = [{ start: 0, end: headingEnd, value: '' }]
  const imageDefinitions = collectImageDefinitions(tree)

  visit(tree, ['link', 'image', 'definition'], (node: UrlNode) => {
    const start = requiredOffset(node.position?.start.offset, context.sourcePath)
    if (start < headingEnd) return

    const image = node.type === 'image' || (node.type === 'definition' && imageDefinitions.has(node.identifier))
    const rewritten = rewriteUrl(node.url, image, context)
    if (rewritten === node.url) return
    edits.push(urlEdit(preparedMarkdown, node, rewritten, context.sourcePath))
  })

  return applyEdits(preparedMarkdown, edits)
}

function pinSameRepositoryUrls(markdown: string, context: MarkdownContext): string {
  const repository = escapeRegExp(context.repository)
  const repositoryPath = escapeRegExp(new URL(context.repository).pathname.replace(/^\/|\/$/g, ''))
  return markdown
    .replace(
      new RegExp(`(${repository}/(?:blob|edit|tree|raw)/)(?:main|master)(?=/|[?#]|\\s|\\)|>|\\]|\\}|$)`, 'g'),
      `$1${context.revision}`
    )
    .replace(
      new RegExp(
        `(https://raw\\.githubusercontent\\.com/${repositoryPath}/)(?:main|master)(?=/|[?#]|\\s|\\)|>|\\]|\\}|$)`,
        'g'
      ),
      `$1${context.revision}`
    )
}

function normalizeFenceLanguages(markdown: string): string {
  return markdown.replace(/^([ \t]{0,3})(`{3,}|~{3,})(?:dw|cedar)(?=[ \t]*$)/gim, '$1$2text')
}

function validateMarkdown(tree: Root, markdown: string, sourcePath: string): void {
  for (const child of tree.children) {
    if (child.type !== 'paragraph' || !child.position) continue
    const paragraph = markdown.slice(child.position.start.offset, child.position.end.offset).trimStart()
    if (/^(?:import|export)\s/.test(paragraph)) {
      throw new Error(`${sourcePath}:${child.position.start.line}: MDX import/export syntax is not allowed`)
    }
  }

  visit(tree, 'text', (node) => {
    if (/[{}]/.test(node.value)) {
      throw new Error(`${sourcePath}:${node.position?.start.line ?? 1}: MDX expression braces must be in code`)
    }
  })

  visit(tree, 'html', (node) => {
    if (!SAFE_RAW_HTML.test(node.value)) {
      throw new Error(`${sourcePath}:${node.position?.start.line ?? 1}: unsafe HTML or MDX markup is not allowed`)
    }
  })

  visit(tree, 'code', (node) => {
    if (node.value.split('\n').some((line) => MKDOCS_SNIPPET_DIRECTIVE.test(line.trim()))) {
      throw new Error(`${sourcePath}:${node.position?.start.line ?? 1}: snippet include directives are not allowed`)
    }
  })
}

function rewriteUrl(url: string, image: boolean, context: MarkdownContext): string {
  if (url.length === 0 || url.startsWith('#') || url.startsWith('?')) return url
  if (url.startsWith('//')) throw new Error(`${context.sourcePath}: protocol-relative links are not allowed`)
  if (url.startsWith('/')) return url
  const scheme = url.match(URL_SCHEME)?.[0].slice(0, -1).toLowerCase()
  if (scheme) {
    if (scheme === 'http' || scheme === 'https' || (!image && scheme === 'mailto')) return url
    throw new Error(`${context.sourcePath}: URL scheme "${scheme}" is not allowed`)
  }

  const suffixStart = url.search(/[?#]/)
  const pathPart = suffixStart === -1 ? url : url.slice(0, suffixStart)
  const suffix = suffixStart === -1 ? '' : url.slice(suffixStart)
  const decoded = decodeLinkPath(pathPart, context.sourcePath)
  if (decoded.startsWith('/') || decoded.includes('\\')) {
    throw new Error(`${context.sourcePath}: link path "${pathPart}" is unsafe`)
  }

  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(context.sourcePath), decoded))
  if (resolved === '..' || resolved.startsWith('../')) {
    throw new Error(`${context.sourcePath}: link path "${pathPart}" escapes the repository`)
  }

  const publishedRoute = context.publishedRoutes.get(resolved)
  if (publishedRoute && !image) return `/${publishedRoute}/${suffix}`

  const encodedPath = resolved.split('/').map(encodeURIComponent).join('/')
  if (image) {
    const repositoryPath = new URL(context.repository).pathname.replace(/^\/|\/$/g, '')
    return `https://raw.githubusercontent.com/${repositoryPath}/${context.revision}/${encodedPath}${suffix}`
  }
  return `${context.repository}/blob/${context.revision}/${encodedPath}${suffix}`
}

function decodeLinkPath(value: string, sourcePath: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error(`${sourcePath}: link path "${value}" has invalid percent encoding`)
  }
}

function urlEdit(markdown: string, node: UrlNode, rewritten: string, sourcePath: string): Edit {
  const start = requiredOffset(node.position?.start.offset, sourcePath)
  const end = requiredOffset(node.position?.end.offset, sourcePath)
  const source = markdown.slice(start, end)
  const relativeStart = destinationStart(source, node, start)
  if (!source.startsWith(node.url, relativeStart)) {
    throw new Error(`${sourcePath}:${node.position?.start.line ?? 1}: could not locate link destination`)
  }
  return {
    start: start + relativeStart,
    end: start + relativeStart + node.url.length,
    value: rewritten,
  }
}

function destinationStart(source: string, node: UrlNode, absoluteStart: number): number {
  let cursor: number
  if (node.type === 'definition') {
    const delimiter = source.indexOf(']:')
    cursor = delimiter + 2
  } else {
    const lastChild = node.type === 'link' ? node.children.at(-1) : undefined
    const labelEnd = lastChild?.position?.end.offset
    const searchStart = labelEnd === undefined ? 0 : labelEnd - absoluteStart
    const closeBracket = source.indexOf(']', searchStart)
    const openParenthesis = source.indexOf('(', closeBracket + 1)
    cursor = openParenthesis + 1
  }

  while (/\s/.test(source[cursor] ?? '')) cursor++
  if (source[cursor] === '<') cursor++
  return cursor
}

function collectImageDefinitions(tree: Root): Set<string> {
  const identifiers = new Set<string>()
  visit(tree, 'imageReference', (node) => identifiers.add(node.identifier))
  return identifiers
}

function consumeHeadingBreak(markdown: string, headingEnd: number): number {
  const breakMatch = markdown.slice(headingEnd).match(/^(?:\r?\n){1,2}/)
  return headingEnd + (breakMatch?.[0].length ?? 0)
}

function applyEdits(source: string, edits: Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start)
  let result = source
  let priorStart = source.length
  for (const edit of ordered) {
    if (edit.end > priorStart) throw new Error('external docs markdown edits overlap')
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end)
    priorStart = edit.start
  }
  return result
}

function requiredOffset(offset: number | undefined, sourcePath: string): number {
  if (offset === undefined) throw new Error(`${sourcePath}: markdown parser did not provide source offsets`)
  return offset
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
