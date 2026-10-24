import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'
import { chromium } from 'playwright'

// Regression for https://github.com/strands-agents/harness-sdk/issues/5420.
// Run against `npm run dev` with BLOG_TEST_URL pointing at the site origin.
const origin = process.env.BLOG_TEST_URL || 'http://localhost:4321'
const article = '/blog/introducing-strands-agents/'
const artifacts = process.env.BLOG_TEST_ARTIFACTS

test('reading progress follows the visible header edge on the real blog route', async () => {
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  })
  try {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ colorScheme: theme })
      await page.addInitScript((value) => localStorage.setItem('starlight-theme', value), theme)
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 320, height: 640 },
        { width: 1280, height: 900 },
        { width: 1024, height: 400 },
      ]) {
        await page.setViewportSize(viewport)
        await page.goto(new URL(article, origin).href)
        await page.locator('.reading-progress').waitFor()
        await page.evaluate(() => document.fonts.ready)
        const compact = viewport.width < 800 || viewport.height <= 496
        const label = `${theme}-${viewport.width}x${viewport.height}`

        const checkEdge = async (state, hidden) => {
          try {
            await page.waitForFunction(
              (expectedHidden) => {
                const header = document.querySelector('.page > .header')
                const progress = document.querySelector('.reading-progress')
                return (
                  document.documentElement.hasAttribute('data-header-hidden') === expectedHidden &&
                  header.getAnimations().length === 0 &&
                  progress.getAnimations().length === 0
                )
              },
              hidden
            )
            const geometry = await page.evaluate(() => ({
              headerBottom: document.querySelector('.page > .header').getBoundingClientRect().bottom,
              progressTop: document.querySelector('.reading-progress').getBoundingClientRect().top,
              scale: new DOMMatrix(getComputedStyle(document.querySelector('[data-reading-progress]')).transform).a,
              theme: document.documentElement.dataset.theme,
            }))
            console.log(JSON.stringify({ label, state, ...geometry }))
            assert.equal(geometry.theme, theme)
            assert.ok(
              Math.abs(geometry.progressTop - Math.max(0, geometry.headerBottom)) < 1,
              `${label} ${state}: ${JSON.stringify(geometry)}`
            )
            return geometry
          } finally {
            if (artifacts) {
              await mkdir(artifacts, { recursive: true })
              await page.screenshot({ path: `${artifacts}/${label}-${state}.png` })
            }
          }
        }

        await checkEdge('visible', false)
        await page.evaluate(() => window.scrollTo(0, 1800))
        await page.waitForFunction(() => window.scrollY >= 1800)
        await page.waitForFunction(
          () => new DOMMatrix(getComputedStyle(document.querySelector('[data-reading-progress]')).transform).a > 0
        )
        const down = await checkEdge('down', compact)
        assert.ok(down.scale > 0 && down.scale <= 1, 'progress fills while reading')
        await page.evaluate(() => window.scrollBy(0, -200))
        await checkEdge('reverse', false)
        if (compact) {
          await page.evaluate(() => window.scrollBy(0, 300))
          await checkEdge('hidden-before-resize', true)
          await page.setViewportSize({ width: 1280, height: 900 })
          await checkEdge('resized-desktop', false)
          await page.setViewportSize(viewport)
          await checkEdge('resized-compact', false)
          await page.emulateMedia({ reducedMotion: 'reduce' })
          await page.evaluate(() => window.scrollBy(0, 300))
          await checkEdge('reduced-motion', true)
          assert.equal(
            await page.locator('.reading-progress').evaluate((element) => getComputedStyle(element).transitionDuration),
            '0s'
          )
          await page.emulateMedia({ reducedMotion: 'no-preference' })
        }
        await page.goto(new URL(`${article}?embed`, origin).href)
        await page.waitForFunction(() => document.documentElement.hasAttribute('data-embed'))
        assert.equal(await page.locator('.reading-progress').isVisible(), false)
      }
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
