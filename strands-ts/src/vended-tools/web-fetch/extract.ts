/**
 * HTML → markdown extraction for the web fetch tool.
 *
 * Delegates HTML-to-markdown conversion to turndown with ATX headings and
 * fenced code blocks. Non-content elements (scripts, styles, media, forms,
 * etc.) are dropped entirely. `data:` URI images are replaced with their alt
 * text (or nothing) to avoid enormous blobs in the output. `javascript:`
 * hrefs and src values are stripped silently.
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

// Strip invisible characters before URL scheme detection.
function _stripInvisible(value: string): string {
  return value.replace(/^[\p{Cc}\p{Cf}\p{Zs}]+/u, '')
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
  // Strip javascript: src values entirely.
  td.addRule('safeImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const element = node as HTMLImageElement
      const src = (element.getAttribute('src') ?? '').trim()
      const alt = element.getAttribute('alt') ?? ''
      if (!src) return alt
      try {
        const scheme = new URL(_stripInvisible(src)).protocol
        if (scheme === 'javascript:') return ''
        if (scheme === 'data:') return alt
      } catch {
        // not an absolute URL — pass through as-is
      }
      return `![${alt}](${src})`
    },
  })

  // Strip javascript: hrefs — render link text only.
  td.addRule('safeLink', {
    filter: (node) => {
      if (node.nodeName !== 'A') return false
      const href = ((node as HTMLAnchorElement).getAttribute('href') ?? '').trim()
      try {
        return new URL(_stripInvisible(href)).protocol === 'javascript:'
      } catch {
        return false
      }
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
