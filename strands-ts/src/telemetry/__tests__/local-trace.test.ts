import { describe, it, expect } from 'vitest'
import { AgentTrace } from '../tracer.js'
import { Message, TextBlock } from '../../types/messages.js'

describe('LocalTrace', () => {
  describe('constructor', () => {
    it('generates a unique id in UUID format', () => {
      const trace1 = new AgentTrace('test')
      const trace2 = new AgentTrace('test')

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      expect(trace1.id).toMatch(uuidRegex)
      expect(trace2.id).toMatch(uuidRegex)
      expect(trace1.id).not.toBe(trace2.id)
    })

    it('sets name and defaults', () => {
      const trace = new AgentTrace('Cycle 1')

      expect(trace.name).toBe('Cycle 1')
      expect(trace.parentId).toBeNull()
      expect(trace.endTime).toBeNull()
      expect(trace.duration).toBe(0)
      expect(trace.children).toEqual([])
      expect(trace.metadata).toEqual({})
      expect(trace.message).toBeNull()
    })

    it('uses current time as default startTime', () => {
      const before = Date.now()
      const trace = new AgentTrace('test')
      const after = Date.now()

      expect(trace.startTime).toBeGreaterThanOrEqual(before)
      expect(trace.startTime).toBeLessThanOrEqual(after)
    })

    it('accepts a custom startTime', () => {
      const trace = new AgentTrace('test', { startTime: 1000 })

      expect(trace.startTime).toBe(1000)
    })
  })

  describe('parent-child relationships', () => {
    it('adds child to parent when parent is provided', () => {
      const parent = new AgentTrace('parent')
      const child = new AgentTrace('child', { parent })

      expect(parent.children).toHaveLength(1)
      expect(parent.children[0]).toBe(child)
      expect(child.parentId).toBe(parent.id)
    })

    it('supports multiple children', () => {
      const parent = new AgentTrace('parent')
      const child1 = new AgentTrace('child1', { parent })
      const child2 = new AgentTrace('child2', { parent })

      expect(parent.children).toHaveLength(2)
      expect(parent.children[0]).toBe(child1)
      expect(parent.children[1]).toBe(child2)
    })

    it('sets parentId to null when no parent is provided', () => {
      const trace = new AgentTrace('root')

      expect(trace.parentId).toBeNull()
    })

    it('builds a three-level hierarchy', () => {
      const root = new AgentTrace('Cycle 1', { startTime: 1000 })
      const model = new AgentTrace('stream_messages', { parent: root, startTime: 1001 })
      const tool = new AgentTrace('Tool: calc', { parent: root, startTime: 1050 })

      expect(root.children).toHaveLength(2)
      expect(root.children[0]!.name).toBe('stream_messages')
      expect(root.children[0]!.parentId).toBe(root.id)
      expect(root.children[1]!.name).toBe('Tool: calc')
      expect(root.children[1]!.parentId).toBe(root.id)
      expect(model.parentId).toBe(root.id)
      expect(tool.parentId).toBe(root.id)
    })
  })

  describe('end', () => {
    it('computes duration from startTime to endTime', () => {
      const trace = new AgentTrace('test', { startTime: 1000 })

      trace.end(1500)

      expect(trace.endTime).toBe(1500)
      expect(trace.duration).toBe(500)
    })

    it('uses current time when no endTime is provided', () => {
      const before = Date.now()
      const trace = new AgentTrace('test')

      trace.end()

      expect(trace.endTime).toBeGreaterThanOrEqual(before)
      expect(trace.duration).toBeGreaterThanOrEqual(0)
    })
  })

  describe('metadata and message', () => {
    it('stores cycle metadata', () => {
      const trace = new AgentTrace('Cycle 1')

      trace.metadata.cycleId = 'cycle-1'

      expect(trace.metadata).toStrictEqual({ cycleId: 'cycle-1' })
    })

    it('stores tool metadata', () => {
      const trace = new AgentTrace('Tool: calc')

      trace.metadata.toolUseId = 'tool-1'
      trace.metadata.toolName = 'calc'

      expect(trace.metadata).toStrictEqual({ toolUseId: 'tool-1', toolName: 'calc' })
    })

    it('stores a message with role and content', () => {
      const msg = new Message({ role: 'assistant', content: [new TextBlock('hello')] })
      const trace = new AgentTrace('stream_messages')

      trace.message = msg

      expect(trace.message.role).toBe('assistant')
      expect(trace.message.content).toStrictEqual([new TextBlock('hello')])
    })
  })

  describe('toJSON', () => {
    it('returns complete data for a default trace', () => {
      const trace = new AgentTrace('Cycle 1', { startTime: 1000 })

      const json = trace.toJSON()

      expect(json).toStrictEqual({
        id: trace.id,
        name: 'Cycle 1',
        parentId: null,
        startTime: 1000,
        endTime: null,
        duration: 0,
        children: [],
        metadata: {},
        message: null,
      })
    })

    it('serializes a hierarchy with children and metadata', () => {
      const root = new AgentTrace('Cycle 1', { startTime: 1000 })
      root.metadata.cycleId = 'cycle-1'
      const child = new AgentTrace('stream_messages', { parent: root, startTime: 1001 })
      child.end(1100)
      root.end(1200)

      const json = root.toJSON()

      expect(json.name).toBe('Cycle 1')
      expect(json.metadata.cycleId).toBe('cycle-1')
      expect(json.duration).toBe(200)
      expect(json.children).toHaveLength(1)
      expect(json.children[0]).toStrictEqual({
        id: child.id,
        name: 'stream_messages',
        parentId: root.id,
        startTime: 1001,
        endTime: 1100,
        duration: 99,
        children: [],
        metadata: {},
        message: null,
      })
    })

    it('serializes tool metadata correctly', () => {
      const toolTrace = new AgentTrace('Tool: calc', { startTime: 1000 })
      toolTrace.metadata.toolUseId = 'tool-123'
      toolTrace.metadata.toolName = 'calc'
      toolTrace.end(1500)

      const json = toolTrace.toJSON()

      expect(json.name).toBe('Tool: calc')
      expect(json.metadata).toStrictEqual({
        toolUseId: 'tool-123',
        toolName: 'calc',
      })
      expect(json.duration).toBe(500)
    })
  })
})
