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

  it('passes through any JSX element whose attributes are literal strings', () => {
    const source = `# Source title

<YouTube id="j6zR0sPeMko" title="Episode 1" />

<Card variant="info">
  Hello from a component the site has auto-imported.
</Card>
`
    const transformed = transformExternalMarkdown(source, context)
    expect(transformed).toContain('<YouTube id="j6zR0sPeMko" title="Episode 1" />')
    expect(transformed).toContain('<Card variant="info">')
    expect(transformed).toContain('</Card>')
  })

  it('rejects an attribute whose value is an expression', () => {
    expect(() => transformExternalMarkdown('# Source title\n\n<YouTube id={x} />\n', context)).toThrow(
      /must be a literal string/
    )
  })

  it('rejects a spread or expression-only attribute', () => {
    expect(() => transformExternalMarkdown('# Source title\n\n<YouTube {...props} />\n', context)).toThrow(
      /spread or expression attribute/
    )
  })

  it('rejects an ESM import statement', () => {
    expect(() => transformExternalMarkdown("# Source title\n\nimport Foo from 'bar'\n\n<Foo />\n", context)).toThrow(
      /import and export/
    )
  })

  it('rejects a bare {expression} in prose', () => {
    expect(() => transformExternalMarkdown('# Source title\n\nReplace {name} with your box.\n', context)).toThrow(
      /bare \{expression\}/
    )
  })

  it('leaves braces inside inline code alone', () => {
    const source = '# Source title\n\nSee `/orders/{order_id}/replacement`.\n'
    expect(transformExternalMarkdown(source, context)).toBe('See `/orders/{order_id}/replacement`.\n')
  })

  it('leaves JSX inside a fenced code block as literal text', () => {
    const source = `# Source title

\`\`\`md
<YouTube id="j6zR0sPeMko" title="Example" />
\`\`\`
`
    const output = transformExternalMarkdown(source, context)
    expect(output).toContain('<YouTube id="j6zR0sPeMko" title="Example" />')
    expect(output).not.toContain('youtube-nocookie.com')
  })

  it('treats lines that happen to contain "import"/"export" mid-paragraph as prose', () => {
    const source = '# Source title\n\nThe words import and export are ordinary in a Markdown paragraph.\n'
    expect(transformExternalMarkdown(source, context)).toBe(
      'The words import and export are ordinary in a Markdown paragraph.\n'
    )
  })

  it('passes raw HTML tags through literally — upstream owns what it renders', () => {
    const source = '# Source title\n\n<section class="note">Hello</section>\n'
    expect(transformExternalMarkdown(source, context)).toContain('<section class="note">Hello</section>')
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
