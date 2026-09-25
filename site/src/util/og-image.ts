/**
 * Shared Open Graph / social share image renderer for blog posts and the
 * site-wide default. Renders a dark green-to-black gradient card with a
 * diagonally-fading halftone dot field, the STRANDS wordmark, an eyebrow,
 * headline, description, and the pixel frog mark. Layout is described as a
 * satori vnode tree and rasterised to PNG with resvg.
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { Resvg } from '@resvg/resvg-js'
import satori from 'satori'
import type { SatoriOptions } from 'satori'
import frogSvg from '../assets/nav/frog-hop.svg?raw'
import wordmarkSvg from '../assets/nav/wordmark.svg?raw'

const require = createRequire(import.meta.url)

// Brand tokens (mirror of src/styles/fonts.css).
const GREEN = '#00cc60'
const PINK = '#ff70eb'
const HEADLINE = '#eafff2'
const SUB = '#9fb4a8'
const BG_TOP = '#0c1310'
const BG_BOTTOM = '#000000'

const WIDTH = 1200
const HEIGHT = 630

function svgUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

// Nav marks are shared SVGs whose `currentColor` satori can't resolve, so
// recolour to a fixed value and inline as data URIs.
const FROG_URI = svgUri(frogSvg.replaceAll('currentColor', GREEN))
const WORDMARK_URI = svgUri(wordmarkSvg.replaceAll('currentColor', GREEN))

// Halftone dot field echoing the homepage banner: a grid of green dots whose
// opacity fades along a 115° diagonal, densest at the top-left. Generated
// rather than reusing the banner's halftone.svg (~3MB).
function halftoneUri(): string {
  const gap = 22
  const peakAlpha = 0.42
  // 115° gradient direction (CSS: 0° points up, clockwise): points right+down.
  const dirX = Math.sin((115 * Math.PI) / 180)
  const dirY = -Math.cos((115 * Math.PI) / 180)
  const projMax = WIDTH * dirX + HEIGHT * dirY
  const dots: string[] = []
  for (let y = 0; y <= HEIGHT; y += gap) {
    for (let x = 0; x <= WIDTH; x += gap) {
      const norm = (x * dirX + y * dirY) / projMax
      // Opaque until the mask start, fading to zero by 74% along the axis.
      const alpha = Math.max(0, 1 - norm / 0.74) * peakAlpha
      if (alpha < 0.01) continue
      dots.push(`<circle cx="${x}" cy="${y}" r="2" fill="${GREEN}" fill-opacity="${alpha.toFixed(3)}"/>`)
    }
  }
  return svgUri(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">${dots.join('')}</svg>`)
}
const HALFTONE_URI = halftoneUri()

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

// Longer headlines step down in size so they stay within the card.
function headlineSize(title: string): number {
  if (title.length > 70) return 40
  if (title.length > 50) return 46
  if (title.length > 32) return 52
  return 56
}

// Minimal hyperscript for satori's vnode form (no JSX in this .ts endpoint).
type Style = Record<string, string | number>
type VNode = { type: string; props: { style?: Style; children?: unknown; [k: string]: unknown } }
const h = (type: string, style: Style, children?: unknown, extra: Record<string, unknown> = {}): VNode => ({
  type,
  props: { style, children, ...extra },
})

export interface OgImageInput {
  title: string
  description?: string
  /** Small uppercase kicker above the headline. */
  eyebrow?: string
}

function card({ title, description, eyebrow = 'Open source' }: OgImageInput): VNode {
  // Wordmark viewBox is 1512×217 (~6.97:1); size by height and derive width.
  const wordmarkHeight = 62
  const top = h('div', { display: 'flex' }, [
    h('img', { width: wordmarkHeight * 6.968, height: wordmarkHeight }, undefined, { src: WORDMARK_URI }),
  ])

  const body = h('div', { display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center' }, [
    h(
      'div',
      { fontSize: 18, fontWeight: 600, color: PINK, letterSpacing: 3.6, textTransform: 'uppercase', marginBottom: 20 },
      eyebrow
    ),
    h(
      'div',
      { fontSize: headlineSize(title), fontWeight: 600, color: HEADLINE, lineHeight: 1.22, maxWidth: 920 },
      title
    ),
    ...(description
      ? [
          h(
            'div',
            { fontSize: 24, fontWeight: 400, color: SUB, lineHeight: 1.45, marginTop: 22, maxWidth: 880 },
            description
          ),
        ]
      : []),
  ])

  const content = h(
    'div',
    { position: 'relative', display: 'flex', flexDirection: 'column', flexGrow: 1, padding: '64px 80px' },
    [top, body]
  )

  const halftone = h('img', { position: 'absolute', top: 0, left: 0, width: WIDTH, height: HEIGHT }, undefined, {
    src: HALFTONE_URI,
  })

  const mascot = h('img', { position: 'absolute', bottom: 56, right: 72, width: 84, height: 84 }, undefined, {
    src: FROG_URI,
  })

  return h(
    'div',
    {
      position: 'relative',
      display: 'flex',
      width: '100%',
      height: '100%',
      backgroundColor: BG_BOTTOM,
      backgroundImage: `linear-gradient(160deg, ${BG_TOP} 0%, ${BG_BOTTOM} 100%)`,
    },
    [halftone, content, mascot]
  )
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
