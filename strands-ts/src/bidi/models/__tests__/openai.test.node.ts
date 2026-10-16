import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultWebSocketFactory } from '../openai.js'

describe('defaultWebSocketFactory (node)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('authenticates with handshake headers', () => {
    const WebSocketMock = vi.fn()
    vi.stubGlobal('WebSocket', WebSocketMock)

    defaultWebSocketFactory('wss://example.test', { Authorization: 'Bearer sk-test', 'OpenAI-Project': 'proj' })

    expect(WebSocketMock).toHaveBeenCalledWith('wss://example.test', {
      headers: { Authorization: 'Bearer sk-test', 'OpenAI-Project': 'proj' },
    })
  })
})
