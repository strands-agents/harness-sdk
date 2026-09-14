import type { ElicitResult, ElicitRequestParams, ClientContext } from '@modelcontextprotocol/client'

/**
 * Context provided to an elicitation callback. The abort signal for the in-flight request is
 * available at `context.mcpReq.signal`.
 */
export type ElicitationContext = ClientContext

/**
 * Callback invoked when an MCP server sends an elicitation request to gather user input during tool execution.
 *
 * @param context - Request context including abort signal.
 * @param params - The elicitation parameters from the server (message, requested schema or URL).
 * @returns The user's response: accept (with content), decline, or cancel.
 */
export type ElicitationCallback = (context: ElicitationContext, params: ElicitRequestParams) => Promise<ElicitResult>
