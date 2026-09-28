// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { expireEvents } from '../src/util/expire-events'

const TODAY = '2026-08-05'
const PAST = '2026-07-01'
const FUTURE = '2026-12-01'

function buildDOM({
  headlinerExpires,
  rowExpires,
  includeHeadliner = true,
  includeRows = true,
  includeTickerEvent = true,
}: {
  headlinerExpires?: string
  rowExpires?: string
  includeHeadliner?: boolean
  includeRows?: boolean
  includeTickerEvent?: boolean
}): Document {
  const dom = new JSDOM(`
    <div class="bulletin">
      ${
        includeTickerEvent
          ? `<span class="row" data-expires="${headlinerExpires ?? FUTURE}">Event A</span>`
          : ''
      }
    </div>
    <div class="poster">
      ${
        includeHeadliner && headlinerExpires
          ? `<div id="poster-headliner" data-expires="${headlinerExpires}">Headliner</div>`
          : ''
      }
      ${
        includeRows && rowExpires
          ? `<div class="list">
               <div class="row" data-expires="${rowExpires}">Row event</div>
             </div>`
          : ''
      }
      <div id="poster-evergreen" hidden>Join us</div>
      <a id="poster-cal" href="#">Event updates on Discord →</a>
    </div>
  `)
  return dom.window.document
}

describe('expireEvents: all events expired → evergreen shown, cal text swapped', () => {
  it('shows evergreen content and swaps cal text when all dated events are gone', () => {
    const doc = buildDOM({ headlinerExpires: PAST, rowExpires: PAST })
    expireEvents(doc, TODAY)

    const evergreen = doc.getElementById('poster-evergreen')
    const cal = doc.getElementById('poster-cal')
    expect(evergreen?.hasAttribute('hidden')).toBe(false)
    expect(cal?.textContent).toBe('Join the Discord →')
  })
})

describe('expireEvents: headliner expired, rows remain → list--bare added', () => {
  it('adds list--bare to .list when headliner expired but row events remain', () => {
    const doc = buildDOM({ headlinerExpires: PAST, rowExpires: FUTURE })
    expireEvents(doc, TODAY)

    const list = doc.querySelector<HTMLElement>('.list')
    expect(list).not.toBeNull()
    expect(list?.classList.contains('list--bare')).toBe(true)

    const evergreen = doc.getElementById('poster-evergreen')
    expect(evergreen?.hasAttribute('hidden')).toBe(true)
  })
})

describe('expireEvents: rows expired, headliner remains → list removed', () => {
  it('removes .list when all row events expired but headliner is still live', () => {
    const doc = buildDOM({ headlinerExpires: FUTURE, rowExpires: PAST })
    expireEvents(doc, TODAY)

    const list = doc.querySelector('.list')
    expect(list).toBeNull()
  })
})

describe('expireEvents: nothing expired → no DOM changes', () => {
  it('leaves DOM untouched when all events are in the future', () => {
    const doc = buildDOM({ headlinerExpires: FUTURE, rowExpires: FUTURE })
    expireEvents(doc, TODAY)

    expect(doc.querySelector('#poster-headliner')).not.toBeNull()
    expect(doc.querySelector('.list')).not.toBeNull()
    const evergreen = doc.getElementById('poster-evergreen')
    expect(evergreen?.hasAttribute('hidden')).toBe(true)
    const cal = doc.getElementById('poster-cal')
    expect(cal?.textContent).toBe('Event updates on Discord →')
  })
})

describe('expireEvents: bulletin rows', () => {
  it('hides the bulletin when its only row expires', () => {
    const doc = buildDOM({ headlinerExpires: FUTURE, rowExpires: FUTURE, includeTickerEvent: false })
    const bulletin = doc.querySelector('.bulletin')!
    const span = doc.createElement('span')
    span.className = 'row'
    span.dataset.expires = PAST
    span.textContent = 'Past event'
    bulletin.appendChild(span)

    expireEvents(doc, TODAY)

    expect(doc.querySelector<HTMLElement>('.bulletin')?.hidden).toBe(true)
  })

  it('keeps the bulletin visible when a dateless row remains after events expire', () => {
    const doc = buildDOM({ headlinerExpires: FUTURE, rowExpires: FUTURE, includeTickerEvent: false })
    const bulletin = doc.querySelector('.bulletin')!
    const expired = doc.createElement('span')
    expired.className = 'row'
    expired.dataset.expires = PAST
    bulletin.appendChild(expired)
    const post = doc.createElement('a')
    post.className = 'row'
    post.textContent = 'New post'
    bulletin.appendChild(post)

    expireEvents(doc, TODAY)

    expect(doc.querySelector<HTMLElement>('.bulletin')?.hidden).toBe(false)
    expect(doc.querySelectorAll('.bulletin .row')).toHaveLength(1)
  })
})
