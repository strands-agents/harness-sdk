import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Agent } from '$/sdk/index.js'
import { fileEditor } from '$/sdk/vended-tools/file-editor/index.js'
import { collectGenerator } from '$/sdk/__fixtures__/model-test-helpers.js'
import { promises as fs } from 'fs'
import * as path from 'path'
import { tmpdir } from 'os'
import { bedrock } from '../__fixtures__/model-providers.js'

describe.skipIf(bedrock.skip)('FileEditor Tool Integration', () => {
  let testDir: string

  // Shared agent configuration for all tests
  const createAgent = () =>
    new Agent({
      model: bedrock.createModel({
        region: 'us-east-1',
      }),
      tools: [fileEditor],
    })

  beforeEach(async () => {
    // Create a temporary test directory
    testDir = path.join(tmpdir(), `file-editor-integ-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true })
    } catch (error) {
      console.error('Failed to clean up test directory', testDir)
      console.error(error)
    }
  })

  it('should create and view a file via prompt', async () => {
    const agent = createAgent()
    const testFile = path.join(testDir, 'test.txt')

    // Create a file
    await agent.invoke(`Create a file at ${testFile} with content "Hello World"`)

    // Verify file was created on disk
    const fileContent = await fs.readFile(testFile, 'utf-8')
    expect(fileContent).toBe('Hello World')

    // View the file
    const { items: events } = await collectGenerator(agent.stream(`View the file at ${testFile}`))

    // The agent should have received the file content
    const textBlocks = events.filter((e: any) => e.type === 'contentBlockEvent' && e.contentBlock.type === 'textBlock')
    expect(textBlocks.length).toBeGreaterThan(0)
  }, 60000)

  it('should edit a file using str_replace', async () => {
    const agent = createAgent()
    const testFile = path.join(testDir, 'edit-test.txt')

    // Create initial file
    await agent.invoke(`Create a file at ${testFile} with content "Hello OLD World"`)

    // Replace text
    await agent.invoke(`In the file ${testFile}, replace "OLD" with "NEW"`)

    // Verify the replacement on disk
    const fileContent = await fs.readFile(testFile, 'utf-8')
    expect(fileContent).toBe('Hello NEW World')
  }, 60000)

  it('should insert text at specific lines', async () => {
    const agent = createAgent()
    const testFile = path.join(testDir, 'insert-test.txt')

    // Create file with multiple lines
    const initialContent = 'Line 1\nLine 2\nLine 3'
    await agent.invoke(`Create a file at ${testFile} with content "${initialContent}"`)

    // Insert text at line 2
    await agent.invoke(`In the file ${testFile}, insert "Inserted Line" at line 2`)

    // Verify the insertion on disk
    const fileContent = await fs.readFile(testFile, 'utf-8')
    expect(fileContent).toBe('Line 1\nLine 2\nInserted Line\nLine 3')
  }, 60000)

  it('should handle errors gracefully', async () => {
    const agent = createAgent()
    const nonExistentFile = path.join(testDir, 'does-not-exist.txt')

    // Try to view non-existent file
    const { items: events } = await collectGenerator(agent.stream(`View the file at ${nonExistentFile}`))

    // The agent should handle the error and provide a reasonable response
    const toolResults = events.filter((e: any) => e.type === 'toolResultEvent')
    expect(toolResults.length).toBeGreaterThan(0)

    // The model should have handled the error gracefully
    const textBlocks = events.filter((e: any) => e.type === 'contentBlockEvent' && e.contentBlock.type === 'textBlock')
    expect(textBlocks.length).toBeGreaterThan(0)
  }, 60000)

  it('should view directory contents', async () => {
    const agent = createAgent()

    // Create some files in the test directory
    await fs.writeFile(path.join(testDir, 'file1.txt'), 'content1', 'utf-8')
    await fs.writeFile(path.join(testDir, 'file2.txt'), 'content2', 'utf-8')
    await fs.mkdir(path.join(testDir, 'subdir'), { recursive: true })
    await fs.writeFile(path.join(testDir, 'subdir', 'file3.txt'), 'content3', 'utf-8')

    // View the directory
    const { items: events } = await collectGenerator(agent.stream(`List the files in directory ${testDir}`))

    // The agent should have received the directory listing
    const textBlocks = events.filter((e: any) => e.type === 'contentBlockEvent' && e.contentBlock.type === 'textBlock')
    expect(textBlocks.length).toBeGreaterThan(0)
  }, 60000)

  it('should handle multi-line file content', async () => {
    const agent = createAgent()
    const testFile = path.join(testDir, 'multiline-test.txt')

    // Create file with multiple lines
    const multilineContent = `Line 1
Line 2
Line 3
Line 4`

    await agent.invoke(`Create a file at ${testFile} with this content:
${multilineContent}`)

    // Verify file was created correctly
    const fileContent = await fs.readFile(testFile, 'utf-8')
    expect(fileContent).toContain('Line 1')
    expect(fileContent).toContain('Line 4')

    // Replace multi-line content
    await agent.invoke(`In the file ${testFile}, replace "Line 2
Line 3" with "Replaced Lines"`)

    // Verify replacement
    const updatedContent = await fs.readFile(testFile, 'utf-8')
    expect(updatedContent).toContain('Replaced Lines')
    expect(updatedContent).not.toContain('Line 2')
  }, 60000)

  it('should handle view with line ranges', async () => {
    const agent = createAgent()
    const testFile = path.join(testDir, 'range-test.txt')

    // Create file with multiple lines
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5'
    await agent.invoke(`Create a file at ${testFile} with content "${content}"`)

    // View specific line range
    const { items: events } = await collectGenerator(agent.stream(`View lines 2 to 4 of file ${testFile}`))

    // The agent should have used view_range parameter
    const toolResults = events.filter((e: any) => e.type === 'toolResultEvent')
    expect(toolResults.length).toBeGreaterThan(0)
  }, 60000)
})
