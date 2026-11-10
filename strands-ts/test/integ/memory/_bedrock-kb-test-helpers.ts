import { onTestFinished } from 'vitest'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import {
  BedrockAgentClient,
  DeleteKnowledgeBaseDocumentsCommand,
  GetKnowledgeBaseDocumentsCommand,
} from '@aws-sdk/client-bedrock-agent'

import type { BedrockKnowledgeBaseStore } from '$/sdk/vended-memory-stores/bedrock-knowledge-base/index.js'

/**
 * Generates a globally unique marker so concurrent tests against the same KB don't collide.
 */
export function uniqueMarker(label: string): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `integ-${label}-${ts}-${rand}`
}

/**
 * Polls a scope-isolated store search until at least one entry matches `predicate` (default: any
 * result), or the timeout elapses; returns the matched entry's content, or `undefined` on timeout.
 *
 * Use when the written content has no test-known document id — extraction rephrases what it writes,
 * and the add tool mints ids internally — so indexing can't be awaited by id via {@link waitForIndexed}.
 */
export async function searchUntil(
  store: BedrockKnowledgeBaseStore,
  query: string,
  predicate: (content: string) => boolean = () => true,
  { timeoutMs = 60_000, intervalMs = 2_000 } = {}
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const entries = await store.search(query, { maxSearchResults: 10 })
    const match = entries.find((e) => predicate(e.content))
    if (match) return match.content
    if (Date.now() >= deadline) return undefined
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * Polls until the document reaches INDEXED (or fails/times out).
 * Ingestion is async even for IngestKnowledgeBaseDocuments; without this a subsequent
 * Retrieve can miss the document.
 */
export async function waitForIndexed(
  agentClient: BedrockAgentClient,
  knowledgeBaseId: string,
  dataSourceId: string,
  documentIdentifier: { dataSourceType: 'CUSTOM' | 'S3'; custom?: { id: string }; s3?: { uri: string } },
  { timeoutMs = 30_000, intervalMs = 2_000 } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await agentClient.send(
      new GetKnowledgeBaseDocumentsCommand({
        knowledgeBaseId,
        dataSourceId,
        documentIdentifiers: [documentIdentifier],
      })
    )
    const detail = response.documentDetails?.[0]
    if (detail?.status === 'INDEXED' || detail?.status === 'PARTIALLY_INDEXED') return
    if (detail?.status === 'FAILED') {
      throw new Error(`Document indexing failed: ${detail.statusReason ?? 'unknown'}`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Document did not reach INDEXED within ${timeoutMs}ms`)
}

/**
 * Registers best-effort cleanup (via onTestFinished) for a CUSTOM document.
 */
export function cleanupCustomDocument(
  agentClient: BedrockAgentClient,
  knowledgeBaseId: string,
  dataSourceId: string,
  documentId: string
): void {
  onTestFinished(async () => {
    try {
      await agentClient.send(
        new DeleteKnowledgeBaseDocumentsCommand({
          knowledgeBaseId,
          dataSourceId,
          documentIdentifiers: [{ dataSourceType: 'CUSTOM', custom: { id: documentId } }],
        })
      )
    } catch {
      // best-effort — don't mask test failures
    }
  })
}

/**
 * Registers best-effort cleanup (via onTestFinished) for an S3 document:
 * deletes the content object, its optional .metadata.json sidecar, and the KB document entry.
 */
export function cleanupS3Document(
  agentClient: BedrockAgentClient,
  s3Client: S3Client,
  knowledgeBaseId: string,
  dataSourceId: string,
  bucket: string,
  contentKey: string
): void {
  onTestFinished(async () => {
    const deleteObj = (key: string) =>
      s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {})

    await Promise.all([deleteObj(contentKey), deleteObj(`${contentKey}.metadata.json`)])

    const uri = `s3://${bucket}/${contentKey}`
    try {
      await agentClient.send(
        new DeleteKnowledgeBaseDocumentsCommand({
          knowledgeBaseId,
          dataSourceId,
          documentIdentifiers: [{ dataSourceType: 'S3', s3: { uri } }],
        })
      )
    } catch {
      // best-effort
    }
  })
}

/** Extracts the S3 object key from an s3:// URI. */
export function keyFromUri(uri: string): string {
  const url = new URL(uri)
  return url.pathname.slice(1)
}
