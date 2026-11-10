import { describe, expect, it } from 'vitest'
import { FunctionTool } from '../function-tool.js'
import { Tool, ToolStreamEvent, isValidToolName } from '../tool.js'
import type { ToolContext } from '../tool.js'
import type { JSONValue } from '../../types/json.js'
import { createMockContext } from '../../__fixtures__/tool-helpers.js'

import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'

describe('isValidToolName', () => {
  it.each([
    ['simple', true],
    ['with_underscore', true],
    ['with-hyphen', true],
    ['Mixed-Case_123', true],
    ['a', true],
    ['a'.repeat(64), true],
  ])('accepts %s', (name, expected) => {
    expect(isValidToolName(name)).toBe(expected)
  })

  it.each([
    ['', 'empty string'],
    ['a'.repeat(65), 'over 64 chars'],
    ['has space', 'space'],
    ['has.dot', 'dot'],
    ['has/slash', 'slash'],
    ['has:colon', 'colon'],
    ['emoji🚀', 'non-ascii'],
  ])('rejects %s (%s)', (name) => {
    expect(isValidToolName(name)).toBe(false)
  })
})

describe('FunctionTool', () => {
  describe('properties', () => {
    it('has a non-empty toolName', () => {
      const tool = new FunctionTool({
        name: 'testTool',
        description: 'Test description',
        inputSchema: { type: 'object' },
        callback: (): string => 'result',
      })
      expect(tool.name).toBeTruthy()
      expect(typeof tool.name).toBe('string')
      expect(tool.name.length).toBeGreaterThan(0)
      expect(tool.name).toBe('testTool')
    })

    it('has a non-empty description', () => {
      const tool = new FunctionTool({
        name: 'testTool',
        description: 'Test description',
        inputSchema: { type: 'object' },
        callback: (): string => 'result',
      })
      expect(tool.description).toBeTruthy()
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.description).toBe('Test description')
    })

    it('has a valid toolSpec', () => {
      const inputSchema = {
        type: 'object' as const,
        properties: {
          value: { type: 'string' as const },
        },
      }
      const tool = new FunctionTool({
        name: 'testTool',
        description: 'Test description',
        inputSchema,
        callback: (): string => 'result',
      })

      // Verify entire toolSpec object at once
      expect(tool.toolSpec).toEqual({
        name: 'testTool',
        description: 'Test description',
        inputSchema,
      })
    })

    it('has matching toolName and toolSpec.name', () => {
      const tool = new FunctionTool({
        name: 'testTool',
        description: 'Test description',
        inputSchema: { type: 'object' },
        callback: (): string => 'result',
      })
      expect(tool.name).toBe(tool.toolSpec.name)
    })

    it('has matching description and toolSpec.description', () => {
      const tool = new FunctionTool({
        name: 'testTool',
        description: 'Test description',
        inputSchema: { type: 'object' },
        callback: (): string => 'result',
      })
      expect(tool.description).toBe(tool.toolSpec.description)
    })
  })

  describe('stream method', () => {
    describe('with synchronous callback', () => {
      it('wraps return value in ToolResult', async () => {
        const tool = new FunctionTool({
          name: 'syncTool',
          description: 'Returns synchronous value',
          inputSchema: { type: 'object', properties: { value: { type: 'number' } } },
          callback: (input: unknown): number => {
            const { value } = input as { value: number }
            return value * 2
          },
        })

        const toolUse = {
          name: 'syncTool',
          toolUseId: 'test-sync-1',
          input: { value: 5 },
        }
        const context = createMockContext(toolUse)

        const { items: streamEvents, result } = await collectGenerator(tool.stream(context))

        // No stream events for sync callback
        expect(streamEvents.length).toBe(0)

        // Verify entire result with actual calculated value
        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-sync-1',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: '10', // 5 * 2 = 10 (converted to string)
            }),
          ],
        })
      })

      it('handles string return values', async () => {
        const tool = new FunctionTool({
          name: 'stringTool',
          description: 'Returns string',
          inputSchema: { type: 'object' },
          callback: (): string => 'Hello, World!',
        })

        const toolUse = {
          name: 'stringTool',
          toolUseId: 'test-string',
          input: {},
        }
        const context = createMockContext(toolUse)

        const { items: streamEvents, result } = await collectGenerator(tool.stream(context))

        expect(streamEvents.length).toBe(0)

        // Verify entire result object
        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-string',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: 'Hello, World!',
            }),
          ],
        })
      })

      it('handles object return values', async () => {
        const tool = new FunctionTool({
          name: 'objectTool',
          description: 'Returns object',
          inputSchema: { type: 'object' },
          callback: (): { key: string; count: number } => ({ key: 'value', count: 42 }),
        })

        const toolUse = {
          name: 'objectTool',
          toolUseId: 'test-object',
          input: {},
        }
        const context = createMockContext(toolUse)

        const { items: streamEvents, result } = await collectGenerator(tool.stream(context))

        expect(streamEvents.length).toBe(0)

        // Verify entire result object
        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-object',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'jsonBlock',
              json: { key: 'value', count: 42 },
            }),
          ],
        })
      })

      it('treats objects with extra keys beyond a content block key as JSON', async () => {
        const tool = new FunctionTool({
          name: 'extraKeyTool',
          description: 'Returns object with text key plus extra keys',
          inputSchema: { type: 'object' },
          callback: (): { text: string; extra: string } => ({ text: 'abc', extra: '123' }),
        })

        const toolUse = { name: 'extraKeyTool', toolUseId: 'test-extra', input: {} }
        const { result } = await collectGenerator(tool.stream(createMockContext(toolUse)))

        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-extra',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'jsonBlock',
              json: { text: 'abc', extra: '123' },
            }),
          ],
        })
      })

      it('passes input to callback exactly as provided to stream', async () => {
        const inputData = { name: 'test', value: 42, nested: { key: 'value' } }
        let receivedInput: unknown

        const tool = new FunctionTool({
          name: 'inputTool',
          description: 'Captures input',
          inputSchema: { type: 'object' },
          callback: (input: unknown): string => {
            receivedInput = input
            return 'success'
          },
        })

        const toolUse = {
          name: 'inputTool',
          toolUseId: 'test-input',
          input: inputData,
        }

        await collectGenerator(tool.stream(createMockContext(toolUse)))

        expect(receivedInput).toEqual(inputData)
      })

      it('handles null return values correctly', async () => {
        const tool = new FunctionTool({
          name: 'nullTool',
          description: 'Returns null',
          inputSchema: { type: 'object' },
          callback: (): null => null,
        })

        const { result } = await collectGenerator(
          tool.stream(createMockContext({ name: 'nullTool', toolUseId: 'test-null', input: {} }))
        )

        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-null',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: 'null',
            }),
          ],
        })
      })

      it('handles undefined return values correctly', async () => {
        const tool = new FunctionTool({
          name: 'undefinedTool',
          description: 'Returns undefined',
          inputSchema: { type: 'object' },
          // @ts-expect-error we're intentionally testing a type violation
          callback: (): undefined => undefined,
        })

        const { result } = await collectGenerator(
          tool.stream(createMockContext({ name: 'undefinedTool', toolUseId: 'test-undefined', input: {} }))
        )

        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-undefined',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: 'null',
            }),
          ],
        })
      })

      it('handles boolean return values as text content', async () => {
        const trueTool = new FunctionTool({
          name: 'trueTool',
          description: 'Returns true',
          inputSchema: { type: 'object' },
          callback: (): boolean => true,
        })

        const { result: trueResult } = await collectGenerator(
          trueTool.stream(createMockContext({ name: 'trueTool', toolUseId: 'test-true', input: {} }))
        )

        expect(trueResult).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-true',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: 'true',
            }),
          ],
        })

        const falseTool = new FunctionTool({
          name: 'falseTool',
          description: 'Returns false',
          inputSchema: { type: 'object' },
          callback: (): boolean => false,
        })

        const { result: falseResult } = await collectGenerator(
          falseTool.stream(createMockContext({ name: 'falseTool', toolUseId: 'test-false', input: {} }))
        )

        expect(falseResult).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-false',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: 'false',
            }),
          ],
        })
      })

      it('handles number return values as text content', async () => {
        const tool = new FunctionTool({
          name: 'numberTool',
          description: 'Returns number',
          inputSchema: { type: 'object' },
          callback: (): number => 42,
        })

        const { result } = await collectGenerator(
          tool.stream(createMockContext({ name: 'numberTool', toolUseId: 'test-number', input: {} }))
        )

        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-number',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: '42',
            }),
          ],
        })

        // Test negative number
        const negativeTool = new FunctionTool({
          name: 'negativeTool',
          description: 'Returns negative number',
          inputSchema: { type: 'object' },
          callback: (): number => -3.14,
        })

        const { result: negativeResult } = await collectGenerator(
          negativeTool.stream(createMockContext({ name: 'negativeTool', toolUseId: 'test-negative', input: {} }))
        )

        expect(negativeResult).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-negative',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: '-3.14',
            }),
          ],
        })
      })

      it('handles array return values as wrapped JSON content', async () => {
        const tool = new FunctionTool({
          name: 'arrayTool',
          description: 'Returns array',
          inputSchema: { type: 'object' },
          callback: (): JSONValue[] => [1, 2, 3, { key: 'value' }],
        })

        const { result } = await collectGenerator(
          tool.stream(createMockContext({ name: 'arrayTool', toolUseId: 'test-array', input: {} }))
        )

        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-array',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'jsonBlock',
              json: { $value: [1, 2, 3, { key: 'value' }] },
            }),
          ],
        })
      })

      it('deep copies objects to prevent mutation', async () => {
        const original = { nested: { value: 'original' } }
        const tool = new FunctionTool({
          name: 'copyTool',
          description: 'Returns object',
          inputSchema: { type: 'object' },
          callback: (): { nested: { value: string } } => original,
        })

        const { result } = await collectGenerator(
          tool.stream(createMockContext({ name: 'copyTool', toolUseId: 'test-copy', input: {} }))
        )

        // Mutate the original object
        original.nested.value = 'mutated'

        // Verify the result still has the original value
        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-copy',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'jsonBlock',
              json: { nested: { value: 'original' } },
            }),
          ],
        })
      })

      it('deep copies arrays to prevent mutation', async () => {
        const original = [{ value: 'original' }]
        const tool = new FunctionTool({
          name: 'arrayCopyTool',
          description: 'Returns array',
          inputSchema: { type: 'object' },
          callback: (): JSONValue[] => original,
        })

        const { result } = await collectGenerator(
          tool.stream(createMockContext({ name: 'arrayCopyTool', toolUseId: 'test-array-copy', input: {} }))
        )

        // Mutate the original array
        original[0]!.value = 'mutated'

        // Verify the result still has the original value (wrapped in $value)
        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-array-copy',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'jsonBlock',
              json: { $value: [{ value: 'original' }] },
            }),
          ],
        })
      })
    })

    describe('with promise callback', () => {
      it('wraps resolved value in ToolResult', async () => {
        const tool = new FunctionTool({
          name: 'promiseTool',
          description: 'Returns promise',
          inputSchema: { type: 'object', properties: { value: { type: 'number' } } },
          callback: async (input: unknown): Promise<number> => {
            const { value } = input as { value: number }
            return value + 10
          },
        })

        const toolUse = {
          name: 'promiseTool',
          toolUseId: 'test-promise-1',
          input: { value: 5 },
        }
        const context = createMockContext(toolUse)

        const { items: streamEvents, result } = await collectGenerator(tool.stream(context))

        expect(streamEvents.length).toBe(0)
        expect(result.toolUseId).toBe('test-promise-1')
        expect(result.status).toBe('success')
        expect(result.status).toBe('success')
      })

      it('can access ToolContext in promise', async () => {
        const tool = new FunctionTool({
          name: 'contextTool',
          description: 'Uses context',
          inputSchema: { type: 'object' },
          callback: async (_input: unknown, context: ToolContext): Promise<JSONValue> => {
            return context.agent.appState.getAll()
          },
        })

        const toolUse = {
          name: 'contextTool',
          toolUseId: 'test-context',
          input: {},
        }
        const context = createMockContext(toolUse, { userId: 'user-123' })

        const { items: streamEvents, result } = await collectGenerator(tool.stream(context))

        expect(streamEvents.length).toBe(0)
        expect(result.status).toBe('success')
      })
    })

    describe('with async generator callback', () => {
      it('yields ToolStreamEvents then final ToolResult', async () => {
        const tool = new FunctionTool({
          name: 'generatorTool',
          description: 'Streams progress',
          inputSchema: { type: 'object' },
          callback: async function* (): AsyncGenerator<string, string, unknown> {
            yield 'Starting...'
            yield 'Processing...'
            yield 'Complete!'
            return 'Final result'
          },
        })

        const toolUse = {
          name: 'generatorTool',
          toolUseId: 'test-gen-1',
          input: {},
        }
        const context = createMockContext(toolUse)

        const { items: streamEvents, result } = await collectGenerator(tool.stream(context))

        // Should have 3 stream events
        expect(streamEvents.length).toBe(3)

        // Verify all stream events are as expected
        expect(streamEvents).toEqual([
          { type: 'toolStreamEvent', data: 'Starting...' },
          { type: 'toolStreamEvent', data: 'Processing...' },
          { type: 'toolStreamEvent', data: 'Complete!' },
        ])

        // Verify entire result object
        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-gen-1',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: 'Final result',
            }),
          ],
        })
      })

      it('can yield objects as ToolStreamEvents', async () => {
        const tool = new FunctionTool({
          name: 'objectGenTool',
          description: 'Streams objects',
          inputSchema: { type: 'object' },
          callback: async function* (): AsyncGenerator<{ progress: number; message: string }, string, unknown> {
            yield { progress: 0.25, message: 'Quarter done' }
            yield { progress: 0.5, message: 'Halfway done' }
            yield { progress: 1.0, message: 'Complete' }
            return 'Done'
          },
        })

        const toolUse = {
          name: 'objectGenTool',
          toolUseId: 'test-obj-gen',
          input: {},
        }
        const context = createMockContext(toolUse)

        const { items: streamEvents, result } = await collectGenerator(tool.stream(context))

        expect(streamEvents.length).toBe(3)

        // Verify all stream events have data
        for (const event of streamEvents) {
          expect(event.type).toBe('toolStreamEvent')
          expect(event.data).toBeDefined()
        }

        // Verify final result
        expect(result.status).toBe('success')
      })
    })

    describe('error handling', () => {
      it('catches synchronous errors', async () => {
        const tool = new FunctionTool({
          name: 'errorTool',
          description: 'Throws error',
          inputSchema: { type: 'object' },
          callback: (): never => {
            throw new Error('Something went wrong')
          },
        })

        const toolUse = {
          name: 'errorTool',
          toolUseId: 'test-error-1',
          input: {},
        }
        const context = createMockContext(toolUse)

        const { items: streamEvents, result } = await collectGenerator(tool.stream(context))

        expect(streamEvents.length).toBe(0)
        expect(result.toolUseId).toBe('test-error-1')
        expect(result.status).toBe('error')
        expect(result.content.length).toBeGreaterThan(0)
        expect(result.content[0]?.type).toBe('textBlock')
      })

      it('catches promise rejections', async () => {
        const tool = new FunctionTool({
          name: 'rejectTool',
          description: 'Rejects promise',
          inputSchema: { type: 'object' },
          callback: async (): Promise<never> => {
            throw new Error('Promise rejected')
          },
        })

        const toolUse = {
          name: 'rejectTool',
          toolUseId: 'test-error-2',
          input: {},
        }
        const context = createMockContext(toolUse)

        const { items: streamEvents, result } = await collectGenerator(tool.stream(context))

        expect(streamEvents.length).toBe(0)
        expect(result.status).toBe('error')
      })

      it('captures Error object in ToolResult when callback throws Error', async () => {
        const testError = new Error('Test error message')
        const tool = new FunctionTool({
          name: 'errorObjectTool',
          description: 'Throws Error object',
          inputSchema: { type: 'object' },
          callback: (): never => {
            throw testError
          },
        })

        const toolUse = {
          name: 'errorObjectTool',
          toolUseId: 'test-error-capture',
          input: {},
        }

        const { result } = await collectGenerator(tool.stream(createMockContext(toolUse)))

        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-error-capture',
          status: 'error',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: 'Error: Test error message',
            }),
          ],
          error: testError,
        })
      })

      it('wraps non-Error thrown values into Error object', async () => {
        const tool = new FunctionTool({
          name: 'stringThrowTool',
          description: 'Throws string',
          inputSchema: { type: 'object' },
          callback: (): never => {
            throw 'string error'
          },
        })

        const toolUse = {
          name: 'stringThrowTool',
          toolUseId: 'test-string-wrap',
          input: {},
        }

        const { result } = await collectGenerator(tool.stream(createMockContext(toolUse)))

        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-string-wrap',
          status: 'error',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: 'Error: string error',
            }),
          ],
          error: expect.any(Error),
        })
        expect(result.error?.message).toBe('string error')
      })

      it('preserves custom Error subclass instances', async () => {
        class CustomError extends Error {
          constructor(
            message: string,
            public code: string
          ) {
            super(message)
            this.name = 'CustomError'
          }
        }

        const customError = new CustomError('Custom error message', 'ERR_001')
        const tool = new FunctionTool({
          name: 'customErrorTool',
          description: 'Throws custom error',
          inputSchema: { type: 'object' },
          callback: (): never => {
            throw customError
          },
        })

        const toolUse = {
          name: 'customErrorTool',
          toolUseId: 'test-custom-error',
          input: {},
        }

        const { result } = await collectGenerator(tool.stream(createMockContext(toolUse)))

        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-custom-error',
          status: 'error',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: 'Error: Custom error message',
            }),
          ],
          error: customError,
        })
        expect((result.error as CustomError).code).toBe('ERR_001')
      })

      it('preserves error stack traces', async () => {
        const tool = new FunctionTool({
          name: 'stackTraceTool',
          description: 'Throws error with stack trace',
          inputSchema: { type: 'object' },
          callback: (): never => {
            throw new Error('Error with stack')
          },
        })

        const toolUse = {
          name: 'stackTraceTool',
          toolUseId: 'test-stack-trace',
          input: {},
        }

        const { result } = await collectGenerator(tool.stream(createMockContext(toolUse)))

        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-stack-trace',
          status: 'error',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: 'Error: Error with stack',
            }),
          ],
          error: expect.any(Error),
        })
        expect(result.error?.stack).toBeDefined()
        expect(result.error?.stack).toContain('Error: Error with stack')
      })

      it('captures errors thrown in async generator callbacks', async () => {
        const testError = new Error('Async generator error')
        const tool = new FunctionTool({
          name: 'asyncGenErrorTool',
          description: 'Async generator that throws',
          inputSchema: { type: 'object' },
          callback: async function* (): AsyncGenerator<string, never, unknown> {
            yield 'Starting...'
            throw testError
          },
        })

        const toolUse = {
          name: 'asyncGenErrorTool',
          toolUseId: 'test-async-gen-error',
          input: {},
        }

        const context = tool.stream(createMockContext(toolUse))
        const { items: streamEvents, result } = await collectGenerator(context)

        // Should have one stream event before the error
        expect(streamEvents.length).toBe(1)
        expect(streamEvents[0]).toEqual({ type: 'toolStreamEvent', data: 'Starting...' })

        // Final result should have error object
        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-async-gen-error',
          status: 'error',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: 'Error: Async generator error',
            }),
          ],
          error: testError,
        })
      })

      it('catches errors in async generators', async () => {
        const tool = new FunctionTool({
          name: 'genErrorTool',
          description: 'Generator throws',
          inputSchema: { type: 'object' },
          callback: async function* (): AsyncGenerator<string, never, unknown> {
            yield 'Starting...'
            throw new Error('Generator error')
          },
        })

        const toolUse = {
          name: 'genErrorTool',
          toolUseId: 'test-error-3',
          input: {},
        }
        const context = createMockContext(toolUse)

        const { items: streamEvents, result } = await collectGenerator(tool.stream(context))

        // Should have one stream event before the error
        expect(streamEvents.length).toBe(1)
        expect(streamEvents[0]?.type).toBe('toolStreamEvent')

        // Final result should be error
        expect(result.status).toBe('error')
      })

      it('handles non-Error thrown values', async () => {
        const tool = new FunctionTool({
          name: 'stringErrorTool',
          description: 'Throws string',
          inputSchema: { type: 'object' },
          callback: (): never => {
            throw 'String error'
          },
        })

        const toolUse = {
          name: 'stringErrorTool',
          toolUseId: 'test-error-4',
          input: {},
        }
        const context = createMockContext(toolUse)

        const { items: streamEvents, result } = await collectGenerator(tool.stream(context))

        expect(streamEvents.length).toBe(0)
        expect(result.status).toBe('error')
      })

      it('returns error for circular references', async () => {
        const tool = new FunctionTool({
          name: 'circularTool',
          description: 'Returns circular object',
          inputSchema: { type: 'object' },
          callback: (): JSONValue => {
            // Create circular reference
            const obj: any = { a: 1 }
            obj.self = obj
            return obj
          },
        })

        const { result } = await collectGenerator(
          tool.stream(createMockContext({ name: 'circularTool', toolUseId: 'test-circular', input: {} }))
        )

        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-circular',
          status: 'error',
          error: expect.any(Error),
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: expect.stringContaining('Error:'),
            }),
          ],
        })
      })

      it('silently drops non-serializable values (functions)', async () => {
        const tool = new FunctionTool({
          name: 'functionTool',
          description: 'Returns object with function',
          inputSchema: { type: 'object' },
          callback: (): JSONValue => {
            return { fn: () => {} } as any
          },
        })

        const { result } = await collectGenerator(
          tool.stream(createMockContext({ name: 'functionTool', toolUseId: 'test-function', input: {} }))
        )

        // Functions are silently dropped during JSON serialization
        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-function',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'jsonBlock',
              json: {},
            }),
          ],
        })
      })
    })
  })
})

describe('Tool interface backwards compatibility', () => {
  it('maintains stable interface signature', () => {
    const tool = new FunctionTool({
      name: 'testTool',
      description: 'Test description',
      inputSchema: { type: 'object' },
      callback: (): string => 'result',
    })

    // Verify interface properties exist
    expect(tool).toHaveProperty('name')
    expect(tool).toHaveProperty('description')
    expect(tool).toHaveProperty('toolSpec')
    expect(tool).toHaveProperty('stream')

    // Verify stream is a function
    expect(typeof tool.stream).toBe('function')
  })

  it('stream method accepts correct parameter types', async () => {
    const tool = new FunctionTool({
      name: 'testTool',
      description: 'Test description',
      inputSchema: { type: 'object' },
      callback: (input: unknown): JSONValue => input as JSONValue,
    })
    const toolUse = {
      name: 'testTool',
      toolUseId: 'test-types',
      input: { value: 123 },
    }
    const context = createMockContext(toolUse)

    // This should compile and execute without type errors
    const stream = tool.stream({ ...context, toolUse })
    expect(stream).toBeDefined()
    expect(Symbol.asyncIterator in stream).toBe(true)

    // Consume the stream with helper
    const { result } = await collectGenerator(stream)

    expect(result).toBeDefined()
    expect(result.status).toBe('success')
  })
})

describe('ToolStreamEvent', () => {
  describe('instantiation', () => {
    it('creates instance with data', () => {
      const event = new ToolStreamEvent({
        data: 'test data',
      })

      expect(event).toEqual({
        type: 'toolStreamEvent',
        data: 'test data',
      })
    })

    it('creates instance without data', () => {
      const event = new ToolStreamEvent({})

      expect(event).toEqual({
        type: 'toolStreamEvent',
      })
    })

    it('creates instance with structured data', () => {
      const structuredData = {
        progress: 50,
        message: 'halfway complete',
      }

      const event = new ToolStreamEvent({
        data: structuredData,
      })

      expect(event).toEqual({
        type: 'toolStreamEvent',
        data: structuredData,
      })
    })
  })
})

describe('instanceof checks', () => {
  describe('FunctionTool', () => {
    it('passes instanceof Tool check', () => {
      const tool = new FunctionTool({
        name: 'testTool',
        description: 'Test description',
        inputSchema: { type: 'object' },
        callback: (): string => 'result',
      })

      expect(tool instanceof Tool).toBe(true)
    })

    it('can be used as type guard', () => {
      const tool = new FunctionTool({
        name: 'testTool',
        description: 'Test description',
        inputSchema: { type: 'object' },
        callback: (): string => 'result',
      })

      // Type guard function
      function isTool(value: unknown): value is Tool {
        return value instanceof Tool
      }

      expect(isTool(tool)).toBe(true)
      expect(isTool({})).toBe(false)
      expect(isTool(null)).toBe(false)
    })
  })
})

describe('optional inputSchema', () => {
  describe('when inputSchema is undefined', () => {
    it('creates tool with default empty object schema', () => {
      const tool = new FunctionTool({
        name: 'noInputTool',
        description: 'Tool that takes no input',
        callback: () => 'result',
      })

      expect(tool.name).toBe('noInputTool')
      expect(tool.description).toBe('Tool that takes no input')
      expect(tool.toolSpec).toEqual({
        name: 'noInputTool',
        description: 'Tool that takes no input',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      })
    })

    it('executes successfully with empty input', async () => {
      const tool = new FunctionTool({
        name: 'getStatus',
        description: 'Gets system status',
        callback: () => ({ status: 'operational' }),
      })

      const toolUse = {
        name: 'getStatus',
        toolUseId: 'test-no-input-1',
        input: {},
      }

      const { result } = await collectGenerator(tool.stream(createMockContext(toolUse)))

      expect(result).toEqual({
        type: 'toolResultBlock',
        toolUseId: 'test-no-input-1',
        status: 'success',
        content: [
          expect.objectContaining({
            type: 'jsonBlock',
            json: { status: 'operational' },
          }),
        ],
      })
    })

    it('callback receives empty object when no schema provided', async () => {
      let receivedInput: unknown
      const tool = new FunctionTool({
        name: 'captureInput',
        description: 'Captures the input',
        callback: (input: unknown) => {
          receivedInput = input
          return 'captured'
        },
      })

      const toolUse = {
        name: 'captureInput',
        toolUseId: 'test-input-capture',
        input: {},
      }

      await collectGenerator(tool.stream(createMockContext(toolUse)))

      expect(receivedInput).toEqual({})
    })

    it('works with async callback', async () => {
      const tool = new FunctionTool({
        name: 'asyncNoInput',
        description: 'Async tool with no input',
        callback: async () => {
          return 'async result'
        },
      })

      const toolUse = {
        name: 'asyncNoInput',
        toolUseId: 'test-async-no-input',
        input: {},
      }

      const { result } = await collectGenerator(tool.stream(createMockContext(toolUse)))

      expect(result).toEqual({
        type: 'toolResultBlock',
        toolUseId: 'test-async-no-input',
        status: 'success',
        content: [
          expect.objectContaining({
            type: 'textBlock',
            text: 'async result',
          }),
        ],
      })
    })

    it('works with async generator callback', async () => {
      const tool = new FunctionTool({
        name: 'streamNoInput',
        description: 'Streaming tool with no input',
        callback: async function* () {
          yield 'Starting...'
          yield 'Processing...'
          return 'Complete!'
        },
      })

      const toolUse = {
        name: 'streamNoInput',
        toolUseId: 'test-stream-no-input',
        input: {},
      }

      const { items: streamEvents, result } = await collectGenerator(tool.stream(createMockContext(toolUse)))

      expect(streamEvents).toEqual([
        { type: 'toolStreamEvent', data: 'Starting...' },
        { type: 'toolStreamEvent', data: 'Processing...' },
      ])

      expect(result).toEqual({
        type: 'toolResultBlock',
        toolUseId: 'test-stream-no-input',
        status: 'success',
        content: [
          expect.objectContaining({
            type: 'textBlock',
            text: 'Complete!',
          }),
        ],
      })
    })
  })
})
