import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSampleGuides } from '../scripts/samples/importer'

let fixtureDir: string
let sourceDir: string
let outputDir: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: sourceDir, encoding: 'utf8' }).trim()
}

function write(relativePath: string, content: string): void {
  const filePath = path.join(sourceDir, relativePath)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
}

beforeEach(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), 'sample-guides-'))
  sourceDir = path.join(fixtureDir, 'samples')
  outputDir = path.join(fixtureDir, 'output')
  mkdirSync(sourceDir)

  write(
    'samples.json',
    JSON.stringify({
      version: 1,
      repository: 'example/samples',
      categories: [
        { language: 'TypeScript', id: 'learn', label: 'Learn' },
        { language: 'Python', id: 'learn', label: 'Learn' },
      ],
      samples: [
        {
          id: 'readme',
          language: 'TypeScript',
          category: 'learn',
          title: 'README guide',
          description: 'README fixture',
          path: 'typescript/01-learn/01-readme',
        },
        {
          id: 'notebook',
          language: 'Python',
          category: 'learn',
          title: 'Notebook guide',
          description: 'Notebook fixture',
          path: 'python/01-learn/02-notebook',
          notebook: 'guide.ipynb',
        },
      ],
    })
  )
  write(
    'typescript/01-learn/01-readme/README.md',
    [
      '# README guide',
      '',
      '<div align="center">',
      '<img src="images/html.png" alt="HTML image" width="500">',
      '</div>',
      '',
      '<video src="https://example.com/demo.mp4" controls></video>',
      '',
      'Before<br>after',
      '',
      '![One](images/one.png)',
      '![Two](images/two.png)',
      '',
      '![Reference image][diagram]',
      '[Reference file][source]',
      '',
      '[diagram]: images/reference.png',
      '[source]: src/index.ts',
      '',
      '[File](src/index.ts) [Folder](src/)',
      '',
      '```JSON',
      '{"ok": true}',
      '```',
      '',
      '- [x] Keeps GFM task lists',
      '- ~~Keeps strikethrough~~',
      '',
      '# Secondary heading',
    ].join('\n')
  )
  write('typescript/01-learn/01-readme/src/index.ts', 'export const ok = true\n')
  write('typescript/01-learn/01-readme/images/one.png', 'one')
  write('typescript/01-learn/01-readme/images/two.png', 'two')
  write('typescript/01-learn/01-readme/images/html.png', 'html')
  write('typescript/01-learn/01-readme/images/reference.png', 'reference')
  write(
    'python/01-learn/02-notebook/guide.ipynb',
    JSON.stringify({
      metadata: { language_info: { name: 'Python' } },
      cells: [
        { cell_type: 'markdown', source: ['# Notebook guide\n', '\n', 'Notebook introduction.'] },
        {
          cell_type: 'code',
          source: ['print("shown")'],
          outputs: [{ text: ['hidden output'] }],
        },
        { cell_type: 'raw', source: ['hidden raw cell'] },
      ],
    })
  )

  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('add', '.')
  git('commit', '--quiet', '-m', 'fixture')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(fixtureDir, { recursive: true, force: true })
})

describe('buildSampleGuides', () => {
  it('turns README and notebook guides into reproducible site Markdown', async () => {
    const commit = git('rev-parse', 'HEAD')
    await expect(buildSampleGuides({ sourceDir, outputDir })).resolves.toEqual({
      repository: 'example/samples',
      commit,
      sampleCount: 2,
    })

    const readme = readFileSync(path.join(outputDir, 'typescript/readme.md'), 'utf8')
    expect(readme).toContain(`sourceCommit: "${commit}"`)
    expect(readme).toContain('guideKind: "readme"')
    expect(readme).not.toContain('# README guide')
    expect(readme).not.toContain('<div>')
    expect(readme).toContain(
      `https://raw.githubusercontent.com/example/samples/${commit}/typescript/01-learn/01-readme/images/html.png`
    )
    expect(readme).toContain('[Watch the sample video](https://example.com/demo.mp4)')
    expect(readme).toContain('Before after')
    expect(readme).toContain(
      `https://raw.githubusercontent.com/example/samples/${commit}/typescript/01-learn/01-readme/images/one.png`
    )
    expect(readme).toContain(
      `https://raw.githubusercontent.com/example/samples/${commit}/typescript/01-learn/01-readme/images/two.png`
    )
    expect(readme).toContain(
      `[diagram]: https://raw.githubusercontent.com/example/samples/${commit}/typescript/01-learn/01-readme/images/reference.png`
    )
    expect(readme).toContain(
      `https://github.com/example/samples/blob/${commit}/typescript/01-learn/01-readme/src/index.ts`
    )
    expect(readme).toContain(`https://github.com/example/samples/tree/${commit}/typescript/01-learn/01-readme/src`)
    expect(readme).toContain('```json')
    expect(readme).toContain('- [x] Keeps GFM task lists')
    expect(readme).toContain('- ~~Keeps strikethrough~~')
    expect(readme).toContain('## Secondary heading')

    const notebook = readFileSync(path.join(outputDir, 'python/notebook.md'), 'utf8')
    expect(notebook).toContain('guideKind: "notebook"')
    expect(notebook).toContain('Notebook introduction.')
    expect(notebook).toContain('```python\nprint("shown")')
    expect(notebook).not.toContain('hidden output')
    expect(notebook).not.toContain('hidden raw cell')
  })

  it('rejects a samples checkout with unpublished changes', async () => {
    write('untracked.txt', 'not committed\n')
    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow(
      'Samples checkout must be clean before it can be published'
    )
  })

  it('rejects unsafe link protocols', async () => {
    write('typescript/01-learn/01-readme/README.md', '[Unsafe](javascript:alert(1))\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'unsafe link')

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow(
      'Sample guide contains an unsafe javascript: URL'
    )
  })

  it('warns about missing files but rejects missing images', async () => {
    write('typescript/01-learn/01-readme/README.md', '[Missing file](missing.txt)\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'missing file')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const commit = git('rev-parse', 'HEAD')

    await buildSampleGuides({ sourceDir, outputDir })

    expect(readFileSync(path.join(outputDir, 'typescript/readme.md'), 'utf8')).toContain(
      `https://github.com/example/samples/blob/${commit}/typescript/01-learn/01-readme/missing.txt`
    )
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('links to missing relative target missing.txt'))

    write('typescript/01-learn/01-readme/README.md', '![Missing image](missing.png)\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'missing image')

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow(
      'links to missing relative image missing.png'
    )
  })

  it('keeps a section heading when prose appears before the first H1', async () => {
    write(
      'typescript/01-learn/01-readme/README.md',
      ['Introductory prose without a source title.', '', '# Important section', '', 'Section content.'].join('\n')
    )
    git('add', '.')
    git('commit', '--quiet', '-m', 'heading after prose')

    await buildSampleGuides({ sourceDir, outputDir })

    const readme = readFileSync(path.join(outputDir, 'typescript/readme.md'), 'utf8')
    expect(readme).toContain('Introductory prose without a source title.')
    expect(readme).toContain('## Important section')
  })
})
