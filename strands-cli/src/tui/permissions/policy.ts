import { resolve } from 'node:path'
import type { BeforeToolCallEvent } from '@strands-agents/sdk'
import { InterventionActions, InterventionHandler } from '@strands-agents/sdk'
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'

import { type ChatDiffPreview, type ChatPermissionRequest, type ChatPermissionOption } from '../chat/controller.js'
import { containsPath } from '../paths.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { buildFileChangePreview, sanitizeDiffPreview } from './file-change-preview.js'
import { canonicalPath, permissionAction, permissionRuleDecision, permissionScopes } from './rules.js'
import { CliConfigStore, type PermissionMode, type CliConfigSnapshot } from '../config.js'
import { isRecord } from '../values.js'

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
  action == Action::"retrieve_context",
  resource
);

// Vended by a ContextOffloader (one a project adds, or an older harness release).
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
  { id: 'allow-always', label: 'Allow forever', kind: 'allow_always' },
  { id: 'deny', label: 'Deny once', kind: 'reject_once' },
  { id: 'deny-always', label: 'Deny forever', kind: 'reject_always' },
]

export type PermissionDecision =
  | { type: 'allow-once' }
  | { type: 'deny' }
  | { type: 'allow-always'; rule: string }
  | { type: 'deny-always'; rule: string }
type PermissionListener = (request: ChatPermissionRequest | undefined) => void

interface PermissionRequestDetails {
  diff?: ChatDiffPreview
  action?: string
  scopes?: ChatPermissionRequest['scopes']
}

interface PendingPermission {
  request: ChatPermissionRequest
  resolve: (decision: PermissionDecision) => void
}

const DENY: PermissionDecision = { type: 'deny' }

export class ToolPermissionBroker {
  private readonly _listeners = new Set<PermissionListener>()
  private readonly _queue: PendingPermission[] = []
  private _active: PendingPermission | undefined
  private _nextRequest = 1
  private _disposed = false

  request(
    toolName: string,
    input: BeforeToolCallEvent['toolUse']['input'],
    details: PermissionRequestDetails = {}
  ): Promise<PermissionDecision> {
    if (this._disposed) {
      return Promise.resolve(DENY)
    }
    const { diff, action, scopes = [{ rule: toolName, label: '*' }] } = details
    const request: ChatPermissionRequest = {
      id: `strands-permission-${this._nextRequest++}`,
      toolName: sanitizeTerminalText(toolName),
      input: globalThis.structuredClone(input),
      options: PERMISSION_OPTIONS.map((option) => ({ ...option })),
      scopes: scopes.map((scope) => ({ ...scope })),
      ...(action !== undefined ? { action } : {}),
      ...(diff ? { diff } : {}),
    }
    return new Promise((resolveDecision) => {
      this._queue.push({ request, resolve: resolveDecision })
      this._activateNext()
    })
  }

  /** `rule` picks one of the request's scopes for a forever choice; it defaults to the most specific. */
  respond(requestId: string, optionId?: string, rule?: string): boolean {
    const active = this._active
    const decision = active?.request.id === requestId ? permissionDecision(active.request, optionId, rule) : undefined
    if (!active || !decision) {
      return false
    }
    this._active = undefined
    active.resolve(decision)
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
      permission.resolve(DENY)
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
  configurationDenied?: (revision: number) => void
}

export class CedarPermissions extends InterventionHandler {
  readonly name = 'strands:cedar-permissions'
  override readonly onError = 'deny'

  private readonly _broker: ToolPermissionBroker
  private readonly _config: CliConfigStore
  private readonly _cedar: CedarAuthorization
  private readonly _configurationPreview: CedarPermissionsOptions['configurationPreview']
  private readonly _configurationDenied: CedarPermissionsOptions['configurationDenied']
  private readonly _workspace: string

  constructor(options: CedarPermissionsOptions) {
    super()
    this._broker = options.broker
    this._config = options.config ?? CliConfigStore.memory()
    this._configurationPreview = options.configurationPreview
    this._configurationDenied = options.configurationDenied
    const workspace = canonicalPath(options.cwd)
    this._workspace = workspace
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
          (toolInput.action === 'inspect' || toolInput.action === 'models' || toolInput.action === 'update'),
      }),
    })
  }

  override async beforeToolCall(event: BeforeToolCallEvent): Promise<ReturnType<CedarAuthorization['beforeToolCall']>> {
    const action = await this._authorizeToolCall(event)
    const { name, input } = event.toolUse
    if (
      action.type === 'deny' &&
      name === 'strands_config' &&
      isRecord(input) &&
      input.action === 'apply' &&
      typeof input.revision === 'number' &&
      Number.isInteger(input.revision)
    ) {
      this._configurationDenied?.(input.revision)
    }
    return action
  }

  private async _authorizeToolCall(
    event: BeforeToolCallEvent
  ): Promise<ReturnType<CedarAuthorization['beforeToolCall']>> {
    const toolName = sanitizeTerminalText(event.toolUse.name)
    const input = event.toolUse.input
    const configured = this._config.snapshot().permissions
    const saved = permissionRuleDecision(toolName, input, configured, this._workspace)
    if (saved === 'deny') {
      return InterventionActions.deny(`Tool call denied by user configuration: ${toolName}`)
    }
    if (configured.mode === 'bypassPermissions') {
      return InterventionActions.proceed({ reason: 'Permission checks bypassed by user configuration' })
    }
    if (saved === 'allow') {
      return InterventionActions.proceed({ reason: `Tool always allowed by user configuration: ${toolName}` })
    }
    const cedarDecision = this._cedar.beforeToolCall(event)
    if (cedarDecision.type !== 'deny' || !cedarDecision.reason.startsWith('Access denied by Cedar policy')) {
      return cedarDecision
    }

    const diff = toolName === 'strands_config' ? this._configurationPreview?.() : await buildFileChangePreview(event)
    const decision = await requestToolPermission(this._broker, toolName, input, this._workspace, diff)
    return applyPermissionDecision(this._config, toolName, decision)
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

  removeDeniedTool(rule: string): Promise<void> {
    return this._config.removeDeniedTool(rule)
  }
}

/** Prompts for a call, offering the action it performs and the rules a forever choice can save. */
export function requestToolPermission(
  broker: ToolPermissionBroker,
  toolName: string,
  input: BeforeToolCallEvent['toolUse']['input'],
  workspace: string,
  diff?: ChatDiffPreview
): Promise<PermissionDecision> {
  const action = permissionAction(toolName, input, workspace)
  return broker.request(toolName, input, {
    ...(diff ? { diff } : {}),
    ...(action !== undefined ? { action } : {}),
    scopes: permissionScopes(toolName, input, workspace),
  })
}

export async function savePermissionDecision(config: CliConfigStore, decision: PermissionDecision): Promise<void> {
  if (decision.type === 'allow-always') await config.allowTool(decision.rule)
  if (decision.type === 'deny-always') await config.denyTool(decision.rule)
}

/** Saves a forever choice and returns the intervention action for the call being decided. */
export async function applyPermissionDecision(
  config: CliConfigStore,
  toolName: string,
  decision: PermissionDecision
): Promise<ReturnType<CedarAuthorization['beforeToolCall']>> {
  await savePermissionDecision(config, decision)
  if (decision.type === 'allow-always') {
    return InterventionActions.proceed({ reason: `Tool always allowed by user configuration: ${decision.rule}` })
  }
  if (decision.type === 'deny-always') {
    return InterventionActions.deny(`Tool call denied by user configuration: ${decision.rule}`)
  }
  if (decision.type === 'allow-once') {
    return InterventionActions.proceed({ reason: `Tool approved once by the user: ${toolName}` })
  }
  return InterventionActions.deny(`Tool call denied by the user: ${toolName}`)
}

function permissionDecision(
  request: ChatPermissionRequest,
  optionId: string | undefined,
  rule: string | undefined
): PermissionDecision | undefined {
  if (!request.options.some((option) => option.id === optionId)) return undefined
  if (optionId === 'allow-once' || optionId === 'deny') return { type: optionId }
  const scopes = request.scopes ?? []
  const scope = rule === undefined ? scopes[0] : scopes.find((candidate) => candidate.rule === rule)
  if (!scope || (optionId !== 'allow-always' && optionId !== 'deny-always')) return undefined
  return { type: optionId, rule: scope.rule }
}

export function pathIsWithinWorkspace(value: unknown, workspace: string): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false
  }
  return containsPath(workspace, canonicalPath(resolve(workspace, value)))
}

function clonePermissionRequest(request: ChatPermissionRequest): ChatPermissionRequest {
  return {
    id: request.id,
    toolName: request.toolName,
    input: globalThis.structuredClone(request.input),
    options: request.options.map((option) => ({ ...option })),
    ...(request.action !== undefined ? { action: request.action } : {}),
    ...(request.scopes ? { scopes: request.scopes.map((scope) => ({ ...scope })) } : {}),
    ...(request.diff ? { diff: sanitizeDiffPreview(request.diff) } : {}),
  }
}
