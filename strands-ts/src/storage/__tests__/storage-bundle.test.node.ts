import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('S3Storage', () => {
  describe('bundling', () => {
    // Ordinary S3 storage does not require the optional vector search client (#6171).
    it('bundles the public storage entry without the vector search peer', async () => {
      const entry = fileURLToPath(new URL('../index.ts', import.meta.url))

      for (const format of ['esm', 'cjs'] as const) {
        const result = await build({
          stdin: {
            contents: `import { S3Storage } from ${JSON.stringify(entry)}; export const storage = new S3Storage('bucket');`,
            resolveDir: fileURLToPath(new URL('..', import.meta.url)),
            loader: 'ts',
          },
          bundle: true,
          platform: 'node',
          format,
          write: false,
          logLevel: 'silent',
          plugins: [
            {
              name: 'missing-optional-vector-peer',
              setup(buildContext): void {
                buildContext.onResolve({ filter: /^@aws-sdk\/client-s3vectors$/ }, () => ({
                  errors: [{ text: 'The optional @aws-sdk/client-s3vectors peer is not installed' }],
                }))
              },
            },
          ],
        })

        expect(result.errors).toEqual([])
      }
    })
  })
})
