import { describe, expect, it } from 'vitest'
import { AgentPrinter } from '../printer.js'
import { Agent } from '../agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { TextBlock, ToolResultBlock } from '../../types/messages.js'
import { BeforeToolCallEvent, BeforeToolsEvent } from '../../hooks/events.js'

describe('AgentPrinter', () => {
  describe('end-to-end scenarios', () => {
    it('prints simple text output', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello world' })

      const outputs: string[] = []
      const mockAppender = (text: string) => outputs.push(text)

      const agent = new Agent({ model, printer: false })
      ;(agent as any)._printer = new AgentPrinter(mockAppender)

      await collectGenerator(agent.stream('Test'))

      const allOutput = outputs.join('')
      expect(allOutput).toBe('Hello world\n')
    })

    it('prints reasoning content wrapped in tags', async () => {
      const model = new MockMessageModel().addTurn({ type: 'reasoningBlock', text: 'Let me think' })

      const outputs: string[] = []
      const mockAppender = (text: string) => outputs.push(text)

      const agent = new Agent({ model, printer: false })
      ;(agent as any)._printer = new AgentPrinter(mockAppender)

      await collectGenerator(agent.stream('Test'))

      const allOutput = outputs.join('')
      expect(allOutput).toBe('\n💭 Reasoning:\n   Let me think\n\n')
    })

    it('prints text and reasoning together', async () => {
      const model = new MockMessageModel().addTurn([
        { type: 'textBlock', text: 'Answer: ' },
        { type: 'reasoningBlock', text: 'thinking' },
      ])

      const outputs: string[] = []
      const mockAppender = (text: string) => outputs.push(text)

      const agent = new Agent({ model, printer: false })
      ;(agent as any)._printer = new AgentPrinter(mockAppender)

      await collectGenerator(agent.stream('Test'))

      const allOutput = outputs.join('')
      expect(allOutput).toBe('Answer: \n💭 Reasoning:\n   thinking\n\n')
    })

    it('handles newlines in reasoning content', async () => {
      const model = new MockMessageModel().addTurn({
        type: 'reasoningBlock',
        text: 'First line\nSecond line\nThird line',
      })

      const outputs: string[] = []
      const mockAppender = (text: string) => outputs.push(text)

      const agent = new Agent({ model, printer: false })
      ;(agent as any)._printer = new AgentPrinter(mockAppender)

      await collectGenerator(agent.stream('Test'))

      const allOutput = outputs.join('')
      const expected = `
💭 Reasoning:
   First line
   Second line
   Third line
\n`
      expect(allOutput).toBe(expected)
    })

    it('prints tool execution', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'calc', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Result: 4' })

      const tool = createMockTool(
        'calc',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success' as const,
            content: [new TextBlock('4')],
          })
      )

      const outputs: string[] = []
      const mockAppender = (text: string) => outputs.push(text)

      const agent = new Agent({ model, tools: [tool], printer: false })
      ;(agent as any)._printer = new AgentPrinter(mockAppender)

      await collectGenerator(agent.stream('Test'))

      const allOutput = outputs.join('')
      expect(allOutput).toBe('\n  ⏳ calc\n\n🔧 Tool #1: calc\n✓ Tool completed\nResult: 4\n')
    })

    it('prints tool error', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'bad_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Error handled' })

      const tool = createMockTool(
        'bad_tool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'error' as const,
            content: [new TextBlock('Failed')],
          })
      )

      const outputs: string[] = []
      const mockAppender = (text: string) => outputs.push(text)

      const agent = new Agent({ model, tools: [tool], printer: false })
      ;(agent as any)._printer = new AgentPrinter(mockAppender)

      await collectGenerator(agent.stream('Test'))

      const allOutput = outputs.join('')
      expect(allOutput).toBe('\n  ⏳ bad_tool\n\n🔧 Tool #1: bad_tool\n✗ Tool failed\nError handled\n')
    })

    it('prints denied tool with denied icon', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'dangerous_tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Tool was denied' })

      const tool = createMockTool(
        'dangerous_tool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'error' as const,
            content: [new TextBlock('denied')],
          })
      )

      const outputs: string[] = []
      const mockAppender = (text: string) => outputs.push(text)

      const agent = new Agent({ model, tools: [tool], printer: false })
      ;(agent as any)._printer = new AgentPrinter(mockAppender)

      agent.addHook(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
        event.cancel = 'Tool not allowed'
      })

      await collectGenerator(agent.stream('Test'))

      const allOutput = outputs.join('')
      expect(allOutput).toBe(
        '\n  ⏳ dangerous_tool\n\n🚫 Tool #1: dangerous_tool (denied)\n✗ Tool failed\nTool was denied\n'
      )
    })

    it('prints batch cancel notice when BeforeToolsEvent cancels', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'tool_a', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool(
        'tool_a',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success' as const,
            content: [new TextBlock('ok')],
          })
      )

      const outputs: string[] = []
      const mockAppender = (text: string) => outputs.push(text)

      const agent = new Agent({ model, tools: [tool], printer: false })
      ;(agent as any)._printer = new AgentPrinter(mockAppender)

      agent.addHook(BeforeToolsEvent, (event: BeforeToolsEvent) => {
        event.cancel = true
      })

      await collectGenerator(agent.stream('Test'))

      const allOutput = outputs.join('')
      expect(allOutput).toBe('\n  ⏳ tool_a\n\n🚫 All tools denied\n✗ Tool failed\nDone\n')
    })

    it('prints comprehensive scenario with all output types', async () => {
      const model = new MockMessageModel()
        .addTurn([
          { type: 'textBlock', text: 'Let me help you. ' },
          { type: 'reasoningBlock', text: 'I need to use the calculator' },
          { type: 'toolUseBlock', name: 'calculator', toolUseId: 'tool-1', input: { expr: '2+2' } },
        ])
        .addTurn([
          { type: 'textBlock', text: 'The calculation succeeded. ' },
          { type: 'reasoningBlock', text: 'Now trying validation' },
          { type: 'toolUseBlock', name: 'validator', toolUseId: 'tool-2', input: { value: 'test' } },
        ])
        .addTurn([
          { type: 'textBlock', text: 'All done. ' },
          { type: 'reasoningBlock', text: 'Task completed successfully' },
        ])

      const calcTool = createMockTool(
        'calculator',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success' as const,
            content: [new TextBlock('4')],
          })
      )

      const validatorTool = createMockTool(
        'validator',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-2',
            status: 'error' as const,
            content: [new TextBlock('Validation failed')],
          })
      )

      const outputs: string[] = []
      const mockAppender = (text: string) => outputs.push(text)

      const agent = new Agent({ model, tools: [calcTool, validatorTool], printer: false })
      ;(agent as any)._printer = new AgentPrinter(mockAppender)

      await collectGenerator(agent.stream('Test'))

      const allOutput = outputs.join('')
      const expected = [
        'Let me help you. ',
        '\n💭 Reasoning:\n   I need to use the calculator\n',
        '\n  ⏳ calculator\n',
        '\n🔧 Tool #1: calculator\n',
        '✓ Tool completed\n',
        'The calculation succeeded. ',
        '\n💭 Reasoning:\n   Now trying validation\n',
        '\n  ⏳ validator\n',
        '\n🔧 Tool #2: validator\n',
        '✗ Tool failed\n',
        'All done. ',
        '\n💭 Reasoning:\n   Task completed successfully\n',
        '\n',
      ].join('')

      expect(allOutput).toBe(expected)
    })
  })
})
