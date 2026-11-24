import { readFileSync } from 'node:fs'

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

// The site overrides Starlight's MarkdownContent, so starlight-image-zoom skips its own override
// and overrides/MarkdownContent.astro has to render <ImageZoom /> itself. Without it the build still
// passes and images still get a zoom button, but clicking does nothing. These checks catch that.
function builtPage(route: string): Document {
  const html = readFileSync(new URL(`../dist/${route}/index.html`, import.meta.url), 'utf8')
  return new JSDOM(html).window.document
}

describe('image zoom', () => {
  const page = builtPage('docs/user-guide/sdk/observability-evaluation/traces')

  it('wraps Markdown images in a zoom control', () => {
    const image = page.querySelector('.sl-markdown-content img[alt="Trace Visualization"]')
    const zoomable = image?.closest('starlight-image-zoom-zoomable')

    expect(zoomable).not.toBeNull()
    expect(zoomable?.querySelector('button.starlight-image-zoom-control')).not.toBeNull()
  })

  it('renders the zoom dialog the control opens', () => {
    const zoom = page.querySelector('starlight-image-zoom')
    // The plugin keeps its dialog in a <template> and clones it on click.
    const template = zoom?.querySelector('template')

    expect(zoom).not.toBeNull()
    expect(template?.content.querySelector('dialog.starlight-image-zoom-dialog')).not.toBeNull()
  })
})
