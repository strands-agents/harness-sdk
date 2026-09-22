/**
 * Shared Open Graph / social share image renderer.
 *
 * Renders the "terminal card" share image used for blog posts and the
 * site-wide default, matching the site's visual identity: black canvas,
 * JetBrains Mono, brand green (#00cc60), terminal-window chrome, and the
 * Strands "S" strand mark. Layout is described as a satori vnode tree and
 * rasterised to PNG with resvg.
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { Resvg } from '@resvg/resvg-js'
import satori from 'satori'
import type { SatoriOptions } from 'satori'

const require = createRequire(import.meta.url)

// Brand tokens (mirror of src/styles/fonts.css).
const BLACK = '#000000'
const GREEN = '#00cc60'
const WHITE = '#ffffff'
const GREY = '#a0a8b0'
const HAIRLINE = '#28292a'
const RED = '#f7414c'
const YELLOW = '#f6bc00'

const WIDTH = 1200
const HEIGHT = 630

// Strands "S" strand mark (from src/assets/logo-dark.svg), embedded as a data
// URI so satori can rasterise it without a filesystem lookup at render time.
const S_MARK = `<svg width="290" height="463" viewBox="0 0 290 463" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M97.2902 52.7884C85.0674 49.1667 72.2234 56.1389 68.6017 68.3616C64.9801 80.5843 71.9524 93.4283 84.1749 97.0501L235.117 139.775C245.223 142.769 246.357 156.628 236.874 161.226L32.546 260.291C-14.9439 283.316 -9.16107 352.74 41.4835 367.591L189.551 411.009L190.125 411.169C202.183 414.376 214.665 407.396 218.196 395.355C221.784 383.122 214.774 370.296 202.541 366.709L54.4738 323.291C44.3447 320.321 43.1879 306.436 52.6857 301.831L257.014 202.766C304.432 179.776 298.758 110.483 248.233 95.512L97.2902 52.7884Z" fill="#0E0E0E"/><path d="M259.147 0.981812C271.389 -2.57498 284.197 4.46571 287.754 16.7074C291.311 28.9492 284.27 41.757 272.028 45.3138L71.1727 103.671C40.7142 112.521 37.1976 154.262 65.7459 168.083L241.343 253.093C307.872 285.302 299.794 382.546 228.862 403.336L30.4041 461.502C18.1707 465.088 5.34708 458.078 1.76153 445.844C-1.8239 433.611 5.18637 420.787 17.4197 417.202L215.878 359.035C246.277 350.125 249.739 308.449 221.226 294.645L45.6297 209.635C-20.9834 177.386 -12.7772 79.9893 58.2928 59.3402L259.147 0.981812Z" fill="#00cc60"/></svg>`
const S_MARK_URI = `data:image/svg+xml;base64,${Buffer.from(S_MARK).toString('base64')}`

type FontWeight = 400 | 500 | 700

let fontsPromise: Promise<SatoriOptions['fonts']> | undefined

function loadFonts(): Promise<SatoriOptions['fonts']> {
  fontsPromise ??= (async () => {
    const weights: FontWeight[] = [400, 500, 700]
    return Promise.all(
      weights.map(async (weight) => ({
        name: 'JetBrains Mono',
        weight,
        style: 'normal' as const,
        data: await readFile(
          require.resolve(`@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${weight}-normal.woff`)
        ),
      }))
    )
  })()
  return fontsPromise
}

// Longer titles step down in size so they stay within the card.
function titleSize(title: string): number {
  if (title.length > 70) return 42
  if (title.length > 50) return 50
  if (title.length > 32) return 58
  return 66
}

// Minimal hyperscript for satori's vnode form (no JSX in this .ts endpoint).
type Style = Record<string, string | number>
type VNode = { type: string; props: { style?: Style; children?: unknown; [k: string]: unknown } }
const h = (type: string, style: Style, children?: unknown, extra: Record<string, unknown> = {}): VNode => ({
  type,
  props: { style, children, ...extra },
})

function dot(color: string): VNode {
  return h('div', { width: 16, height: 16, borderRadius: 8, backgroundColor: color })
}

export interface OgImageInput {
  title: string
  description?: string
  /** Footer install command, without the leading prompt. */
  command?: string
}

function card({ title, description, command = 'pip install strands-harness' }: OgImageInput): VNode {
  const header = h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, [
    h('div', { display: 'flex', alignItems: 'center', gap: 14 }, [dot(RED), dot(YELLOW), dot(GREEN)]),
    h('div', { display: 'flex', alignItems: 'center', gap: 14 }, [
      h('img', { width: 26, height: 41 }, undefined, { src: S_MARK_URI }),
      h('div', { fontSize: 24, fontWeight: 500, color: GREY, letterSpacing: 2 }, 'strands'),
    ]),
  ])

  const body = h('div', { display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center' }, [
    h('div', { fontSize: titleSize(title), fontWeight: 700, color: WHITE, lineHeight: 1.15, letterSpacing: -1 }, title),
    h('div', { width: 104, height: 6, borderRadius: 3, backgroundColor: GREEN, marginTop: 30, marginBottom: 30 }),
    ...(description ? [h('div', { fontSize: 28, fontWeight: 400, color: GREY, lineHeight: 1.45 }, description)] : []),
  ])

  const footer = h('div', { display: 'flex', alignItems: 'center', gap: 14 }, [
    h('div', { fontSize: 26, fontWeight: 700, color: GREEN }, '$'),
    h('div', { fontSize: 26, fontWeight: 500, color: WHITE }, command),
  ])

  const terminal = h(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      flexGrow: 1,
      padding: '52px 64px',
      borderTop: `1px solid ${HAIRLINE}`,
    },
    [header, body, footer]
  )

  return h('div', { display: 'flex', width: '100%', height: '100%', backgroundColor: BLACK }, [
    h('div', { width: 12, height: '100%', backgroundColor: GREEN }),
    terminal,
  ])
}

export async function renderOgImage(input: OgImageInput): Promise<Uint8Array<ArrayBuffer>> {
  const fonts = await loadFonts()
  const svg = await satori(card(input) as never, { width: WIDTH, height: HEIGHT, fonts })
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng()
  // Copy into a concrete Uint8Array<ArrayBuffer> so it satisfies Response's BodyInit.
  const body = new Uint8Array(png.length)
  body.set(png)
  return body
}
