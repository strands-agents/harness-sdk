/**
 * Utility to convert old MkDocs-style API reference links to the new @api shorthand format.
 *
 * Old formats:
 * - Python: `../api-reference/python/agent/agent_result.md#strands.agent.agent_result.AgentResult`
 * - TypeScript: `../api-reference/typescript/classes/BedrockModel.html`
 *
 * New formats:
 * - Python: `@api/python/strands.agent.agent_result#AgentResult`
 * - TypeScript: `@api/typescript/BedrockModel`
 */

/**
 * Pattern to match old Python API links.
 * Captures: path segments and optional hash with full dotted path
 */
const PYTHON_API_PATTERN = /^(\.\.\/)*api-reference\/python\/([^#]+)\.md(#(.+))?$/

/**
 * Pattern to match old TypeScript API links.
 * Captures: classes/interfaces subdirectory and the type name
 */
const TS_API_PATTERN = /^(\.\.\/)*api-reference\/typescript\/(?:classes|interfaces)\/([^.]+)\.html(#(.+))?$/

/**
 * Map a strands.experimental.bidi module path to its strands.bidi equivalent.
 */
function resolveExperimentalBidiModule(modulePath: string): string {
  return modulePath.replace(/^strands\.experimental\.bidi(?=\.|$)/, 'strands.bidi')
}

/**
 * Check if a link is an old-style API reference link that needs conversion.
 */
export function isOldApiLink(link: string): boolean {
  return PYTHON_API_PATTERN.test(link) || TS_API_PATTERN.test(link)
}

/**
 * Convert an old Python API link to the new @api shorthand format.
 *
 * The hash fragment contains the full dotted path (e.g., `strands.agent.agent_result.AgentResult`).
 * We extract the module path (everything up to the last segment) and the symbol (last segment).
 *
 * Examples:
 * - `../api-reference/python/agent/agent_result.md#strands.agent.agent_result.AgentResult`
 *   -> `@api/python/strands.agent.agent_result#AgentResult`
 * - `../api-reference/python/models/model.md#strands.models.model.Model.get_config`
 *   -> `@api/python/strands.models.model#Model.get_config`
 * - `../api-reference/python/models/model.md` (no hash)
 *   -> `@api/python/strands.models.model`
 */
export function convertPythonApiLink(link: string): string | null {
  const match = link.match(PYTHON_API_PATTERN)
  if (!match) return null

  const pathPart = match[2] ?? '' // e.g., "agent/agent_result" or "models/model"
  const hashContent = match[4] // e.g., "strands.agent.agent_result.AgentResult" or undefined

  if (hashContent) {
    // Hash contains the full dotted path - extract module and symbol
    // The module path is typically the part that matches the file structure
    // The symbol is what comes after (class name, method, etc.)

    // Find where the module path ends and the symbol begins
    // Module paths follow the pattern: strands.{path segments matching file structure}
    const pathSegments = pathPart.split('/')
    const modulePrefix = 'strands.' + pathSegments.join('.')

    if (hashContent.startsWith(modulePrefix)) {
      // Everything after the module prefix is the symbol
      const symbolPart = hashContent.slice(modulePrefix.length)
      if (symbolPart.startsWith('.')) {
        // There's a symbol after the module path
        return `@api/python/${resolveExperimentalBidiModule(modulePrefix)}#${symbolPart.slice(1)}`
      } else if (symbolPart === '') {
        // Hash points to the module itself
        return `@api/python/${resolveExperimentalBidiModule(modulePrefix)}`
      }
    }

    // Fallback: use the hash content directly to determine module
    // This handles cases where the hash might not perfectly match the path
    const hashParts = hashContent.split('.')
    // Find the likely module boundary (usually before a capitalized class name)
    let moduleEndIndex = hashParts.length
    for (let i = 1; i < hashParts.length; i++) {
      const part = hashParts[i]
      if (part && /^[A-Z]/.test(part)) {
        moduleEndIndex = i
        break
      }
    }

    const modulePath = resolveExperimentalBidiModule(hashParts.slice(0, moduleEndIndex).join('.'))
    const symbol = hashParts.slice(moduleEndIndex).join('.')

    if (symbol) {
      return `@api/python/${modulePath}#${symbol}`
    } else {
      return `@api/python/${modulePath}`
    }
  } else {
    // No hash - convert path to dotted module notation
    const modulePath = resolveExperimentalBidiModule('strands.' + pathPart.split('/').join('.'))
    return `@api/python/${modulePath}`
  }
}

/**
 * Convert an old TypeScript API link to the new @api shorthand format.
 *
 * Examples:
 * - `../api-reference/typescript/classes/BedrockModel.html` -> `@api/typescript/BedrockModel`
 * - `../api-reference/typescript/interfaces/BedrockModelOptions.html` -> `@api/typescript/BedrockModelOptions`
 * - `../api-reference/typescript/classes/Agent.html#constructor` -> `@api/typescript/Agent#constructor`
 */
export function convertTypeScriptApiLink(link: string): string | null {
  const match = link.match(TS_API_PATTERN)
  if (!match) return null

  const typeName = match[2] // e.g., "BedrockModel"
  const anchor = match[4] // e.g., "constructor" or undefined

  if (anchor) {
    return `@api/typescript/${typeName}#${anchor}`
  }
  return `@api/typescript/${typeName}`
}

/**
 * Convert any old-style API link to the new @api shorthand format.
 * Returns null if the link is not an API reference link.
 */
export function convertApiLink(link: string): string | null {
  if (PYTHON_API_PATTERN.test(link)) {
    return convertPythonApiLink(link)
  }
  if (TS_API_PATTERN.test(link)) {
    return convertTypeScriptApiLink(link)
  }
  return null
}
