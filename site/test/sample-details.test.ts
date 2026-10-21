import { describe, expect, it } from 'vitest'
import {
  getSampleDetailPath,
  renderSampleMarkdown,
  resolveSampleHref,
  sampleDetails,
  sampleFileId,
} from '../src/util/sample-details'

const sample = sampleDetails[0]
if (!sample) throw new Error('Expected the prototype sample snapshot')

describe('sample details', () => {
  it('maps a sample manifest id to a stable internal route', () => {
    expect(getSampleDetailPath(sample.id)).toBe('/examples/typescript/first-agent/')
    expect(getSampleDetailPath('unknown')).toBeUndefined()
  })

  it('rewrites relative images against the pinned source commit', () => {
    expect(resolveSampleHref(sample, 'README.md', 'images/simple_agent.png', 'image')).toBe(
      `https://raw.githubusercontent.com/strands-agents/samples/${sample.source.commit}/` +
        'typescript/01-learn/01-first-agent/images/simple_agent.png'
    )
  })

  it('links included files to the on-page file viewer', () => {
    expect(resolveSampleHref(sample, 'README.md', 'src/firstAgent.ts', 'link')).toBe('#sample-file-src-firstagent-ts')
  })

  it('does not allow relative links to escape the sample root', () => {
    expect(resolveSampleHref(sample, 'README.md', '../../../../package.json', 'link')).toBe(
      `https://github.com/strands-agents/samples/tree/${sample.source.commit}/${sample.source.path}`
    )
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

  it('creates stable file panel ids', () => {
    expect(sampleFileId('src/firstAgent.ts')).toBe('sample-file-src-firstagent-ts')
  })
})
