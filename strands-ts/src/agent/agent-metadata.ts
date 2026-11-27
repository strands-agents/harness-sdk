/**
 * Read-only view of agent metadata passed to a model on `stream()`.
 *
 * Populated by the agent per request. Because it is rebuilt for every request, a single
 * model instance shared across agents sees each agent's own identity rather than a value
 * baked in at construction.
 */
export interface AgentMetadata {
  /** The agent's persisted session id; present only when a session manager is attached. */
  sessionId?: string
}
