/**
 * HTML → markdown extraction for the web fetch tool.
 *
 * Delegates HTML-to-markdown conversion to turndown with ATX headings and
 * fenced code blocks. Non-content elements (scripts, styles, media, forms,
 * etc.) are dropped entirely. `data:` URI images are replaced with their alt
 * text (or nothing) to avoid enormous blobs in the output. Images with a
 * `javascript:` or `vbscript:` source are dropped, and links with a
 * `javascript:`, `vbscript:`, or `data:` href are reduced to their text.
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

// Read the scheme from the start of the URL, after stripping leading whitespace and invisible characters.
// The rest of the URL is not parsed: a malformed host must not hide the scheme.
function _urlScheme(url: string): string {
  const stripped = url.replace(/^[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]+/u, '').replace(/[\t\n\r]/g, '')
  return /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped)?.[1]?.toLowerCase() ?? ''
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
      const text = (node as HTMLElement).textContent?.trim() ?? ''
      return text ? `# ${text}\n\n` : ''
    },
  })

  // Replace data: URI images with alt text only (they can be enormous blobs).
  // Strip javascript: and vbscript: src values entirely.
  td.addRule('safeImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const element = node as HTMLImageElement
      const src = (element.getAttribute('src') ?? '').trim()
      const alt = element.getAttribute('alt') ?? ''
      if (!src) return alt
      const scheme = _urlScheme(src)
      if (scheme === 'javascript' || scheme === 'vbscript') return ''
      if (scheme === 'data') return alt
      return `![${alt}](${src})`
    },
  })

  // Render only the link text for javascript:, vbscript:, and data: hrefs.
  td.addRule('safeLink', {
    filter: (node) => {
      if (node.nodeName !== 'A') return false
      const scheme = _urlScheme((node as HTMLAnchorElement).getAttribute('href') ?? '')
      return scheme === 'javascript' || scheme === 'vbscript' || scheme === 'data'
    },
    replacement: (content) => content,
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
