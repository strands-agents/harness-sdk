import type { Agent, AgentResult, AgentStreamEvent } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'

import { projectAgentEvent, projectAgentResult } from '../src/tui/chat/sdk-projector.js'

describe('projectAgentEvent', () => {
  it('projects text, reasoning, and complete tool events', () => {
    expect(
      projectAgentEvent({
        type: 'modelStreamUpdateEvent',
        event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: 'think' } },
      } as unknown as AgentStreamEvent)
    ).toEqual([{ type: 'reasoningDelta', text: 'think' }])
    expect(
      projectAgentEvent({
        type: 'modelStreamUpdateEvent',
        event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'answer' } },
      } as unknown as AgentStreamEvent)
    ).toEqual([{ type: 'textDelta', text: 'answer' }])
    expect(
      projectAgentEvent({
        type: 'beforeToolCallEvent',
        toolUse: { toolUseId: 'tool-1', name: 'bash', input: { command: 'pwd' } },
      } as unknown as AgentStreamEvent)
    ).toEqual([{ type: 'toolStart', toolUseId: 'tool-1', name: 'bash', input: { command: 'pwd' } }])
    expect(
      projectAgentEvent({
        type: 'contentBlockEvent',
        contentBlock: {
          type: 'toolUseBlock',
          toolUseId: 'tool-2',
          name: 'read',
          input: { path: 'src/auth.ts', _background_execution: true },
        },
      } as unknown as AgentStreamEvent)
    ).toEqual([
      {
        type: 'toolStart',
        toolUseId: 'tool-2',
        name: 'read',
        input: { path: 'src/auth.ts', _background_execution: true },
        background: true,
      },
    ])
    expect(
      projectAgentEvent(
        {
          type: 'contentBlockEvent',
          contentBlock: {
            type: 'toolUseBlock',
            toolUseId: 'tool-3',
            name: 'subagent',
            input: { task: 'Review authentication.' },
          },
        } as unknown as AgentStreamEvent,
        { alwaysBackgroundTools: new Set(['subagent']) }
      )
    ).toEqual([
      {
        type: 'toolStart',
        toolUseId: 'tool-3',
        name: 'subagent',
        input: { task: 'Review authentication.' },
        background: true,
      },
    ])
  })

  it('projects tool-result media and directly emitted media', () => {
    const image = projectAgentEvent({
      type: 'toolResultEvent',
      result: {
        toolUseId: 'tool-1',
        status: 'success',
        content: [
          {
            type: 'imageBlock',
            format: 'png',
            source: { type: 'imageSourceUrl', url: 'https://example.com/image.png' },
          },
          {
            type: 'videoBlock',
            format: 'mp4',
            source: {
              type: 'videoSourceS3Location',
              location: { uri: 's3://bucket/video.mp4', bucketOwner: '123' },
            },
          },
        ],
      },
    } as unknown as AgentStreamEvent)

    expect(image).toMatchObject([
      {
        type: 'toolResult',
        content: [
          { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
          {
            type: 'video',
            source: { type: 's3', location: { uri: 's3://bucket/video.mp4', bucketOwner: '123' } },
          },
        ],
      },
    ])

    const media = projectAgentEvent({
      type: 'contentBlockEvent',
      contentBlock: {
        type: 'imageBlock',
        format: 'jpeg',
        source: { type: 'imageSourceBytes', bytes: new Uint8Array([7, 8]) },
      },
    } as unknown as AgentStreamEvent)
    expect(media).toEqual([
      {
        type: 'media',
        content: { type: 'image', format: 'jpeg', source: { type: 'bytes', bytes: new Uint8Array([7, 8]) } },
      },
    ])
  })
})

describe('projectAgentResult', () => {
  it('projects accumulated usage when no latest invocation exists', () => {
    const agent = {
      model: { getConfig: () => ({}) },
    } as unknown as Agent
    const result = {
      stopReason: 'endTurn',
      lastMessage: {
        role: 'assistant',
        content: [
          { type: 'reasoningBlock', text: 'careful' },
          { type: 'textBlock', text: 'complete answer' },
        ],
      },
      metrics: {
        accumulatedUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      },
    } as AgentResult

    expect(projectAgentResult(agent, result)).toMatchObject({
      finalText: 'complete answer',
      finalReasoning: 'careful',
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
    })
  })

  it('does not infer a context limit when the model config omits one', () => {
    const agent = {
      model: {
        getConfig: () => ({}),
        estimateUtilization: (tokens: number) => tokens / 200_000,
      },
    } as unknown as Agent
    const result = {
      stopReason: 'endTurn',
      contextSize: 12_000,
      projectedContextSize: 12_500,
    } as AgentResult

    expect(projectAgentResult(agent, result).context).toEqual({
      currentTokens: 12_000,
      projectedTokens: 12_500,
    })
  })
})
