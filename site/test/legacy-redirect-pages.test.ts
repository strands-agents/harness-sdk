import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writeLegacyRedirectPages } from '../src/plugins/legacy-redirect-pages'

function writePage(outputDir: string, relativePath: string, body: string): void {
  const filePath = path.join(outputDir, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    `<!doctype html><html><head><link rel="canonical" href="/docs/state/"></head>${body}</html>`
  )
}

describe('writeLegacyRedirectPages', () => {
  let outputDir: string

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-redirect-pages-test-'))
  })

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true })
  })

  it('serves destination content at an internal legacy route', async () => {
    writePage(
      outputDir,
      'docs/state/index.html',
      '<body><main>State guide content <a href="../history/">History</a></main></body>'
    )

    const count = await writeLegacyRedirectPages(outputDir, {
      '/latest/documentation/docs/state': '/docs/state/',
    })

    const legacyHtml = fs.readFileSync(path.join(outputDir, 'latest/documentation/docs/state/index.html'), 'utf-8')

    expect(count).toBe(1)
    expect(legacyHtml).toContain('State guide content')
    expect(legacyHtml).toContain('<base href="/docs/state/">')
    expect(legacyHtml).toContain('<meta http-equiv="refresh" content="0;url=/docs/state/">')
    expect(legacyHtml).toContain('window.location.replace(target.href)')

    const base = legacyHtml.match(/<base href="([^"]+)">/)?.[1]
    expect(new URL('../history/', `https://strandsagents.com${base}`).pathname).toBe('/docs/history/')
  })

  it('locates a destination beneath the deploy base path', async () => {
    writePage(outputDir, 'docs/state/index.html', '<body><main>State guide content</main></body>')

    await writeLegacyRedirectPages(
      outputDir,
      { '/latest/documentation/docs/state': '/pull-123/docs/state/' },
      '/pull-123/'
    )

    const legacyHtml = fs.readFileSync(path.join(outputDir, 'latest/documentation/docs/state/index.html'), 'utf-8')
    expect(legacyHtml).toContain('content="0;url=/pull-123/docs/state/"')
  })

  it('supports a redirect to the site root', async () => {
    writePage(outputDir, 'index.html', '<body><main>Home content</main></body>')

    await writeLegacyRedirectPages(outputDir, { '/latest': '/' })

    const legacyHtml = fs.readFileSync(path.join(outputDir, 'latest/index.html'), 'utf-8')
    expect(legacyHtml).toContain('Home content')
    expect(legacyHtml).toContain('content="0;url=/"')
  })

  it('leaves external redirect stubs unchanged', async () => {
    const count = await writeLegacyRedirectPages(outputDir, {
      '/docs/old': 'https://example.com/guide',
    })

    expect(count).toBe(0)
    expect(fs.existsSync(path.join(outputDir, 'docs/old/index.html'))).toBe(false)
  })
})
