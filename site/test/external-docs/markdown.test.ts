import { describe, expect, it } from 'vitest'
import { transformExternalMarkdown } from '../../scripts/external-docs/markdown'

const revision = '1234567890abcdef1234567890abcdef12345678'
const context = {
  sourcePath: 'docs/user/guide.md',
  currentRoute: 'docs/user-guide/box/source/guide',
  repository: 'https://github.com/strands-agents/box',
  revision,
  editRef: 'main',
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

    expect(transformed)
      .toBe(`See [published](../other/#part), [design](https://github.com/strands-agents/box/blob/${revision}/docs/design/architecture.md), and
![diagram](https://raw.githubusercontent.com/strands-agents/box/${revision}/docs/design/images/diagram.svg).

\`\`\`markdown
[sample](./other.md)
\`\`\`
`)
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

    expect(transformed).toBe(`[Source](https://github.com/strands-agents/box/tree/${revision}/docs)
[Edit](https://github.com/strands-agents/box/edit/main)

\`\`\`sh
curl https://raw.githubusercontent.com/strands-agents/box/${revision}/download.sh
curl https://raw.githubusercontent.com/another/project/main/download.sh
\`\`\`
`)
  })

  it('keeps same-repository edit URLs on the configured editable ref', () => {
    const source = '# Source title\n\n[Edit](https://github.com/strands-agents/box/edit/main/docs/user/guide.md)\n'
    const transformed = transformExternalMarkdown(source, { ...context, editRef: 'docs-source' })

    expect(transformed).toBe('[Edit](https://github.com/strands-agents/box/edit/docs-source/docs/user/guide.md)\n')
  })

  it('rewrites the destination when a link title repeats the URL', () => {
    const transformed = transformExternalMarkdown('# Source title\n\n[Other](./other.md "./other.md")\n', context)
    expect(transformed).toBe('[Other](../other/ "./other.md")\n')
  })

  it('rewrites a link definition whose label contains a colon', () => {
    const transformed = transformExternalMarkdown(
      '# Source title\n\nSee [the other page][foo:bar].\n\n[foo:bar]: ./other.md\n',
      context
    )
    expect(transformed).toBe('See [the other page][foo:bar].\n\n[foo:bar]: ../other/\n')
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

  it('preserves braces and import-like paragraphs as plain Markdown prose', () => {
    const source = `# Source title

Replace {name} with your box.

import and export are ordinary words in a Markdown paragraph.
`
    expect(transformExternalMarkdown(source, context)).toBe(
      'Replace {name} with your box.\n\nimport and export are ordinary words in a Markdown paragraph.\n'
    )
  })

  it.each([
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
