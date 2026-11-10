/**
 * Remark plugin for mkdocs-style code snippets.
 *
 * Replaces snippet references in code blocks with actual file content:
 *   --8<-- "path/to/file.ts:section_name"
 *
 * Source files use markers to define sections:
 *   // --8<-- [start:section_name]
 *   ...code...
 *   // --8<-- [end:section_name]
 *
 * See SITE-ARCHITECTURE.md for usage details.
 */

import { visit } from 'unist-util-visit'
import fs from 'node:fs'
import path from 'node:path'
import type { Root, Code } from 'mdast'
import type { VFile } from 'vfile'

interface RemarkMkdocsSnippetsOptions {
  baseDir?: string
}

const SNIPPET_PATTERN = /^-+8<-+\s*"([^"]+)"$/
const START_MARKER_PATTERN = /--8<--\s*\[start:\s*([^\]]+?)\s*\]/
const END_MARKER_PATTERN = /--8<--\s*\[end:\s*([^\]]+?)\s*\]/

/** Extract named section from file content, removing common indentation */
function extractSection(content: string, sectionName: string): string | null {
  const lines = content.split('\n')
  let inSection = false
  const sectionLines: string[] = []

  for (const line of lines) {
    const startMatch = line.match(START_MARKER_PATTERN)
    const endMatch = line.match(END_MARKER_PATTERN)

    if (startMatch && startMatch[1]?.trim() === sectionName.trim()) {
      inSection = true
      continue
    }

    if (endMatch && endMatch[1]?.trim() === sectionName.trim()) {
      break
    }

    if (inSection) {
      sectionLines.push(line)
    }
  }

  if (sectionLines.length === 0) return null

  // Dedent: find minimum indentation and remove it from all lines
  const nonEmptyLines = sectionLines.filter((line) => line.trim().length > 0)
  if (nonEmptyLines.length === 0) return sectionLines.join('\n')

  const minIndent = Math.min(
    ...nonEmptyLines.map((line) => {
      const match = line.match(/^(\s*)/)
      return match?.[1]?.length ?? 0
    })
  )

  return sectionLines
    .map((line) => line.slice(minIndent))
    .join('\n')
    .trim()
}

export default function remarkMkdocsSnippets(options: RemarkMkdocsSnippetsOptions = {}) {
  const baseDir = options.baseDir || path.resolve(process.cwd(), 'src/content/docs')

  return (tree: Root, file: VFile) => {
    visit(tree, 'code', (node: Code) => {
      if (!node.value) return

      const lines = node.value.trim().split('\n')
      const processedLines: string[] = []
      let hasSnippets = false

      for (const line of lines) {
        const match = line.trim().match(SNIPPET_PATTERN)

        if (!match) {
          processedLines.push(line)
          continue
        }

        hasSnippets = true
        const reference = match[1]!

        // Parse "path:section" or just "path" (handle Windows paths with drive letters)
        const colonIndex = reference.lastIndexOf(':')
        const hasSection = colonIndex > 0 && reference[colonIndex - 1] !== '\\'
        const filePath = hasSection ? reference.slice(0, colonIndex) : reference
        const sectionName = hasSection ? reference.slice(colonIndex + 1) : null

        const resolvedPath = path.resolve(baseDir, filePath)

        try {
          const fileContent = fs.readFileSync(resolvedPath, 'utf-8')

          if (sectionName) {
            const extracted = extractSection(fileContent, sectionName)
            if (extracted === null) {
              console.warn(`[remark-mkdocs-snippets] Section "${sectionName}" not found in ${resolvedPath}`)
              processedLines.push(`// Section "${sectionName}" not found in ${filePath}`)
            } else {
              processedLines.push(extracted)
            }
          } else {
            processedLines.push(fileContent.trim())
          }
        } catch {
          console.warn(`[remark-mkdocs-snippets] Failed to read file: ${resolvedPath}`)
          processedLines.push(`// Failed to load snippet from ${filePath}`)
        }
      }

      if (hasSnippets) {
        node.value = processedLines.join('\n')
      }
    })
  }
}
