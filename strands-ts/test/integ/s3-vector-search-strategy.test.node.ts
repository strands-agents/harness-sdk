/**
 * Integration tests for S3VectorSearchStrategy against real S3, S3 Vectors and Bedrock.
 *
 * Creates a throwaway S3 bucket plus a `<bucket>-vectors` vector bucket and `default` index,
 * and tears all three down afterwards.
 */
import { describe, expect, it, beforeAll, afterAll, inject } from 'vitest'
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import {
  S3VectorsClient,
  CreateVectorBucketCommand,
  CreateIndexCommand,
  DeleteIndexCommand,
  DeleteVectorBucketCommand,
} from '@aws-sdk/client-s3vectors'
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { S3Storage } from '$/sdk/storage/s3-storage.js'
import { S3VectorSearchStrategy } from '$/sdk/storage/search/s3-vector.js'
import { BedrockEmbedder } from '$/sdk/storage/embeddings/bedrock.js'
import type { StorageSearchResult } from '$/sdk/storage/storage.js'
import { bedrock } from './__fixtures__/model-providers.js'
import { AWS_REGION } from './__fixtures__/_aws.js'

/** Titan Text Embeddings V2, the default embedder, produces 1024-dimensional vectors. */
const TITAN_V2_DIMENSION = 1024

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

const keys = (results: StorageSearchResult[]): string[] => results.map((r) => r.key)

/** Setup and teardown make several sequential calls to real AWS; vitest's 10 s default is too short. */
const HOOK_TIMEOUT_MS = 60_000

/**
 * Polls `storage.search(query)` until `predicate` holds, and returns those results. Guards against
 * any delay between a vector write and its visibility. Throws if the timeout elapses first.
 */
async function searchUntil(
  storage: S3Storage,
  query: string,
  predicate: (results: StorageSearchResult[]) => boolean,
  { timeoutMs = 30_000, intervalMs = 1_000 } = {}
): Promise<StorageSearchResult[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const results = await storage.search(query)
    if (predicate(results)) return results
    if (Date.now() >= deadline) {
      throw new Error(
        `search('${query}') did not reach the expected state within ${timeoutMs / 1000}s; last keys: ${JSON.stringify(keys(results))}`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

describe.skipIf(bedrock.skip)('S3VectorSearchStrategy', () => {
  let credentials: any
  let bucket: string
  let vectorBucket: string
  let s3: S3Client
  let s3Vectors: S3VectorsClient
  let bedrockRuntime: BedrockRuntimeClient

  /** A storage on the test bucket whose strategy uses the test vector index and clients. */
  function makeStorage(prefix?: string): S3Storage {
    return new S3Storage(bucket, {
      ...(prefix && { prefix }),
      s3Client: s3,
      searchStrategy: new S3VectorSearchStrategy({
        vectorBucketName: vectorBucket,
        indexName: 'default',
        s3VectorsClient: s3Vectors,
        embedder: new BedrockEmbedder({ bedrockClient: bedrockRuntime }),
      }),
    })
  }

  beforeAll(async () => {
    credentials = inject('provider-bedrock')?.credentials
    s3 = new S3Client({ region: AWS_REGION, credentials })
    s3Vectors = new S3VectorsClient({ region: AWS_REGION, credentials })
    bedrockRuntime = new BedrockRuntimeClient({ region: AWS_REGION, credentials })

    const { Account } = await new STSClient({ region: AWS_REGION, credentials }).send(new GetCallerIdentityCommand({}))
    const suffix = Math.random().toString(16).slice(2, 8)
    bucket = `test-strands-s3v-${Account}-${AWS_REGION}-${suffix}`
    vectorBucket = `${bucket}-vectors`

    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(AWS_REGION !== 'us-east-1' && { CreateBucketConfiguration: { LocationConstraint: AWS_REGION as any } }),
      })
    )
    await s3Vectors.send(new CreateVectorBucketCommand({ vectorBucketName: vectorBucket }))
    await s3Vectors.send(
      new CreateIndexCommand({
        vectorBucketName: vectorBucket,
        indexName: 'default',
        dataType: 'float32',
        dimension: TITAN_V2_DIMENSION,
        distanceMetric: 'cosine',
      })
    )
  }, HOOK_TIMEOUT_MS)

  afterAll(async () => {
    // Best-effort teardown in reverse order; one failure should not leak the rest.
    if (s3Vectors && vectorBucket) {
      await s3Vectors
        .send(new DeleteIndexCommand({ vectorBucketName: vectorBucket, indexName: 'default' }))
        .catch(() => {})
      await s3Vectors.send(new DeleteVectorBucketCommand({ vectorBucketName: vectorBucket })).catch(() => {})
    }
    if (s3 && bucket) {
      try {
        let token: string | undefined
        do {
          const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }))
          const objects = list.Contents?.map((o) => ({ Key: o.Key! })) ?? []
          if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }))
          token = list.NextContinuationToken
        } while (token)
      } catch {
        // Best effort: still attempt DeleteBucket below (e.g. the bucket was never created).
      }
      await s3.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {})
    }
  }, HOOK_TIMEOUT_MS)

  it('indexes on write, finds content by meaning, and de-indexes on delete', async () => {
    const storage = makeStorage('semantic')
    await storage.write('auth.md', encode('Users sign in with OAuth2 and receive short-lived JWT access tokens.'))
    await storage.write('deploy.md', encode('Services are deployed to ECS on Fargate with auto-scaling enabled.'))

    const query = 'how do people log in to the app?'
    const results = await searchUntil(
      storage,
      query,
      (r) => keys(r).includes('auth.md') && keys(r).includes('deploy.md')
    )
    const score = (key: string): number | undefined => results.find((r) => r.key === key)?.score
    expect(results[0]?.key).toBe('auth.md')
    expect(score('auth.md')).toBeGreaterThan(score('deploy.md')!)

    await storage.delete('auth.md')
    const afterDelete = await searchUntil(storage, query, (r) => !keys(r).includes('auth.md'))
    expect(keys(afterDelete)).not.toContain('auth.md')
    expect(keys(afterDelete)).toContain('deploy.md')
  })

  it('isolates storages that share the default index under different prefixes', async () => {
    const tenantA = makeStorage('tenant-a')
    const tenantB = makeStorage('tenant-b')
    await tenantA.write('notes.md', encode('Tenant A plans a product launch in Lisbon next spring.'))
    await tenantA.write('a-only.md', encode('Tenant A budget review for the launch event.'))
    await tenantB.write('notes.md', encode('Tenant B is migrating its database to Postgres.'))

    // Wait until every vector is visible, so the per-tenant assertions below can't pass vacuously.
    const query = 'product launch'
    const expected = ['tenant-a/notes.md', 'tenant-a/a-only.md', 'tenant-b/notes.md']
    await searchUntil(makeStorage(), query, (r) => expected.every((key) => keys(r).includes(key)))

    expect(keys(await tenantA.search(query)).sort()).toEqual(['a-only.md', 'notes.md'])
    expect(keys(await tenantB.search(query))).toEqual(['notes.md'])

    // Deleting tenant A's notes.md must not remove tenant B's vector for the same key.
    await tenantA.delete('notes.md')
    const afterDeleteA = await searchUntil(tenantA, query, (r) => !keys(r).includes('notes.md'))
    expect(keys(afterDeleteA)).toEqual(['a-only.md'])
    expect(keys(await tenantB.search(query))).toEqual(['notes.md'])
  })

  it('removes the old vector when a text key is overwritten with binary data', async () => {
    const storage = makeStorage('overwrite')
    await storage.write('image.md', encode('A description of a sunset over the mountains.'))
    const query = 'sunset over mountains'
    expect(keys(await searchUntil(storage, query, (r) => r.length >= 1))).toEqual(['image.md'])

    // A PNG signature is not valid UTF-8, so the strategy stores it but drops the old vector.
    await storage.write('image.md', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]))
    const afterOverwrite = await searchUntil(storage, query, (r) => r.length === 0)
    expect(afterOverwrite).toEqual([])
    expect(await storage.read('image.md')).not.toBeNull()
  })
})
