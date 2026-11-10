/**
 * Integration tests for session management.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { inject } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import { Agent } from '$/sdk/agent/agent.js'
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { SessionManager } from '$/sdk/session/session-manager.js'
import { FileStorage } from '$/sdk/session/file-storage.js'
import { S3Storage } from '$/sdk/session/s3-storage.js'
import { bedrock, openaiResponses } from './__fixtures__/model-providers.js'
import { AWS_REGION } from './__fixtures__/_aws.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getBucketName(credentials: any): Promise<string> {
  const sts = new STSClient({ region: AWS_REGION, credentials })
  const { Account } = await sts.send(new GetCallerIdentityCommand({}))
  const suffix = Math.random().toString(16).slice(2, 8)
  return `test-strands-session-${Account}-${AWS_REGION}-${suffix}`
}

function makeFileManager(sessionId: string, storageDir: string): SessionManager {
  return new SessionManager({ sessionId, storage: { snapshot: new FileStorage(storageDir) } })
}

function makeS3Manager(sessionId: string, bucket: string, credentials: any): SessionManager {
  return new SessionManager({
    sessionId,
    storage: { snapshot: new S3Storage({ bucket, s3Client: new S3Client({ region: AWS_REGION, credentials }) }) },
  })
}

async function getPersistedMessageCount(manager: SessionManager): Promise<number> {
  const snap = await (manager as any)._storage.snapshot.loadSnapshot({
    location: (manager as any)._location({ id: 'agent' }),
  })
  return (snap?.data?.messages as unknown[])?.length ?? 0
}

// ─── File Storage Tests ───────────────────────────────────────────────────────

describe.skipIf(bedrock.skip)('Session Management - FileStorage', () => {
  let tempDir: string

  beforeAll(async () => {
    tempDir = join(tmpdir(), `strands-session-integ-${Date.now()}`)
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('persists and restores agent messages across sessions', async () => {
    const sessionId = uuidv7()
    const model = bedrock.createModel()

    const manager1 = makeFileManager(sessionId, tempDir)
    const agent1 = new Agent({ model, sessionManager: manager1, printer: false })
    await agent1.invoke('Hello!')
    expect(agent1.messages).toHaveLength(2)
    expect(await getPersistedMessageCount(manager1)).toBe(2)

    const manager2 = makeFileManager(sessionId, tempDir)
    const agent2 = new Agent({ model, sessionManager: manager2, printer: false })
    await agent2.initialize()
    expect(agent2.messages).toHaveLength(2)

    await agent2.invoke('Hello again!')
    expect(agent2.messages).toHaveLength(4)
    expect(await getPersistedMessageCount(manager2)).toBe(4)
  })

  it('preserves conversation context across sessions', async () => {
    const sessionId = uuidv7()
    const model = bedrock.createModel()

    const manager1 = makeFileManager(sessionId, tempDir)
    const agent1 = new Agent({ model, sessionManager: manager1, printer: false })
    await agent1.invoke('My name is Alice')
    await agent1.invoke('What is my name?')
    expect(agent1.messages).toHaveLength(4)

    const manager2 = makeFileManager(sessionId, tempDir)
    const agent2 = new Agent({ model, sessionManager: manager2, printer: false })
    await agent2.initialize()
    expect(agent2.messages).toHaveLength(4)

    const result = await agent2.invoke('Repeat my name')
    const text = result.lastMessage.content.find((b) => b.type === 'textBlock')
    expect(text?.text).toMatch(/Alice/i)
  })

  it('deleteSession removes all session data', async () => {
    const sessionId = uuidv7()
    const model = bedrock.createModel()
    const manager = makeFileManager(sessionId, tempDir)
    const agent = new Agent({ model, sessionManager: manager, printer: false })
    await agent.invoke('Hello!')
    expect(await getPersistedMessageCount(manager)).toBe(2)

    await manager.deleteSession()

    const sessionDir = join(tempDir, sessionId)
    await expect(fs.access(sessionDir)).rejects.toThrow()
  })

  it('creates immutable snapshots, verifies storage layout, and restores from specific snapshot', async () => {
    const sessionId = uuidv7()
    const model = bedrock.createModel()
    const storage = new FileStorage(tempDir)

    const manager1 = new SessionManager({ sessionId, storage: { snapshot: storage }, snapshotTrigger: () => true })
    const agent1 = new Agent({ model, sessionManager: manager1, printer: false })
    await agent1.invoke('First message') // snapshot 1: 2 messages
    await agent1.invoke('Second message') // snapshot 2: 4 messages
    expect(agent1.messages).toHaveLength(4)

    // Verify storage layout
    const base = join(tempDir, sessionId, 'scopes', 'agent', 'agent', 'snapshots')
    await expect(fs.access(join(base, 'snapshot_latest.json'))).resolves.toBeUndefined()
    const files = await fs.readdir(join(base, 'immutable_history'))
    expect(files).toHaveLength(2)
    expect(files.every((f) => /^snapshot_[\w-]+\.json$/.test(f))).toBe(true)

    // Restore from snapshot 1 — should only have 2 messages
    const snapshotIds = await storage.listSnapshotIds({ location: { sessionId, scope: 'agent', scopeId: 'agent' } })
    expect(snapshotIds[0]).toBeDefined()
    const sessionManager2 = new SessionManager({
      sessionId,
      storage: { snapshot: storage },
    })
    const agent2 = new Agent({
      model,
      sessionManager: sessionManager2,
      printer: false,
    })
    await agent2.initialize()
    await sessionManager2.restoreSnapshot({ target: agent2, snapshotId: snapshotIds[0]! })
    expect(agent2.messages).toHaveLength(2)
  })
})

// ─── Stateful Model Tests ─────────────────────────────────────────────────────

describe.skipIf(openaiResponses.skip)('Session Management - stateful model (OpenAI Responses)', () => {
  let tempDir: string

  beforeAll(async () => {
    tempDir = join(tmpdir(), `strands-session-stateful-integ-${Date.now()}`)
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('persists modelState.responseId and restores a usable stateful agent', async () => {
    const sessionId = uuidv7()
    const manager1 = makeFileManager(sessionId, tempDir)
    const agent1 = new Agent({
      model: openaiResponses.createModel({ modelId: 'gpt-5.4-mini', stateful: true }),
      sessionManager: manager1,
      printer: false,
      systemPrompt: 'Reply in one short sentence.',
    })

    await agent1.invoke('Hello.')
    // Stateful invariant: server owns history, local messages stay empty.
    expect(agent1.messages).toEqual([])
    const firstResponseId = agent1.modelState.get('responseId')
    expect(firstResponseId).toEqual(expect.any(String))

    // Persisted snapshot must reflect both: empty messages and the captured responseId.
    const snap1 = await (manager1 as any)._storage.snapshot.loadSnapshot({
      location: (manager1 as any)._location({ id: 'agent' }),
    })
    expect(snap1?.data?.messages).toEqual([])
    expect(snap1?.data?.modelState).toEqual({ responseId: firstResponseId })

    // Reload into a fresh agent/manager pair backed by the same storage.
    const manager2 = makeFileManager(sessionId, tempDir)
    const agent2 = new Agent({
      model: openaiResponses.createModel({ modelId: 'gpt-5.4-mini', stateful: true }),
      sessionManager: manager2,
      printer: false,
      systemPrompt: 'Reply in one short sentence.',
    })
    await agent2.initialize()

    expect(agent2.messages).toEqual([])
    expect(agent2.modelState.get('responseId')).toBe(firstResponseId)

    // The restored agent must be able to continue the conversation. We only
    // assert mechanical outcomes — no model-output string checks, so no flake surface.
    const turn2 = await agent2.invoke('Say something brief.')
    expect(turn2.stopReason).toBe('endTurn')
    expect(agent2.messages).toEqual([])
    expect(agent2.modelState.get('responseId')).toEqual(expect.any(String))
    expect(agent2.modelState.get('responseId')).not.toBe(firstResponseId)
  })
})

// ─── S3 Storage Tests ─────────────────────────────────────────────────────────

describe.skipIf(bedrock.skip)('Session Management - S3Storage', () => {
  let bucket: string
  let credentials: any
  let s3: S3Client

  beforeAll(async () => {
    credentials = inject('provider-bedrock')?.credentials
    bucket = await getBucketName(credentials)
    s3 = new S3Client({ region: AWS_REGION, credentials })
    try {
      await s3.send(
        new CreateBucketCommand({
          Bucket: bucket,
          ...(AWS_REGION !== 'us-east-1' && { CreateBucketConfiguration: { LocationConstraint: AWS_REGION as any } }),
        })
      )
    } catch (e: any) {
      if (e?.name !== 'BucketAlreadyOwnedByYou') throw e
    }
  })

  afterAll(async () => {
    // Delete all objects then the bucket
    let token: string | undefined
    do {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }))
      const objects = list.Contents?.map((o) => ({ Key: o.Key! })) ?? []
      if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }))
      token = list.NextContinuationToken
    } while (token)
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }))
  })

  it('persists and restores agent messages across sessions', async () => {
    const sessionId = uuidv7()
    const model = bedrock.createModel()

    const manager1 = makeS3Manager(sessionId, bucket, credentials)
    const agent1 = new Agent({ model, sessionManager: manager1, printer: false })
    await agent1.invoke('Hello!')
    expect(agent1.messages).toHaveLength(2)
    expect(await getPersistedMessageCount(manager1)).toBe(2)

    const manager2 = makeS3Manager(sessionId, bucket, credentials)
    const agent2 = new Agent({ model, sessionManager: manager2, printer: false })
    await agent2.initialize()
    expect(agent2.messages).toHaveLength(2)

    await agent2.invoke('Hello again!')
    expect(agent2.messages).toHaveLength(4)
    expect(await getPersistedMessageCount(manager2)).toBe(4)
  })

  it('preserves conversation context across sessions', async () => {
    const sessionId = uuidv7()
    const model = bedrock.createModel()

    const manager1 = makeS3Manager(sessionId, bucket, credentials)
    const agent1 = new Agent({ model, sessionManager: manager1, printer: false })
    await agent1.invoke('My name is Bob')
    await agent1.invoke('What is my name?')
    expect(agent1.messages).toHaveLength(4)

    const manager2 = makeS3Manager(sessionId, bucket, credentials)
    const agent2 = new Agent({ model, sessionManager: manager2, printer: false })
    await agent2.initialize()
    expect(agent2.messages).toHaveLength(4)

    const result = await agent2.invoke('Repeat my name')
    const text = result.lastMessage.content.find((b) => b.type === 'textBlock')
    expect(text?.text).toMatch(/Bob/i)
  })

  it('deleteSession removes all session data from S3', async () => {
    const sessionId = uuidv7()
    const model = bedrock.createModel()
    const manager = makeS3Manager(sessionId, bucket, credentials)
    const agent = new Agent({ model, sessionManager: manager, printer: false })
    await agent.invoke('Hello!')
    expect(await getPersistedMessageCount(manager)).toBe(2)

    await manager.deleteSession()

    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${sessionId}/` }))
    expect(list.Contents ?? []).toHaveLength(0)
  })

  it('creates immutable snapshots and supports time-travel restore', async () => {
    const sessionId = uuidv7()
    const model = bedrock.createModel()

    const manager1 = new SessionManager({
      sessionId,
      storage: { snapshot: new S3Storage({ bucket, s3Client: new S3Client({ region: AWS_REGION, credentials }) }) },
      snapshotTrigger: ({ agentData }) => agentData.messages.length === 4,
      saveLatestOn: 'invocation',
    })
    const agent1 = new Agent({ model, sessionManager: manager1, printer: false })
    await agent1.invoke('What is 10 + 5?') // 2 messages — no snapshot
    await agent1.invoke('What is 20 * 3?') // 4 messages — snapshot 1
    await agent1.invoke('What is 100 / 4?') // 6 messages — no snapshot
    await agent1.invoke('What is 50 - 15?') // 8 messages — no snapshot
    expect(agent1.messages).toHaveLength(8)

    // Verify UUID-based S3 key naming and restore from snapshot 1 (after turn 2)
    const s3Storage = new S3Storage({ bucket, s3Client: new S3Client({ region: AWS_REGION, credentials }) })
    const snapshotIds = await s3Storage.listSnapshotIds({ location: { sessionId, scope: 'agent', scopeId: 'agent' } })
    expect(snapshotIds).toHaveLength(1)
    expect(snapshotIds.every((id) => /^[\w-]{36}$/.test(id))).toBe(true)
    expect(snapshotIds[0]).toBeDefined()
    const s3Manager2 = new SessionManager({
      sessionId,
      storage: { snapshot: s3Storage },
      saveLatestOn: 'trigger',
    })
    const agent2 = new Agent({ model, sessionManager: s3Manager2, printer: false })
    await agent2.initialize()
    await s3Manager2.restoreSnapshot({ target: agent2, snapshotId: snapshotIds[0]! })
    expect(agent2.messages).toHaveLength(4)

    const result = await agent2.invoke('What was my last question?')
    const text = result.lastMessage.content.find((b) => b.type === 'textBlock')
    expect(text?.text).toMatch(/20.*3|multiply|60/i)
  })
})
