import type { Scope, Snapshot, SnapshotManifest } from '../session/types.js'
import type { SnapshotStorage, SnapshotLocation } from '../session/index.js'

export function createTestSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: '1.0',
    scope: 'agent',
    createdAt: '2024-01-01T00:00:00.000Z',
    data: {
      messages: [],
      state: { testKey: 'testValue' },
      systemPrompt: 'You are a test assistant',
    },
    appData: {},
    ...overrides,
  }
}

export function createTestManifest(overrides: Partial<SnapshotManifest> = {}): SnapshotManifest {
  return {
    schemaVersion: '1.0',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function createTestScope(kind: 'agent' | 'multiAgent' = 'agent'): Scope {
  return kind
}

export function createTestSnapshots(count: number, baseSnapshot?: Partial<Snapshot>): Snapshot[] {
  return Array.from({ length: count }, (_, i) =>
    createTestSnapshot({
      ...baseSnapshot,
      createdAt: new Date(2024, 0, 1, 0, i).toISOString(),
    })
  )
}

/**
 * Mock storage implementation for testing that stores data in memory
 */
export class MockSnapshotStorage implements SnapshotStorage {
  private snapshots = new Map<string, Snapshot>()
  private manifests = new Map<string, SnapshotManifest>()
  public shouldThrowErrors = false

  async saveSnapshot(params: {
    location: SnapshotLocation
    snapshotId: string
    isLatest: boolean
    snapshot: Snapshot
  }): Promise<void> {
    if (this.shouldThrowErrors) throw new Error('Mock save error')

    const { location, snapshotId, isLatest, snapshot } = params
    const key = this.getKey(location, snapshotId)
    this.snapshots.set(key, snapshot)

    if (isLatest) {
      this.snapshots.set(this.getKey(location, 'latest'), snapshot)
    }
  }

  async loadSnapshot(params: { location: SnapshotLocation; snapshotId?: string }): Promise<Snapshot | null> {
    if (this.shouldThrowErrors) throw new Error('Mock load error')

    if (params.snapshotId === undefined) {
      return this.snapshots.get(this.getKey(params.location, 'latest')) ?? null
    }
    return this.snapshots.get(this.getKey(params.location, params.snapshotId)) ?? null
  }

  async listSnapshotIds(params: {
    location: SnapshotLocation
    limit?: number
    startAfter?: string
  }): Promise<string[]> {
    if (this.shouldThrowErrors) throw new Error('Mock list error')

    const prefix = `${params.location.sessionId}::${params.location.scope}::${params.location.scopeId}::`
    let ids: string[] = []

    for (const [key] of this.snapshots) {
      if (key.startsWith(prefix) && !key.endsWith('::latest')) {
        ids.push(key.slice(prefix.length))
      }
    }

    ids = ids.sort()
    if (params.startAfter) {
      ids = ids.filter((id) => id > params.startAfter!)
    }
    if (params.limit !== undefined) {
      ids = ids.slice(0, params.limit)
    }
    return ids
  }

  async deleteSession(params: { sessionId: string }): Promise<void> {
    if (this.shouldThrowErrors) throw new Error('Mock delete error')

    for (const key of this.snapshots.keys()) {
      if (key.startsWith(`${params.sessionId}::`)) this.snapshots.delete(key)
    }
    for (const key of this.manifests.keys()) {
      if (key.startsWith(`${params.sessionId}::`)) this.manifests.delete(key)
    }
  }

  async loadManifest(params: { location: SnapshotLocation }): Promise<SnapshotManifest> {
    if (this.shouldThrowErrors) throw new Error('Mock manifest load error')

    const { sessionId } = params.location
    if (!sessionId) {
      throw new Error('Invalid sessionId: cannot be empty or undefined')
    }

    const key = this.getManifestKey(params.location)
    return (
      this.manifests.get(key) ?? {
        schemaVersion: '1.0',
        updatedAt: new Date().toISOString(),
      }
    )
  }

  async saveManifest(params: { location: SnapshotLocation; manifest: SnapshotManifest }): Promise<void> {
    if (this.shouldThrowErrors) throw new Error('Mock manifest save error')

    const { sessionId } = params.location
    if (!sessionId) {
      throw new Error('Invalid sessionId: cannot be empty or undefined')
    }

    this.manifests.set(this.getManifestKey(params.location), params.manifest)
  }

  private getKey(location: SnapshotLocation, snapshotId: string): string {
    if (!location.sessionId) {
      throw new Error('Invalid sessionId: cannot be empty or undefined')
    }
    return `${location.sessionId}::${location.scope}::${location.scopeId}::${snapshotId}`
  }

  private getManifestKey(location: SnapshotLocation): string {
    if (!location.sessionId) {
      throw new Error('Invalid sessionId: cannot be empty or undefined')
    }
    return `${location.sessionId}::${location.scope}::${location.scopeId}::manifest`
  }
}
