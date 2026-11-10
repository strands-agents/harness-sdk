/**
 * Remark plugin that calculates reading time and injects it into frontmatter.
 *
 * Follows the Astro recipe: https://docs.astro.build/en/recipes/reading-time/
 * Uses the same plugin pattern as remark-mkdocs-snippets.ts.
 */
import { toString } from 'mdast-util-to-string'
import getReadingTime from 'reading-time'
import type { Root } from 'mdast'

export default function remarkReadingTime() {
  return (tree: Root, file: { data: { astro?: { frontmatter?: Record<string, unknown> } } }) => {
    const textOnPage = toString(tree)
    const readingTime = getReadingTime(textOnPage)

    if (!file.data.astro) {
      file.data.astro = {}
    }
    if (!file.data.astro.frontmatter) {
      file.data.astro.frontmatter = {}
    }
    file.data.astro.frontmatter.readingTime = readingTime.text
  }
}
