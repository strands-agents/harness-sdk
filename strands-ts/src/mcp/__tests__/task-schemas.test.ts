import { describe, expect, it } from 'vitest'

import type { McpInputRequests, McpInputResponses } from '../task-types.js'
import type { ElicitationCallback } from '../../types/elicitation.js'
import {
  McpInputResponsesSchema,
  McpCallToolWithTaskResultSchema,
  McpGetTaskResultSchema,
  McpTaskStatusNotificationSchema,
  McpTaskAcknowledgementSchema,
} from '../task-schemas.js'

const TASK_BASE = {
  taskId: 'task-123',
  createdAt: '2026-08-04T12:00:00Z',
  lastUpdatedAt: '2026-08-04T12:01:00Z',
  ttlMs: 60_000,
  pollIntervalMs: 1_000,
} as const

const CALL_TOOL_RESULT = {
  content: [{ type: 'text', text: 'finished' }],
  structuredContent: { answer: 42 },
  isError: false,
} as const

const INPUT_REQUESTS = {
  sampling: {
    method: 'sampling/createMessage',
    params: {
      messages: [{ role: 'user', content: { type: 'text', text: 'Summarize this task' } }],
      maxTokens: 128,
    },
  },
  roots: {
    method: 'roots/list',
  },
  elicitation: {
    method: 'elicitation/create',
    params: {
      message: 'Choose a format',
      requestedSchema: {
        type: 'object',
        properties: {
          format: { type: 'string' },
        },
        required: ['format'],
      },
    },
  },
} as const

const INPUT_RESPONSES = {
  sampling: {
    model: 'test-model',
    role: 'assistant',
    content: { type: 'text', text: 'Task summary' },
    stopReason: 'endTurn',
  },
  roots: {
    roots: [{ uri: 'file:///workspace', name: 'workspace' }],
  },
  elicitation: {
    action: 'accept',
    content: { format: 'json' },
  },
} as const

describe('MCP task schemas', () => {
  describe('McpCallToolWithTaskResultSchema', () => {
    it('parses a task handle and preserves result extensions', () => {
      const result = {
        ...TASK_BASE,
        resultType: 'task',
        status: 'working',
        statusMessage: 'Processing',
        _meta: { traceId: 'trace-123' },
        'example.com/priority': 'high',
      }

      expect(McpCallToolWithTaskResultSchema.parse(result)).toEqual(result)
    })

    it('rejects an unknown result discriminator', () => {
      expect(() =>
        McpCallToolWithTaskResultSchema.parse({
          ...TASK_BASE,
          resultType: 'unknown',
          status: 'working',
        })
      ).toThrow()
    })

    it.each([
      { name: 'empty task identifier', override: { taskId: '' } },
      { name: 'invalid creation timestamp', override: { createdAt: 'not-a-timestamp' } },
      { name: 'invalid update timestamp', override: { lastUpdatedAt: '2026-02-30T12:00:00Z' } },
      { name: 'negative ttl', override: { ttlMs: -1 } },
      { name: 'fractional ttl', override: { ttlMs: 1.5 } },
      { name: 'infinite ttl', override: { ttlMs: Number.POSITIVE_INFINITY } },
      { name: 'unsafe ttl', override: { ttlMs: Number.MAX_SAFE_INTEGER + 1 } },
      { name: 'negative poll interval', override: { pollIntervalMs: -1 } },
      { name: 'fractional poll interval', override: { pollIntervalMs: 1.5 } },
      {
        name: 'update timestamp before creation',
        override: {
          createdAt: '2026-08-04T12:01:00Z',
          lastUpdatedAt: '2026-08-04T12:00:00Z',
        },
      },
    ])('rejects task metadata with $name', ({ override }) => {
      expect(() =>
        McpCallToolWithTaskResultSchema.parse({
          ...TASK_BASE,
          ...override,
          resultType: 'task',
          status: 'working',
        })
      ).toThrow()
    })

    it('accepts unlimited retention and a zero poll interval', () => {
      const result = {
        ...TASK_BASE,
        resultType: 'task',
        status: 'working',
        ttlMs: null,
        pollIntervalMs: 0,
      }

      expect(McpCallToolWithTaskResultSchema.parse(result)).toEqual(result)
    })

    it('parses direct, input-required, and task results', () => {
      const task = {
        ...TASK_BASE,
        resultType: 'task',
        status: 'working',
      }
      const inputRequired = {
        resultType: 'input_required',
        inputRequests: INPUT_REQUESTS,
        requestState: 'opaque-state',
      }

      expect(McpCallToolWithTaskResultSchema.parse({ ...CALL_TOOL_RESULT, resultType: 'complete' })).toEqual(
        CALL_TOOL_RESULT
      )
      expect(McpCallToolWithTaskResultSchema.parse(inputRequired)).toEqual(inputRequired)
      expect(McpCallToolWithTaskResultSchema.parse(task)).toEqual(task)
    })

    it.each([{ requestState: '' }, { requestState: '', inputRequests: {} }])(
      'accepts request-state-only input-required results: %j',
      (params) => {
        const result = { resultType: 'input_required', ...params }
        expect(McpCallToolWithTaskResultSchema.parse(result)).toEqual(result)
      }
    )

    it('rejects malformed direct, input-required, and task results', () => {
      expect(() => McpCallToolWithTaskResultSchema.parse({ resultType: 'complete' })).toThrow()
      expect(() => McpCallToolWithTaskResultSchema.parse({ resultType: 'complete', content: [{}] })).toThrow()
      expect(() => McpCallToolWithTaskResultSchema.parse({ resultType: 'input_required' })).toThrow()
      expect(() => McpCallToolWithTaskResultSchema.parse({ resultType: 'input_required', inputRequests: {} })).toThrow()
      expect(() => McpCallToolWithTaskResultSchema.parse({ resultType: 'task', taskId: TASK_BASE.taskId })).toThrow()
    })

    it('preserves metadata in modern URL elicitation without a legacy identifier', () => {
      const params = {
        mode: 'url',
        message: 'Authorize',
        url: 'https://example.com/authorize',
        _meta: { correlation: 'authorization-1', progressToken: 'progress-1' },
      } satisfies Parameters<ElicitationCallback>[1]
      const result = {
        resultType: 'input_required',
        inputRequests: {
          authorize: {
            method: 'elicitation/create',
            params,
          },
        } satisfies McpInputRequests,
      }
      expect(McpCallToolWithTaskResultSchema.parse(result)).toEqual(result)
      const task = {
        ...TASK_BASE,
        resultType: 'complete',
        status: 'input_required',
        inputRequests: result.inputRequests,
      }
      expect(McpGetTaskResultSchema.parse(task)).toEqual(task)
      expect(() =>
        McpCallToolWithTaskResultSchema.parse({
          ...result,
          inputRequests: {
            authorize: { method: 'elicitation/create', params: { mode: 'url', message: 'Authorize', url: 'invalid' } },
          },
        })
      ).toThrow()
    })
  })

  describe('McpGetTaskResultSchema', () => {
    it.each([
      {
        name: 'working',
        result: {
          ...TASK_BASE,
          resultType: 'complete',
          status: 'working',
          statusMessage: 'Processing',
        },
      },
      {
        name: 'input_required',
        result: {
          ...TASK_BASE,
          resultType: 'complete',
          status: 'input_required',
          inputRequests: INPUT_REQUESTS,
        },
      },
      {
        name: 'completed',
        result: {
          ...TASK_BASE,
          resultType: 'complete',
          status: 'completed',
          result: CALL_TOOL_RESULT,
        },
      },
      {
        name: 'failed',
        result: {
          ...TASK_BASE,
          resultType: 'complete',
          status: 'failed',
          error: {
            code: -32_603,
            message: 'Tool execution failed',
            data: { retryable: false, requestId: 'request-123' },
          },
        },
      },
      {
        name: 'cancelled',
        result: {
          ...TASK_BASE,
          resultType: 'complete',
          status: 'cancelled',
          statusMessage: 'Cancelled by caller',
        },
      },
    ])('parses the $name status shape', ({ result }) => {
      expect(McpGetTaskResultSchema.parse(result)).toEqual(result)
    })

    it('rejects a non-complete result discriminator', () => {
      expect(() =>
        McpGetTaskResultSchema.parse({
          ...TASK_BASE,
          resultType: 'task',
          status: 'working',
        })
      ).toThrow()
    })

    it.each(['input_required', 'completed', 'failed'])('rejects %s without its required payload', (status) => {
      expect(() =>
        McpGetTaskResultSchema.parse({
          ...TASK_BASE,
          resultType: 'complete',
          status,
        })
      ).toThrow()
    })

    it.each([
      {
        name: 'completed task with an error',
        result: {
          ...TASK_BASE,
          resultType: 'complete',
          status: 'completed',
          result: CALL_TOOL_RESULT,
          error: { code: -32_603, message: 'Contradiction' },
        },
      },
      {
        name: 'failed task with a result',
        result: {
          ...TASK_BASE,
          resultType: 'complete',
          status: 'failed',
          error: { code: -32_603, message: 'Failed' },
          result: CALL_TOOL_RESULT,
        },
      },
      {
        name: 'cancelled task with pending input',
        result: {
          ...TASK_BASE,
          resultType: 'complete',
          status: 'cancelled',
          inputRequests: INPUT_REQUESTS,
        },
      },
    ])('rejects a $name', ({ result }) => {
      expect(() => McpGetTaskResultSchema.parse(result)).toThrow()
    })

    it.each([{}, { content: [{ type: 'text' }] }])('rejects an invalid nested CallToolResult: %j', (result) => {
      expect(() =>
        McpGetTaskResultSchema.parse({
          ...TASK_BASE,
          resultType: 'complete',
          status: 'completed',
          result,
        })
      ).toThrow()
    })
  })

  describe('McpInputResponsesSchema', () => {
    it('parses sampling, roots, and elicitation responses', () => {
      expect(McpInputResponsesSchema.parse(INPUT_RESPONSES)).toEqual(INPUT_RESPONSES)
    })

    it('accepts sampling arrays and validates their content blocks', () => {
      const sample = {
        model: 'test-model',
        role: 'assistant',
        content: [{ type: 'text', text: 'Summary' }],
      } satisfies McpInputResponses[string]
      expect(McpInputResponsesSchema.parse({ sample })).toEqual({ sample })
      expect(() => McpInputResponsesSchema.parse({ sample: { ...sample, content: [{ type: 'text' }] } })).toThrow()
    })
  })

  describe('task acknowledgement schemas', () => {
    it('parses an empty acknowledgement', () => {
      const result = {
        resultType: 'complete',
        _meta: { requestId: 'request-123' },
      }

      expect(McpTaskAcknowledgementSchema.parse(result)).toEqual(result)
    })

    it('rejects task state in an acknowledgement', () => {
      expect(() =>
        McpTaskAcknowledgementSchema.parse({
          ...TASK_BASE,
          resultType: 'complete',
          status: 'working',
        })
      ).toThrow()
    })

    it('rejects a non-complete acknowledgement', () => {
      expect(() => McpTaskAcknowledgementSchema.parse({ resultType: 'task' })).toThrow()
    })
  })

  describe('McpTaskStatusNotificationSchema', () => {
    it('parses complete detailed task parameters', () => {
      const params = {
        ...TASK_BASE,
        status: 'input_required',
        inputRequests: INPUT_REQUESTS,
        _meta: { subscriptionId: 'subscription-123' },
      }

      expect(McpTaskStatusNotificationSchema.parse(params)).toEqual({
        ...params,
        resultType: 'complete',
      })
    })

    it('parses a completed task notification', () => {
      const params = {
        ...TASK_BASE,
        status: 'completed',
        result: CALL_TOOL_RESULT,
      }

      expect(McpTaskStatusNotificationSchema.parse(params)).toEqual({
        ...params,
        resultType: 'complete',
      })
    })

    it('rejects contradictory notification task state', () => {
      expect(() =>
        McpTaskStatusNotificationSchema.parse({
          ...TASK_BASE,
          status: 'failed',
          error: { code: -32_603, message: 'Failed' },
          result: CALL_TOOL_RESULT,
        })
      ).toThrow()
    })
  })
})
