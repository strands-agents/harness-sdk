/**
 * Null implementation of conversation management.
 *
 * This module provides a no-op conversation manager that does not modify
 * the conversation history. Useful for testing and scenarios where conversation
 * management is handled externally.
 */

import { ConversationManager, type ConversationManagerReduceOptions } from './conversation-manager.js'

/**
 * A no-op conversation manager that does not modify the conversation history.
 *
 * Does not register any proactive hooks. Overflow errors will not be retried
 * since `reduce` always returns `false`.
 */
export class NullConversationManager extends ConversationManager {
  /**
   * Unique identifier for this conversation manager.
   */
  readonly name = 'strands:null-conversation-manager'

  /**
   * No-op reduction — never modifies the conversation history.
   *
   * @returns `false` always
   */
  reduce(_args: ConversationManagerReduceOptions): boolean {
    return false
  }
}
