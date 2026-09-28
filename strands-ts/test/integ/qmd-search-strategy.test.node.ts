import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { QmdSearchStrategy } from '../../src/storage/search/qmd.js'
import { LocalFileStorage } from '../../src/storage/local-file-storage.js'

const qmdAvailable = await import('@tobilu/qmd' as string).then(() => true).catch(() => false)

describe('QmdSearchStrategy', () => {
  describe.skipIf(!qmdAvailable)('integration', () => {
    let tempDir: string
    let strategy: QmdSearchStrategy

    afterEach(async () => {
      if (strategy) await strategy.close()
      if (tempDir) await rm(tempDir, { recursive: true, force: true })
    })

    it('indexes real files and returns relevant results', async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'qmd-integ-'))
      await writeFile(join(tempDir, 'auth.md'), '# Authentication\nUsers authenticate via OAuth2 with JWT tokens.')
      await writeFile(join(tempDir, 'deploy.md'), '# Deployment\nWe deploy to ECS using Fargate with auto-scaling.')
      await writeFile(
        join(tempDir, 'testing.md'),
        '# Testing\nUnit tests use vitest. Integration tests hit real databases.'
      )

      const storage = new LocalFileStorage(tempDir)
      strategy = new QmdSearchStrategy()

      const results = await strategy.search(storage, 'OAuth authentication tokens')

      expect(results.length).toBeGreaterThan(0)
      const first = results[0]!
      expect(first.key).toBe('auth.md')
      expect(first.score).toBeGreaterThan(0)
      expect(first.score).toBeLessThanOrEqual(1)
    })

    it('returns empty results for unrelated queries', async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'qmd-integ-'))
      await writeFile(join(tempDir, 'recipes.md'), '# Recipes\nChocolate cake requires flour, sugar, and cocoa powder.')

      const storage = new LocalFileStorage(tempDir)
      strategy = new QmdSearchStrategy()

      const results = await strategy.search(storage, 'kubernetes cluster networking')

      expect(results).toEqual([])
    })

    it('picks up newly written files on subsequent searches', async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'qmd-integ-'))
      await writeFile(join(tempDir, 'initial.md'), '# Initial\nThis file exists from the start.')

      const storage = new LocalFileStorage(tempDir)
      strategy = new QmdSearchStrategy()

      await strategy.search(storage, 'initial')

      await writeFile(join(tempDir, 'added.md'), '# Caching\nRedis is used for session caching and rate limiting.')
      const results = await strategy.search(storage, 'Redis caching sessions')

      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.key).toBe('added.md')
    })
  })
})
