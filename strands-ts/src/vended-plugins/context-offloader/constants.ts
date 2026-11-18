/**
 * Names the context offloader shares with the core SDK, kept apart from the plugin so the core doesn't load it.
 */

/**
 * Name of the tool a model calls to read back content the offloader moved out of context.
 *
 * @internal
 */
export const RETRIEVAL_TOOL_NAME = 'retrieve_offloaded_content'
