#!/usr/bin/env node
// Screenshot every <Diagram> (and Mermaid diagram) on a docs page in light and dark mode,
// including diagrams inside inactive language tabs, so an agent can look at what it drew.
//
// Usage (dev server running, from the repo root):
//   node .agents/skills/docs-diagrams/screenshot.mjs /docs/user-guide/sdk/agents/agent-loop/ [outDir]
//
// Writes <outDir>/<slug>-<index>-<theme>.png (default outDir: /tmp/diagrams) and prints the paths.
//
// Environment:
//   DOCS_URL                         dev server origin (default http://localhost:4321)
//   PLAYWRIGHT_CHROMIUM_EXECUTABLE   explicit Chromium/Chrome binary to launch
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const [, , pagePath, outDir = '/tmp/diagrams'] = process.argv
if (!pagePath) {
  console.error('usage: screenshot.mjs <page-path> [outDir]')
  process.exit(1)
}
const base = process.env.DOCS_URL || 'http://localhost:4321'
const slug = pagePath.replace(/^\/|\/$/g, '').replace(/\//g, '_') || 'index'
mkdirSync(outDir, { recursive: true })

// The dev server takes ~35s to start on a cold machine; wait for it instead of failing.
async function waitForServer(url, budgetMs = 90_000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    if (Date.now() > deadline) {
      console.error(`dev server not reachable at ${url} after ${budgetMs / 1000}s (cd site && npm run dev)`)
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

// With no system fonts, Chromium silently draws Mermaid labels as nothing: the diagram
// looks structurally fine with every box empty. Warn loudly so the agent checks.
function warnIfNoFonts() {
  if (process.platform !== 'linux' || process.env.FONTCONFIG_FILE) return
  try {
    if (execFileSync('fc-list', { encoding: 'utf8' }).trim()) return
  } catch {}
  console.warn('WARNING: no system fonts found (fc-list is empty or missing). Labels may render blank.')
  console.warn('         Install fonts (or set FONTCONFIG_FILE), then retry.')
}

async function launch() {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  if (executablePath) return chromium.launch({ executablePath })
  try {
    return await chromium.launch()
  } catch (bundledError) {
    try {
      return await chromium.launch({ channel: 'chrome' })
    } catch {
      // The bundled-browser error is the informative one (missing libs, not installed, ...).
      console.error(bundledError.message)
      console.error('\nFix: npx playwright install chromium, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE.')
      process.exit(1)
    }
  }
}

await waitForServer(base + pagePath)
warnIfNoFonts()
const browser = await launch()
let count = 0

for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 })
  await page.addInitScript((t) => localStorage.setItem('starlight-theme', t), theme)
  await page.goto(base + pagePath, { waitUntil: 'load', timeout: 30_000 })
  await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' })

  // Mermaid renders client-side; wait until every block has become an SVG.
  const waitForMermaid = (label) =>
    page
      .waitForFunction(
        () =>
          !document.querySelector('pre[data-language="mermaid"]') &&
          [...document.querySelectorAll('pre.mermaid')].every((el) => el.querySelector('svg')),
        null,
        { timeout: 15_000 },
      )
      .catch(() => console.warn(`WARNING: Mermaid did not finish rendering ${label} on ${pagePath} (${theme})`))

  // Let the visible diagrams render first. The site renders diagrams in hidden tab panels
  // when the panel is shown, but only watches for that after its initial render pass, so
  // revealing panels too early leaves those diagrams as raw code. The pass is done once
  // every block has been converted and every visible one has an SVG.
  const hasMermaid = await page.$('pre[data-language="mermaid"], pre.mermaid')
  if (hasMermaid) {
    await page
      .waitForFunction(
        () =>
          !document.querySelector('pre[data-language="mermaid"]') &&
          [...document.querySelectorAll('pre.mermaid')]
            .filter((el) => !el.closest('[role="tabpanel"][hidden]'))
            .every((el) => el.querySelector('svg')),
        null,
        { timeout: 15_000 },
      )
      .catch(() => {})
    await page.waitForTimeout(250)
  }

  // Then reveal inactive tab panels so their diagrams render and can be captured.
  await page.evaluate(() => {
    document.querySelectorAll('[role="tabpanel"][hidden]').forEach((p) => p.removeAttribute('hidden'))
  })
  if (hasMermaid) await waitForMermaid('')
  await page.evaluate(() => document.fonts.ready)

  const figures = await page.$$('figure.dg-figure, pre.mermaid')
  if (figures.length === 0) {
    const errorOverlay = await page.$('vite-error-overlay')
    console.log(
      errorOverlay
        ? `page failed to render: ${pagePath}. Check the dev server log (e.g. tail -30 /tmp/site-dev.log)`
        : `no diagrams found on ${pagePath}. If you expected some, check the dev server log for MDX errors`,
    )
  }
  for (const [i, el] of figures.entries()) {
    const file = join(outDir, `${slug}-${i}-${theme}.png`)
    await el.scrollIntoViewIfNeeded()
    await el.screenshot({ path: file })
    console.log(file)
    count++
  }
  await page.close()
}
await browser.close()
if (count) console.log('\nOpen every PNG and confirm all labels are legible: blank boxes mean missing fonts.')
