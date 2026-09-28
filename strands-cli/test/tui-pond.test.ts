import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { ChatController, type ChatBackend, type ChatEvent, type ChatRunResult } from '../src/tui/chat/controller.js'
import type { PondFrog } from '../src/tui/chat/types.js'
import { ConversationManager } from '../src/tui/session/conversations.js'
import { pondContent, readPondTaskValue, type PondConversation } from '../src/tui/session/pond.js'
import { FileSessionRuntime, type SessionInfo } from '../src/tui/session/sessions.js'
import { clampPondScroll, layoutPond, renderPond, revealPondFrog } from '../src/tui/view/pond-drawing.js'

const NOW = Date.parse('2026-09-27T12:00:00.000Z')

function conversation(overrides: Partial<PondConversation> = {}): PondConversation {
  return {
    id: 'agent-1',
    title: 'Strands harness',
    current: true,
    status: 'working',
    workspace: '/work/harness-sdk',
    sessionId: 'live-session',
    subagents: [],
    ...overrides,
  }
}

function saved(id: string, workspace: string, updatedAt: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { id, active: false, workspace, updatedAt, messageCount: 4, ...overrides }
}

describe('pond content', () => {
  it('seats live and saved agents on pads grouped by workspace cove', () => {
    const { rows, pond } = pondContent(
      [
        conversation({
          subagents: [{ taskId: 'task-1', task: 'Review the parser', status: 'working' }],
        }),
      ],
      [
        saved('live-session', '/work/harness-sdk', '2026-09-27T11:59:00.000Z'),
        saved('old', '/work/harness-sdk', '2026-09-01T00:00:00.000Z'),
        saved('doom', '/work/doomfly', '2026-09-27T09:00:00.000Z', {
          reference: 'strands-session:doom',
          preview: 'Speed up training',
          subagents: [{ task: 'Audit the dataloader', agentType: 'generalist', status: 'failed' }],
        }),
        saved('recent', '/work/harness-sdk', '2026-09-27T11:58:00.000Z', { name: 'Fix cache tokens' }),
      ],
      NOW
    )

    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['Strands harness', 'conversation:agent-1'],
      ['Review the parser', 'pond-task:agent-1:task-1'],
      ['Fix cache tokens', 'recent'],
      ['Speed up training', 'strands-session:doom'],
      ['Audit the dataloader', 'strands-session:doom'],
    ])
    expect(pond).toEqual([
      { cove: 'harness-sdk', pad: 'conversation:agent-1', kind: 'session', state: 'working', current: true },
      { cove: 'harness-sdk', pad: 'conversation:agent-1', kind: 'subagent', state: 'working' },
      { cove: 'harness-sdk', pad: 'session:recent', kind: 'session', state: 'awake' },
      { cove: 'doomfly', pad: 'session:strands-session:doom', kind: 'session', state: 'asleep' },
      { cove: 'doomfly', pad: 'session:strands-session:doom', kind: 'subagent', state: 'failed' },
    ])
    expect(rows[2]!.description).toContain('active in another terminal')
    expect(readPondTaskValue(rows[1]!.value)).toEqual({ conversationId: 'agent-1', taskId: 'task-1' })
  })

  it('searches every saved session and keeps whole matching pads', () => {
    const { rows } = pondContent(
      [conversation()],
      [
        saved('old', '/work/doomfly', '2026-01-01T00:00:00.000Z', {
          preview: 'Tune the learning rate',
          subagents: [{ task: 'Profile the dataloader', status: 'completed' }],
        }),
        saved('other', '/work/doomfly', '2026-09-27T11:00:00.000Z', { preview: 'Unrelated' }),
      ],
      NOW,
      'DATALOADER'
    )
    expect(rows.map((row) => row.label)).toEqual(['Tune the learning rate', 'Profile the dataloader'])
  })
})

describe('pond layout', () => {
  const frogs: PondFrog[] = [
    { cove: 'a', pad: 'a1', kind: 'session', state: 'working' },
    { cove: 'a', pad: 'a1', kind: 'subagent', state: 'working' },
    { cove: 'a', pad: 'a2', kind: 'session', state: 'asleep' },
    { cove: 'b', pad: 'b1', kind: 'session', state: 'awake' },
    { cove: 'c', pad: 'c1', kind: 'session', state: 'failed' },
  ]

  it('keeps each cove in its own region with every pad inside it', () => {
    const layout = layoutPond(frogs, 160)
    expect(layout.hidden).toBe(0)
    expect(layout.coves.map((cove) => cove.name)).toEqual(['a', 'b', 'c'])
    for (const placement of layout.pads) {
      const cove = layout.coves.find((candidate) => candidate.name === placement.pad.cove)!
      expect(placement.x).toBeGreaterThanOrEqual(cove.left)
      expect(placement.x).toBeLessThan(cove.left + cove.width)
      expect(placement.y).toBeGreaterThan(cove.top)
      expect(placement.y).toBeLessThan(cove.top + cove.height)
    }
    for (const [index, first] of layout.coves.entries()) {
      for (const second of layout.coves.slice(index + 1)) {
        const apart =
          first.left + first.width <= second.left ||
          second.left + second.width <= first.left ||
          first.top + first.height <= second.top ||
          second.top + second.height <= first.top
        expect(apart).toBe(true)
      }
    }
  })

  it('scrolls a pond taller than the view and reveals any frog', () => {
    const many = Array.from({ length: 40 }, (_, index): PondFrog => ({
      cove: `workspace-${index % 5}`,
      pad: `pad-${index}`,
      kind: 'session',
      state: 'asleep',
    }))
    const canvas = { width: 100, height: 30 }
    const layout = layoutPond(many, canvas.width)
    expect(layout.pads).toHaveLength(40)
    expect(layout.height).toBeGreaterThan(canvas.height * 3)

    const last = many.length - 1
    const scroll = revealPondFrog(many, canvas, 0, last)
    const placement = layout.pads.find(({ pad }) => pad.session === last)!
    expect(placement.y - 7).toBeGreaterThanOrEqual(scroll)
    expect(placement.y + 3).toBeLessThan(scroll + canvas.height)
    expect(clampPondScroll(many, canvas, 10_000)).toBe(layout.height - canvas.height)
    expect(clampPondScroll(many, canvas, -5)).toBe(0)

    const scene = renderPond(
      many,
      many.map((frog) => frog.pad),
      canvas.width,
      canvas.height,
      { elapsedMs: 0, scroll, color: false, theme: 'green' }
    )
    expect(scene.lines).toHaveLength(canvas.height)
    expect(scene.hitBoxes.map((box) => box.index)).toContain(last)
    expect(scene.hitBoxes.map((box) => box.index)).not.toContain(0)
    for (const box of scene.hitBoxes) {
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.top + box.height).toBeLessThanOrEqual(canvas.height)
    }
  })

  it('draws a full canvas with a click target for every visible frog', () => {
    const scene = renderPond(
      frogs,
      frogs.map((frog) => frog.pad),
      160,
      40,
      { elapsedMs: 0, color: false, theme: 'green' }
    )
    expect(scene.lines).toHaveLength(40)
    expect(scene.hitBoxes.map((box) => box.index).sort()).toEqual([0, 1, 2, 3, 4])
    for (const box of scene.hitBoxes) {
      expect(box.width).toBeGreaterThan(0)
      expect(box.height).toBeGreaterThan(0)
    }
  })
})

describe('saved session subagents', () => {
  it('reads subagent calls and their outcomes from the latest snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-pond-'))
    const sessionsDirectory = join(directory, '.agent', 'sessions')
    const snapshots = join(sessionsDirectory, 'saved', 'scopes', 'agent', 'agent', 'snapshots')
    await mkdir(snapshots, { recursive: true })
    await writeFile(
      join(snapshots, 'snapshot_latest.json'),
      JSON.stringify({
        data: {
          messages: [
            { role: 'user', content: [{ text: 'Review both files' }] },
            {
              role: 'assistant',
              content: [
                {
                  toolUse: { name: 'subagent', toolUseId: 'one', input: { task: 'Read a.ts', agent_type: 'explorer' } },
                },
                { toolUse: { name: 'subagent', toolUseId: 'two', input: { task: 'Read b.ts' } } },
                { toolUse: { name: 'shell', toolUseId: 'three', input: { command: 'ls' } } },
              ],
            },
            {
              role: 'user',
              content: [
                { toolResult: { toolUseId: 'one', status: 'success', content: [] } },
                { toolResult: { toolUseId: 'two', status: 'error', content: [] } },
              ],
            },
          ],
        },
      })
    )
    const sessions = new FileSessionRuntime(
      { sessionId: undefined, sessionDirectory: sessionsDirectory },
      sessionsDirectory
    )
    try {
      const [session] = await sessions.list()
      expect(session?.subagents).toEqual([
        { task: 'Read a.ts', agentType: 'explorer', status: 'completed' },
        { task: 'Read b.ts', status: 'failed' },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('/pond', () => {
  it('opens the pond and switches to the clicked conversation', async () => {
    const run = (name: string) =>
      async function* (prompt: string): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
        yield { type: 'textDelta', text: `${name}:${prompt}` }
        return { stopReason: 'endTurn' }
      }
    const backend = (id: string): ChatBackend => ({
      id,
      name: 'Strands harness',
      protocol: 'strands',
      stream: run(id),
      cancel: vi.fn(),
      dispose: vi.fn(),
    })
    const primary = new ChatController(backend('main'))
    const fork = new ChatController(backend('fork'))
    const manager = new ConversationManager(primary, { fork: async () => fork })

    await manager.submit('baseline')
    await manager.submit('/fork')
    await manager.submit('/pond')

    const panel = manager.getSnapshot().panel!
    expect(panel.kind).toBe('pond')
    expect(panel.pond).toHaveLength(2)
    expect(panel.pond?.filter((frog) => frog.current)).toHaveLength(1)
    const main = panel.rows.find((row) => row.value === 'conversation:agent-1')!
    await manager.activatePanelRow(main)
    expect(manager.getSnapshot().panel).toBeUndefined()
    expect(manager.getSnapshot().completedTurns.at(-1)).toMatchObject({ prompt: 'baseline' })
  })
})
