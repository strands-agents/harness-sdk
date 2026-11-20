import { afterEach, describe, it, expect, vi } from 'vitest'
import rehypeStringify from 'rehype-stringify'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import remarkWideBlocks, { WIDE_BLOCK_CLASS } from '../src/plugins/remark-wide-blocks'
import type { Root } from 'mdast'

/** Renders Markdown to HTML the way the site does, so the tests check what readers get. */
async function render(markdown: string) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(remarkWideBlocks)
    .use(remarkRehype)
    .use(rehypeStringify)
    .process({ path: 'docs/page.md', value: markdown })
  return { html: String(file), warnings: warn.mock.calls.map((args) => args.join(' ')) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

/** MDX components can't be stringified to HTML, so this one checks the transformed tree. */
async function transformMdx(markdown: string) {
  const processor = unified().use(remarkParse).use(remarkMdx).use(remarkDirective).use(remarkWideBlocks)
  return (await processor.run(processor.parse(markdown))) as Root
}

describe('remarkWideBlocks', () => {
  it('wraps a table in a wide-block div', async () => {
    const { html, warnings } = await render(':::wide\n| A | B |\n| - | - |\n| 1 | 2 |\n:::')

    expect(html).toBe(
      '<div class="wide-block"><table>\n<thead>\n<tr>\n<th>A</th>\n<th>B</th>\n</tr>\n</thead>\n' +
        '<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table></div>'
    )
    expect(warnings).toEqual([])
  })

  it('wraps a fenced code block', async () => {
    const { html } = await render(':::wide\n```python\nprint("hi")\n```\n:::')

    expect(html).toBe('<div class="wide-block"><pre><code class="language-python">print("hi")\n</code></pre></div>')
  })

  it('keeps an id and extra classes from directive attributes', async () => {
    const { html } = await render(':::wide{#options .foo}\nText\n:::')

    expect(html).toBe('<div id="options" class="wide-block foo"><p>Text</p></div>')
  })

  it('drops a label with a warning instead of rendering a stray paragraph', async () => {
    const { html, warnings } = await render(':::wide[Caption]\nText\n:::')

    expect(html).toBe('<div class="wide-block"><p>Text</p></div>')
    expect(warnings).toEqual(['[remark-wide-blocks] docs/page.md:1: `:::wide` takes no label; the label was dropped'])
  })

  it('wraps JSX in MDX', async () => {
    const tree = await transformMdx(':::wide\n<FoundationComparison />\n:::')
    const [node] = tree.children

    expect(node).toMatchObject({ type: 'containerDirective', name: 'wide' })
    expect(node.data).toEqual({ hName: 'div', hProperties: { className: [WIDE_BLOCK_CLASS] } })
    expect((node as { children: { type: string }[] }).children.map((c) => c.type)).toEqual(['mdxJsxFlowElement'])
  })

  it('leaves asides and other directives alone', async () => {
    const tree = await transformMdx(':::note\nHello\n:::')
    const [node] = tree.children

    expect(node).toMatchObject({ type: 'containerDirective', name: 'note' })
    expect(node.data).toBeUndefined()
  })
})
