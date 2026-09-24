import type { HarnessAgentOptions, SessionConfig } from '@strands-agents/harness'
import { SessionManager } from '@strands-agents/sdk'

/** The `session` option unpacked: `enabled` mirrors the harness toggle (`undefined` leaves the default on). */
export interface SessionSettings {
  enabled: boolean
  id?: string
  dir?: string
  manager?: SessionManager
}

export function sessionSettings(session: HarnessAgentOptions['session']): SessionSettings {
  if (session === undefined || session === true) {
    return { enabled: true }
  }
  if (session === false || session === null) {
    return { enabled: false }
  }
  if (session instanceof SessionManager) {
    return { enabled: true, manager: session }
  }
  return {
    enabled: true,
    ...(session.id !== undefined ? { id: session.id } : {}),
    ...(session.dir !== undefined ? { dir: session.dir } : {}),
  }
}

export function sessionId(options: Pick<HarnessAgentOptions, 'session'>): string | undefined {
  return sessionSettings(options.session).id
}

export function sessionDir(options: Pick<HarnessAgentOptions, 'session'>): string | undefined {
  return sessionSettings(options.session).dir
}

/**
 * Sets `session.id`/`session.dir`, keeping other configured keys. A disabled session or a `SessionManager`
 * instance is returned as is; `id: undefined` clears the id so the harness mints a fresh one.
 */
export function withSession(
  options: HarnessAgentOptions,
  settings: { id?: string | undefined; dir?: string }
): HarnessAgentOptions {
  if (options.session === false || options.session === null || options.session instanceof SessionManager) {
    return options
  }
  const current: SessionConfig = typeof options.session === 'object' && options.session !== null ? options.session : {}
  const next: SessionConfig = { ...current }
  if ('id' in settings) {
    if (settings.id === undefined) delete next.id
    else next.id = settings.id
  }
  if (settings.dir !== undefined) next.dir = settings.dir
  return { ...options, session: next }
}
