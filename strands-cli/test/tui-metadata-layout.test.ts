import { renderToString } from 'ink'
import { createElement } from 'react'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'
import { DevStatusContext } from '../src/tui/view/dev-status-context.js'
import { ComposerFooter } from '../src/tui/view/help-footer.js'
import { metadataPlacements } from '../src/tui/view/presentation.js'
import type { DevStatus } from '../src/dev/status.js'
import { snapshot } from './fixtures/chat-snapshot.js'

function metadataSnapshot(model: string, cwd: string) {
  const current = snapshot()
  return snapshot({ runtime: { ...current.runtime, model, effort: 'High', cwd } })
}

describe('metadataPlacements', () => {
  it('centers the directory when it fits between the controls', () => {
    const placements = metadataPlacements(metadataSnapshot('Claude Opus 4.6', '/work'), 100)
    const path = placements.find(({ target }) => target === 'cwd')!
    expect(Math.abs(placements[0]!.width + stringWidth(path.text) / 2 - 49)).toBeLessThanOrEqual(0.5)
    expect(placements.reduce((sum, { width }) => sum + width, 0)).toBe(98)
  })

  it('shortens the directory before the controls and preserves the final directory name', () => {
    const current = metadataSnapshot('Claude Opus 4.6', `/Users/gsird/${'workspace/'.repeat(15)}harness-sdk`)
    const placements = metadataPlacements(current, 80)
    expect(placements[0]!.text).toContain('Claude Opus 4.6 • High')
    expect(placements.find(({ target }) => target === 'cwd')!.text).toMatch(/….*harness-sdk$/u)
    expect(placements.at(-1)!.text).toBe('/settings')
  })

  it('preserves effort and settings when the model must be shortened', () => {
    const placements = metadataPlacements(metadataSnapshot('large model '.repeat(20), '/work'), 40)
    expect(placements[0]!.text).toContain('… • High')
    expect(placements.at(-1)!.text).toBe('/settings')
  })

  it.each([0, 1, 12, 24, 40, 80, 120])('fits Unicode labels without splitting graphemes at %i columns', (width) => {
    const model = '界👩‍💻e\u0301🇺🇸'.repeat(20)
    const cwd = `/用户/${'👨‍👩‍👧‍👦e\u0301📁/'.repeat(20)}`
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const allowed = new Set([...segmenter.segment(`${model}${cwd} • High…/settings░—`)].map(({ segment }) => segment))
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

describe('metadataPlacements in dev mode', () => {
  const dev: DevStatus = { entrypoint: 'refund_desk/agent.py', reload: { kind: 'watching' } }

  function devSnapshot(model = 'Claude Opus 4.6', cwd = '/work/refund-desk') {
    const current = metadataSnapshot(model, cwd)
    return snapshot({ ...current, runtime: { ...current.runtime, agent: 'refund-desk' } })
  }

  it('shows the agent name first and the dev state before /settings', () => {
    const placements = metadataPlacements(devSnapshot(), 140, dev)
    expect(placements.map(({ target }) => target)).toEqual(['model', 'cwd', 'dev', 'settings'])
    expect(placements[0]).toMatchObject({ lead: 'refund-desk' })
    expect(placements[0]!.text).toMatch(/^refund-desk • Claude Opus 4\.6 • High/u)
    expect(placements[2]).toMatchObject({ text: '● dev · watching', tone: 'success' })
    expect(placements.reduce((sum, { width }) => sum + width, 0)).toBe(138)
  })

  it('names the reloaded file and keeps /settings in a narrow terminal', () => {
    const placements = metadataPlacements(devSnapshot(), 60, { ...dev, reload: { kind: 'reloaded' } })
    expect(placements.at(-1)!.text).toBe('/settings')
    expect(placements.find(({ target }) => target === 'dev')!.text).toMatch(/^↻ agent\.py reloaded/u)
  })

  it('keeps the normal layout outside dev mode', () => {
    const placements = metadataPlacements(devSnapshot(), 100)
    expect(placements.map(({ target }) => target)).toEqual(['model', 'cwd', 'settings'])
    expect(placements[0]).not.toHaveProperty('lead')
  })

  it('renders the agent name, the dev state, and /settings in the footer', () => {
    const footer = (value: DevStatus | undefined): string =>
      renderToString(
        createElement(
          DevStatusContext.Provider,
          { value },
          createElement(ComposerFooter, { snapshot: devSnapshot(), width: 120 })
        ),
        { columns: 120 }
      )
    expect(footer(dev)).toMatch(/refund-desk • Claude Opus 4\.6 • High.*● dev · watching {2}\/settings/u)
    expect(footer(undefined)).not.toMatch(/refund-desk • |● dev/u)
  })

  it.each([0, 1, 12, 24, 40, 60, 80, 120, 200])('keeps two free columns between segments at %i columns', (width) => {
    let offset = 0
    let previousEnd: number | undefined
    const placements = metadataPlacements(devSnapshot('界👩‍💻é'.repeat(10)), width, {
      ...dev,
      reload: { kind: 'reloaded' },
    })
    for (const placement of placements) {
      const textWidth = stringWidth(placement.text)
      expect(textWidth).toBeLessThanOrEqual(placement.width)
      const start = offset + (placement.alignment === 'flex-end' ? placement.width - textWidth : 0)
      if (previousEnd !== undefined) expect(start - previousEnd).toBeGreaterThanOrEqual(2)
      previousEnd = start + textWidth
      offset += placement.width
    }
    expect(offset).toBeLessThanOrEqual(Math.max(0, width - 2))
  })
})
