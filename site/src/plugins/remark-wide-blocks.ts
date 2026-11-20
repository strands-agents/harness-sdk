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
 * Starlight registers `remark-directive`, so the syntax works in `.md` and `.mdx` pages,
 * including imported external docs.
 */
import { visit } from 'unist-util-visit'
import type { Root } from 'mdast'

export const WIDE_BLOCK_CLASS = 'wide-block'

interface DirectiveLike {
  type: string
  name?: string
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

export default function remarkWideBlocks() {
  return (tree: Root) => {
    visit(tree, (node) => {
      const directive = node as DirectiveLike
      if (directive.type !== 'containerDirective' || directive.name !== 'wide') return
      directive.data = { ...directive.data, hName: 'div', hProperties: { className: [WIDE_BLOCK_CLASS] } }
    })
  }
}
