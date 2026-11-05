import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'
import { metadataPlacements } from '../../src/ui/presentation.js'
import { snapshot } from '../fixtures/chat-snapshot.js'

function metadataSnapshot(model: string, cwd: string) {
  const current = snapshot()
  return snapshot({ runtime: { ...current.runtime, model, effort: 'High', cwd }, permissionMode: 'default' })
}

describe('metadataPlacements', () => {
  it('sanitizes the workspace path only for display', () => {
    const current = metadataSnapshot('Claude Opus 4.6', '/work/\u001b[31mteam\u007fagent')
    const path = metadataPlacements(current, 100).find(({ target }) => target === 'cwd')!
    expect(path.text).toBe('/work/teamagent')
    expect(current.runtime.cwd).toBe('/work/\u001b[31mteam\u007fagent')
  })

  it('shortens the directory before the controls and preserves the final directory name', () => {
    const current = metadataSnapshot('Claude Opus 4.6', `/Users/gsird/${'workspace/'.repeat(15)}harness-sdk`)
    const placements = metadataPlacements(current, 100)
    expect(placements[0]!.text).toContain('Claude Opus 4.6 • High • Ask')
    expect(placements.find(({ target }) => target === 'cwd')!.text).toMatch(/….*harness-sdk$/u)
    expect(placements.at(-1)!.text).toBe('/voice  /settings')
  })

  it('preserves effort and settings when the model must be shortened', () => {
    const current = metadataSnapshot('large model '.repeat(20), '/work')
    const placements = metadataPlacements(current, 40)
    expect(placements[0]!.text).toContain('… • High • Ask')
    expect(placements.at(-1)!.text).toBe('/voice  /settings')
    expect(metadataPlacements(current, 18).at(-1)!.text).toBe('/settings')
  })

  it('labels bypass and custom permission modes beside effort', () => {
    const current = metadataSnapshot('Claude Opus 4.6', '/work')
    const bypass = metadataPlacements({ ...current, permissionMode: 'bypassPermissions' }, 100)
    const custom = metadataPlacements({ ...current, permissionPreset: 'custom' }, 100)
    expect(bypass[0]!.text).toContain('Claude Opus 4.6 • High • Bypass')
    expect(custom[0]!.text).toContain('Claude Opus 4.6 • High • Custom')
  })

  it('keeps an available update actionable without overflowing narrow footers', () => {
    const current = metadataSnapshot('Claude Opus 4.6', '/work')
    const wide = metadataPlacements(current, 100, '0.2.1').at(-1)!
    expect(wide.actions).toEqual([
      { target: 'update', text: '↑ Update 0.2.1' },
      { target: 'voice', text: '/voice' },
      { target: 'settings', text: '/settings' },
    ])

    for (const width of [20, 40, 80]) {
      const placements = metadataPlacements(current, width, '0.2.1')
      expect(placements.reduce((sum, placement) => sum + placement.width, 0)).toBeLessThanOrEqual(
        Math.max(0, width - 2)
      )
      expect(placements.at(-1)?.actions?.[0]?.target).toBe('update')
    }
  })

  it.each([24, 40, 80, 120])('fits Unicode labels without splitting graphemes at %i columns', (width) => {
    const model = '界👩‍💻e\u0301🇺🇸'.repeat(20)
    const cwd = `/用户/${'👨‍👩‍👧‍👦e\u0301📁/'.repeat(20)}`
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const allowed = new Set(
      [...segmenter.segment(`${model}${cwd} • HighAsk…/voice/settings░—`)].map(({ segment }) => segment)
    )
    let offset = 0
    let previousEnd: number | undefined
    for (const placement of metadataPlacements(metadataSnapshot(model, cwd), width)) {
      const textWidth = stringWidth(placement.text)
      expect(textWidth).toBeLessThanOrEqual(placement.width)
      const start = offset + (placement.alignment === 'flex-end' ? placement.width - textWidth : 0)
      if (previousEnd !== undefined) expect(start - previousEnd).toBeGreaterThanOrEqual(2)
      for (const { segment } of segmenter.segment(placement.text)) expect(allowed.has(segment)).toBe(true)
      previousEnd = start + textWidth
      offset += placement.width
    }
    expect(offset).toBeLessThanOrEqual(Math.max(0, width - 2))
  })
})
