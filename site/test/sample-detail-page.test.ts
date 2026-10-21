import { existsSync, readFileSync } from 'node:fs'

import { parse, type HTMLElement } from 'node-html-parser'
import { describe, expect, it } from 'vitest'
import {
  getSampleGuideKind,
  getSampleDetailPath,
  getSampleRunCommands,
  renderSampleMarkdownParts,
  sampleCategories,
  sampleDetails,
  sampleSnapshotSource,
  type SampleDetail,
} from '../src/util/sample-details'
import { getSamplePagePath } from '../src/util/sample-navigation'

const defaultSample = sampleDetails.find((candidate) => candidate.slug === 'typescript/first-agent')
if (!defaultSample) throw new Error('Expected the default TypeScript First Agent sample')

const sample =
  sampleDetails.find((candidate) => candidate.slug !== defaultSample.slug && candidate.files.length > 0) ??
  sampleDetails.find((candidate) => candidate.slug !== defaultSample.slug)
if (!sample) throw new Error('Expected at least one non-default generated sample page')

const defaultPage = readFileSync(new URL('../dist/examples/index.html', import.meta.url), 'utf8')
const notebookSample = sampleDetails.find((candidate) => getSampleGuideKind(candidate) === 'notebook')
const detailPage = readFileSync(new URL(`../dist/examples/${sample.slug}/index.html`, import.meta.url), 'utf8')
const canonicalHref = parse(defaultPage).querySelector('link[rel="canonical"]')?.getAttribute('href')
if (!canonicalHref) throw new Error('Expected a canonical URL on the default examples page')
const canonicalPath = new URL(canonicalHref).pathname
const defaultRoute = getSamplePagePath(defaultSample)
if (!canonicalPath.endsWith(defaultRoute)) {
  throw new Error(`Expected canonical path ${canonicalPath} to end with ${defaultRoute}`)
}
const builtBasePath = canonicalPath.slice(0, -defaultRoute.length).replace(/\/$/, '')

function expectedSampleHref(candidate: SampleDetail): string {
  return `${builtBasePath}${getSamplePagePath(candidate)}`
}

function readSamplePage(candidate: SampleDetail): string {
  return candidate.slug === defaultSample.slug
    ? defaultPage
    : readFileSync(new URL(`../dist/examples/${candidate.slug}/index.html`, import.meta.url), 'utf8')
}

function sidebarNavigation(html: string): HTMLElement {
  const sidebar = parse(html).querySelector('#starlight__sidebar')
  if (!sidebar) throw new Error('Expected the Starlight documentation sidebar')

  return sidebar.querySelector('sl-sidebar-state-persist') ?? sidebar
}

function currentSidebarLink(html: string): HTMLElement {
  const current = sidebarNavigation(html).querySelectorAll('a[aria-current="page"]')
  expect(current).toHaveLength(1)

  const link = current[0]
  if (!link) throw new Error('Expected one current sample link')
  return link
}

describe('sample detail page', () => {
  it('renders the guide and selected files on-site', () => {
    expect(detailPage).toContain(sample.metadata.summary)
    expect(detailPage).toContain(sample.guide.path)
    expect(detailPage).toContain('aria-labelledby="guide-tab"')
    expect(detailPage).toContain('aria-labelledby="files-tab"')
    expect(detailPage).toContain('data-pagefind-ignore')

    const file = sample.files[0]
    if (file) {
      expect(detailPage).toContain(file.path)

      const filePanel = parse(detailPage)
        .querySelectorAll('[data-sample-file-panel]')
        .find((panel) => panel.getAttribute('data-sample-file-panel') === file.path)
      const renderedCode = filePanel
        ?.querySelector('.copy button[data-code]')
        ?.getAttribute('data-code')
        ?.replaceAll('\u007f', '\n')

      expect(renderedCode).toBe(file.content.trimEnd())
    }
  })

  it('pins source and fallback links to the generated snapshot commit', () => {
    expect(detailPage).toContain(sample.source.commit)
    expect(detailPage).toContain('Browse the full repository snapshot')
    expect(detailPage).not.toContain(`/tree/main/${sample.source.path}`)
  })

  it('shows rendered files and omitted source entries', () => {
    expect(detailPage).toContain(`${sample.files.length} files rendered`)
    if (sample.skippedFileCount > 0) {
      expect(detailPage).toContain(`${sample.skippedFileCount} additional source`)
    } else {
      expect(detailPage).toContain('all selected source files rendered')
    }
  })

  it('labels notebook-led guides as notebooks', () => {
    if (!notebookSample) return
    const notebookPage = readFileSync(
      new URL(`../dist/examples/${notebookSample.slug}/index.html`, import.meta.url),
      'utf8'
    )
    expect(notebookPage).toContain('Read the notebook')
    expect(notebookPage).toContain('>Notebook<')
  })
})

describe('examples documentation navigation', () => {
  it('renders the first TypeScript sample on the initial examples page', () => {
    const page = parse(defaultPage)

    expect(page.querySelector('[data-sample-detail]')).not.toBeNull()
    expect(page.querySelectorAll('[data-sample-card]')).toHaveLength(0)
    expect(defaultPage).toContain(defaultSample.metadata.summary)
    expect(defaultPage).toContain(defaultSample.guide.path)

    const current = currentSidebarLink(defaultPage)
    expect(current.getAttribute('href')).toBe(expectedSampleHref(defaultSample))
    expect(current.text.trim()).toBe(defaultSample.metadata.title)
  })

  it('lists every sample beneath its category on every examples page', () => {
    for (const html of [defaultPage, detailPage]) {
      const navigation = sidebarNavigation(html)
      const sections = navigation.querySelectorAll('.section-group')

      for (const category of sampleCategories) {
        const expectedHrefs = sampleDetails
          .filter(
            (candidate) =>
              candidate.metadata.language.toLowerCase() === category.language.toLowerCase() &&
              candidate.metadata.category === category.id
          )
          .map(expectedSampleHref)
        if (expectedHrefs.length === 0) continue

        const matchingLabel = sections.filter(
          (section) => section.querySelector('.section-label')?.text.trim() === category.label
        )
        const group = matchingLabel.find((section) => {
          const actualHrefs = section.querySelectorAll('a').map((anchor) => anchor.getAttribute('href'))
          return (
            actualHrefs.length === expectedHrefs.length && expectedHrefs.every((href) => actualHrefs.includes(href))
          )
        })

        expect(group, `Missing ${category.language} / ${category.label} sample section`).toBeDefined()
      }

      expect(navigation.querySelectorAll('a')).toHaveLength(sampleDetails.length)
    }
  })

  it('lists every sample in the mobile Examples navigation', () => {
    const page = parse(defaultPage)
    const examplesCategory = page
      .querySelectorAll('.mobile-menu__cat')
      .find((category) => category.querySelector('.mobile-menu__cat-title')?.text.trim() === 'Examples')
    const links = examplesCategory
      ?.querySelectorAll('.mobile-menu__pages a')
      .map((anchor) => anchor.getAttribute('href'))

    expect(links).toHaveLength(sampleDetails.length)
    expect(new Set(links)).toEqual(new Set(sampleDetails.map(expectedSampleHref)))
  })

  it('keeps the complete sidebar and selected-sample state on every detail route', () => {
    for (const candidate of sampleDetails) {
      if (candidate.slug === defaultSample.slug) continue

      const html = readSamplePage(candidate)
      const navigation = sidebarNavigation(html)
      const current = currentSidebarLink(html)

      expect(navigation.querySelectorAll('a')).toHaveLength(sampleDetails.length)
      expect(current.getAttribute('href')).toBe(expectedSampleHref(candidate))
      expect(current.text.trim()).toBe(candidate.metadata.title)
    }
  })

  it('keeps every route helper aligned with a generated page', () => {
    for (const candidate of sampleDetails) {
      const route = getSampleDetailPath(candidate.id)
      if (!route) throw new Error(`Expected a route for ${candidate.id}`)
      expect(existsSync(new URL(`../dist${route}index.html`, import.meta.url)), route).toBe(true)
    }
  })
})

describe('examples code blocks', () => {
  it('uses the documentation code renderer for guide, setup, and file code', () => {
    for (const candidate of sampleDetails) {
      const page = parse(readSamplePage(candidate))
      const detail = page.querySelector('[data-sample-detail]')
      if (!detail) throw new Error(`Expected the ${candidate.slug} sample detail`)

      const guideParts = renderSampleMarkdownParts(candidate, candidate.guide.markdown, candidate.guide.path, {
        stripTitle: true,
      })
      const renderedGuideCode = guideParts.filter((part) => part.type === 'code' && part.code.trim())
      const emptyGuideCode = guideParts.filter((part) => part.type === 'code' && !part.code.trim())
      const renderedFileCode = candidate.files.filter((file) => file.content.trim())
      const expectedCodeBlocks =
        renderedGuideCode.length + renderedFileCode.length + (getSampleRunCommands(candidate).length > 0 ? 1 : 0)
      const codeBlocks = detail.querySelectorAll('.expressive-code figure.frame')

      expect(codeBlocks, candidate.slug).toHaveLength(expectedCodeBlocks)
      expect(detail.querySelectorAll('pre'), candidate.slug).toHaveLength(expectedCodeBlocks + emptyGuideCode.length)

      for (const block of codeBlocks) {
        expect(block.querySelector('pre[data-language]')).not.toBeNull()
        expect(block.toString()).toContain('class="ec-line"')
        expect(block.toString()).toContain('class="code"')
        expect(block.querySelector('.copy button[data-code]')).not.toBeNull()
      }
    }
  })

  it('keeps source links pinned to the generated snapshot', () => {
    expect(defaultPage).toContain(`${sampleSnapshotSource.repository}@${sampleSnapshotSource.commit.slice(0, 7)}`)
    expect(defaultPage).not.toContain('raw.githubusercontent.com/tmoreton')
    expect(defaultPage).not.toContain('add-samples-manifest')
  })
})

describe('examples document integrity', () => {
  it('emits unique ids and valid sample aria-controls relationships', () => {
    for (const candidate of sampleDetails) {
      const page = parse(readSamplePage(candidate))
      const ids = page.querySelectorAll('[id]').map((element) => element.getAttribute('id'))
      expect(new Set(ids).size, `${candidate.slug} duplicate id`).toBe(ids.length)

      const detail = page.querySelector('[data-sample-detail]')
      if (!detail) throw new Error(`Expected the ${candidate.slug} sample detail`)
      for (const control of detail.querySelectorAll('[aria-controls]')) {
        const targetId = control.getAttribute('aria-controls')
        expect(page.querySelectorAll(`#${targetId}`), `${candidate.slug} aria-controls=${targetId}`).toHaveLength(1)
      }
    }
  })

  it('gives every rendered guide image an alt attribute', () => {
    for (const candidate of sampleDetails) {
      const page = parse(readSamplePage(candidate))
      for (const image of page.querySelectorAll('.sample-detail__readme img')) {
        expect(image.getAttribute('alt'), `${candidate.slug} image ${image.getAttribute('src')}`).not.toBeNull()
      }
    }
  })

  it('keeps rendered guide heading levels sequential', () => {
    for (const candidate of sampleDetails) {
      const page = parse(readSamplePage(candidate))
      let previousLevel = 1
      for (const heading of page.querySelectorAll(
        '.sample-detail__readme h1, .sample-detail__readme h2, .sample-detail__readme h3, .sample-detail__readme h4, .sample-detail__readme h5, .sample-detail__readme h6'
      )) {
        const level = Number(heading.tagName.slice(1))
        expect(level, `${candidate.slug} heading jump after h${previousLevel}`).toBeLessThanOrEqual(previousLevel + 1)
        previousLevel = level
      }
    }
  })
})
