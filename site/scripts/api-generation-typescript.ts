/**
 * Generate TypeScript API documentation using typedoc-plugin-markdown.
 *
 * This script runs typedoc to generate markdown files, then post-processes them
 * to add frontmatter with slugs for Astro/Starlight compatibility.
 *
 * Usage:
 *   npx tsx scripts/api-generation-typescript.ts
 */

import { execSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync, mkdirSync } from 'fs'
import { join, basename, relative } from 'path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { mdxToMarkdown } from 'mdast-util-mdx'

const OUTPUT_DIR = '.build/api-docs/typescript'

interface FileInfo {
  path: string
  category: string // 'classes', 'interfaces', 'type-aliases', 'functions', 'variables', 'enumerations', or 'index'
  name: string
  namespace?: string // set for members under namespaces/<ns>/
}

/**
 * Recursively get all .md files in a directory
 */
function getAllMdFiles(dir: string, baseDir: string = dir): FileInfo[] {
  const files: FileInfo[] = []

  if (!existsSync(dir)) {
    return files
  }

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      files.push(...getAllMdFiles(fullPath, baseDir))
    } else if (entry.endsWith('.md')) {
      const relativePath = relative(baseDir, fullPath)
      const parts = relativePath.split('/')

      let category: string
      let name: string

      // Find 'namespaces' segment anywhere in the path (typedoc may nest under a project-name dir)
      const nsIdx = parts.indexOf('namespaces')

      if (parts.length === 1) {
        // Root level file (index.md)
        category = 'index'
        name = basename(entry, '.md')
        files.push({ path: fullPath, category, name })
      } else if (nsIdx !== -1 && parts.length > nsIdx + 2) {
        // Namespace file: [.../namespaces/<ns>/index.md] or [.../namespaces/<ns>/<category>/<Name>.md]
        const ns = parts[nsIdx + 1]!
        const afterNs = parts.slice(nsIdx + 2)
        if (afterNs.length === 1 && basename(entry, '.md') === 'index') {
          // namespaces/<ns>/index.md — keep as a dedicated namespace page
          files.push({ path: fullPath, category: 'namespaces', name: ns, namespace: ns })
        } else if (afterNs.length === 2) {
          // namespaces/<ns>/<category>/<Name>.md
          category = afterNs[0]!
          name = basename(entry, '.md')
          files.push({ path: fullPath, category, name, namespace: ns })
        }
        // deeper nesting not expected; ignore
      } else {
        // Nested file (classes/Agent.md)
        category = parts[0]!
        name = basename(entry, '.md')
        files.push({ path: fullPath, category, name })
      }
    }
  }

  return files
}

/**
 * Generate a slug for a file (flat, without category)
 */
function generateSlug(category: string, name: string, namespace?: string): string {
  if (category === 'index') {
    return 'docs/api/typescript'
  }
  if (category === 'namespaces') {
    return `docs/api/typescript/${name}`
  }
  if (namespace) {
    return `docs/api/typescript/${namespace}:${name}`
  }
  return `docs/api/typescript/${name}`
}

/**
 * Generate a title for a file
 */
function generateTitle(category: string, name: string): string {
  if (category === 'index') {
    return 'TypeScript API Reference'
  }
  return name
}

/**
 * Escape MDX-unsafe characters in markdown content using the unified pipeline.
 * Parses as GFM markdown, then serializes with mdxToMarkdown() which escapes
 * characters like { } that are valid in markdown but invalid in MDX outside code blocks.
 * Content inside code fences is left untouched.
 */
async function escapeMdxChars(content: string): Promise<string> {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify)
  processor.data('toMarkdownExtensions', [mdxToMarkdown()])
  const result = await processor.process(content)
  return String(result)
}

/**
 * Process a single file: add frontmatter, escape MDX-unsafe chars, write as .mdx
 */
async function processFile(file: FileInfo): Promise<void> {
  const content = readFileSync(file.path, 'utf-8')

  // Check if frontmatter already exists
  if (content.startsWith('---')) {
    console.log(`Skipping (already has frontmatter): ${file.path}`)
    return
  }

  const slug = generateSlug(file.category, file.name, file.namespace)
  const title = generateTitle(file.category, file.name)

  // For the index file, we'll create a custom one later
  if (file.category === 'index') {
    console.log(`Skipping index file (will be replaced): ${file.path}`)
    return
  }

  // Fix relative links to remove category folders (e.g., ../interfaces/AgentData.md -> ../AgentData.md)
  // Also update .md extensions to .mdx in relative links since we output .mdx files
  // For namespace members, also strip the extra ../ that points up from the category subfolder
  // For namespace index pages, rewrite category-prefixed links to absolute slug paths
  //   e.g. interfaces/TracerConfig.md -> /api/typescript/telemetry:TracerConfig
  let linkedFixed = content
    .replace(/\]\(\.\.\/(classes|interfaces|type-aliases|functions|variables|enumerations)\/([^)]+)\)/g, '](../$2)')
    .replace(/\]\(\.\.\/([^./][^)]+\.md(?:#[^)]*)?)\)/g, ']($1)')

  if (file.namespace) {
    // Rewrite category-prefixed links in namespace pages/members to relative paths
    linkedFixed = linkedFixed.replace(
      /\]\((classes|interfaces|type-aliases|functions|variables|enumerations|namespaces)\/([^)]+?)\.md((?:#[^)]*)?)\)/g,
      (_match, _cat, name, hash) => `](../${file.namespace}:${name}/${hash})`
    )
    // Also rewrite bare Name.md links (after ../category/ was already stripped) to relative paths
    linkedFixed = linkedFixed.replace(
      /\]\(([A-Za-z][^)/]+?)\.md((?:#[^)]*)?)\)/g,
      (_match, name, hash) => `](../${file.namespace}:${name}/${hash})`
    )
  }

  linkedFixed = linkedFixed
    .replace(/\]\((\.\.[^)]+)\.md((?:#[^)]+)?)\)/g, ']($1.mdx$2)')
    .replace(/\]\(([^)]+)\.md((?:#[^)]+)?)\)/g, ']($1.mdx$2)')

  // Special-case: escape the literal string "<name>Data" which typedoc emits in prose
  // to describe the naming pattern for data interfaces (e.g. "the <name>Data pattern").
  // Encode the leading "<" as an HTML entity so MDX renders it as text instead of
  // attempting to parse "<name>" as a JSX tag.
  const specialCased = linkedFixed.replace(/<name>Data/g, '&lt;name>Data')

  // Escape MDX-unsafe characters (e.g. { } outside code blocks)
  const mdxSafe = await escapeMdxChars(specialCased)

  // Add frontmatter with category for sidebar grouping
  const frontmatter = `---
title: "${title}"
slug: ${slug}
category: ${file.category}
editUrl: false
---

`

  const finalContent = frontmatter + mdxSafe

  // Write as .mdx into the flat category folder at OUTPUT_DIR root (not in-place)
  const flatDir = join(OUTPUT_DIR, file.category)
  const mdxPath = join(flatDir, `${file.name}.mdx`)
  if (!existsSync(flatDir)) {
    mkdirSync(flatDir, { recursive: true })
  }
  writeFileSync(mdxPath, finalContent, 'utf-8')
  // Remove the original .md file
  rmSync(file.path)
  console.log(`Processed: ${file.path} → ${file.category}/${file.name}.mdx`)
}

/**
 * Main function
 */
async function main(): Promise<void> {
  console.log('🔧 TypeScript API Documentation Generator\n')

  // Step 1: Clean output directory
  if (existsSync(OUTPUT_DIR)) {
    console.log(`Cleaning output directory: ${OUTPUT_DIR}`)
    rmSync(OUTPUT_DIR, { recursive: true })
  }

  // Step 2: Run typedoc
  console.log('\n📚 Running typedoc...\n')
  try {
    execSync('npx typedoc --options typedoc.json', {
      stdio: 'inherit',
    })
  } catch (error) {
    console.error('Failed to run typedoc')
    process.exit(1)
  }

  // Step 3: Get all generated files
  console.log('\n📝 Post-processing files...\n')
  const files = getAllMdFiles(OUTPUT_DIR)

  // Step 4: Process each file (skip the index file - we have our own)
  for (const file of files) {
    if (file.category === 'index') {
      // Delete the generated index file - we use our own in src/content/docs/api/typescript/index.mdx
      rmSync(file.path)
      console.log(`Deleted: ${file.path} (using custom index)`)
      continue
    }
    await processFile(file)
  }

  console.log(`\n✅ Done! Generated ${files.length - 1} API doc files.`)
}

main().catch(console.error)
