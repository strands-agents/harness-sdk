import { DEFAULT_CHAT_SETTINGS, type ChatSnapshot } from '../../src/tui/chat/types.js'

export function snapshot(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    completedTurns: [],
    queuedPrompts: [],
    notices: [],
    tasks: [],
    context: {},
    status: 'idle',
    runtime: {
      agent: 'Strands harness',
      version: '1.2.3',
      backendId: 'strands',
      protocol: 'strands',
      model: 'bedrock/test',
      session: 'in-memory',
      cwd: '/work',
      tools: [],
    },
    settings: DEFAULT_CHAT_SETTINGS,
    ...overrides,
  }
}
