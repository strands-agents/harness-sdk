import { describe, it, expect } from 'vitest'
import { getCollection } from 'astro:content'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  isOldApiLink,
  convertPythonApiLink,
  convertTypeScriptApiLink,
  convertApiLink,
} from '../src/util/api-link-converter'
import { resolveHref } from '../src/util/links'

/**
 * Extract anchor IDs from MDX content.
 * Looks for patterns like: <a id="strands.agent.agent.Agent"></a>
 * and heading IDs like: ## Agent {#agent}
 */
function extractAnchorsFromMdx(content: string): Set<string> {
  const anchors = new Set<string>()

  // Match <a id="..."></a> patterns
  const anchorTagRegex = /<a\s+id="([^"]+)"[^>]*>/g
  let match
  while ((match = anchorTagRegex.exec(content)) !== null) {
    if (match[1]) anchors.add(match[1])
  }

  // Match heading IDs like ## Heading {#heading-id}
  const headingIdRegex = /^#{1,6}\s+.+\s+\{#([^}]+)\}/gm
  while ((match = headingIdRegex.exec(content)) !== null) {
    if (match[1]) anchors.add(match[1])
  }

  return anchors
}

/**
 * All broken links from broken-links-analysis.md with their expected conversions.
 * Format: [oldLink, expectedNewLink]
 */
const BROKEN_LINKS_TEST_DATA: [string, string][] = [
  // user-guide/quickstart.mdx
  ['../api-reference/python/agent/agent_result.md#strands.agent.agent_result.AgentResult', '@api/python/strands.agent.agent_result#AgentResult'],
  ['../api-reference/python/models/model.md#strands.models.model.Model.get_config', '@api/python/strands.models.model#Model.get_config'],
  ['../api-reference/python/agent/agent.md#strands.agent.agent.Agent.stream_async', '@api/python/strands.agent.agent#Agent.stream_async'],
  ['../api-reference/python/agent/agent.md#strands.agent.agent.Agent.invoke_async', '@api/python/strands.agent.agent#Agent.invoke_async'],

  // user-guide/quickstart/python.mdx
  ['../../api-reference/python/agent/agent_result.md#strands.agent.agent_result.AgentResult', '@api/python/strands.agent.agent_result#AgentResult'],
  ['../../api-reference/python/models/model.md#strands.models.model.Model.get_config', '@api/python/strands.models.model#Model.get_config'],
  ['../../api-reference/python/agent/agent.md#strands.agent.agent.Agent.stream_async', '@api/python/strands.agent.agent#Agent.stream_async'],
  ['../../api-reference/python/agent/agent.md#strands.agent.agent.Agent.invoke_async', '@api/python/strands.agent.agent#Agent.invoke_async'],

  // community/model-providers/*.mdx
  ['../../api-reference/python/models/model.md', '@api/python/strands.models.model'],

  // user-guide/concepts/interrupts.mdx
  ['../../api-reference/python/types/interrupt.md#strands.types.interrupt', '@api/python/strands.types.interrupt'],

  // user-guide/observability-evaluation/metrics.mdx
  ['../../api-reference/python/agent/agent_result.md#strands.agent.agent_result.AgentResult', '@api/python/strands.agent.agent_result#AgentResult'],
  ['../../api-reference/python/telemetry/metrics.md#strands.telemetry.metrics', '@api/python/strands.telemetry.metrics'],
  ['../../api-reference/python/telemetry/metrics.md#strands.telemetry.metrics.EventLoopMetrics', '@api/python/strands.telemetry.metrics#EventLoopMetrics'],
  ['../../api-reference/python/telemetry/metrics.md#strands.telemetry.metrics.AgentInvocation', '@api/python/strands.telemetry.metrics#AgentInvocation'],
  ['../../api-reference/python/telemetry/metrics.md#strands.telemetry.metrics.ToolMetrics', '@api/python/strands.telemetry.metrics#ToolMetrics'],

  // user-guide/concepts/experimental/agent-config.mdx
  ['../../../api-reference/python/agent/agent.md#strands.agent.agent.Agent.__init__', '@api/python/strands.agent.agent#Agent.__init__'],

  // examples/python/multi_agent_example/multi_agent_example.mdx
  ['../../../api-reference/python/handlers/callback_handler.md#strands.handlers.callback_handler.PrintingCallbackHandler', '@api/python/strands.handlers.callback_handler#PrintingCallbackHandler'],

  // user-guide/concepts/agents/conversation-management.mdx
  ['../../../api-reference/python/agent/conversation_manager/null_conversation_manager.md#strands.agent.conversation_manager.null_conversation_manager.NullConversationManager', '@api/python/strands.agent.conversation_manager.null_conversation_manager#NullConversationManager'],
  ['../../../api-reference/python/agent/conversation_manager/sliding_window_conversation_manager.md#strands.agent.conversation_manager.sliding_window_conversation_manager.SlidingWindowConversationManager', '@api/python/strands.agent.conversation_manager.sliding_window_conversation_manager#SlidingWindowConversationManager'],
  ['../../../api-reference/python/agent/conversation_manager/summarizing_conversation_manager.md#strands.agent.conversation_manager.summarizing_conversation_manager.SummarizingConversationManager', '@api/python/strands.agent.conversation_manager.summarizing_conversation_manager#SummarizingConversationManager'],
  ['../../../api-reference/python/agent/conversation_manager/conversation_manager.md#strands.agent.conversation_manager.conversation_manager.ConversationManager', '@api/python/strands.agent.conversation_manager.conversation_manager#ConversationManager'],
  ['../../../api-reference/python/agent/conversation_manager/conversation_manager.md#strands.agent.conversation_manager.conversation_manager.ConversationManager.apply_management', '@api/python/strands.agent.conversation_manager.conversation_manager#ConversationManager.apply_management'],
  ['../../../api-reference/python/agent/conversation_manager/conversation_manager.md#strands.agent.conversation_manager.conversation_manager.ConversationManager.reduce_context', '@api/python/strands.agent.conversation_manager.conversation_manager#ConversationManager.reduce_context'],

  // user-guide/concepts/agents/hooks.mdx
  ['../../../api-reference/python/hooks/events.md#strands.hooks.events.AfterModelCallEvent', '@api/python/strands.hooks.events#AfterModelCallEvent'],
  ['../../../api-reference/python/hooks/events.md#strands.hooks.events.BeforeToolCallEvent', '@api/python/strands.hooks.events#BeforeToolCallEvent'],
  ['../../../api-reference/python/hooks/events.md#strands.hooks.events.AfterToolCallEvent', '@api/python/strands.hooks.events#AfterToolCallEvent'],

  // user-guide/concepts/agents/prompts.mdx
  ['../../../api-reference/python/types/content.md#strands.types.content.ContentBlock', '@api/python/strands.types.content#ContentBlock'],

  // user-guide/concepts/agents/session-management.mdx
  ['../../../api-reference/python/session/file_session_manager.md#strands.session.file_session_manager.FileSessionManager', '@api/python/strands.session.file_session_manager#FileSessionManager'],
  ['../../../api-reference/python/session/s3_session_manager.md#strands.session.s3_session_manager.S3SessionManager', '@api/python/strands.session.s3_session_manager#S3SessionManager'],
  ['../../../api-reference/python/types/session.md#strands.types.session.Session', '@api/python/strands.types.session#Session'],
  ['../../../api-reference/python/types/session.md#strands.types.session.SessionAgent', '@api/python/strands.types.session#SessionAgent'],
  ['../../../api-reference/python/types/session.md#strands.types.session.SessionMessage', '@api/python/strands.types.session#SessionMessage'],

  // user-guide/concepts/agents/state.mdx
  ['../../../api-reference/python/agent/conversation_manager/sliding_window_conversation_manager.md#strands.agent.conversation_manager.sliding_window_conversation_manager.SlidingWindowConversationManager', '@api/python/strands.agent.conversation_manager.sliding_window_conversation_manager#SlidingWindowConversationManager'],

  // user-guide/concepts/agents/structured-output.mdx
  ['../../../api-reference/python/agent/agent.md#strands.agent.agent', '@api/python/strands.agent.agent'],
  ['../../../api-reference/python/agent/agent_result.md#strands.agent.agent_result', '@api/python/strands.agent.agent_result'],

  // user-guide/concepts/bidirectional-streaming/*.mdx
  ['../../../api-reference/python/experimental/bidi/agent/agent.md', '@api/python/strands.experimental.bidi.agent.agent'],

  // user-guide/concepts/multi-agent/graph.mdx
  ['../../../api-reference/python/multiagent/graph.md#strands.multiagent.graph.GraphNode', '@api/python/strands.multiagent.graph#GraphNode'],
  ['../../../api-reference/python/multiagent/graph.md#strands.multiagent.graph.GraphEdge', '@api/python/strands.multiagent.graph#GraphEdge'],
  ['../../../api-reference/python/multiagent/graph.md#strands.multiagent.graph.GraphBuilder', '@api/python/strands.multiagent.graph#GraphBuilder'],
  ['../../../api-reference/python/multiagent/graph.md#strands.multiagent.graph.Graph', '@api/python/strands.multiagent.graph#Graph'],
  ['../../../api-reference/python/multiagent/graph.md#strands.multiagent.graph.Graph.invoke_async', '@api/python/strands.multiagent.graph#Graph.invoke_async'],
  ['../../../api-reference/python/multiagent/graph.md#strands.multiagent.graph.Graph.stream_async', '@api/python/strands.multiagent.graph#Graph.stream_async'],
  ['../../../api-reference/python/multiagent/graph.md#strands.multiagent.graph.GraphResult', '@api/python/strands.multiagent.graph#GraphResult'],
  ['../../../api-reference/python/multiagent/swarm.md#strands.multiagent.swarm.Swarm', '@api/python/strands.multiagent.swarm#Swarm'],
  ['../../../api-reference/python/multiagent/base.md#strands.multiagent.base.MultiAgentBase', '@api/python/strands.multiagent.base#MultiAgentBase'],
  ['../../../api-reference/python/types/content.md#strands.types.content.ContentBlock', '@api/python/strands.types.content#ContentBlock'],

  // user-guide/concepts/multi-agent/swarm.mdx
  ['../../../api-reference/python/multiagent/swarm.md#strands.multiagent.swarm.Swarm.invoke_async', '@api/python/strands.multiagent.swarm#Swarm.invoke_async'],
  ['../../../api-reference/python/multiagent/swarm.md#strands.multiagent.swarm.Swarm.stream_async', '@api/python/strands.multiagent.swarm#Swarm.stream_async'],
  ['../../../api-reference/python/multiagent/swarm.md#strands.multiagent.swarm.SwarmResult', '@api/python/strands.multiagent.swarm#SwarmResult'],

  // user-guide/concepts/model-providers/amazon-bedrock.mdx
  ['../../../api-reference/python/models/bedrock.md#strands.models.bedrock', '@api/python/strands.models.bedrock'],
  ['../../../api-reference/typescript/classes/BedrockModel.html', '@api/typescript/BedrockModel'],
  ['../../../api-reference/typescript/interfaces/BedrockModelOptions.html', '@api/typescript/BedrockModelOptions'],
  ['../../../api-reference/python/types/content.md', '@api/python/strands.types.content'],

  // user-guide/concepts/model-providers/anthropic.mdx
  ['../../../api-reference/python/agent/agent.md#strands.agent.agent.Agent.structured_output', '@api/python/strands.agent.agent#Agent.structured_output'],
  ['../../../api-reference/python/models/model.md', '@api/python/strands.models.model'],

  // user-guide/concepts/model-providers/ollama.mdx
  ['../../../api-reference/python/models/ollama.md#strands.models.ollama', '@api/python/strands.models.ollama'],
  ['../../../api-reference/python/models/ollama.md#strands.models.ollama.OllamaModel.OllamaConfig', '@api/python/strands.models.ollama#OllamaModel.OllamaConfig'],

  // user-guide/concepts/model-providers/custom_model_provider.mdx
  ['../../../api-reference/python/types/content.md#strands.types.content.Messages', '@api/python/strands.types.content#Messages'],
  ['../../../api-reference/python/types/content.md#strands.types.content.Role', '@api/python/strands.types.content#Role'],
  ['../../../api-reference/python/types/content.md#strands.types.content.ContentBlockStartToolUse', '@api/python/strands.types.content#ContentBlockStartToolUse'],
  ['../../../api-reference/python/types/tools.md#strands.types.tools.ToolSpec', '@api/python/strands.types.tools#ToolSpec'],
  ['../../../api-reference/python/types/streaming.md#strands.types.streaming.StreamEvent', '@api/python/strands.types.streaming#StreamEvent'],
  ['../../../api-reference/python/types/streaming.md#strands.types.streaming.MessageStartEvent', '@api/python/strands.types.streaming#MessageStartEvent'],
  ['../../../api-reference/python/types/streaming.md#strands.types.streaming.ContentBlockStartEvent', '@api/python/strands.types.streaming#ContentBlockStartEvent'],
  ['../../../api-reference/python/types/streaming.md#strands.types.streaming.ContentBlockDeltaEvent', '@api/python/strands.types.streaming#ContentBlockDeltaEvent'],
  ['../../../api-reference/python/types/streaming.md#strands.types.streaming.ContentBlockStopEvent', '@api/python/strands.types.streaming#ContentBlockStopEvent'],
  ['../../../api-reference/python/types/streaming.md#strands.types.streaming.MessageStopEvent', '@api/python/strands.types.streaming#MessageStopEvent'],
  ['../../../api-reference/python/types/streaming.md#strands.types.streaming.MetadataEvent', '@api/python/strands.types.streaming#MetadataEvent'],
  ['../../../api-reference/python/types/streaming.md#strands.types.streaming.RedactContentEvent', '@api/python/strands.types.streaming#RedactContentEvent'],
  ['../../../api-reference/python/types/event_loop.md#strands.types.event_loop.StopReason', '@api/python/strands.types.event_loop#StopReason'],

  // user-guide/concepts/tools/custom-tools.mdx
  ['../../../api-reference/python/tools/decorator.md#strands.tools.decorator.tool', '@api/python/strands.tools.decorator#tool'],
  ['../../../api-reference/python/types/tools.md#strands.types.tools.ToolContext', '@api/python/strands.types.tools#ToolContext'],
  ['../../../api-reference/python/types/tools.md#strands.types.tools.ToolResult', '@api/python/strands.types.tools#ToolResult'],

  // user-guide/concepts/tools/index.mdx
  ['../../../api-reference/python/tools/decorator.md#strands.tools.decorator.tool', '@api/python/strands.tools.decorator#tool'],

  // user-guide/concepts/streaming/async-iterators.mdx
  ['../../../api-reference/python/agent/agent.md#strands.agent.agent.Agent.stream_async', '@api/python/strands.agent.agent#Agent.stream_async'],
  ['../../../api-reference/python/agent/agent.md#strands.agent.agent.Agent.invoke_async', '@api/python/strands.agent.agent#Agent.invoke_async'],
  ['../../../api-reference/python/agent/agent.md', '@api/python/strands.agent.agent'],

  // user-guide/concepts/streaming/index.mdx
  ['../../../api-reference/python/agent/agent_result.md#strands.agent.agent_result.AgentResult', '@api/python/strands.agent.agent_result#AgentResult'],
  ['../../../api-reference/python/types/tools.md#strands.types.tools.ToolUse', '@api/python/strands.types.tools#ToolUse'],

  // user-guide/concepts/bidirectional-streaming/models/google.mdx
  ['../../../../api-reference/python/experimental/bidi/models/configs.md#strands.experimental.bidi.models.configs.AudioConfig', '@api/python/strands.experimental.bidi.models.configs#AudioConfig'],
  ['../../../../api-reference/python/experimental/bidi/models/google.md#strands.experimental.bidi.models.google.GoogleGeminiLiveModel', '@api/python/strands.experimental.bidi.models.google#GoogleGeminiLiveModel'],

  // user-guide/concepts/bidirectional-streaming/models/bedrock.mdx
  ['../../../../api-reference/python/experimental/bidi/models/configs.md#strands.experimental.bidi.models.configs.AudioConfig', '@api/python/strands.experimental.bidi.models.configs#AudioConfig'],
  ['../../../../api-reference/python/experimental/bidi/models/bedrock.md#strands.experimental.bidi.models.bedrock.BedrockNovaSonicModel', '@api/python/strands.experimental.bidi.models.bedrock#BedrockNovaSonicModel'],

  // user-guide/concepts/bidirectional-streaming/models/openai.mdx
  ['../../../../api-reference/python/experimental/bidi/models/configs.md#strands.experimental.bidi.models.configs.AudioConfig', '@api/python/strands.experimental.bidi.models.configs#AudioConfig'],
  ['../../../../api-reference/python/experimental/bidi/models/openai.md#strands.experimental.bidi.models.openai.OpenAIRealtimeModel', '@api/python/strands.experimental.bidi.models.openai#OpenAIRealtimeModel'],
]

describe('API Link Converter', () => {
  describe('isOldApiLink', () => {
    it('should detect old Python API links', () => {
      expect(isOldApiLink('../api-reference/python/agent/agent_result.md')).toBe(true)
      expect(isOldApiLink('../../api-reference/python/models/model.md')).toBe(true)
      expect(isOldApiLink('../../../api-reference/python/agent/agent.md#strands.agent.agent.Agent')).toBe(true)
    })

    it('should detect old TypeScript API links', () => {
      expect(isOldApiLink('../api-reference/typescript/classes/BedrockModel.html')).toBe(true)
      expect(isOldApiLink('../../api-reference/typescript/interfaces/BedrockModelOptions.html')).toBe(true)
    })

    it('should not detect non-API links', () => {
      expect(isOldApiLink('../user-guide/quickstart.md')).toBe(false)
      expect(isOldApiLink('@api/python/strands.agent.agent')).toBe(false)
      expect(isOldApiLink('https://example.com')).toBe(false)
      expect(isOldApiLink('./sibling.md')).toBe(false)
    })
  })

  describe('convertPythonApiLink', () => {
    it('should convert links without hash', () => {
      expect(convertPythonApiLink('../api-reference/python/models/model.md')).toBe('@api/python/strands.models.model')
      expect(convertPythonApiLink('../../api-reference/python/agent/agent.md')).toBe('@api/python/strands.agent.agent')
    })

    it('should convert links with class hash', () => {
      expect(
        convertPythonApiLink('../api-reference/python/agent/agent_result.md#strands.agent.agent_result.AgentResult')
      ).toBe('@api/python/strands.agent.agent_result#AgentResult')
    })

    it('should convert links with method hash', () => {
      expect(
        convertPythonApiLink('../api-reference/python/models/model.md#strands.models.model.Model.get_config')
      ).toBe('@api/python/strands.models.model#Model.get_config')

      expect(
        convertPythonApiLink('../api-reference/python/agent/agent.md#strands.agent.agent.Agent.stream_async')
      ).toBe('@api/python/strands.agent.agent#Agent.stream_async')
    })

    it('should convert links with module-only hash', () => {
      expect(convertPythonApiLink('../api-reference/python/types/interrupt.md#strands.types.interrupt')).toBe(
        '@api/python/strands.types.interrupt'
      )
    })

    it('should convert nested module paths', () => {
      expect(
        convertPythonApiLink(
          '../api-reference/python/agent/conversation_manager/sliding_window_conversation_manager.md#strands.agent.conversation_manager.sliding_window_conversation_manager.SlidingWindowConversationManager'
        )
      ).toBe('@api/python/strands.agent.conversation_manager.sliding_window_conversation_manager#SlidingWindowConversationManager')
    })

    it('should convert experimental module paths', () => {
      expect(convertPythonApiLink('../api-reference/python/experimental/bidi/agent/agent.md')).toBe(
        '@api/python/strands.experimental.bidi.agent.agent'
      )
    })

    it('should handle various relative path depths', () => {
      expect(convertPythonApiLink('../api-reference/python/models/bedrock.md')).toBe(
        '@api/python/strands.models.bedrock'
      )
      expect(convertPythonApiLink('../../api-reference/python/models/bedrock.md')).toBe(
        '@api/python/strands.models.bedrock'
      )
      expect(convertPythonApiLink('../../../api-reference/python/models/bedrock.md')).toBe(
        '@api/python/strands.models.bedrock'
      )
      expect(convertPythonApiLink('../../../../api-reference/python/models/bedrock.md')).toBe(
        '@api/python/strands.models.bedrock'
      )
    })

    it('should return null for non-Python API links', () => {
      expect(convertPythonApiLink('../user-guide/quickstart.md')).toBe(null)
      expect(convertPythonApiLink('../api-reference/typescript/classes/Agent.html')).toBe(null)
    })
  })

  describe('convertTypeScriptApiLink', () => {
    it('should convert class links', () => {
      expect(convertTypeScriptApiLink('../api-reference/typescript/classes/BedrockModel.html')).toBe(
        '@api/typescript/BedrockModel'
      )
      expect(convertTypeScriptApiLink('../../api-reference/typescript/classes/Agent.html')).toBe(
        '@api/typescript/Agent'
      )
    })

    it('should convert interface links', () => {
      expect(convertTypeScriptApiLink('../api-reference/typescript/interfaces/BedrockModelOptions.html')).toBe(
        '@api/typescript/BedrockModelOptions'
      )
    })

    it('should convert links with anchors', () => {
      expect(convertTypeScriptApiLink('../api-reference/typescript/classes/Agent.html#constructor')).toBe(
        '@api/typescript/Agent#constructor'
      )
    })

    it('should handle various relative path depths', () => {
      expect(convertTypeScriptApiLink('../api-reference/typescript/classes/Model.html')).toBe('@api/typescript/Model')
      expect(convertTypeScriptApiLink('../../api-reference/typescript/classes/Model.html')).toBe('@api/typescript/Model')
      expect(convertTypeScriptApiLink('../../../api-reference/typescript/classes/Model.html')).toBe(
        '@api/typescript/Model'
      )
    })

    it('should return null for non-TypeScript API links', () => {
      expect(convertTypeScriptApiLink('../user-guide/quickstart.md')).toBe(null)
      expect(convertTypeScriptApiLink('../api-reference/python/agent/agent.md')).toBe(null)
    })
  })

  describe('convertApiLink', () => {
    it('should convert Python API links', () => {
      expect(convertApiLink('../api-reference/python/agent/agent.md#strands.agent.agent.Agent')).toBe(
        '@api/python/strands.agent.agent#Agent'
      )
    })

    it('should convert TypeScript API links', () => {
      expect(convertApiLink('../api-reference/typescript/classes/BedrockModel.html')).toBe(
        '@api/typescript/BedrockModel'
      )
    })

    it('should return null for non-API links', () => {
      expect(convertApiLink('../user-guide/quickstart.md')).toBe(null)
      expect(convertApiLink('https://example.com')).toBe(null)
    })
  })

  describe('Real-world examples from broken-links-analysis.md', () => {
    // user-guide/quickstart.mdx
    it('should convert quickstart.mdx links', () => {
      expect(
        convertApiLink('../api-reference/python/agent/agent_result.md#strands.agent.agent_result.AgentResult')
      ).toBe('@api/python/strands.agent.agent_result#AgentResult')

      expect(convertApiLink('../api-reference/python/models/model.md#strands.models.model.Model.get_config')).toBe(
        '@api/python/strands.models.model#Model.get_config'
      )

      expect(convertApiLink('../api-reference/python/agent/agent.md#strands.agent.agent.Agent.stream_async')).toBe(
        '@api/python/strands.agent.agent#Agent.stream_async'
      )
    })

    // user-guide/concepts/agents/conversation-management.mdx
    it('should convert conversation-management.mdx links', () => {
      expect(
        convertApiLink(
          '../../../api-reference/python/agent/conversation_manager/null_conversation_manager.md#strands.agent.conversation_manager.null_conversation_manager.NullConversationManager'
        )
      ).toBe('@api/python/strands.agent.conversation_manager.null_conversation_manager#NullConversationManager')

      expect(
        convertApiLink(
          '../../../api-reference/python/agent/conversation_manager/conversation_manager.md#strands.agent.conversation_manager.conversation_manager.ConversationManager.apply_management'
        )
      ).toBe('@api/python/strands.agent.conversation_manager.conversation_manager#ConversationManager.apply_management')
    })

    // user-guide/concepts/model-providers/amazon-bedrock.mdx
    it('should convert amazon-bedrock.mdx links', () => {
      expect(convertApiLink('../../../api-reference/python/models/bedrock.md#strands.models.bedrock')).toBe(
        '@api/python/strands.models.bedrock'
      )

      expect(convertApiLink('../../../api-reference/typescript/classes/BedrockModel.html')).toBe(
        '@api/typescript/BedrockModel'
      )

      expect(convertApiLink('../../../api-reference/typescript/interfaces/BedrockModelOptions.html')).toBe(
        '@api/typescript/BedrockModelOptions'
      )
    })

    // user-guide/concepts/bidirectional-streaming/models/google.mdx
    it('should convert google.mdx links', () => {
      expect(
        convertApiLink(
          '../../../../api-reference/python/experimental/bidi/models/configs.md#strands.experimental.bidi.models.configs.AudioConfig'
        )
      ).toBe('@api/python/strands.experimental.bidi.models.configs#AudioConfig')

      expect(
        convertApiLink(
          '../../../../api-reference/python/experimental/bidi/models/google.md#strands.experimental.bidi.models.google.GoogleGeminiLiveModel'
        )
      ).toBe('@api/python/strands.experimental.bidi.models.google#GoogleGeminiLiveModel')
    })

    // user-guide/concepts/tools/custom-tools.mdx
    it('should convert custom-tools.mdx links', () => {
      expect(convertApiLink('../../../api-reference/python/tools/decorator.md#strands.tools.decorator.tool')).toBe(
        '@api/python/strands.tools.decorator#tool'
      )

      expect(convertApiLink('../../../api-reference/python/types/tools.md#strands.types.tools.ToolContext')).toBe(
        '@api/python/strands.types.tools#ToolContext'
      )
    })

    // Links without hash (just module reference)
    it('should convert links without hash', () => {
      expect(convertApiLink('../../api-reference/python/models/model.md')).toBe('@api/python/strands.models.model')

      expect(convertApiLink('../../../api-reference/python/types/content.md')).toBe('@api/python/strands.types.content')

      expect(convertApiLink('../../../api-reference/python/experimental/bidi/agent/agent.md')).toBe(
        '@api/python/strands.experimental.bidi.agent.agent'
      )
    })
  })

  describe('Data-driven: All broken links from broken-links-analysis.md', () => {
    it.each(BROKEN_LINKS_TEST_DATA)('converts %s -> %s', (oldLink, expectedNewLink) => {
      const result = convertApiLink(oldLink)
      expect(result).toBe(expectedNewLink)
    })

    it('should detect all test links as old API links', () => {
      for (const [oldLink] of BROKEN_LINKS_TEST_DATA) {
        expect(isOldApiLink(oldLink)).toBe(true)
      }
    })

    it('should have converted all unique broken links', () => {
      // Verify we have a reasonable number of test cases
      const uniqueLinks = new Set(BROKEN_LINKS_TEST_DATA.map(([old]) => old))
      expect(uniqueLinks.size).toBeGreaterThan(50)
      console.log(`Tested ${uniqueLinks.size} unique broken link conversions`)
    })
  })

  describe('Integration: Converted links resolve to real content', () => {
    it('should resolve all converted @api links to actual pages in the content collection', async () => {
      const docs = await getCollection('docs')
      const docSlugs = new Set(docs.map((doc) => doc.id)) as Set<string>

      const unresolvedLinks: { oldLink: string; newLink: string; slug: string }[] = []

      for (const [oldLink, expectedNewLink] of BROKEN_LINKS_TEST_DATA) {
        const converted = convertApiLink(oldLink)
        expect(converted).toBe(expectedNewLink)

        // Now verify the converted link resolves to a real page
        const { resolvedHref, found } = resolveHref(converted!, '/user-guide/quickstart/', docSlugs)

        if (!found) {
          // Extract the slug from the resolved href (remove leading/trailing slashes and anchor)
          const slug = resolvedHref.replace(/^\//, '').replace(/\/$/, '').split('#')[0]
          unresolvedLinks.push({ oldLink, newLink: converted!, slug: slug ?? '' })
        }
      }

      if (unresolvedLinks.length > 0) {
        console.log('\n=== Converted links that do not resolve to content ===\n')
        for (const { oldLink, newLink, slug } of unresolvedLinks) {
          console.log(`- ${oldLink}`)
          console.log(`  -> ${newLink}`)
          console.log(`  -> slug: ${slug} (NOT FOUND)`)
        }
      }

      expect(unresolvedLinks).toEqual([])
    })

    it('should have all expected Python API pages in the content collection', async () => {
      const docs = await getCollection('docs')
      const docSlugs = new Set(docs.map((doc) => doc.id)) as Set<string>

      // Extract unique Python module paths from test data
      const pythonModules = new Set<string>()
      for (const [, newLink] of BROKEN_LINKS_TEST_DATA) {
        if (newLink.startsWith('@api/python/')) {
          const modulePath = newLink.replace('@api/python/', '').split('#')[0]
          pythonModules.add(modulePath ?? '')
        }
      }

      const missingModules: string[] = []
      for (const modulePath of pythonModules) {
        const slug = `docs/api/python/${modulePath}`
        if (!docSlugs.has(slug)) {
          missingModules.push(slug)
        }
      }

      if (missingModules.length > 0) {
        console.log('\n=== Missing Python API pages ===\n')
        for (const slug of missingModules) {
          console.log(`- ${slug}`)
        }
      }

      expect(missingModules).toEqual([])
    })

    it('should have all expected TypeScript API pages in the content collection', async () => {
      const docs = await getCollection('docs')
      const docSlugs = new Set(docs.map((doc) => doc.id)) as Set<string>

      // Extract unique TypeScript type names from test data
      const tsTypes = new Set<string>()
      for (const [, newLink] of BROKEN_LINKS_TEST_DATA) {
        if (newLink.startsWith('@api/typescript/')) {
          const typeName = newLink.replace('@api/typescript/', '').split('#')[0]
          tsTypes.add(typeName ?? '')
        }
      }

      const missingTypes: string[] = []
      for (const typeName of tsTypes) {
        const slug = `docs/api/typescript/${typeName}`
        if (!docSlugs.has(slug)) {
          missingTypes.push(slug)
        }
      }

      if (missingTypes.length > 0) {
        console.log('\n=== Missing TypeScript API pages ===\n')
        for (const slug of missingTypes) {
          console.log(`- ${slug}`)
        }
      }

      expect(missingTypes).toEqual([])
    })

    it('should have valid hash anchors in target Python API pages', async () => {
      // Extract links with hashes that target Python API pages
      const linksWithHashes: { newLink: string; slug: string; hash: string }[] = []

      for (const [, newLink] of BROKEN_LINKS_TEST_DATA) {
        if (newLink.startsWith('@api/python/') && newLink.includes('#')) {
          const [pathPart, hash] = newLink.replace('@api/python/', '').split('#')
          if (pathPart && hash) {
            linksWithHashes.push({
              newLink,
              slug: `docs/api/python/${pathPart}`,
              hash,
            })
          }
        }
      }

      const invalidAnchors: { newLink: string; slug: string; hash: string; availableAnchors: string[] }[] = []

      // Group by slug to avoid reading the same file multiple times
      const bySlug = new Map<string, { newLink: string; hash: string }[]>()
      for (const item of linksWithHashes) {
        const existing = bySlug.get(item.slug) || []
        existing.push({ newLink: item.newLink, hash: item.hash })
        bySlug.set(item.slug, existing)
      }

      for (const [slug, items] of bySlug) {
        // Try to read the MDX file
        const mdxPath = path.resolve(`src/content/docs/${slug}.mdx`)
        let content: string
        try {
          content = await readFile(mdxPath, 'utf-8')
        } catch {
          // File doesn't exist - skip (covered by other tests)
          continue
        }

        const anchors = extractAnchorsFromMdx(content)

        for (const { newLink, hash } of items) {
          // The hash in the new format is the symbol name (e.g., "Agent" or "Agent.stream_async")
          // The anchor in the MDX is the full dotted path (e.g., "strands.agent.agent.Agent")
          // We need to construct the expected anchor ID

          // Extract the module path from the slug
          const modulePath = slug.replace('docs/api/python/', '')

          // The full anchor ID is modulePath + "." + hash (for class/method references)
          // But for simple class references, the anchor might just be modulePath.ClassName
          const possibleAnchors = [
            `${modulePath}.${hash}`, // e.g., strands.agent.agent.Agent
            hash, // Just the hash itself
          ]

          const found = possibleAnchors.some((anchor) => anchors.has(anchor))

          if (!found) {
            // Get a sample of available anchors for debugging
            const availableAnchors = Array.from(anchors).slice(0, 10)
            invalidAnchors.push({ newLink, slug, hash, availableAnchors })
          }
        }
      }

      if (invalidAnchors.length > 0) {
        console.log('\n=== Invalid hash anchors (not found in target file) ===\n')
        for (const { newLink, slug, hash, availableAnchors } of invalidAnchors) {
          console.log(`- ${newLink}`)
          console.log(`  File: ${slug}.mdx`)
          console.log(`  Hash: ${hash}`)
          console.log(`  Available anchors (sample): ${availableAnchors.join(', ')}`)
        }
      }

      expect(invalidAnchors).toEqual([])
    })
  })
})
