import { describe, it, expect } from 'vitest'
import { isOldApiLink, convertApiLink } from '../src/util/api-link-converter'

/**
 * Test the API link conversion utilities.
 */
describe('API link conversion', () => {
  /**
   * Helper function to convert API links in markdown content
   * Uses a regex that handles nested brackets in link text
   */
  function convertApiLinks(content: string): string {
    // Match markdown links with potentially nested brackets in the text
    // This handles cases like [`list[ToolSpec]`](url)
    const markdownLinkPattern = /\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

    return content.replace(markdownLinkPattern, (match, text, url) => {
      if (isOldApiLink(url)) {
        const newUrl = convertApiLink(url)
        if (newUrl) {
          return `[${text}](${newUrl})`
        }
      }
      return match
    })
  }

  describe('convertApiLinks', () => {
    it('should convert Python API links in markdown', () => {
      const input = `See the [AgentResult](../api-reference/python/agent/agent_result.md#strands.agent.agent_result.AgentResult) class.`
      const expected = `See the [AgentResult](@api/python/strands.agent.agent_result#AgentResult) class.`
      expect(convertApiLinks(input)).toBe(expected)
    })

    it('should convert TypeScript API links in markdown', () => {
      const input = `Use the [BedrockModel](../api-reference/typescript/classes/BedrockModel.html) class.`
      const expected = `Use the [BedrockModel](@api/typescript/BedrockModel) class.`
      expect(convertApiLinks(input)).toBe(expected)
    })

    it('should convert multiple API links in the same content', () => {
      const input = `
The [Agent](../api-reference/python/agent/agent.md#strands.agent.agent.Agent) class uses
[BedrockModel](../../api-reference/typescript/classes/BedrockModel.html) by default.
See also [AgentResult](../api-reference/python/agent/agent_result.md#strands.agent.agent_result.AgentResult).
`
      const expected = `
The [Agent](@api/python/strands.agent.agent#Agent) class uses
[BedrockModel](@api/typescript/BedrockModel) by default.
See also [AgentResult](@api/python/strands.agent.agent_result#AgentResult).
`
      expect(convertApiLinks(input)).toBe(expected)
    })

    it('should not modify non-API links', () => {
      const input = `
See the [quickstart guide](../user-guide/quickstart.md) for more info.
Check out [GitHub](https://github.com/strands-agents/harness-sdk).
`
      expect(convertApiLinks(input)).toBe(input)
    })

    it('should handle links with titles', () => {
      const input = `See [AgentResult](../api-reference/python/agent/agent_result.md#strands.agent.agent_result.AgentResult "The result class").`
      const expected = `See [AgentResult](@api/python/strands.agent.agent_result#AgentResult).`
      expect(convertApiLinks(input)).toBe(expected)
    })

    it('should handle links without hash anchors', () => {
      const input = `See the [model module](../api-reference/python/models/model.md) for details.`
      const expected = `See the [model module](@api/python/strands.models.model) for details.`
      expect(convertApiLinks(input)).toBe(expected)
    })

    it('should handle deeply nested relative paths', () => {
      const input = `See [AudioConfig](../../../../api-reference/python/experimental/bidi/models/configs.md#strands.experimental.bidi.models.configs.AudioConfig).`
      const expected = `See [AudioConfig](@api/python/strands.experimental.bidi.models.configs#AudioConfig).`
      expect(convertApiLinks(input)).toBe(expected)
    })

    it('should handle TypeScript interface links', () => {
      const input = `Configure with [BedrockModelOptions](../api-reference/typescript/interfaces/BedrockModelOptions.html).`
      const expected = `Configure with [BedrockModelOptions](@api/typescript/BedrockModelOptions).`
      expect(convertApiLinks(input)).toBe(expected)
    })

    it('should preserve link text exactly', () => {
      const input = `The [\`Agent.stream_async()\`](../api-reference/python/agent/agent.md#strands.agent.agent.Agent.stream_async) method.`
      const expected = `The [\`Agent.stream_async()\`](@api/python/strands.agent.agent#Agent.stream_async) method.`
      expect(convertApiLinks(input)).toBe(expected)
    })

    it('should handle mixed content with code blocks', () => {
      const input = `
Use the [Agent](../api-reference/python/agent/agent.md#strands.agent.agent.Agent) class:

\`\`\`python
from strands import Agent
agent = Agent()
\`\`\`

See [AgentResult](../api-reference/python/agent/agent_result.md#strands.agent.agent_result.AgentResult) for results.
`
      const expected = `
Use the [Agent](@api/python/strands.agent.agent#Agent) class:

\`\`\`python
from strands import Agent
agent = Agent()
\`\`\`

See [AgentResult](@api/python/strands.agent.agent_result#AgentResult) for results.
`
      expect(convertApiLinks(input)).toBe(expected)
    })

    it('should handle links with backticks in link text', () => {
      const input = `- [\`list[ToolSpec]\`](../../../api-reference/python/types/tools.md#strands.types.tools.ToolSpec): List of tool specifications.`
      const expected = `- [\`list[ToolSpec]\`](@api/python/strands.types.tools#ToolSpec): List of tool specifications.`
      expect(convertApiLinks(input)).toBe(expected)
    })

    it('should handle links with square brackets in link text', () => {
      const input = `See [\`dict[str, Any]\`](../api-reference/python/types/content.md#strands.types.content.ContentBlock) for details.`
      const expected = `See [\`dict[str, Any]\`](@api/python/strands.types.content#ContentBlock) for details.`
      expect(convertApiLinks(input)).toBe(expected)
    })
  })
})
