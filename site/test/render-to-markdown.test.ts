import { describe, it, expect } from 'vitest'
import type { CollectionEntry } from 'astro:content'
import { renderImplementation } from '../src/util/render-to-markdown'
import type { SourceLink } from '../src/content.config'

function docWithSourceLinks(sourceLinks?: SourceLink[]): CollectionEntry<'docs'> {
  return {
    id: 'docs/user-guide/example',
    collection: 'docs',
    data: { title: 'Example', tags: [], sourceLinks },
  } as unknown as CollectionEntry<'docs'>
}

describe('renderImplementation', () => {
  it('returns empty string when there are no source links', () => {
    expect(renderImplementation(docWithSourceLinks(undefined))).toBe('')
    expect(renderImplementation(docWithSourceLinks([]))).toBe('')
  })

  it('infers language from the file extension and groups under per-language headings', () => {
    const md = renderImplementation(
      docWithSourceLinks([
        { path: 'strands-py/src/strands/agent/agent.py', repo: 'harness-sdk' },
        { path: 'strands-ts/src/agent/agent.ts', repo: 'harness-sdk' },
      ])
    )

    expect(md).toContain('## Implementation')
    expect(md).toContain('### Python')
    expect(md).toContain('### TypeScript')
    expect(md).toContain(
      '- [harness-sdk/strands-py/src/strands/agent/agent.py]' +
        '(https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py)'
    )
    expect(md).toContain(
      '- [harness-sdk/strands-ts/src/agent/agent.ts]' +
        '(https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts)'
    )
  })

  it('collects multiple links for the same language under one heading', () => {
    const md = renderImplementation(
      docWithSourceLinks([
        { path: 'strands-py/src/strands/models/bedrock.py', repo: 'harness-sdk' },
        { path: 'strands-py/src/strands/models/model.py', repo: 'harness-sdk' },
      ])
    )

    expect(md.match(/### Python/g)).toHaveLength(1)
    expect(md).toContain('bedrock.py')
    expect(md).toContain('model.py')
  })

  it('preserves first-seen language order', () => {
    const md = renderImplementation(
      docWithSourceLinks([
        { path: 'strands-ts/src/agent/agent.ts', repo: 'harness-sdk' },
        { path: 'strands-py/src/strands/agent/agent.py', repo: 'harness-sdk' },
      ])
    )

    expect(md.indexOf('### TypeScript')).toBeLessThan(md.indexOf('### Python'))
  })

  it('respects an explicit language override over the extension', () => {
    const md = renderImplementation(
      docWithSourceLinks([{ path: 'configs/agent.toml', language: 'python', repo: 'harness-sdk' }])
    )

    expect(md).toContain('### Python')
    expect(md).toContain('configs/agent.toml')
  })

  it('honors a custom repo override in the generated URL', () => {
    const md = renderImplementation(docWithSourceLinks([{ path: 'src/tool.py', repo: 'tools' }]))

    expect(md).toContain('https://github.com/strands-agents/tools/blob/main/src/tool.py')
  })
})
