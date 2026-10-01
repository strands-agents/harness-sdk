import { ProtocolError, ProtocolErrorCode, UrlElicitationRequiredError } from '@modelcontextprotocol/client'

import { createErrorResult, Tool, type ToolContext, type ToolStreamGenerator } from './tool.js'
import type { ToolSpec } from './types.js'
import type { JSONSchema, JSONValue } from '../types/json.js'
import { JsonBlock, TextBlock, ToolResultBlock, type ToolResultContent } from '../types/messages.js'
import { ImageBlock, decodeBase64 } from '../types/media.js'
import { toMediaFormat, IMAGE_FORMATS, type ImageFormat } from '../mime.js'
import type { McpClient } from '../mcp/index.js'
import { logger } from '../logging/logger.js'

export interface McpToolConfig {
  name: string
  description: string
  inputSchema: JSONSchema
  outputSchema?: JSONSchema
  annotations?: Record<string, JSONValue | undefined>
  client: McpClient
}

/**
 * A Tool implementation that proxies calls to a remote MCP server.
 *
 * Unlike FunctionTool, which wraps local logic, McpTool delegates execution
 * to the connected McpClient and translates the SDK's response format
 * directly into ToolResultBlocks.
 */
export class McpTool extends Tool {
  readonly name: string
  readonly description: string
  readonly toolSpec: ToolSpec
  private readonly mcpClient: McpClient

  constructor(config: McpToolConfig) {
    super()
    this.name = config.name
    this.description = config.description
    this.toolSpec = {
      name: config.name,
      description: config.description,
      inputSchema: config.inputSchema,
      ...(config.outputSchema !== undefined && { outputSchema: config.outputSchema }),
      ...(config.annotations !== undefined && { annotations: config.annotations }),
    }
    this.mcpClient = config.client
  }

  // eslint-disable-next-line require-yield
  async *stream(toolContext: ToolContext): ToolStreamGenerator {
    const { toolUseId, input } = toolContext.toolUse

    try {
      const rawResult: unknown = await this.mcpClient.callTool(this, input as JSONValue, {
        signal: toolContext.cancelSignal,
      })

      if (!this._isMcpToolResult(rawResult)) {
        throw new Error('Invalid tool result from MCP Client: missing content array')
      }

      const content: ToolResultContent[] = []

      for (const item of rawResult.content) {
        content.push(this._mapMcpContent(item))
      }

      if (content.length === 0) {
        content.push(new TextBlock('Tool execution completed successfully with no output.'))
      }

      return new ToolResultBlock({
        toolUseId,
        status: rawResult.isError ? 'error' : 'success',
        content,
      })
    } catch (error) {
      if (
        error instanceof UrlElicitationRequiredError ||
        (error instanceof ProtocolError && error.code === ProtocolErrorCode.UrlElicitationRequired)
      ) {
        const elicitations =
          error instanceof UrlElicitationRequiredError
            ? error.elicitations
            : (error.data as Record<string, unknown> | undefined)?.elicitations
        if (Array.isArray(elicitations) && elicitations.length > 0) {
          return new ToolResultBlock({
            toolUseId,
            status: 'error',
            content: [
              new TextBlock(`MCP Elicitation required: [${String(error)}] with data ${JSON.stringify(elicitations)}`),
            ],
          })
        }
      }
      return createErrorResult(error, toolUseId)
    }
  }

  /**
   * Maps a single MCP content item to an SDK ToolResultContent block.
   *
   * @param item - MCP content item from tool result
   * @returns Mapped content block
   */
  private _mapMcpContent(item: unknown): ToolResultContent {
    if (!item || typeof item !== 'object') {
      return new JsonBlock({ json: item as JSONValue })
    }

    const record = item as Record<string, unknown>

    switch (record.type) {
      case 'text':
        if (typeof record.text === 'string') {
          return new TextBlock(record.text)
        }
        return new JsonBlock({ json: item as JSONValue })

      case 'image':
        return this._mapMcpImageContent(record)

      case 'resource':
        return this._mapMcpEmbeddedResource(record)

      default:
        return new JsonBlock({ json: item as JSONValue })
    }
  }

  /**
   * Maps an MCP image content item to an ImageBlock.
   *
   * @param record - MCP image content with data (base64) and mimeType
   * @returns ImageBlock or TextBlock fallback if format is unsupported
   */
  private _mapMcpImageContent(record: Record<string, unknown>): ToolResultContent {
    const data = record.data
    const mimeType = record.mimeType

    if (typeof data !== 'string' || typeof mimeType !== 'string') {
      logger.warn('content_type=<image> | mcp image content missing data or mimeType, falling back to json')
      return new JsonBlock({ json: record as JSONValue })
    }

    const format = toMediaFormat(mimeType)
    if (!format || !this._isImageFormat(format)) {
      logger.warn(`mime_type=<${mimeType}> | unsupported mcp image mime type, falling back to json`)
      return new JsonBlock({ json: record as JSONValue })
    }

    return new ImageBlock({
      format,
      source: { bytes: decodeBase64(data) },
    })
  }

  /**
   * Maps an MCP embedded resource to an SDK content block.
   * Text resources become TextBlock, blob resources with image MIME types become ImageBlock.
   *
   * @param record - MCP embedded resource content
   * @returns Mapped content block or undefined if unsupported
   */
  private _mapMcpEmbeddedResource(record: Record<string, unknown>): ToolResultContent {
    const resource = record.resource
    if (!resource || typeof resource !== 'object') {
      return new JsonBlock({ json: record as JSONValue })
    }

    const res = resource as Record<string, unknown>

    // Text resource
    if (typeof res.text === 'string') {
      return new TextBlock(res.text)
    }

    // Blob resource
    if (typeof res.blob === 'string' && typeof res.mimeType === 'string') {
      const format = toMediaFormat(res.mimeType)
      if (format && this._isImageFormat(format)) {
        return new ImageBlock({
          format,
          source: { bytes: decodeBase64(res.blob) },
        })
      }
      // Non-image blob: fall back to json
      logger.warn(`mime_type=<${res.mimeType}> | unsupported mcp resource blob mime type, falling back to json`)
    }

    return new JsonBlock({ json: record as JSONValue })
  }

  /**
   * Type Guard: Checks if value matches the expected MCP SDK result shape.
   * \{ content: unknown[]; isError?: boolean \}
   */
  private _isMcpToolResult(value: unknown): value is { content: unknown[]; isError?: boolean } {
    if (typeof value !== 'object' || value === null) {
      return false
    }

    // Safe cast to generic record to check properties
    const record = value as Record<string, unknown>

    return Array.isArray(record.content)
  }

  /**
   * Type Guard: Checks if a media format is a supported image format.
   */
  private _isImageFormat(format: string): format is ImageFormat {
    return (IMAGE_FORMATS as readonly string[]).includes(format)
  }
}
