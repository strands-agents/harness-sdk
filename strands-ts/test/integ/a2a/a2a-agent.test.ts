import { describe, expect, it, inject, beforeAll } from 'vitest'
import { A2AAgent, A2AStreamUpdateEvent } from '$/sdk/a2a/index.js'
import { collectGenerator } from '$/sdk/__fixtures__/model-test-helpers.js'

const a2aServer = {
  get skip() {
    return inject('a2a-server').shouldSkip
  },
  get url() {
    const url = inject('a2a-server').url
    if (!url) throw new Error('A2A server URL not provided')
    return url
  },
}

describe.skipIf(a2aServer.skip)('A2AAgent', () => {
  let agent: A2AAgent

  beforeAll(() => {
    agent = new A2AAgent({ url: a2aServer.url })
  })

  describe('invoke', () => {
    it('receives a text response and populates agent card metadata', async () => {
      const result = await agent.invoke('What is 2+2? Reply with just the number.')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.role).toBe('assistant')
      expect(result.lastMessage.content.length).toBeGreaterThan(0)
      expect(result.toString()).toMatch(/4/)

      expect(agent.name).toBe('Test A2A Agent')
      expect(agent.description).toBe('Integration test agent')
    })
  })

  describe('stream', () => {
    it('yields events and returns final result', async () => {
      const { items, result } = await collectGenerator(agent.stream('Say the word test'))

      const streamUpdates = items.filter((e) => e instanceof A2AStreamUpdateEvent)
      expect(streamUpdates.length).toBeGreaterThan(0)

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content[0]!.type).toBe('textBlock')
    })
  })
})
