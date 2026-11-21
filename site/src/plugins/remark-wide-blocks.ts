/**
 * Remark plugin for the `:::wide` container directive.
 *
 * Wrapping one figure, table, or code block in `:::wide` lets it grow past the text column
 * into spare room beside it on large screens. The plugin only renders the wrapper as
 * `<div class="wide-block">`; the width rules live in `src/styles/custom.css`.
 *
 * ```md
 * :::wide
 * | A | B | C | D | E |
 * | - | - | - | - | - |
 * :::
 * ```
 *
 * Directive attributes are kept, so `:::wide{#options}` adds an anchor and `:::wide{.foo}`
 * adds a class next to `wide-block`. A wide block has no label: `:::wide[Caption]` drops the
 * caption and logs a warning instead of rendering it as a stray paragraph.
 *
 * Starlight registers `remark-directive`, so the syntax works in `.md` and `.mdx` pages,
 * including imported external docs.
 */
import type { Root } from 'mdast'
import type {} from 'mdast-util-directive'
// Adds `hName` and `hProperties` to mdast's node data types.
import type {} from 'remark-rehype'
import type { Transformer } from 'unified'
import { visit } from 'unist-util-visit'

export const WIDE_BLOCK_CLASS = 'wide-block'

export default function remarkWideBlocks(): Transformer<Root> {
  return (tree, file) => {
    visit(tree, 'containerDirective', (node) => {
      if (node.name !== 'wide') return

      const label = node.children[0]
      if (label?.type === 'paragraph' && label.data?.directiveLabel) {
        node.children.shift()
        // Astro never reads vfile messages, so log directly, like remark-mkdocs-snippets does.
        const line = label.position ? `:${label.position.start.line}` : ''
        console.warn(
          `[remark-wide-blocks] ${file?.path ?? '<unknown file>'}${line}: \`:::wide\` takes no label; the label was dropped`
        )
      }

      const { class: extraClasses, ...attributes } = node.attributes ?? {}
      const properties: Record<string, string> = {}
      for (const [key, value] of Object.entries(attributes)) {
        if (value != null) properties[key] = value
      }
      node.data = {
        ...node.data,
        hName: 'div',
        hProperties: {
          ...properties,
          className: [WIDE_BLOCK_CLASS, ...(extraClasses?.split(/\s+/).filter(Boolean) ?? [])],
        },
      }
    })
  }
}
