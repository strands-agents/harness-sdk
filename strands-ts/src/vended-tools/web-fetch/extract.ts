/**
 * HTML → markdown extraction for the web fetch tool.
 *
 * Delegates HTML-to-markdown conversion to turndown with ATX headings and
 * fenced code blocks. Non-content elements (scripts, styles, media, forms,
 * etc.) are dropped entirely. `data:` URI images are replaced with their alt
 * text (or nothing) to avoid enormous blobs in the output. Images with a
 * `javascript:` or `vbscript:` source are dropped, and links with a
 * `javascript:`, `vbscript:`, or `data:` href are reduced to their text.
 * Body text, the page title, image alt text, and link titles and URLs are
 * escaped so they cannot change the structure of the output.
 *
 * Requires `turndown` as an optional peer dependency.
 */

import type TurndownService from 'turndown'

import { logger } from '../../logging/logger.js'

// Elements whose entire subtree is discarded.
const DROPPED_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'nav',
]

// Read the scheme after stripping leading whitespace and invisible characters, and tab/CR/LF anywhere as browsers do.
// The rest of the URL is not parsed: a malformed host must not hide the scheme.
function _urlScheme(url: string): string {
  const stripped = url.replace(/^[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]+/u, '').replace(/[\t\n\r]/g, '')
  return /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped)?.[1]?.toLowerCase() ?? ''
}

// Strip what URL parsers strip from both ends of a URL. trim() differs from Python's strip().
function _trimC0ControlOrSpace(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value.charCodeAt(start) <= 0x20) start++
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--
  return value.slice(start, end)
}

// Collapse whitespace and control characters, and escape markdown and HTML syntax, so the text is plain text.
// A "(" can only open a link destination after a "]", so it is escaped only there.
function _escapeText(text: string): string {
  return text
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .replace(/[\\[\]`~]/g, '\\$&')
    .replace(/(\\\] ?)\(/g, '$1\\(')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Image alt text can directly follow a "![" or a "]": a "^" or "(" at its start is escaped too.
function _escapeAltText(text: string): string {
  return _escapeText(text).replace(/^(?=\^)|^ ?(?=\()/, '$&\\')
}

// Drop tabs and newlines as URL parsers do, and percent-encode what a markdown parser could read as syntax.
function _escapeUrl(url: string): string {
  return url
    .replace(/[\t\n\r]/g, '')
    .replace(/[\s\p{Cc}<>\\"`]/gu, (char) => encodeURIComponent(char))
    .replace(/[()']/g, (char) => `%${char.charCodeAt(0).toString(16)}`)
}

async function loadTurndown(): Promise<typeof TurndownService> {
  try {
    return (await import('turndown')).default
  } catch (cause) {
    throw new Error("web_fetch requires the 'turndown' package. Install it with: npm install turndown", { cause })
  }
}

async function _createTurndownService(): Promise<TurndownService> {
  const Turndown = await loadTurndown()

  const td = new Turndown({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  })

  // Cast needed because svg/noscript/template are absent from HTMLElementTagNameMap.
  td.remove(DROPPED_ELEMENTS as unknown as import('turndown').Filter)

  // Render the <title> as a top-level heading so it appears in the document
  // body rather than being silently dropped (turndown ignores <head> elements).
  td.addRule('title', {
    filter: 'title',
    replacement: (_content, node) => {
      // The title is one line of plain text. "*" and "_" are escaped as they are in body text.
      const text = _escapeText((node as HTMLElement).textContent ?? '')
        .replace(/[*_]/g, '\\$&')
        .trim()
      return text ? `# ${text}\n\n` : ''
    },
  })

  // Replace data: URI images with alt text only (they can be enormous blobs).
  // Strip javascript: and vbscript: src values entirely.
  td.addRule('safeImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const element = node as HTMLImageElement
      const src = _trimC0ControlOrSpace(element.getAttribute('src') ?? '')
      const alt = _escapeAltText(element.getAttribute('alt') ?? '')
      // Written as bare text, a trailing "!" would turn a link that follows into an image.
      const bareAlt = alt.replace(/!(?= ?$)/, '\\!')
      if (!src) return bareAlt
      const scheme = _urlScheme(src)
      if (scheme === 'javascript' || scheme === 'vbscript') return ''
      if (scheme === 'data') return bareAlt
      return `![${alt}](${_escapeUrl(src)})`
    },
  })

  // Render only the link text for javascript:, vbscript:, and data: hrefs, and for a link with no href.
  td.addRule('safeLink', {
    filter: 'a',
    replacement: (content, node) => {
      const element = node as HTMLAnchorElement
      const href = _trimC0ControlOrSpace(element.getAttribute('href') ?? '')
      const scheme = _urlScheme(href)
      if (!href || scheme === 'javascript' || scheme === 'vbscript' || scheme === 'data') return content
      const title = _escapeText(element.getAttribute('title') ?? '').replace(/"/g, '\\"')
      return `[${content}](${_escapeUrl(href)}${title && ` "${title}"`})`
    },
  })

  return td
}

// Cache the configured service so rules are registered once across all calls.
let _turndownServicePromise: Promise<TurndownService> | null = null

/**
 * Convert HTML to markdown suitable for a model to read.
 *
 * The page title, if present, is rendered as a top-level ATX heading so the
 * model sees it as part of the document. Returns the original HTML string if
 * conversion fails.
 *
 * @param html - Raw HTML string to convert.
 * @returns The converted markdown string, or the original HTML if conversion failed.
 */
export async function htmlToMarkdown(html: string): Promise<string> {
  _turndownServicePromise ??= _createTurndownService()
  const td = await _turndownServicePromise
  try {
    const markdown = td.turndown(html).trim()
    return markdown ? markdown + '\n' : ''
  } catch (error) {
    logger.warn(`error=<${error}> | html_to_markdown failed, returning raw html`)
    return html
  }
}
