import { vi } from 'vitest'

import type { ChatBackend } from '../../src/agent/types.js'

export function idleBackend(overrides: Partial<ChatBackend> = {}): ChatBackend {
  return {
    id: 'test',
    name: 'Strands harness',
    protocol: 'strands',
    async *stream() {
      yield* []
      return { stopReason: 'endTurn' }
    },
    cancel: vi.fn(),
    dispose: vi.fn(async () => {}),
    ...overrides,
  }
}
