import { AfterInvocationEvent } from '../hooks/events.js'
import { logger } from '../logging/logger.js'
import type { Model } from '../models/model.js'
import type { LocalAgent } from '../types/agent.js'
import type { Plugin } from './plugin.js'

/**
 * Built-in plugin that manages model-related lifecycle hooks.
 *
 * When the model is stateful (server-managed conversation state), this plugin
 * clears the agent's local message history after each invocation since the
 * server holds the authoritative conversation state.
 *
 * Internal: wired up automatically by Agent; not re-exported from the package
 * entrypoint and not intended to be instantiated by consumers.
 */
export class ModelPlugin implements Plugin {
  readonly name = 'strands:model'
  private readonly _model: Model

  constructor(model: Model) {
    this._model = model
  }

  initAgent(agent: LocalAgent): void {
    const model = this._model
    agent.addHook(AfterInvocationEvent, () => {
      if (model.stateful) {
        agent.messages.length = 0
        logger.debug('cleared messages for server-managed conversation')
      }
    })
  }
}
