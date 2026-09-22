import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { BeforeToolCallEvent } from '@strands-agents/sdk'
import { InterventionActions, InterventionHandler } from '@strands-agents/sdk'
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'

import { type ChatDiffPreview, type ChatPermissionRequest, type ChatPermissionOption } from '../chat/controller.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { buildFileChangePreview, sanitizeDiffPreview } from './file-change-preview.js'
import { CliConfigStore, type PermissionMode, type CliConfigSnapshot } from '../config.js'

export const DEFAULT_CEDAR_POLICIES = `
permit (
  principal,
  action == Action::"read",
  resource
) when {
  context.session.path_in_workspace
};

permit (
  principal,
  action == Action::"todo_write",
  resource
);

permit (
  principal,
  action == Action::"retrieve_offloaded_content",
  resource
);

permit (
  principal,
  action == Action::"strands_config",
  resource
) when {
  context.session.configuration_draft
};
`

const PERMISSION_OPTIONS: readonly ChatPermissionOption[] = [
  { id: 'allow-once', label: 'Allow once', kind: 'allow_once' },
  {
    id: 'allow-tool-always',
    label: 'Always allow tool',
    description: 'Save this tool to config.json',
    kind: 'allow_always',
  },
  { id: 'deny', label: 'Deny', kind: 'reject_once' },
]

type PermissionDecision = 'allow-once' | 'allow-tool-always' | 'deny'
type PermissionListener = (request: ChatPermissionRequest | undefined) => void

interface PendingPermission {
  request: ChatPermissionRequest
  resolve: (decision: PermissionDecision) => void
}

export class ToolPermissionBroker {
  private readonly _listeners = new Set<PermissionListener>()
  private readonly _queue: PendingPermission[] = []
  private _active: PendingPermission | undefined
  private _nextRequest = 1
  private _disposed = false

  request(
    toolName: string,
    input: BeforeToolCallEvent['toolUse']['input'],
    diff?: ChatDiffPreview
  ): Promise<PermissionDecision> {
    if (this._disposed) {
      return Promise.resolve('deny')
    }
    const request: ChatPermissionRequest = {
      id: `strands-permission-${this._nextRequest++}`,
      toolName: sanitizeTerminalText(toolName),
      input: globalThis.structuredClone(input),
      options: PERMISSION_OPTIONS.filter(
        (option) => toolName !== 'strands_config' || option.kind !== 'allow_always'
      ).map((option) => ({ ...option })),
      ...(diff ? { diff } : {}),
    }
    return new Promise((resolveDecision) => {
      this._queue.push({ request, resolve: resolveDecision })
      this._activateNext()
    })
  }

  respond(requestId: string, optionId?: string): boolean {
    const active = this._active
    if (
      !active ||
      active.request.id !== requestId ||
      !isPermissionDecision(optionId) ||
      !active.request.options.some((option) => option.id === optionId)
    ) {
      return false
    }
    this._active = undefined
    active.resolve(optionId)
    this._notify(undefined)
    void Promise.resolve().then(() => this._activateNext())
    return true
  }

  subscribe(listener: PermissionListener): () => void {
    this._listeners.add(listener)
    if (this._active) {
      listener(clonePermissionRequest(this._active.request))
    }
    return () => {
      this._listeners.delete(listener)
    }
  }

  cancelAll(): void {
    const pending = [...(this._active ? [this._active] : []), ...this._queue]
    this._active = undefined
    this._queue.length = 0
    for (const permission of pending) {
      permission.resolve('deny')
    }
    this._notify(undefined)
  }

  dispose(): void {
    if (this._disposed) {
      return
    }
    this._disposed = true
    this.cancelAll()
    this._listeners.clear()
  }

  private _activateNext(): void {
    if (this._active || this._disposed) {
      return
    }
    this._active = this._queue.shift()
    if (this._active) {
      this._notify(this._active.request)
    }
  }

  private _notify(request: ChatPermissionRequest | undefined): void {
    for (const listener of this._listeners) {
      listener(request ? clonePermissionRequest(request) : undefined)
    }
  }
}

interface CedarPermissionsOptions {
  broker: ToolPermissionBroker
  config?: CliConfigStore
  cwd: string
  policies?: string
  configurationPreview?: () => ChatDiffPreview | undefined
  trustedTools?: readonly string[]
}

export class CedarPermissions extends InterventionHandler {
  readonly name = 'strands:cedar-permissions'
  override readonly onError = 'deny'

  private readonly _broker: ToolPermissionBroker
  private readonly _config: CliConfigStore
  private readonly _cedar: CedarAuthorization
  private readonly _configurationPreview: CedarPermissionsOptions['configurationPreview']
  private readonly _trustedTools: ReadonlySet<string>

  constructor(options: CedarPermissionsOptions) {
    super()
    this._broker = options.broker
    this._config = options.config ?? CliConfigStore.memory()
    this._configurationPreview = options.configurationPreview
    this._trustedTools = new Set(options.trustedTools?.map(sanitizeTerminalText))
    const workspace = canonicalPath(options.cwd)
    this._cedar = new CedarAuthorization({
      policies: options.policies ?? DEFAULT_CEDAR_POLICIES,
      onError: 'deny',
      contextEnricher: ({
        toolName,
        toolInput,
      }): { workspace: string; path_in_workspace: boolean; configuration_draft: boolean } => ({
        workspace,
        path_in_workspace: toolName === 'read' && pathIsWithinWorkspace(toolInput.path, workspace),
        configuration_draft:
          toolName === 'strands_config' &&
          (toolInput.action === 'inspect' ||
            toolInput.action === 'models' ||
            toolInput.action === 'update' ||
            toolInput.action === 'reset'),
      }),
    })
  }

  override async beforeToolCall(event: BeforeToolCallEvent): Promise<ReturnType<CedarAuthorization['beforeToolCall']>> {
    const toolName = sanitizeTerminalText(event.toolUse.name)
    const configured = this._config.snapshot().permissions
    if (this._trustedTools.has(toolName)) {
      return InterventionActions.proceed({ reason: `Tool trusted for this session: ${toolName}` })
    }
    if (configured.mode === 'bypassPermissions') {
      return InterventionActions.proceed({ reason: 'Permission checks bypassed by user configuration' })
    }
    if (toolName !== 'strands_config' && configured.allow.includes(toolName)) {
      return InterventionActions.proceed({ reason: `Tool always allowed by user configuration: ${toolName}` })
    }
    const cedarDecision = this._cedar.beforeToolCall(event)
    if (cedarDecision.type !== 'deny' || !cedarDecision.reason.startsWith('Access denied by Cedar policy')) {
      return cedarDecision
    }

    const diff = toolName === 'strands_config' ? this._configurationPreview?.() : await buildFileChangePreview(event)
    const decision = await this._broker.request(toolName, event.toolUse.input, diff)
    if (decision === 'allow-tool-always' && toolName !== 'strands_config') {
      await this._config.allowTool(toolName)
      return InterventionActions.proceed({ reason: `Tool always allowed by user configuration: ${toolName}` })
    }
    if (decision === 'allow-once') {
      return InterventionActions.proceed({ reason: `Tool approved once by the user: ${toolName}` })
    }
    return InterventionActions.deny(`Tool call denied by the user: ${toolName}`)
  }

  permissionStatus(): CliConfigSnapshot {
    return this._config.snapshot()
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    this._broker.cancelAll()
    return this._config.setPermissionMode(mode)
  }

  allowTool(toolName: string): Promise<void> {
    return this._config.allowTool(toolName)
  }

  removeAllowedTool(toolName: string): Promise<void> {
    return this._config.removeAllowedTool(toolName)
  }
}

function isPermissionDecision(value: string | undefined): value is PermissionDecision {
  return value === 'allow-once' || value === 'allow-tool-always' || value === 'deny'
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function pathIsWithinWorkspace(value: unknown, workspace: string): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false
  }
  const candidate = canonicalPath(resolve(workspace, value))
  const pathFromWorkspace = relative(workspace, candidate)
  return pathFromWorkspace !== '..' && !pathFromWorkspace.startsWith(`..${sep}`) && !isAbsolute(pathFromWorkspace)
}

function clonePermissionRequest(request: ChatPermissionRequest): ChatPermissionRequest {
  return {
    id: request.id,
    toolName: request.toolName,
    input: globalThis.structuredClone(request.input),
    options: request.options.map((option) => ({ ...option })),
    ...(request.diff ? { diff: sanitizeDiffPreview(request.diff) } : {}),
  }
}
