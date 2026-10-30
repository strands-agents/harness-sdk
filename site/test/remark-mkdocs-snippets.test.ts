import { describe, it, expect, beforeAll } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkMkdocsSnippets from '../src/plugins/remark-mkdocs-snippets.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('remark-mkdocs-snippets', () => {
  let tempDir: string

  beforeAll(() => {
    // Create a temp directory for test fixtures
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snippets-test-'))

    // Create a test source file with section markers
    const sourceContent = `import { Agent } from '@strands-agents/sdk'

// --8<-- [start:basic_example]
const agent = new Agent()
const result = await agent.invoke('Hello!')
console.log(result)
// --8<-- [end:basic_example]

// --8<-- [start:advanced_example]
const advancedAgent = new Agent({
  model: 'claude-3',
  tools: []
})
// --8<-- [end:advanced_example]

// Some other code
function helper() {
  return 'helper'
}
`
    fs.writeFileSync(path.join(tempDir, 'example.ts'), sourceContent)

    // Create a file with indented sections
    const indentedContent = `class MyClass {
  // --8<-- [start:method]
  async doSomething() {
    const x = 1
    return x + 1
  }
  // --8<-- [end:method]
}
`
    fs.writeFileSync(path.join(tempDir, 'indented.ts'), indentedContent)

    // Create a file with spaces in markers (like some mkdocs files have)
    const spacedContent = `# --8<-- [start: imports]
from strands import Agent
# --8<-- [end: imports]
`
    fs.writeFileSync(path.join(tempDir, 'spaced.py'), spacedContent)
  })

  async function processMarkdown(markdown: string, baseDir: string): Promise<string> {
    const result = await unified()
      .use(remarkParse)
      .use(remarkMkdocsSnippets, { baseDir })
      .use(remarkStringify)
      .process(markdown)
    return String(result)
  }

  it('should replace snippet reference with file section content', async () => {
    const markdown = `# Example

\`\`\`typescript
--8<-- "example.ts:basic_example"
\`\`\`
`
    const result = await processMarkdown(markdown, tempDir)

    expect(result).toContain('const agent = new Agent()')
    expect(result).toContain('await agent.invoke')
    expect(result).not.toContain('--8<--')
    expect(result).not.toContain('[start:')
  })

  it('should handle multiple snippets in one code block', async () => {
    const markdown = `\`\`\`typescript
--8<-- "example.ts:basic_example"
--8<-- "example.ts:advanced_example"
\`\`\`
`
    const result = await processMarkdown(markdown, tempDir)

    expect(result).toContain('const agent = new Agent()')
    expect(result).toContain('const advancedAgent = new Agent')
  })

  it('should remove common indentation from sections', async () => {
    const markdown = `\`\`\`typescript
--8<-- "indented.ts:method"
\`\`\`
`
    const result = await processMarkdown(markdown, tempDir)

    // Should have the method content without the class-level indentation
    expect(result).toContain('async doSomething()')
    expect(result).toContain('const x = 1')
  })

  it('should handle markers with spaces around section name', async () => {
    const markdown = `\`\`\`python
--8<-- "spaced.py:imports"
\`\`\`
`
    const result = await processMarkdown(markdown, tempDir)

    expect(result).toContain('from strands import Agent')
  })

  it('should preserve non-snippet lines in code blocks', async () => {
    const markdown = `\`\`\`typescript
// Some comment
--8<-- "example.ts:basic_example"
// Another comment
\`\`\`
`
    const result = await processMarkdown(markdown, tempDir)

    expect(result).toContain('// Some comment')
    expect(result).toContain('// Another comment')
    expect(result).toContain('const agent = new Agent()')
  })

  it('should handle missing section gracefully', async () => {
    const markdown = `\`\`\`typescript
--8<-- "example.ts:nonexistent_section"
\`\`\`
`
    const result = await processMarkdown(markdown, tempDir)

    expect(result).toContain('Section "nonexistent_section" not found')
  })

  it('should handle missing file gracefully', async () => {
    const markdown = `\`\`\`typescript
--8<-- "nonexistent.ts:section"
\`\`\`
`
    const result = await processMarkdown(markdown, tempDir)

    expect(result).toContain('Failed to load snippet')
  })

  it('should include entire file when no section specified', async () => {
    const markdown = `\`\`\`typescript
--8<-- "example.ts"
\`\`\`
`
    const result = await processMarkdown(markdown, tempDir)

    // Should contain the entire file
    expect(result).toContain('import { Agent }')
    expect(result).toContain('function helper()')
  })

  it('should handle various dash lengths in snippet syntax', async () => {
    const markdown = `\`\`\`typescript
-8<- "example.ts:basic_example"
\`\`\`
`
    const result = await processMarkdown(markdown, tempDir)
    expect(result).toContain('const agent = new Agent()')

    const markdown2 = `\`\`\`typescript
---8<--- "example.ts:basic_example"
\`\`\`
`
    const result2 = await processMarkdown(markdown2, tempDir)
    expect(result2).toContain('const agent = new Agent()')
  })

  it('should not modify code blocks without snippet syntax', async () => {
    const markdown = `\`\`\`typescript
const x = 1
const y = 2
\`\`\`
`
    const result = await processMarkdown(markdown, tempDir)

    expect(result).toContain('const x = 1')
    expect(result).toContain('const y = 2')
  })
})
