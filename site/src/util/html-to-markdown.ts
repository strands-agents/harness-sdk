import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { isLocalLink, toRawMarkdownUrl } from './links'

export interface HtmlToMarkdownOptions {
  /** Heading style: 'setext' (underlined) or 'atx' (# prefixed) */
  headingStyle?: 'setext' | 'atx'
  /** Horizontal rule character */
  hr?: string
  /** Bullet list marker */
  bulletListMarker?: '-' | '+' | '*'
  /** Code block style: 'indented' or 'fenced' */
  codeBlockStyle?: 'indented' | 'fenced'
  /** Fence character for code blocks */
  fence?: '```' | '~~~'
  /** Emphasis delimiter */
  emDelimiter?: '_' | '*'
  /** Strong delimiter */
  strongDelimiter?: '__' | '**'
  /** Link style: 'inlined' or 'referenced' */
  linkStyle?: 'inlined' | 'referenced'
  /** Link reference style */
  linkReferenceStyle?: 'full' | 'collapsed' | 'shortcut'
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'])

function isYouTubeHost(href: string): boolean {
  try {
    return YOUTUBE_HOSTS.has(new URL(href).hostname)
  } catch {
    return false
  }
}

/**
 * Creates a configured TurndownService instance for HTML to Markdown conversion.
 * Returns the service so you can add custom rules before converting.
 */
export function createTurndownService(options: HtmlToMarkdownOptions = {}): TurndownService {
  const service = new TurndownService({
    headingStyle: options.headingStyle ?? 'atx',
    hr: options.hr ?? '---',
    bulletListMarker: options.bulletListMarker ?? '-',
    codeBlockStyle: options.codeBlockStyle ?? 'fenced',
    fence: options.fence ?? '```',
    emDelimiter: options.emDelimiter ?? '*',
    strongDelimiter: options.strongDelimiter ?? '**',
    linkStyle: options.linkStyle ?? 'inlined',
    linkReferenceStyle: options.linkReferenceStyle ?? 'full',
  })

  service.use(gfm)

  service.addRule('removeSrOnly', {
    filter: (node) => {
      if (node.nodeType !== 1) return false
      const el = node as Element
      const className = el.getAttribute?.('class') || ''
      return className.includes('sr-only')
    },
    replacement: () => '',
  })

  service.addRule('removeScripts', {
    filter: 'script',
    replacement: () => '',
  })

  // Removes lite-youtube and its Play anchor so .md/llms-full.txt don't emit bare '[Play](url)' lines.
  service.addRule('removeLiteYouTube', {
    filter: (node) => {
      if (node.nodeName === 'LITE-YOUTUBE') return true
      if (node.nodeName === 'A') {
        const el = node as Element
        const className = el.getAttribute?.('class') || ''
        if (className.includes('lty-playbtn')) return true
        // hostname parsed, not substring-matched, so lookalike hosts don't count
        const href = el.getAttribute?.('href') || ''
        const text = el.textContent?.trim() || ''
        if (text.toLowerCase() === 'play' && isYouTubeHost(href)) return true
      }
      return false
    },
    replacement: () => '',
  })

  service.addRule('removeAnchorLinks', {
    filter: (node) => {
      if (node.nodeName !== 'A') return false
      const el = node as Element
      const className = el.getAttribute?.('class') || ''
      if (className.includes('sl-anchor-link')) return true
      const href = el.getAttribute?.('href') || ''
      if (href.startsWith('#')) {
        const text = el.textContent?.replace(/\s/g, '') || ''
        return text === ''
      }
      return false
    },
    replacement: () => '',
  })

  service.addRule('removeTabList', {
    filter: (node) => {
      if (node.nodeName !== 'UL') return false
      const el = node as Element
      return el.getAttribute?.('role') === 'tablist'
    },
    replacement: () => '',
  })

  service.addRule('tabPanel', {
    filter: (node) => {
      if (node.nodeName !== 'DIV') return false
      const el = node as Element
      return el.getAttribute?.('role') === 'tabpanel'
    },
    replacement: (content, node) => {
      const el = node as Element
      const labelledBy = el.getAttribute?.('aria-labelledby') || ''

      let tabLabel = ''
      if (labelledBy) {
        const parent = el.parentElement
        if (parent) {
          const tabLink = parent.querySelector?.(`#${labelledBy}`)
          if (tabLink) {
            tabLabel = tabLink.textContent?.trim() || ''
          }
        }
      }

      if (tabLabel) {
        return `\n\n(( tab "${tabLabel}" ))\n${content.trim()}\n(( /tab "${tabLabel}" ))\n\n`
      }
      return content
    },
  })

  // Added before expressiveCodeBlock; Turndown checks last-added first, so expressiveCodeBlock wins.
  service.addRule('fencedCodeBlock', {
    filter: (node, options) => {
      return (
        options.codeBlockStyle === 'fenced' &&
        node.nodeName === 'PRE' &&
        node.firstChild !== null &&
        node.firstChild.nodeName === 'CODE'
      )
    },
    replacement: (_content, node, options) => {
      const codeNode = node.firstChild as Element
      const className = codeNode.getAttribute?.('class') || ''
      // Extract language from class like "language-typescript" or "lang-ts"
      const langMatch = className.match(/(?:language-|lang-)(\w+)/)
      const language = langMatch ? langMatch[1] : ''
      const code = codeNode.textContent || ''

      const fence = options.fence || '```'
      return `\n\n${fence}${language}\n${code.replace(/\n$/, '')}\n${fence}\n\n`
    },
  })

  service.addRule('expressiveCodeBlock', {
    filter: (node) => {
      if (node.nodeName !== 'PRE') return false
      const lang = node.getAttribute?.('data-language')
      return lang != null
    },
    replacement: (_content, node, options) => {
      const language = node.getAttribute?.('data-language') || ''
      const fence = options.fence || '```'

      const lines: string[] = []
      function walk(el: Element | ChildNode) {
        if (el.nodeType === 1) {
          const element = el as Element
          const className = element.getAttribute?.('class') || ''
          if (className.includes('ec-line')) {
            lines.push(element.textContent?.replace(/\n/g, '') || '')
          } else {
            const children = element.childNodes || []
            for (let i = 0; i < children.length; i++) {
              walk(children[i] as Element)
            }
          }
        }
      }
      walk(node as Element)

      const code = lines.length > 0 ? lines.join('\n') : (node.textContent || '')
      return `\n\n${fence}${language}\n${code}\n${fence}\n\n`
    },
  })

  service.addRule('rewriteLocalLinks', {
    filter: (node) => {
      if (node.nodeName !== 'A') return false
      const el = node as Element
      const href = el.getAttribute?.('href') || ''
      return isLocalLink(href)
    },
    replacement: (content, node) => {
      const el = node as Element
      const href = el.getAttribute?.('href') || ''
      const title = el.getAttribute?.('title')
      const newHref = toRawMarkdownUrl(href)

      return title ? `[${content}](${newHref} "${title}")` : `[${content}](${newHref})`
    },
  })

  return service
}

/**
 * Converts HTML string to Markdown.
 */
export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions = {}): string {
  const service = createTurndownService(options)
  return service.turndown(html)
}

/** Convert HTML to Markdown with additional Turndown rules configured via a callback. */
export function htmlToMarkdownWithRules(
  html: string,
  configureService: (service: TurndownService) => void,
  options: HtmlToMarkdownOptions = {}
): string {
  const service = createTurndownService(options)
  configureService(service)
  return service.turndown(html)
}
