import { describe, it, expect } from 'vitest'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import remarkWideBlocks, { WIDE_BLOCK_CLASS } from '../src/plugins/remark-wide-blocks'
import type { Root, RootContent } from 'mdast'

type Node = RootContent & { name?: string; data?: { hName?: string; hProperties?: Record<string, unknown> } }

function transform(markdown: string, mdx = false): Node[] {
  const processor = unified().use(remarkParse).use(remarkGfm)
  if (mdx) processor.use(remarkMdx)
  processor.use(remarkDirective)
  const tree = processor.parse(markdown) as Root
  remarkWideBlocks()(tree)
  return tree.children as Node[]
}

describe('remarkWideBlocks', () => {
  it('renders :::wide as a div with the wide-block class', () => {
    const [node] = transform(':::wide\n| A | B |\n| - | - |\n| 1 | 2 |\n:::')

    expect(node.type).toBe('containerDirective')
    expect(node.data?.hName).toBe('div')
    expect(node.data?.hProperties).toEqual({ className: [WIDE_BLOCK_CLASS] })
    expect((node as { children: Node[] }).children[0].type).toBe('table')
  })

  it('keeps a fenced code block inside the wrapper', () => {
    const [node] = transform(':::wide\n```python\nprint("hi")\n```\n:::')

    expect(node.data?.hName).toBe('div')
    expect((node as { children: Node[] }).children[0].type).toBe('code')
  })

  it('wraps JSX in MDX', () => {
    const [node] = transform(':::wide\n<FoundationComparison />\n:::', true)

    expect(node.data?.hName).toBe('div')
    expect((node as { children: Node[] }).children[0].type).toBe('mdxJsxFlowElement')
  })

  it('leaves asides and other directives alone', () => {
    const [note] = transform(':::note\nHello\n:::')

    expect(note.name).toBe('note')
    expect(note.data?.hName).toBeUndefined()
  })
})
