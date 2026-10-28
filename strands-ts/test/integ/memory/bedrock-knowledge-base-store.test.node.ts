import { describe, it, expect, inject, beforeAll } from 'vitest'
import { S3Client } from '@aws-sdk/client-s3'
import { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent'
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'

import { BedrockKnowledgeBaseStore } from '$/sdk/vended-memory-stores/bedrock-knowledge-base/index.js'
import type { MemoryEntry } from '$/sdk/memory/types.js'
import {
  uniqueMarker,
  waitForIndexed,
  cleanupCustomDocument,
  cleanupS3Document,
  keyFromUri,
} from './_bedrock-kb-test-helpers.js'

// Manual overrides — swap these to point at your own resources for local development.
const OVERRIDES: Partial<{
  knowledgeBaseId: string
  customDataSourceId: string
  s3DataSourceId: string
  s3Bucket: string
}> = {
  // knowledgeBaseId: 'YOUR-KB-ID',
  // customDataSourceId: 'YOUR-CUSTOM-DS-ID',
  // s3DataSourceId: 'YOUR-S3-DS-ID',
  // s3Bucket: 'YOUR-BUCKET',
}

function config() {
  const c = inject('provider-bedrock-kb')
  return {
    knowledgeBaseId: OVERRIDES.knowledgeBaseId ?? c.knowledgeBaseId!,
    customDataSourceId: OVERRIDES.customDataSourceId ?? c.customDataSourceId!,
    s3DataSourceId: OVERRIDES.s3DataSourceId ?? c.s3DataSourceId!,
    s3Bucket: OVERRIDES.s3Bucket ?? c.s3Bucket!,
  }
}

describe('BedrockKnowledgeBaseStore Integration Tests', () => {
  const shouldSkip = () => inject('provider-bedrock-kb').shouldSkip

  let agentClient: BedrockAgentClient
  let runtimeClient: BedrockAgentRuntimeClient
  let s3Client: S3Client

  beforeAll(async () => {
    if (shouldSkip()) return
    const credentials = await fromNodeProviderChain()()
    agentClient = new BedrockAgentClient({ credentials })
    runtimeClient = new BedrockAgentRuntimeClient({ credentials })
    s3Client = new S3Client({ credentials })
  })

  // ---------------------------------------------------------------------------
  // CUSTOM data source
  // ---------------------------------------------------------------------------

  describe.skipIf(shouldSkip())('CUSTOM data source', () => {
    it('adds and searches a document', async () => {
      const { knowledgeBaseId, customDataSourceId } = config()

      const store = new BedrockKnowledgeBaseStore({
        config: {
          knowledgeBaseId,
          dataSourceType: 'CUSTOM',
          dataSourceId: customDataSourceId,
          runtimeClient,
          agentClient,
        },
        name: 'integ-custom',
        writable: true,
      })

      const marker = uniqueMarker('custom-add')
      const content = `The project codename is ${marker}. It launched in 2025.`

      const result = await store.add(content)
      expect(result.documentId).toBeTruthy()
      cleanupCustomDocument(agentClient, knowledgeBaseId, customDataSourceId, result.documentId)

      await waitForIndexed(agentClient, knowledgeBaseId, customDataSourceId, {
        dataSourceType: 'CUSTOM',
        custom: { id: result.documentId },
      })

      const entries = await store.search(marker, { maxSearchResults: 10 })
      const match = entries.find((e: MemoryEntry) => e.content.includes(marker))
      expect(match).toBeDefined()
      expect(match!.content).toContain('launched in 2025')
    }, 60_000)

    it('adds with scope and retrieves filtered', async () => {
      const { knowledgeBaseId, customDataSourceId } = config()

      const scope = uniqueMarker('scope')
      const store = new BedrockKnowledgeBaseStore({
        config: {
          knowledgeBaseId,
          dataSourceType: 'CUSTOM',
          dataSourceId: customDataSourceId,
          runtimeClient,
          agentClient,
        },
        name: 'integ-custom-scoped',
        writable: true,
        scope,
      })

      const marker = uniqueMarker('custom-scope')
      const result = await store.add(`Scoped fact: ${marker}`)
      cleanupCustomDocument(agentClient, knowledgeBaseId, customDataSourceId, result.documentId)

      await waitForIndexed(agentClient, knowledgeBaseId, customDataSourceId, {
        dataSourceType: 'CUSTOM',
        custom: { id: result.documentId },
      })

      const entries = await store.search(marker, { maxSearchResults: 10 })
      expect(entries.find((e: MemoryEntry) => e.content.includes(marker))).toBeDefined()
    }, 60_000)

    it('scope isolates documents from other scopes', async () => {
      const { knowledgeBaseId, customDataSourceId } = config()

      const scopeA = uniqueMarker('isolate-a')
      const scopeB = uniqueMarker('isolate-b')
      const marker = uniqueMarker('isolation')

      const storeA = new BedrockKnowledgeBaseStore({
        config: {
          knowledgeBaseId,
          dataSourceType: 'CUSTOM',
          dataSourceId: customDataSourceId,
          runtimeClient,
          agentClient,
        },
        name: 'integ-scope-a',
        writable: true,
        scope: scopeA,
      })

      const storeB = new BedrockKnowledgeBaseStore({
        config: {
          knowledgeBaseId,
          dataSourceType: 'CUSTOM',
          dataSourceId: customDataSourceId,
          runtimeClient,
          agentClient,
        },
        name: 'integ-scope-b',
        scope: scopeB,
      })

      const result = await storeA.add(`Isolated fact: ${marker}`)
      cleanupCustomDocument(agentClient, knowledgeBaseId, customDataSourceId, result.documentId)

      await waitForIndexed(agentClient, knowledgeBaseId, customDataSourceId, {
        dataSourceType: 'CUSTOM',
        custom: { id: result.documentId },
      })

      const entriesA = await storeA.search(marker, { maxSearchResults: 10 })
      expect(entriesA.find((e: MemoryEntry) => e.content.includes(marker))).toBeDefined()

      const entriesB = await storeB.search(marker, { maxSearchResults: 10 })
      expect(entriesB.find((e: MemoryEntry) => e.content.includes(marker))).toBeUndefined()
    }, 60_000)

    it('adds with metadata attributes and returns them in search', async () => {
      const { knowledgeBaseId, customDataSourceId } = config()

      const store = new BedrockKnowledgeBaseStore({
        config: {
          knowledgeBaseId,
          dataSourceType: 'CUSTOM',
          dataSourceId: customDataSourceId,
          runtimeClient,
          agentClient,
        },
        name: 'integ-custom-meta',
        writable: true,
      })

      const marker = uniqueMarker('custom-meta')
      const result = await store.add(`Metadata fact: ${marker}`, { priority: 'high', version: 3 })
      cleanupCustomDocument(agentClient, knowledgeBaseId, customDataSourceId, result.documentId)

      await waitForIndexed(agentClient, knowledgeBaseId, customDataSourceId, {
        dataSourceType: 'CUSTOM',
        custom: { id: result.documentId },
      })

      const entries = await store.search(marker, { maxSearchResults: 10 })
      const match = entries.find((e: MemoryEntry) => e.content.includes(marker))
      expect(match).toBeDefined()
      expect(match!.metadata?.priority).toBe('high')
      expect(match!.metadata?.version).toBe(3)
      expect(typeof match!.metadata?._relevanceScore).toBe('number')
      expect(match!.metadata?._sourceLocation).toBeDefined()
    }, 60_000)
  })

  // ---------------------------------------------------------------------------
  // S3 data source
  // ---------------------------------------------------------------------------

  describe.skipIf(shouldSkip())('S3 data source', () => {
    it('adds and searches a document via S3', async () => {
      const { knowledgeBaseId, s3DataSourceId, s3Bucket } = config()

      const store = new BedrockKnowledgeBaseStore({
        config: {
          knowledgeBaseId,
          dataSourceType: 'S3',
          dataSourceId: s3DataSourceId,
          runtimeClient,
          agentClient,
          s3: { bucket: s3Bucket, client: s3Client, prefix: `integ-test/${uniqueMarker('pfx')}/` },
        },
        name: 'integ-s3',
        writable: true,
      })

      const marker = uniqueMarker('s3-add')
      const content = `S3 stored fact: ${marker}. The answer is 42.`

      const result = await store.add(content)
      expect(result.documentId).toMatch(/^s3:\/\//)

      const contentKey = keyFromUri(result.documentId)
      cleanupS3Document(agentClient, s3Client, knowledgeBaseId, s3DataSourceId, s3Bucket, contentKey)

      await waitForIndexed(agentClient, knowledgeBaseId, s3DataSourceId, {
        dataSourceType: 'S3',
        s3: { uri: result.documentId },
      })

      const entries = await store.search(marker, { maxSearchResults: 10 })
      const match = entries.find((e: MemoryEntry) => e.content.includes(marker))
      expect(match).toBeDefined()
      expect(match!.content).toContain('answer is 42')
    }, 60_000)

    it('adds with scope and writes a sidecar', async () => {
      const { knowledgeBaseId, s3DataSourceId, s3Bucket } = config()

      const scope = uniqueMarker('s3scope')
      const store = new BedrockKnowledgeBaseStore({
        config: {
          knowledgeBaseId,
          dataSourceType: 'S3',
          dataSourceId: s3DataSourceId,
          runtimeClient,
          agentClient,
          s3: { bucket: s3Bucket, client: s3Client, prefix: `integ-test/${uniqueMarker('pfx')}/` },
        },
        name: 'integ-s3-scoped',
        writable: true,
        scope,
      })

      const marker = uniqueMarker('s3-scoped')
      const result = await store.add(`S3 scoped: ${marker}`)
      const contentKey = keyFromUri(result.documentId)
      cleanupS3Document(agentClient, s3Client, knowledgeBaseId, s3DataSourceId, s3Bucket, contentKey)

      await waitForIndexed(agentClient, knowledgeBaseId, s3DataSourceId, {
        dataSourceType: 'S3',
        s3: { uri: result.documentId },
      })

      const entries = await store.search(marker, { maxSearchResults: 10 })
      const match = entries.find((e: MemoryEntry) => e.content.includes(marker))
      expect(match).toBeDefined()
      expect(match!.metadata?.namespace).toBe(scope)
    }, 60_000)

    it('scope isolates S3 documents from other scopes', async () => {
      const { knowledgeBaseId, s3DataSourceId, s3Bucket } = config()

      const scopeA = uniqueMarker('s3-iso-a')
      const scopeB = uniqueMarker('s3-iso-b')
      const marker = uniqueMarker('s3-isolation')

      const storeA = new BedrockKnowledgeBaseStore({
        config: {
          knowledgeBaseId,
          dataSourceType: 'S3',
          dataSourceId: s3DataSourceId,
          runtimeClient,
          agentClient,
          s3: { bucket: s3Bucket, client: s3Client, prefix: `integ-test/${uniqueMarker('pfx')}/` },
        },
        name: 'integ-s3-iso-a',
        writable: true,
        scope: scopeA,
      })

      const storeB = new BedrockKnowledgeBaseStore({
        config: {
          knowledgeBaseId,
          dataSourceType: 'S3',
          dataSourceId: s3DataSourceId,
          runtimeClient,
          agentClient,
          s3: { bucket: s3Bucket, client: s3Client, prefix: `integ-test/${uniqueMarker('pfx')}/` },
        },
        name: 'integ-s3-iso-b',
        scope: scopeB,
      })

      const result = await storeA.add(`S3 isolated: ${marker}`)
      const contentKey = keyFromUri(result.documentId)
      cleanupS3Document(agentClient, s3Client, knowledgeBaseId, s3DataSourceId, s3Bucket, contentKey)

      await waitForIndexed(agentClient, knowledgeBaseId, s3DataSourceId, {
        dataSourceType: 'S3',
        s3: { uri: result.documentId },
      })

      const entriesA = await storeA.search(marker, { maxSearchResults: 10 })
      expect(entriesA.find((e: MemoryEntry) => e.content.includes(marker))).toBeDefined()

      const entriesB = await storeB.search(marker, { maxSearchResults: 10 })
      expect(entriesB.find((e: MemoryEntry) => e.content.includes(marker))).toBeUndefined()
    }, 60_000)

    it('adds with metadata in the sidecar', async () => {
      const { knowledgeBaseId, s3DataSourceId, s3Bucket } = config()

      const store = new BedrockKnowledgeBaseStore({
        config: {
          knowledgeBaseId,
          dataSourceType: 'S3',
          dataSourceId: s3DataSourceId,
          runtimeClient,
          agentClient,
          s3: { bucket: s3Bucket, client: s3Client, prefix: `integ-test/${uniqueMarker('pfx')}/` },
        },
        name: 'integ-s3-meta',
        writable: true,
      })

      const marker = uniqueMarker('s3-meta')
      const result = await store.add(`S3 metadata fact: ${marker}`, { category: 'testing', count: 7 })
      const contentKey = keyFromUri(result.documentId)
      cleanupS3Document(agentClient, s3Client, knowledgeBaseId, s3DataSourceId, s3Bucket, contentKey)

      await waitForIndexed(agentClient, knowledgeBaseId, s3DataSourceId, {
        dataSourceType: 'S3',
        s3: { uri: result.documentId },
      })

      const entries = await store.search(marker, { maxSearchResults: 10 })
      const match = entries.find((e: MemoryEntry) => e.content.includes(marker))
      expect(match).toBeDefined()
      expect(match!.metadata?.category).toBe('testing')
      expect(match!.metadata?.count).toBe(7)
    }, 60_000)
  })

  // ---------------------------------------------------------------------------
  // Read-only / error handling
  // ---------------------------------------------------------------------------

  describe.skipIf(shouldSkip())('read-only and error handling', () => {
    it('throws when add is called on a read-only store', async () => {
      const { knowledgeBaseId } = config()

      const store = new BedrockKnowledgeBaseStore({
        config: { knowledgeBaseId, runtimeClient },
        name: 'integ-readonly',
      })

      await expect(store.add('should fail')).rejects.toThrow()
    }, 15_000)

    it('search works on a read-only store', async () => {
      const { knowledgeBaseId } = config()

      const store = new BedrockKnowledgeBaseStore({
        config: { knowledgeBaseId, runtimeClient },
        name: 'integ-readonly-search',
      })

      const entries = await store.search('hello')
      expect(Array.isArray(entries)).toBe(true)
    }, 30_000)

    it('throws when writable is set with OTHER dataSourceType', () => {
      expect(
        () =>
          new BedrockKnowledgeBaseStore({
            config: { knowledgeBaseId: 'fake-id', dataSourceType: 'OTHER' },
            name: 'integ-other',
            writable: true,
          })
      ).toThrow("add requires dataSourceType 'CUSTOM' or 'S3'")
    })

    it('throws when writable is set without dataSourceId', () => {
      const { knowledgeBaseId } = config()

      expect(
        () =>
          new BedrockKnowledgeBaseStore({
            config: { knowledgeBaseId, dataSourceType: 'CUSTOM' },
            name: 'integ-no-ds',
            writable: true,
          })
      ).toThrow('dataSourceId is required')
    })

    it('throws when writable S3 store is missing s3 config', () => {
      const { knowledgeBaseId, s3DataSourceId } = config()

      expect(
        () =>
          new BedrockKnowledgeBaseStore({
            config: { knowledgeBaseId, dataSourceType: 'S3', dataSourceId: s3DataSourceId },
            name: 'integ-no-s3',
            writable: true,
          })
      ).toThrow('s3 config is required')
    })
  })
})
