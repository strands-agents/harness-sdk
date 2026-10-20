import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AstroIntegration } from 'astro'

function stripBase(urlPath: string, base: string): string {
  const normalizedBase = `/${base.replace(/^\/+|\/+$/g, '')}`
  if (normalizedBase === '/') return urlPath
  if (urlPath === normalizedBase || urlPath === `${normalizedBase}/`) return '/'
  if (!urlPath.startsWith(`${normalizedBase}/`)) {
    throw new Error(`[legacy-redirect-pages] target "${urlPath}" is outside base "${normalizedBase}/"`)
  }
  return urlPath.slice(normalizedBase.length)
}

function outputFile(outputDir: string, urlPath: string, base = '/'): string {
  const routePath = stripBase(urlPath, base).replace(/^\/+|\/+$/g, '')
  if (!routePath) return path.join(outputDir, 'index.html')
  if (routePath.endsWith('.html')) return path.join(outputDir, routePath)
  return path.join(outputDir, routePath, 'index.html')
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function injectRedirect(html: string, target: string): string {
  const head = html.match(/<head(?:\s[^>]*)?>/i)?.[0]
  if (!head) {
    throw new Error('[legacy-redirect-pages] destination page has no <head> element')
  }

  const scriptTarget = JSON.stringify(target).replaceAll('<', '\\u003c')
  const redirectHead = [
    `<base href="${escapeAttribute(target)}">`,
    `<meta http-equiv="refresh" content="0;url=${escapeAttribute(target)}">`,
    '<script>',
    `const target = new URL(${scriptTarget}, window.location.origin);`,
    'target.search = window.location.search;',
    'target.hash = window.location.hash;',
    'window.location.replace(target.href);',
    '</script>',
  ].join('')

  return html.replace(head, `${head}${redirectHead}`)
}

/**
 * Replace Astro's internal redirect stubs with the destination page HTML.
 *
 * Browsers still redirect immediately, while clients that ignore JavaScript
 * and meta refresh receive the same rendered guide content at the legacy URL.
 * The base element keeps relative links anchored to the destination route.
 * Destination files are located assuming `build.format: 'directory'`.
 */
export async function writeLegacyRedirectPages(
  outputDir: string,
  redirects: Record<string, string>,
  base = '/'
): Promise<number> {
  const internalRedirects = Object.entries(redirects).filter(([, target]) => target.startsWith('/'))

  await Promise.all(
    internalRedirects.map(async ([source, target]) => {
      const targetFile = outputFile(outputDir, target, base)
      const sourceFile = outputFile(outputDir, source)
      const html = await fs.readFile(targetFile, 'utf-8').catch((error: unknown) => {
        throw new Error(`legacy redirect ${source} -> ${target}: cannot read ${targetFile}`, { cause: error })
      })

      await fs.mkdir(path.dirname(sourceFile), { recursive: true })
      await fs.writeFile(sourceFile, injectRedirect(html, target))
    })
  )

  return internalRedirects.length
}

export default function legacyRedirectPages(redirects: Record<string, string>, base = '/'): AstroIntegration {
  return {
    name: 'legacy-redirect-pages',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const count = await writeLegacyRedirectPages(fileURLToPath(dir), redirects, base)
        logger.info(`wrote readable content for ${count} internal legacy routes`)
      },
    },
  }
}
