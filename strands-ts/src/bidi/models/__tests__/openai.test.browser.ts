import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultWebSocketFactory } from '../openai.js'

describe('defaultWebSocketFactory (browser)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('authenticates with subprotocols because browsers cannot set websocket headers', () => {
    const WebSocketMock = vi.fn()
    vi.stubGlobal('WebSocket', WebSocketMock)

    defaultWebSocketFactory('wss://example.test', { Authorization: 'Bearer ek_client_secret' })

    expect(WebSocketMock).toHaveBeenCalledWith('wss://example.test', [
      'realtime',
      'openai-insecure-api-key.ek_client_secret',
    ])
  })
})
