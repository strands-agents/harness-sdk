import type { ToolDefinition } from './cedar.js'

/** Adapter for `@cedar-policy/mcp-schema-generator-wasm` — generates Cedar schemas from tool definitions. */
export interface SchemaGenerator {
  generateSchema(tools: ToolDefinition[]): string
}

/** Creates a SchemaGenerator from the loaded `@cedar-policy/mcp-schema-generator-wasm` module. */
export function createSchemaGenerator(
  wasm: {
    generateSchema: (stub: string, toolsJson: string, configJson?: string) => string
  },
  namespace?: string
): SchemaGenerator {
  const ns = namespace ?? 'Agent'
  const defaultStub = `
namespace ${ns} {
  @mcp_principal
  entity User;
  @mcp_resource
  entity Resource;
  @mcp_context("session")
  type SessionContext = {
    hour_utc: Long,
    call_count: Long
  };
}
`

  return {
    generateSchema(tools: ToolDefinition[]): string {
      const config = JSON.stringify({ flattenNamespaces: true })
      const result = JSON.parse(wasm.generateSchema(defaultStub, JSON.stringify(tools), config)) as {
        schema: string | null
        error: string | null
        isOk: boolean
      }
      if (!result.isOk || !result.schema) {
        throw new Error(`Schema generation failed: ${result.error}`)
      }
      // When namespace is configured, preserve the schema as-is (namespaced).
      // Otherwise, strip the namespace wrapper for backward compatibility.
      if (namespace) {
        return result.schema
      }
      const nsMatch = result.schema.match(/^namespace\s+(\w+)\s*\{/)
      const ns = nsMatch ? nsMatch[1]! : 'Agent'
      return result.schema
        .replace(/^namespace\s+\w+\s*\{/, '')
        .replace(/\}\s*$/, '')
        .replaceAll(`${ns}::`, '')
    },
  }
}
