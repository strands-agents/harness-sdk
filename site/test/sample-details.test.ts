import { describe, expect, it, vi } from 'vitest'
import {
  defaultSampleDetail,
  getSampleDetailPath,
  getSampleGuideKind,
  getSampleGuideLabel,
  getSampleRunCommands,
  getSampleRunWorkingDirectory,
  getSampleSourceUrl,
  renderSampleMarkdown,
  renderSampleMarkdownParts,
  resolveSampleHref,
  sampleCategories,
  sampleDetails,
  sampleFileId,
  sampleSnapshotSource,
  type SampleDetail,
} from '../src/util/sample-details'

const sample = sampleDetails[0]
if (!sample) throw new Error('Expected at least one sample in the snapshot')

const sampleWithFile = sampleDetails.find((candidate) => candidate.files.length > 0) ?? sample

describe('sample details', () => {
  it('loads a pinned snapshot shared by the catalog and detail routes', () => {
    expect(sampleSnapshotSource.repository).toBeTruthy()
    expect(sampleSnapshotSource.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(sampleCategories.length).toBeGreaterThan(0)
    expect(sampleDetails.length).toBeGreaterThan(0)
  })

  it('maps every sample id to its stable internal route', () => {
    expect(getSampleDetailPath(sample.id)).toBe(`/examples/${sample.slug}/`)
    expect(getSampleDetailPath(defaultSampleDetail.id)).toBe('/examples/')
    expect(getSampleDetailPath('unknown')).toBeUndefined()
  })

  it('labels notebook-led guides without coupling to one guide field', () => {
    const notebookSample = {
      ...sample,
      guide: { ...sample.guide, kind: undefined, format: 'notebook' },
    } as SampleDetail

    expect(getSampleGuideKind(notebookSample)).toBe('notebook')
    expect(getSampleGuideLabel(notebookSample)).toBe('Notebook')
  })

  it('normalizes optional run metadata', () => {
    const configuredSample = {
      ...sample,
      metadata: {
        ...sample.metadata,
        run: {
          workingDirectory: 'src',
          commands: ['npm install', 'npm start'],
        },
      },
    } satisfies SampleDetail

    expect(getSampleRunCommands(configuredSample)).toEqual(['npm install', 'npm start'])
    expect(getSampleRunWorkingDirectory(configuredSample)).toBe('src')
    expect(getSampleRunCommands({ ...sample, metadata: { ...sample.metadata, run: undefined } })).toEqual([])
  })

  it('rewrites relative images against the pinned source commit', () => {
    expect(resolveSampleHref(sample, 'README.md', 'images/example.png', 'image')).toBe(
      `https://raw.githubusercontent.com/${sample.source.repository}/${sample.source.commit}/` +
        `${sample.source.path}/images/example.png`
    )
  })

  it('links included files to the on-page file viewer', () => {
    const file = sampleWithFile.files[0]
    if (!file) return
    expect(resolveSampleHref(sampleWithFile, sampleWithFile.guide.path, file.path, 'link')).toBe(
      `#${sampleFileId(file.path)}`
    )
  })

  it('does not allow relative or root-relative links to escape the sample root', () => {
    const sourceUrl =
      `https://github.com/${sample.source.repository}/tree/${sample.source.commit}/` + sample.source.path

    expect(resolveSampleHref(sample, 'README.md', '../../../../package.json', 'link')).toBe(sourceUrl)
    expect(resolveSampleHref(sample, 'README.md', '/package.json', 'link')).toBe(sourceUrl)
  })

  it('keeps valid sibling-sample and repository links pinned to their targets', () => {
    const hitl = sampleDetails.find((candidate) => candidate.slug === 'python/human-in-the-loop')
    const memory = sampleDetails.find((candidate) => candidate.slug === 'python/memory')
    const triage = sampleDetails.find((candidate) => candidate.slug === 'python/triage-agent')
    if (!hitl || !memory || !triage) throw new Error('Expected cross-linked samples in the generated snapshot')

    expect(resolveSampleHref(hitl, hitl.guide.path, '../06-memory/', 'link')).toBe(getSampleDetailPath(memory.id))
    expect(renderSampleMarkdown(hitl, '[Memory](../06-memory/)', hitl.guide.path)).toContain(
      `href="${getSampleDetailPath(memory.id)}"`
    )
    expect(resolveSampleHref(triage, triage.guide.path, '../../../CONTRIBUTING.md', 'link')).toBe(
      `https://github.com/${triage.source.repository}/blob/${triage.source.commit}/CONTRIBUTING.md`
    )
  })

  it('applies the deployment base path to cross-sample links', () => {
    const hitl = sampleDetails.find((candidate) => candidate.slug === 'python/human-in-the-loop')
    const memory = sampleDetails.find((candidate) => candidate.slug === 'python/memory')
    if (!hitl || !memory) throw new Error('Expected cross-linked samples in the generated snapshot')

    vi.stubEnv('BASE_URL', '/pr-cms-123/')
    expect(resolveSampleHref(hitl, hitl.guide.path, '../06-memory/', 'link')).toBe(
      `/pr-cms-123${getSampleDetailPath(memory.id)}`
    )
    vi.unstubAllEnvs()
  })

  it('renders untrusted markdown without active HTML', () => {
    const html = renderSampleMarkdown(
      sample,
      '# Duplicate title\n\n<script>alert(1)</script>\n\n[External](https://example.com)',
      'README.md',
      { stripTitle: true }
    )

    expect(html).not.toContain('<h1>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
  })

  it('renders safe raw HTML and rewrites its relative links against the pinned snapshot', () => {
    const file = sampleWithFile.files[0]
    if (!file) throw new Error('Expected a rendered sample file')

    const html = renderSampleMarkdown(
      sampleWithFile,
      [
        '<div style="text-align:center">',
        `  <a href="${file.path}" onclick="alert(1)">Open source</a>`,
        '  <img src="images/diagram.png" alt="Diagram" onerror="alert(1)" />',
        '  <video src="media/demo.mp4" autoplay onplay="alert(1)"></video>',
        '</div>',
      ].join('\n'),
      'README.md'
    )

    expect(html).toContain('<div>')
    expect(html).toContain(`href="#${sampleFileId(file.path)}"`)
    expect(html).toContain(
      `src="https://raw.githubusercontent.com/${sampleWithFile.source.repository}/${sampleWithFile.source.commit}/` +
        `${sampleWithFile.source.path}/images/diagram.png"`
    )
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
    expect(html).toContain('alt="Diagram"')
    expect(html).toContain(
      `src="https://raw.githubusercontent.com/${sampleWithFile.source.repository}/${sampleWithFile.source.commit}/` +
        `${sampleWithFile.source.path}/media/demo.mp4"`
    )
    expect(html).toContain('controls="controls"')
    expect(html).toContain('preload="metadata"')
    expect(html).not.toContain('style=')
    expect(html).not.toContain('onclick=')
    expect(html).not.toContain('onerror=')
    expect(html).not.toContain('onplay=')
    expect(html).not.toContain('autoplay')
  })

  it('escapes disallowed raw tags and neutralizes unsafe URL schemes', () => {
    const html = renderSampleMarkdown(
      sample,
      '<stop/>\n\n<a href="javascript:alert(1)">Unsafe</a>\n\n<iframe src="https://example.com"></iframe>',
      'README.md'
    )

    expect(html).toContain('&lt;stop&gt;')
    expect(html).toContain('&lt;iframe')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('javascript:')
    expect(html).toContain(`href="${getSampleSourceUrl(sample)}"`)
  })

  it('removes a leading-content Setext title and adds deterministic fragment ids', () => {
    const html = renderSampleMarkdown(
      sample,
      [
        '[Status badge](https://example.com/status)',
        '',
        'Duplicate sample title',
        '======================',
        '',
        '[Jump to setup](#setup)',
        '',
        '## Setup',
        '',
        '## Setup',
      ].join('\n'),
      'README.md',
      { stripTitle: true }
    )

    expect(html).toContain('Status badge')
    expect(html).not.toContain('Duplicate sample title')
    expect(html).not.toContain('<h1')
    expect(html).toContain('href="#setup"')
    expect(html).toContain('<h2 id="setup">Setup</h2>')
    expect(html).toContain('<h2 id="setup-1">Setup</h2>')
  })

  it('demotes additional h1 sections after removing the document title', () => {
    const html = renderSampleMarkdown(sample, '# Duplicate title\n\n# Additional section', 'README.md', {
      stripTitle: true,
    })

    expect(html).not.toContain('<h1')
    expect(html).toContain('<h2 id="additional-section">Additional section</h2>')
  })

  it('keeps guide headings and fragment links clear of page-level ids', () => {
    const html = renderSampleMarkdown(sample, '## Files\n\n[Jump to files](#files)', 'README.md', {
      stripTitle: true,
    })

    expect(html).toContain('<h2 id="sample-guide-files">Files</h2>')
    expect(html).toContain('href="#sample-guide-files"')
  })

  it('normalizes heading jumps after removing the guide title', () => {
    const html = renderSampleMarkdown(sample, '# Title\n\n#### Deep section\n\n###### Child', 'README.md', {
      stripTitle: true,
    })

    expect(html).toContain('<h2 id="deep-section">Deep section</h2>')
    expect(html).toContain('<h3 id="child">Child</h3>')
  })

  it('adds an empty alt attribute to raw decorative images', () => {
    const html = renderSampleMarkdown(sample, '<img src="images/diagram.png">', 'README.md')
    expect(html).toContain('alt=""')
  })

  it('extracts nested code fences without losing their surrounding markdown structure', () => {
    const markdown = [
      '1. Install the dependencies:',
      '',
      '   ```bash',
      '   npm install',
      '   ```',
      '',
      '> Then run:',
      '>',
      '> ```powershell',
      '> npm start',
      '> ```',
    ].join('\n')
    const parts = renderSampleMarkdownParts(sample, markdown, 'README.md')
    const codeParts = parts.filter((part) => part.type === 'code')
    const html = renderSampleMarkdown(sample, markdown, 'README.md')

    expect(codeParts).toEqual([
      { type: 'code', code: 'npm install\n', language: 'bash', meta: '' },
      { type: 'code', code: 'npm start\n', language: 'powershell', meta: '' },
    ])
    expect(html).toContain('<ol>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<pre><code class="language-bash">npm install')
    expect(html).toContain('<pre><code class="language-powershell">npm start')
    expect(html).not.toContain('STRANDS_SAMPLE_CODE_')
  })

  it('creates stable file panel ids', () => {
    const id = sampleFileId('src/firstAgent.ts')
    expect(id).toMatch(/^sample-file-src-firstagent-ts-[0-9a-f]{8}$/)
    expect(sampleFileId('a/b-c.ts')).not.toBe(sampleFileId('a-b/c.ts'))
  })
})
