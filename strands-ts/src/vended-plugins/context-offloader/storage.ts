/**
 * Legacy storage backends for offloaded tool result content.
 *
 * @deprecated Use the unified `Storage` from `@strands-agents/sdk/storage` instead.
 * This module's `Storage` interface and its implementations (`InMemoryStorage`,
 * `FileStorage`, `S3Storage`) are retained for backwards compatibility only.
 */

import type { Sandbox } from '../../sandbox/base.js'
import { logger } from '../../logging/logger.js'

/**
 * Backend for storing and retrieving offloaded content blocks.
 *
 * Implement this interface to create custom storage backends (e.g., Redis, DynamoDB).
 * The SDK ships three built-in implementations: `InMemoryStorage`,
 * `FileStorage`, and `S3Storage`.
 *
 * @deprecated Use the unified `Storage` from `@strands-agents/sdk/storage` interface instead.
 * Pass it directly to `ContextOffloaderConfig.storage` — the plugin adapts it internally.
 */
export interface Storage {
  /**
   * Store content and return a reference identifier.
   *
   * @param key - Unique key for this content block
   * @param content - Raw content bytes to store
   * @param contentType - MIME type of the content (e.g., "text/plain", "image/png")
   * @returns Reference string for later retrieval
   */
  store(key: string, content: Uint8Array, contentType?: string): Promise<string>

  /**
   * Retrieve previously stored content by reference.
   *
   * @param reference - Reference returned by a previous {@link store} call
   * @returns Content bytes and content type
   * @throws Error if the reference is not found
   */
  retrieve(reference: string): Promise<{ content: Uint8Array; contentType: string }>
}

function sanitizeId(rawId: string): string {
  return rawId
    .replace(/\.\./g, '_')
    .replace(/[/\\]/g, '_')
    .replace(/[^\w\-.]/g, '_')
}

/**
 * Remove any trailing `/` characters from a path-like string.
 *
 * Implemented as a linear scan rather than a `/\/+$/` replacement so that
 * inputs with long runs of slashes are handled in linear time.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') {
    end--
  }
  return value.slice(0, end)
}

/**
 * In-memory storage backend.
 *
 * Useful for testing and serverless environments where disk access is not available.
 * Supports turn-based eviction: entries not accessed (stored or retrieved) within
 * `evictAfterTurns` agent loop cycles are automatically removed when the plugin
 * calls `_evict`. Eviction is enabled by default (20 cycles). Pass `null` to disable.
 *
 * Note: content does not survive process restarts. For multi-session persistence,
 * use {@link FileStorage} or {@link S3Storage}. Each agent should use its own
 * `InMemoryStorage` instance — sharing one across multiple agents is not supported
 * when eviction is enabled.
 *
 * Evicted entries are permanently deleted from memory. The agent will receive
 * an error if it attempts to retrieve evicted content.
 *
 * @deprecated Pass a unified `Storage` from `@strands-agents/sdk/storage` (e.g.
 * `InMemoryStorage` from `@strands-agents/sdk/storage`) to the ContextOffloader instead.
 * @param evictAfterTurns - Cycles of inactivity before eviction. Defaults to 20. `null` disables.
 */
export class InMemoryStorage implements Storage {
  private _store = new Map<string, { content: Uint8Array; contentType: string; lastAccessedCycle: number }>()
  private _counter = 0
  private _currentCycle = 0
  private _evictAfterTurns: number | null
  private _boundAgent: WeakRef<object> | null = null

  static readonly DEFAULT_EVICT_AFTER_TURNS = 20

  constructor(evictAfterTurns: number | null = InMemoryStorage.DEFAULT_EVICT_AFTER_TURNS) {
    if (evictAfterTurns !== null && evictAfterTurns < 1) {
      throw new Error('evictAfterTurns must be a positive integer')
    }
    this._evictAfterTurns = evictAfterTurns
  }

  /** {@inheritdoc} */
  async store(key: string, content: Uint8Array, contentType: string = 'text/plain'): Promise<string> {
    this._counter++
    const reference = `mem_${this._counter}_${key}`
    this._store.set(reference, { content, contentType, lastAccessedCycle: this._currentCycle })
    return reference
  }

  /** {@inheritdoc} */
  async retrieve(reference: string): Promise<{ content: Uint8Array; contentType: string }> {
    const entry = this._store.get(reference)
    if (!entry) {
      throw new Error(`Reference not found: ${reference}`)
    }
    entry.lastAccessedCycle = this._currentCycle
    return { content: entry.content, contentType: entry.contentType }
  }

  /**
   * Claim this storage for a single agent. Optionally override the eviction window
   * when the user hasn't explicitly set one at construction time.
   * @internal
   */
  _bind(agent: object, evictAfterCycles?: number | null): void {
    if (this._boundAgent === null) {
      this._boundAgent = new WeakRef(agent)
    } else if (this._boundAgent.deref() !== agent) {
      throw new Error(
        'InMemoryStorage cannot be shared across multiple agents. ' +
          'Use a separate InMemoryStorage instance per agent.'
      )
    }
    if (evictAfterCycles !== undefined && this._evictAfterTurns === InMemoryStorage.DEFAULT_EVICT_AFTER_TURNS) {
      this._evictAfterTurns = evictAfterCycles
    }
  }

  /**
   * Update current cycle and evict stale entries.
   * Called by the ContextOffloader plugin on each BeforeModelCallEvent.
   * @internal
   */
  _evict(cycle: number): void {
    this._currentCycle = cycle
    if (this._evictAfterTurns === null) return
    const threshold = cycle - this._evictAfterTurns
    let evicted = 0
    for (const [ref, entry] of this._store) {
      if (entry.lastAccessedCycle < threshold) {
        this._store.delete(ref)
        evicted++
      }
    }
    if (evicted > 0) {
      logger.debug(`evicted=<${evicted}>, cycle=<${cycle}> | stale entries removed`)
    }
  }

  /** Remove all stored content. */
  clear(): void {
    this._store.clear()
  }
}

/**
 * File-based storage backend.
 *
 * Stores offloaded content as files on the host filesystem, or through a configured
 * {@link Sandbox}. File extensions are derived from the content type. A `.metadata.json`
 * sidecar file tracks content types across restarts. References are portable filenames.
 *
 * When used by {@link ContextOffloader} without an explicit sandbox, FileStorage is
 * bound to each agent's sandbox, which may be the default NotASandboxLocalEnvironment.
 *
 * @deprecated Pass a unified `Storage` from `@strands-agents/sdk/storage` (e.g.
 * `LocalFileStorage` from `@strands-agents/sdk/storage`) to the ContextOffloader instead.
 */
export interface FileStorageOptions {
  /** Directory path where artifact files will be stored. Defaults to `./artifacts`. */
  artifactDir?: string
  /** Sandbox to use for direct store/retrieve calls. */
  sandbox?: Sandbox
}

/**
 * @deprecated Use `LocalFileStorage` from `@strands-agents/sdk/storage` instead.
 */
export class FileStorage implements Storage {
  private static readonly METADATA_FILE = '.metadata.json'
  private readonly _artifactDir: string
  private readonly _sandbox: Sandbox | undefined
  private _counter = 0
  private _contentTypes: Record<string, string> = {}
  private _metadataLoaded = false
  private _metadataWriteChain: Promise<void> = Promise.resolve()

  constructor(options: string | FileStorageOptions = './artifacts') {
    if (typeof options === 'string') {
      this._artifactDir = options
      this._sandbox = undefined
    } else {
      this._artifactDir = options.artifactDir ?? './artifacts'
      this._sandbox = options.sandbox
    }
  }

  /**
   * Return a storage instance bound to the provided sandbox.
   *
   * Instances constructed with an explicit sandbox keep using that sandbox. Detached
   * instances produce a new storage object so a shared ContextOffloader can isolate
   * artifacts for each agent sandbox.
   *
   * @param sandbox - Sandbox to use for the returned storage instance.
   */
  forSandbox(sandbox: Sandbox): FileStorage {
    if (this._sandbox) return this
    return new FileStorage({ artifactDir: this._artifactDir, sandbox })
  }

  private static _extensionFor(contentType: string): string {
    if (contentType === 'text/plain') return '.txt'
    return `.${contentType.split('/').pop()}`
  }

  private _artifactPath(filename: string): string {
    return `${this._artifactDir.replace(/\/+$/, '')}/${filename}`
  }

  private async _ensureDir(): Promise<typeof import('node:fs/promises')> {
    const fs = await import('node:fs/promises')
    await fs.mkdir(this._artifactDir, { recursive: true })
    if (!this._metadataLoaded) {
      this._contentTypes = await this._loadMetadata(fs)
      this._metadataLoaded = true
    }
    return fs
  }

  private async _ensureSandbox(): Promise<Sandbox> {
    const sandbox = this._sandbox
    if (!sandbox) {
      throw new Error('FileStorage requires a Sandbox to be configured on the storage instance.')
    }
    if (!this._metadataLoaded) {
      this._contentTypes = await this._loadSandboxMetadata(sandbox)
      this._metadataLoaded = true
    }
    return sandbox
  }

  private async _loadMetadata(fs: typeof import('node:fs/promises')): Promise<Record<string, string>> {
    const path = await import('node:path')
    const metadataPath = path.join(this._artifactDir, FileStorage.METADATA_FILE)
    try {
      const raw = await fs.readFile(metadataPath, 'utf-8')
      return JSON.parse(raw) as Record<string, string>
    } catch {
      return {}
    }
  }

  private async _loadSandboxMetadata(sandbox: Sandbox): Promise<Record<string, string>> {
    try {
      const raw = await sandbox.readText(this._artifactPath(FileStorage.METADATA_FILE))
      return JSON.parse(raw) as Record<string, string>
    } catch {
      return {}
    }
  }

  private async _saveMetadata(fs: typeof import('node:fs/promises')): Promise<void> {
    const path = await import('node:path')
    const metadataPath = path.join(this._artifactDir, FileStorage.METADATA_FILE)
    await fs.writeFile(metadataPath, JSON.stringify(this._contentTypes), 'utf-8')
  }

  private async _saveSandboxMetadata(sandbox: Sandbox): Promise<void> {
    await sandbox.writeText(this._artifactPath(FileStorage.METADATA_FILE), JSON.stringify(this._contentTypes))
  }

  private _knownFilename(candidate: string): string {
    if (Object.hasOwn(this._contentTypes, candidate)) return candidate
    const matches = Object.keys(this._contentTypes).filter(
      (filename) => filename.slice(0, filename.lastIndexOf('.')) === candidate
    )
    return matches.length === 1 ? matches[0]! : candidate
  }

  /** {@inheritdoc} */
  async store(key: string, content: Uint8Array, contentType: string = 'text/plain'): Promise<string> {
    if (this._sandbox) {
      const sandbox = await this._ensureSandbox()
      const filename = `${Date.now()}_${++this._counter}_${sanitizeId(key)}${FileStorage._extensionFor(contentType)}`
      const filePath = this._artifactPath(filename)

      this._contentTypes[filename] = contentType
      this._metadataWriteChain = this._metadataWriteChain.then(() => this._saveSandboxMetadata(sandbox))
      await this._metadataWriteChain

      await sandbox.writeFile(filePath, content)

      return filename
    }

    const fs = await this._ensureDir()
    const path = await import('node:path')

    const sanitizedKey = sanitizeId(key)
    const timestampMs = Date.now()
    this._counter++
    const ext = FileStorage._extensionFor(contentType)
    const filename = `${timestampMs}_${this._counter}_${sanitizedKey}${ext}`

    this._contentTypes[filename] = contentType
    this._metadataWriteChain = this._metadataWriteChain.then(() => this._saveMetadata(fs))
    await this._metadataWriteChain

    const filePath = path.join(this._artifactDir, filename)
    await fs.writeFile(filePath, content)

    return filename
  }

  /** {@inheritdoc} */
  async retrieve(reference: string): Promise<{ content: Uint8Array; contentType: string }> {
    if (this._sandbox) {
      const sandbox = await this._ensureSandbox()

      const prefix = `${this._artifactDir.replace(/\/+$/, '')}/`
      const candidate = reference.startsWith(prefix) ? reference.slice(prefix.length) : reference
      if (!candidate || candidate.includes('..') || /[/\\]/.test(candidate)) {
        throw new Error(`Reference not found: ${reference}`)
      }
      const filename = this._knownFilename(candidate)

      try {
        const content = await sandbox.readFile(this._artifactPath(filename))
        const contentType = this._contentTypes[filename] ?? 'application/octet-stream'
        return { content, contentType }
      } catch {
        throw new Error(`Reference not found: ${reference}`)
      }
    }

    const fs = await this._ensureDir()
    const path = await import('node:path')

    const resolvedDir = path.resolve(this._artifactDir)
    const candidatePath =
      reference === path.basename(reference) ? path.join(resolvedDir, reference) : path.resolve(reference)
    if (reference.split(/[/\\]/).includes('..') || path.dirname(candidatePath) !== resolvedDir) {
      throw new Error(`Reference not found: ${reference}`)
    }
    const filename = this._knownFilename(path.basename(candidatePath))
    const filePath = path.join(resolvedDir, filename)

    try {
      const content = await fs.readFile(filePath)
      const contentType = this._contentTypes[filename] ?? 'application/octet-stream'
      return { content: new Uint8Array(content), contentType }
    } catch {
      throw new Error(`Reference not found: ${reference}`)
    }
  }
}

/**
 * S3-based storage backend.
 *
 * Stores offloaded content as S3 objects. Content type is preserved as S3 object metadata.
 * References are `s3://` URIs for direct access via AWS CLI or SDK.
 *
 * @deprecated Pass a unified `Storage` from `@strands-agents/sdk/storage` (e.g.
 * `S3Storage` from `@strands-agents/sdk/storage`) to the ContextOffloader instead.
 * @param bucket - S3 bucket name
 * @param options - Optional configuration (prefix, region, pre-configured S3Client)
 */
export class S3Storage implements Storage {
  private readonly _bucket: string
  private readonly _prefix: string
  private _client: import('@aws-sdk/client-s3').S3Client | undefined
  private readonly _region: string
  private _counter = 0

  constructor(
    bucket: string,
    options?: { prefix?: string; region?: string; s3Client?: import('@aws-sdk/client-s3').S3Client }
  ) {
    this._bucket = bucket
    this._prefix = options?.prefix ? stripTrailingSlashes(options.prefix) + '/' : ''
    this._client = options?.s3Client
    this._region = options?.region ?? 'us-east-1'
  }

  private async _getClient(): Promise<import('@aws-sdk/client-s3').S3Client> {
    if (this._client) return this._client
    const { S3Client } = await import('@aws-sdk/client-s3')
    this._client = new S3Client({ region: this._region })
    return this._client
  }

  /** {@inheritdoc} */
  async store(key: string, content: Uint8Array, contentType: string = 'text/plain'): Promise<string> {
    const client = await this._getClient()
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')

    const sanitizedKey = sanitizeId(key)
    const timestampMs = Date.now()
    this._counter++
    const s3Key = `${this._prefix}${timestampMs}_${this._counter}_${sanitizedKey}`

    await client.send(
      new PutObjectCommand({
        Bucket: this._bucket,
        Key: s3Key,
        Body: content,
        ContentType: contentType,
      })
    )

    return `s3://${this._bucket}/${s3Key}`
  }

  /** {@inheritdoc} */
  async retrieve(reference: string): Promise<{ content: Uint8Array; contentType: string }> {
    const client = await this._getClient()
    const { GetObjectCommand } = await import('@aws-sdk/client-s3')

    // Accept both s3:// URIs and raw keys
    let s3Key = reference
    const uriMatch = reference.match(/^s3:\/\/([^/]+)\/(.+)$/)
    if (uriMatch?.[1] && uriMatch[2]) {
      if (uriMatch[1] !== this._bucket) {
        throw new Error(`Reference not found: ${reference} (bucket mismatch)`)
      }
      s3Key = uriMatch[2]
    }

    // Constrain references to the configured prefix, mirroring the scope store() enforces.
    if (this._prefix && !s3Key.startsWith(this._prefix)) {
      throw new Error(`Reference not found: ${reference}`)
    }

    try {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: this._bucket,
          Key: s3Key,
        })
      )
      const body = await response.Body?.transformToByteArray()
      if (!body) throw new Error(`Reference not found: ${reference}`)
      const contentType = response.ContentType ?? 'application/octet-stream'
      return { content: new Uint8Array(body), contentType }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'NoSuchKey') {
        throw new Error(`Reference not found: ${reference}`, { cause: error })
      }
      throw error
    }
  }
}
