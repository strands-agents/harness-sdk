import { describe, expect, it } from 'vitest'
import { transformExternalMarkdown } from '../../scripts/external-docs/markdown'

const revision = '1234567890abcdef1234567890abcdef12345678'
const context = {
  sourcePath: 'docs/user/guide.md',
  repository: 'https://github.com/strands-agents/box',
  revision,
  publishedRoutes: new Map([['docs/user/other.md', 'docs/user-guide/box/source/other']]),
}

describe('external docs Markdown transformation', () => {
  it('strips the source H1 and rewrites links without changing code examples', () => {
    const source = `# Source title

See [published](./other.md#part), [design](../design/architecture.md), and
![diagram](../design/images/diagram.svg).

\`\`\`markdown
[sample](./other.md)
\`\`\`
`
    const transformed = transformExternalMarkdown(source, context)

    expect(transformed).not.toContain('# Source title')
    expect(transformed).toContain('[published](/docs/user-guide/box/source/other/#part)')
    expect(transformed).toContain(
      `[design](https://github.com/strands-agents/box/blob/${revision}/docs/design/architecture.md)`
    )
    expect(transformed).toContain(
      `![diagram](https://raw.githubusercontent.com/strands-agents/box/${revision}/docs/design/images/diagram.svg)`
    )
    expect(transformed).toContain('[sample](./other.md)')
  })

  it('pins same-repository absolute URLs, including URLs in code blocks', () => {
    const source = `# Source title

[Source](https://github.com/strands-agents/box/tree/main/docs)
[Edit](https://github.com/strands-agents/box/edit/main)

\`\`\`sh
curl https://raw.githubusercontent.com/strands-agents/box/main/download.sh
curl https://raw.githubusercontent.com/another/project/main/download.sh
\`\`\`
`
    const transformed = transformExternalMarkdown(source, context)

    expect(transformed).toContain(`https://github.com/strands-agents/box/tree/${revision}/docs`)
    expect(transformed).toContain(`https://github.com/strands-agents/box/edit/${revision}`)
    expect(transformed).toContain(`https://raw.githubusercontent.com/strands-agents/box/${revision}/download.sh`)
    expect(transformed).toContain('https://raw.githubusercontent.com/another/project/main/download.sh')
  })

  it('rewrites the destination when a link title repeats the URL', () => {
    const transformed = transformExternalMarkdown('# Source title\n\n[Other](./other.md "./other.md")\n', context)
    expect(transformed).toContain('[Other](/docs/user-guide/box/source/other/ "./other.md")')
  })

  it('rewrites a link definition whose label contains a colon', () => {
    const transformed = transformExternalMarkdown(
      '# Source title\n\nSee [the other page][foo:bar].\n\n[foo:bar]: ./other.md\n',
      context
    )
    expect(transformed).toContain('[foo:bar]: /docs/user-guide/box/source/other/')
  })

  it.each(['dw', 'cedar'])('normalizes unsupported %s code fences to text', (language) => {
    const transformed = transformExternalMarkdown(
      `# Source title

\`\`\`${language}
example
\`\`\`
`,
      context
    )
    expect(transformed).toContain('```text\nexample\n```')
  })

  it('preserves indentation immediately after the stripped H1', () => {
    const transformed = transformExternalMarkdown('# Source title\n\n    indented code\n', context)
    expect(transformed).toBe('    indented code\n')
  })

  it('keeps the safe HTML used by Box documentation', () => {
    const source = `# Source title

<details>
<summary>Show details</summary>

Text.

</details>

<a id="stable-anchor"></a>
`
    expect(transformExternalMarkdown(source, context)).toContain('<summary>Show details</summary>')
    expect(transformExternalMarkdown(source, context)).toContain('<a id="stable-anchor"></a>')
  })

  it.each([
    ['MDX imports', 'import Example from "./Example.astro"'],
    ['MDX exports', 'export const value = 1'],
    ['MDX expressions', '{dangerousExpression}'],
    ['MDX components', '<DangerousComponent />'],
    ['unsafe HTML', '<script>alert("x")</script>'],
  ])('rejects %s', (_label, construct) => {
    expect(() => transformExternalMarkdown(`# Source title\n\n${construct}\n`, context)).toThrow(
      /not allowed|must be in code/
    )
  })

  it('rejects relative links that escape the repository', () => {
    expect(() => transformExternalMarkdown('# Source title\n\n[secret](../../../outside.md)\n', context)).toThrow(
      /escapes the repository/
    )
  })

  it.each(['javascript:alert(1)', 'data:text/html,unsafe', '//example.com/unsafe'])(
    'rejects unsafe link destination %s',
    (destination) => {
      expect(() => transformExternalMarkdown(`# Source title\n\n[unsafe](${destination})\n`, context)).toThrow(
        /not allowed/
      )
    }
  )

  it('rejects snippet directives that global site plugins would execute', () => {
    const source = `# Source title

\`\`\`text
--8<-- "../../../../.git/config"
\`\`\`
`
    expect(() => transformExternalMarkdown(source, context)).toThrow(/snippet include directives are not allowed/)
  })
})
