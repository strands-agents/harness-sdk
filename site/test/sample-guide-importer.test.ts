import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSampleGuides } from '../scripts/samples/importer'

interface ManifestFixture {
  version: 1
  categories: Array<{
    language: string
    id: string
    label: string
  }>
  samples: Array<{
    id?: string
    slug?: string
    language: string
    category: string
    categoryLabel?: string
    title: string
    description: string
    tags?: string[]
    path: string
    notebook?: string
    url?: string
  }>
}

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

function readManifest(): ManifestFixture {
  return JSON.parse(readFileSync(path.join(sourceDir, 'samples.json'), 'utf8')) as ManifestFixture
}

function updateManifest(update: (manifest: ManifestFixture) => void): void {
  const manifest = readManifest()
  update(manifest)
  write('samples.json', JSON.stringify(manifest))
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
      categories: [
        { language: 'TypeScript', id: 'learn', label: 'Learn' },
        { language: 'Python', id: 'learn', label: 'Learn' },
      ],
      samples: [
        {
          language: 'TypeScript',
          category: 'learn',
          title: 'README guide',
          description: 'README fixture',
          tags: ['Agent class'],
          path: 'typescript/01-learn/01-readme',
        },
        {
          language: 'Python',
          category: 'learn',
          title: 'Notebook guide',
          description: 'Notebook fixture',
          path: 'python/01-learn/02-notebook',
          notebook: 'guide.ipynb',
        },
      ],
    } satisfies ManifestFixture)
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
  it('turns README and notebook guides into path-ordered, reproducible site Markdown', async () => {
    const commit = git('rev-parse', 'HEAD')
    await expect(buildSampleGuides({ sourceDir, outputDir })).resolves.toEqual({
      repository: 'strands-agents/samples',
      commit,
      sampleCount: 2,
    })

    const readme = readFileSync(path.join(outputDir, 'typescript/readme.md'), 'utf8').replaceAll(
      commit,
      '<source-commit>'
    )
    await expect(readme).toMatchFileSnapshot('./snapshots/sample-guide-importer/readme.md')

    const notebook = readFileSync(path.join(outputDir, 'python/notebook.md'), 'utf8').replaceAll(
      commit,
      '<source-commit>'
    )
    await expect(notebook).toMatchFileSnapshot('./snapshots/sample-guide-importer/notebook.md')
  })

  it('allows unpublished README changes in local previews', async () => {
    write('typescript/01-learn/01-readme/README.md', '# README guide\n\nUncommitted preview.\n')

    await buildSampleGuides({ sourceDir, outputDir })

    expect(readFileSync(path.join(outputDir, 'typescript/readme.md'), 'utf8')).toContain('Uncommitted preview.')
  })

  it('rejects an empty catalog when samples are required', async () => {
    updateManifest((manifest) => {
      manifest.samples = []
    })

    await expect(buildSampleGuides({ sourceDir, outputDir, requireSamples: true })).rejects.toThrow(
      'Samples source must contain at least one sample.'
    )
  })

  it('falls back to the configured notebook when README.md is missing', async () => {
    await buildSampleGuides({ sourceDir, outputDir })

    const notebook = readFileSync(path.join(outputDir, 'python/notebook.md'), 'utf8')
    expect(notebook).toContain('Notebook introduction.')
    expect(notebook).toContain('print("shown")')
    expect(notebook).not.toContain('hidden output')
    expect(notebook).not.toContain('hidden raw cell')
  })

  it('rejects sample paths outside the checkout', async () => {
    updateManifest((manifest) => {
      manifest.samples[0]!.path = '../outside'
    })

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow('must stay within the samples checkout')
  })

  it('rejects a sample symlink that resolves outside the checkout', async () => {
    const samplePath = path.join(sourceDir, 'typescript/01-learn/01-readme')
    const outsidePath = path.join(fixtureDir, 'outside-sample')
    rmSync(samplePath, { recursive: true, force: true })
    mkdirSync(outsidePath)
    writeFileSync(path.join(outsidePath, 'README.md'), '# Outside\n')
    symlinkSync(outsidePath, samplePath, 'dir')

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow('resolves outside the samples checkout')
  })

  it('rejects duplicate sample slugs', async () => {
    updateManifest((manifest) => {
      manifest.samples[0]!.slug = 'shared'
      manifest.samples[1]!.slug = 'shared'
    })

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow('Duplicate sample slug: shared')
  })

  it('rejects samples that reference an unknown category', async () => {
    updateManifest((manifest) => {
      manifest.samples[0]!.category = 'missing'
    })

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow(
      'references unknown category typescript/missing'
    )
  })

  it('rejects unknown manifest fields', async () => {
    updateManifest((manifest) => {
      Object.assign(manifest, { repository: 'unexpected/repository' })
    })

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow('Unrecognized key')
  })

  it('rejects unknown category fields', async () => {
    updateManifest((manifest) => {
      Object.assign(manifest.categories[0]!, { unexpected: true })
    })

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow('Unrecognized key')
  })

  it('rejects unknown sample fields', async () => {
    updateManifest((manifest) => {
      Object.assign(manifest.samples[0]!, { unexpected: true })
    })

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow('Unrecognized key')
  })

  it('rejects unsafe link protocols', async () => {
    write('typescript/01-learn/01-readme/README.md', '[Unsafe](javascript:alert(1))\n')

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow(
      'Sample guide contains an unsafe javascript: URL'
    )
  })

  it('rejects protocol-relative URLs', async () => {
    write('typescript/01-learn/01-readme/README.md', '[Unsafe](//evil.example/path)\n')

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow(
      'Sample guide contains a protocol-relative URL'
    )
  })

  it('rejects snippet directives in imported content', async () => {
    write('typescript/01-learn/01-readme/README.md', ['```text', '---8<--- "../../../.git/config"', '```'].join('\n'))

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow(
      'Sample guide contains a prohibited --8<-- snippet directive'
    )
  })

  it('rejects snippet directives decoded from embedded HTML', async () => {
    write('typescript/01-learn/01-readme/README.md', '<pre><code>--8&lt;-- "../../../.git/config"</code></pre>\n')

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow(
      'Sample guide contains a prohibited --8<-- snippet directive'
    )
  })

  it('rewrites repo-root links to commit-pinned GitHub URLs', async () => {
    write('shared/example.ts', 'export const shared = true\n')
    write('typescript/01-learn/01-readme/README.md', '[Shared](/shared/example.ts?plain=1#L1)\n')
    const commit = git('rev-parse', 'HEAD')

    await buildSampleGuides({ sourceDir, outputDir })

    expect(readFileSync(path.join(outputDir, 'typescript/readme.md'), 'utf8')).toContain(
      `https://github.com/strands-agents/samples/blob/${commit}/shared/example.ts?plain=1#L1`
    )
  })

  it('warns when a relative file link is missing', async () => {
    write('typescript/01-learn/01-readme/README.md', '[Missing file](missing.txt)\n')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const commit = git('rev-parse', 'HEAD')

    await buildSampleGuides({ sourceDir, outputDir })

    expect(readFileSync(path.join(outputDir, 'typescript/readme.md'), 'utf8')).toContain(
      `https://github.com/strands-agents/samples/blob/${commit}/typescript/01-learn/01-readme/missing.txt`
    )
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('links to missing relative target missing.txt'))
  })

  it('rejects a missing relative image', async () => {
    write('typescript/01-learn/01-readme/README.md', '![Missing image](missing.png)\n')

    await expect(buildSampleGuides({ sourceDir, outputDir })).rejects.toThrow(
      'links to missing relative image missing.png'
    )
  })

  it('keeps a section heading when prose appears before the first H1', async () => {
    write(
      'typescript/01-learn/01-readme/README.md',
      ['Introductory prose without a source title.', '', '# Important section', '', 'Section content.'].join('\n')
    )

    await buildSampleGuides({ sourceDir, outputDir })

    const readme = readFileSync(path.join(outputDir, 'typescript/readme.md'), 'utf8')
    expect(readme).toContain('Introductory prose without a source title.')
    expect(readme).toContain('## Important section')
  })
})
