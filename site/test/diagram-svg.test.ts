import { describe, it, expect } from 'vitest'
import { namespaceSvgIds, prepareDiagramSvg } from '../src/util/diagram-svg'

const raw = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 100">
  <!-- Type: loop. Story: authoring note. -->
  <defs>
    <marker id="arrow"><path class="dg-head" d="M0,0 L8,3 L0,6 Z"/></marker>
    <linearGradient id="fade"/>
  </defs>
  <path class="dg-edge" d="M0,0 H10" marker-end="url(#arrow)"/>
  <use href="#arrow"/>
  <use xlink:href="#fade"/>
  <rect class="dg-node" x="0" y="0" width="10" height="10" rx="6"/>
</svg>`

describe('namespaceSvgIds', () => {
  it('prefixes ids and every kind of reference to them', () => {
    const out = namespaceSvgIds(raw, 'agent-loop')

    expect(out).toContain('id="dg-agent-loop-arrow"')
    expect(out).toContain('id="dg-agent-loop-fade"')
    expect(out).toContain('marker-end="url(#dg-agent-loop-arrow)"')
    expect(out).toContain('<use href="#dg-agent-loop-arrow"/>')
    expect(out).toContain('xlink:href="#dg-agent-loop-fade"')
    expect(out).not.toMatch(/id="arrow"|url\(#arrow\)|href="#arrow"/)
  })

  it('gives two diagrams on one page disjoint ids', () => {
    const ids = (svg: string) => [...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
    const a = ids(namespaceSvgIds(raw, 'agent-loop'))
    const b = ids(namespaceSvgIds(raw, 'agents-as-tools'))

    expect(a).toHaveLength(2)
    expect(a.filter((id) => b.includes(id))).toEqual([])
  })

  it('leaves class names and non-fragment attributes alone', () => {
    const out = namespaceSvgIds(raw, 'x')

    expect(out).toContain('class="dg-head"')
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(out).toContain('viewBox="0 0 720 100"')
  })
})

describe('prepareDiagramSvg', () => {
  it('strips the XML prolog and authoring comments', () => {
    const out = prepareDiagramSvg(raw, 'agent-loop', 'A loop.')

    expect(out).not.toContain('<?xml')
    expect(out).not.toContain('authoring note')
    expect(out.trimStart().startsWith('<svg')).toBe(true)
  })

  it('strips comments that removing an inner comment would otherwise splice together', () => {
    expect(prepareDiagramSvg('<svg><!<!-- a -->-- b --></svg>', 'x', 'X')).toBe(
      '<svg role="img" aria-label="X" focusable="false"></svg>'
    )
  })

  it('gives the root svg an accessible name, escaped', () => {
    const out = prepareDiagramSvg(raw, 'agent-loop', 'Model "calls" tools & <loops>')

    expect(out).toContain(
      '<svg role="img" aria-label="Model &quot;calls&quot; tools &amp; &lt;loops&gt;" focusable="false"'
    )
    expect(out.match(/role="img"/g)).toHaveLength(1)
  })
})
