import { readFileSync } from 'node:fs'

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { showFooterLanguage } from '../src/util/footer'

const SITE_ORIGIN = 'https://strandsagents.com'

function builtPage(route: string): Document {
  const html = readFileSync(new URL(`../dist/${route}/index.html`, import.meta.url), 'utf8')
  return new JSDOM(html).window.document
}

function footerFor(route: string): HTMLElement {
  const footer = builtPage(route).querySelector<HTMLElement>('.site-footer')
  if (!footer) throw new Error(`Missing compact footer on ${route}`)
  return footer
}

function linkByText(root: ParentNode, text: string): HTMLAnchorElement {
  const link = [...root.querySelectorAll<HTMLAnchorElement>('a')].find(
    (candidate) => candidate.textContent?.trim() === text
  )
  if (!link) throw new Error(`Missing "${text}" link`)
  return link
}

function expectDocumentationIssue(link: HTMLAnchorElement, repository: string, pagePath: string): void {
  const href = new URL(link.href)
  expect(href.pathname).toBe(`/strands-agents/${repository}/issues/new`)

  const pageUrl = `${SITE_ORIGIN}/${pagePath}/`
  if (repository === 'harness-sdk') {
    expect(href.searchParams.get('template')).toBe('documentation_improvement.yml')
    expect(href.searchParams.get('documentation-section')).toBe(pageUrl)
  } else {
    expect(href.searchParams.get('body')).toContain(`Page: ${pageUrl}`)
  }
}

describe('compact docs footer output', () => {
  it('shows both SDK language streams and links to the SDK changelog and issue tracker', () => {
    const footer = footerFor('docs/user-guide/sdk')
    const releases = [...footer.querySelectorAll<HTMLElement>('.site-footer__release')]
    const byLanguage = Object.fromEntries(releases.map((release) => [release.dataset.releaseLang, release]))

    expect(Object.keys(byLanguage).sort()).toEqual(['Python', 'TypeScript'])
    expect(byLanguage.Python?.textContent?.trim()).toEqual(expect.stringMatching(/^SDK Python v\S+.+$/))
    expect(byLanguage.TypeScript?.textContent?.trim()).toEqual(expect.stringMatching(/^SDK TypeScript v\S+.+$/))
    expect(byLanguage.Python?.querySelector('a')?.getAttribute('href')).toMatch(/^\/changelog\/sdk\/python-v[^/]+\/$/)
    expect(byLanguage.TypeScript?.querySelector('a')?.getAttribute('href')).toMatch(
      /^\/changelog\/sdk\/typescript-v[^/]+\/$/
    )
    expect(linkByText(footer, 'Changelog →').getAttribute('href')).toBe('/changelog/?sdk=sdk')
    expectDocumentationIssue(linkByText(footer, 'Open an issue'), 'harness-sdk', 'docs/user-guide/sdk')
  })

  it('shows the single Box stream and links to the Box changelog and issue tracker', () => {
    const footer = footerFor('docs/user-guide/box')
    const releases = [...footer.querySelectorAll<HTMLElement>('.site-footer__release')]

    expect(releases).toHaveLength(1)
    expect(releases[0]?.hasAttribute('data-release-lang')).toBe(false)
    expect(releases[0]?.textContent?.trim()).toEqual(expect.stringMatching(/^Box v\S+.+$/))
    expect(releases[0]?.querySelector('a')?.getAttribute('href')).toMatch(/^\/changelog\/box\/v[^/]+\/$/)
    expect(linkByText(footer, 'Changelog →').getAttribute('href')).toBe('/changelog/?sdk=box')
    expectDocumentationIssue(linkByText(footer, 'Open an issue'), 'box', 'docs/user-guide/box')
  })

  it('omits releases for Shell while keeping its issue tracker', () => {
    const footer = footerFor('docs/user-guide/shell')

    expect(footer.querySelector('.site-footer__release')).toBeNull()
    expect(footer.querySelector('.site-footer__more')).toBeNull()
    expectDocumentationIssue(linkByText(footer, 'Open an issue'), 'shell', 'docs/user-guide/shell')
  })

  it('omits releases on non-product docs and uses the site issue tracker', () => {
    const footer = footerFor('docs/contribute')

    expect(footer.querySelector('.site-footer__release')).toBeNull()
    expect(footer.querySelector('.site-footer__more')).toBeNull()
    expectDocumentationIssue(linkByText(footer, 'Open an issue'), 'harness-sdk', 'docs/contribute')
  })

  it('omits the release row on the changelog itself', () => {
    const footer = footerFor('changelog')

    expect(footer.querySelector('.site-footer__release')).toBeNull()
    expect(footer.querySelector('.site-footer__more')).toBeNull()
    expectDocumentationIssue(linkByText(footer, 'Open an issue'), 'harness-sdk', 'changelog')
  })
})

describe('showFooterLanguage', () => {
  it('shows only the preferred stream and responds when the preference changes', () => {
    const document = new JSDOM(`
      <footer class="site-footer">
        <span data-release-lang="Python"></span>
        <span data-release-lang="TypeScript"></span>
      </footer>
    `).window.document
    const python = document.querySelector<HTMLElement>('[data-release-lang="Python"]')!
    const typescript = document.querySelector<HTMLElement>('[data-release-lang="TypeScript"]')!

    showFooterLanguage(document, 'Python')
    expect(python.hidden).toBe(false)
    expect(typescript.hidden).toBe(true)

    showFooterLanguage(document, 'TypeScript')
    expect(python.hidden).toBe(true)
    expect(typescript.hidden).toBe(false)
  })

  it('keeps every stream visible when the preference has no matching release', () => {
    const document = new JSDOM(`
      <footer class="site-footer">
        <span data-release-lang="Python" hidden></span>
        <span data-release-lang="TypeScript" hidden></span>
      </footer>
    `).window.document

    showFooterLanguage(document, 'Java')

    expect([...document.querySelectorAll<HTMLElement>('[data-release-lang]')].every((release) => !release.hidden)).toBe(
      true
    )
  })
})
