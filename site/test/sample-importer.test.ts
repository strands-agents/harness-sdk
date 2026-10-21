import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildSampleSnapshot,
  loadManifest,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SAMPLE,
  MAX_MANIFEST_BYTES,
  prepareSampleSummary,
  resolveGitCommit,
} from '../scripts/samples/importer'

const fixtureSource = path.resolve('test/fixtures/sample-importer/source')
const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

async function copyFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'sample-importer-'))
  temporaryDirectories.push(directory)
  await cp(fixtureSource, directory, { recursive: true })
  return directory
}

async function commitFixture(directory: string): Promise<string> {
  await execFileAsync('git', ['-C', directory, 'init', '--quiet'])
  await execFileAsync('git', ['-C', directory, 'config', 'user.name', 'Sample Importer Tests'])
  await execFileAsync('git', ['-C', directory, 'config', 'user.email', 'sample-importer@example.com'])
  await execFileAsync('git', ['-C', directory, 'add', '--all'])
  await execFileAsync('git', ['-C', directory, 'commit', '--quiet', '-m', 'Fixture'])
  return resolveGitCommit(directory)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('sample importer', () => {
  it('builds every manifest and marker sample deterministically', async () => {
    const sourceDir = await copyFixture()
    const readmeRoot = path.join(sourceDir, 'typescript/01-learn/01-readme')
    await writeFile(path.join(readmeRoot, '.env'), 'SECRET_VALUE=do-not-publish\n')
    await writeFile(path.join(readmeRoot, 'oversize.txt'), 'x'.repeat(MAX_FILE_BYTES + 1))
    await symlink(path.join(readmeRoot, 'package.json'), path.join(readmeRoot, 'linked.json'))
    await Promise.all(
      Array.from({ length: MAX_FILES_PER_SAMPLE }, (_, index) =>
        writeFile(path.join(readmeRoot, `a-${String(index).padStart(2, '0')}.ts`), `export const value = ${index}\n`)
      )
    )
    const commit = await commitFixture(sourceDir)

    const options = {
      sourceDir,
      migrationManifestPath: path.join(sourceDir, 'unused-migration.json'),
    }
    const first = await buildSampleSnapshot(options)
    const second = await buildSampleSnapshot(options)

    expect(second).toEqual(first)
    expect(first.schemaVersion).toBe(2)
    expect(first.source).toEqual({
      repository: 'example/samples',
      commit,
      manifest: 'samples.json',
    })
    expect(first.samples.map((sample) => sample.id)).toEqual([
      'python/01-learn/02-notebook',
      'python/01-learn/03-marker',
      'typescript/01-learn/01-readme',
    ])
    expect(first.stats.sampleCount).toBe(3)

    const notebook = first.samples[0]
    expect(notebook?.slug).toBe('python/notebook')
    expect(notebook?.guide.kind).toBe('notebook')
    expect(notebook?.guide.markdown).toContain('```python')
    expect(notebook?.guide.markdown).not.toContain('SECRET OUTPUT MUST NOT APPEAR')
    expect(notebook?.guide.markdown).not.toContain('RAW CELL MUST NOT APPEAR')

    const markerOnly = first.samples[1]
    expect(markerOnly?.metadata.title).toBe('Marker-only Sample')
    expect(markerOnly?.metadata.summary).toBe('Added without changing the migration manifest.')
    expect(markerOnly?.slug).toBe('python/marker')
    expect(markerOnly?.guide.path).toBe('')
    expect(markerOnly?.guide.markdown).toContain('# Marker-only Sample')

    const readme = first.samples[2]
    expect(readme?.metadata.title).toBe('Marker title')
    expect(readme?.metadata.category).toBe('learn')
    expect(readme?.metadata.categoryLabel).toBe('Learning')
    expect(readme?.metadata.run).toEqual(['npm install', 'npm start'])
    expect(readme?.guide.kind).toBe('readme')
    expect(readme?.files).toHaveLength(MAX_FILES_PER_SAMPLE)
    expect(readme?.files.map((file) => file.path)).toContain('package.json')
    expect(readme?.files.map((file) => file.path)).toContain('src/index.ts')
    expect(readme?.files.map((file) => file.path)).toContain('.env.example')
    expect(readme?.files.map((file) => file.path)).not.toContain('.env')
    expect(readme?.files.map((file) => file.path)).not.toContain('package-lock.json')
    expect(readme?.files.map((file) => file.path)).not.toContain('data/training.json')
    expect(readme?.files.map((file) => file.path)).not.toContain('linked.json')
    expect(readme?.files.map((file) => file.path)).not.toContain('oversize.txt')
    expect(readme?.skippedFileCount).toBeGreaterThanOrEqual(5)
    expect(first.stats.fileCount).toBe(first.samples.reduce((total, sample) => total + sample.files.length, 0))
  })

  it('falls back to the migration manifest when the checkout has no samples.json', async () => {
    const sourceDir = await copyFixture()
    const migrationManifestPath = path.join(sourceDir, 'migration.json')
    await cp(path.join(sourceDir, 'samples.json'), migrationManifestPath)
    await rm(path.join(sourceDir, 'samples.json'))

    const loaded = await loadManifest({ sourceDir, migrationManifestPath })

    expect(loaded.manifestLabel).toBe('site/src/data/samples.json')
    expect(loaded.manifest.samples).toHaveLength(3)
  })

  it('repairs truncated or markup-heavy migration summaries from the guide', () => {
    const repaired = prepareSampleSummary(
      '> [!IMPORTANT] > Deploy with Amaz',
      '# Video games assistant\n\nThis sample builds a conversational data assistant backed by PostgreSQL.'
    )

    expect(repaired).toBe('This sample builds a conversational data assistant backed by PostgreSQL.')
    expect(prepareSampleSummary('A concise curated summary.', '# Title\n\nDifferent guide text.')).toBe(
      'A concise curated summary.'
    )
  })

  it('rejects oversized source manifests before parsing them', async () => {
    const sourceDir = await copyFixture()
    await writeFile(path.join(sourceDir, 'samples.json'), ' '.repeat(MAX_MANIFEST_BYTES + 1))

    await expect(
      loadManifest({
        sourceDir,
        migrationManifestPath: path.join(sourceDir, 'unused-migration.json'),
      })
    ).rejects.toThrow('manifest limit')
  })

  it('requires unique categories referenced by every sample', async () => {
    const missingSource = await copyFixture()
    const missingManifestPath = path.join(missingSource, 'samples.json')
    const missingManifest = JSON.parse(await readFile(missingManifestPath, 'utf8')) as {
      categories: Array<{ language: string; id: string }>
    }
    missingManifest.categories = missingManifest.categories.filter(
      (category) => !(category.language === 'typescript' && category.id === 'learn')
    )
    await writeFile(missingManifestPath, JSON.stringify(missingManifest))
    await commitFixture(missingSource)

    await expect(
      buildSampleSnapshot({
        sourceDir: missingSource,
        migrationManifestPath: path.join(missingSource, 'unused-migration.json'),
      })
    ).rejects.toThrow('references missing category')

    const duplicateSource = await copyFixture()
    const duplicateManifestPath = path.join(duplicateSource, 'samples.json')
    const duplicateManifest = JSON.parse(await readFile(duplicateManifestPath, 'utf8')) as {
      categories: Array<{ language: string; id: string }>
    }
    const duplicate = duplicateManifest.categories[0]
    if (!duplicate) throw new Error('Expected a fixture category')
    duplicateManifest.categories.push({ ...duplicate })
    await writeFile(duplicateManifestPath, JSON.stringify(duplicateManifest))
    await commitFixture(duplicateSource)

    await expect(
      buildSampleSnapshot({
        sourceDir: duplicateSource,
        migrationManifestPath: path.join(duplicateSource, 'unused-migration.json'),
      })
    ).rejects.toThrow('Duplicate sample category')
  })

  it.each([
    ['typescript/01-learn/01-readme', 'id', 'typescript/01-learn/replaced', 'id typescript/01-learn/01-readme'],
    ['python/01-learn/02-notebook', 'slug', 'python/replaced', 'slug python/notebook'],
    ['typescript/01-learn/01-readme', 'language', 'python', 'language typescript'],
    ['typescript/01-learn/01-readme', 'category', 'advanced', 'category learn'],
  ] as const)('rejects a marker that changes the immutable %s %s', async (samplePath, field, replacement, expected) => {
    const sourceDir = await copyFixture()
    await writeFile(path.join(sourceDir, samplePath, 'example.yaml'), `schemaVersion: 1\n${field}: ${replacement}\n`)

    await expect(
      loadManifest({
        sourceDir,
        migrationManifestPath: path.join(sourceDir, 'unused-migration.json'),
      })
    ).rejects.toThrow(`cannot change immutable ${expected}`)
  })

  it('rejects unsupported manifest versions instead of parsing them as version 1', async () => {
    const sourceDir = await copyFixture()
    const manifestPath = path.join(sourceDir, 'samples.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: number }
    manifest.version = 2
    await writeFile(manifestPath, JSON.stringify(manifest))

    await expect(
      loadManifest({
        sourceDir,
        migrationManifestPath: path.join(sourceDir, 'unused-migration.json'),
      })
    ).rejects.toThrow('samples.json.version must be 1')
  })

  it('requires versioned, complete metadata for marker-only samples', async () => {
    const sourceDir = await copyFixture()
    const markerPath = path.join(sourceDir, 'python/01-learn/03-marker/example.yaml')
    await writeFile(markerPath, 'schemaVersion: 1\nid: python/new\nslug: python/new\ntitle: New\n')

    await expect(
      loadManifest({
        sourceDir,
        migrationManifestPath: path.join(sourceDir, 'unused-migration.json'),
      })
    ).rejects.toThrow('non-empty title and summary are required')

    await writeFile(markerPath, 'schemaVersion: 2\nid: python/new\nslug: python/new\ntitle: New\nsummary: New\n')
    await expect(
      loadManifest({
        sourceDir,
        migrationManifestPath: path.join(sourceDir, 'unused-migration.json'),
      })
    ).rejects.toThrow('schemaVersion must be 1')
  })

  it('requires the imported checkout to match a clean git commit', async () => {
    const trackedSource = await copyFixture()
    const trackedCommit = await commitFixture(trackedSource)
    expect(await resolveGitCommit(trackedSource)).toBe(trackedCommit)

    await writeFile(path.join(trackedSource, 'python/01-learn/02-notebook/guide.ipynb'), '{}\n')
    await expect(
      buildSampleSnapshot({
        sourceDir: trackedSource,
        migrationManifestPath: path.join(trackedSource, 'unused-migration.json'),
      })
    ).rejects.toThrow('Samples checkout must be clean before import')

    const untrackedSource = await copyFixture()
    await commitFixture(untrackedSource)
    await writeFile(path.join(untrackedSource, 'python/01-learn/02-notebook/untracked.py'), 'print("new")\n')
    await expect(resolveGitCommit(untrackedSource)).rejects.toThrow('Samples checkout must be clean before import')

    const ignoredSource = await copyFixture()
    await writeFile(path.join(ignoredSource, '.gitignore'), 'ignored.py\n')
    await commitFixture(ignoredSource)
    await writeFile(path.join(ignoredSource, 'ignored.py'), 'print("ignored")\n')
    await expect(resolveGitCommit(ignoredSource)).rejects.toThrow('Samples checkout must be clean before import')
  })

  it('does not traverse skipped directory trees when enforcing scan limits', async () => {
    const sourceDir = await copyFixture()
    const dataDirectory = path.join(sourceDir, 'typescript/01-learn/01-readme/data')
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        writeFile(path.join(dataDirectory, `ignored-${index}.json`), JSON.stringify({ index }))
      )
    )
    await commitFixture(sourceDir)

    const snapshot = await buildSampleSnapshot({
      sourceDir,
      migrationManifestPath: path.join(sourceDir, 'unused-migration.json'),
      scanLimits: { entriesPerSample: 20 },
    })

    expect(snapshot.samples.find((sample) => sample.id === 'typescript/01-learn/01-readme')).toBeDefined()
  })

  it('fails closed when a non-skipped sample tree exceeds the scan limit', async () => {
    const sourceDir = await copyFixture()
    const bulkDirectory = path.join(sourceDir, 'typescript/01-learn/01-readme/bulk')
    await mkdir(bulkDirectory)
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        writeFile(path.join(bulkDirectory, `source-${index}.ts`), `export const value${index} = ${index}\n`)
      )
    )
    await commitFixture(sourceDir)

    await expect(
      buildSampleSnapshot({
        sourceDir,
        migrationManifestPath: path.join(sourceDir, 'unused-migration.json'),
        scanLimits: { entriesPerSample: 20 },
      })
    ).rejects.toThrow('typescript/01-learn/01-readme exceeds the 20-entry scan limit')
  })

  it('bounds total checkout traversal and directory depth', async () => {
    const sourceDir = await copyFixture()
    await commitFixture(sourceDir)

    await expect(
      loadManifest({
        sourceDir,
        migrationManifestPath: path.join(sourceDir, 'unused-migration.json'),
        scanLimits: { totalEntries: 2 },
      })
    ).rejects.toThrow('Samples checkout exceeds the 2-entry scan limit')

    await expect(
      loadManifest({
        sourceDir,
        migrationManifestPath: path.join(sourceDir, 'unused-migration.json'),
        scanLimits: { depth: 2 },
      })
    ).rejects.toThrow('Samples checkout exceeds the 2-level scan depth limit')
  })
})
