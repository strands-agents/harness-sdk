import { existsSync, readFileSync } from 'node:fs'

import { parse } from 'node-html-parser'
import { describe, expect, it } from 'vitest'

function configuredPathWithBase(value: string): string {
  const base = (process.env.ASTRO_BASE_PATH ?? '/').replace(/\/$/, '')
  const normalizedValue = value.startsWith('/') ? value : `/${value}`
  return `${base}${normalizedValue}`
}

describe('Frogs page', () => {
  it('publishes the game preview and permits photo downloads', () => {
    const page = parse(readFileSync(new URL('../dist/frogs/index.html', import.meta.url), 'utf8'))
    const origin = new URL(process.env.SITE_DOMAIN ?? 'https://strandsagents.com').origin
    const canonical = new URL(configuredPathWithBase('/frogs/'), origin).href
    const image = new URL(configuredPathWithBase('/frogs-preview.jpg'), origin).href
    const title = 'Stranded in New York'
    const description = 'Strands frogs hop, skip and drive around Midtown Manhattan. What will you discover?'
    const imageAlt = 'A Strands frog beside the ice rink, skating frogs and Christmas market stalls in Bryant Park.'
    const iframe = page.querySelector('iframe')

    expect({
      title: page.querySelector('title')?.text,
      canonical: page.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      favicon: page.querySelector('link[rel="icon"]')?.getAttribute('href'),
      meta: Object.fromEntries(
        page
          .querySelectorAll('head meta[name], head meta[property]')
          .map((tag) => [tag.getAttribute('property') ?? tag.getAttribute('name'), tag.getAttribute('content')])
      ),
      iframe: {
        src: iframe?.getAttribute('src'),
        title: iframe?.getAttribute('title'),
        sandbox: iframe?.getAttribute('sandbox')?.split(' ').sort(),
      },
      imageExists: existsSync(new URL('../dist/frogs-preview.jpg', import.meta.url)),
    }).toEqual({
      title,
      canonical,
      favicon: configuredPathWithBase('/favicon.svg'),
      meta: {
        viewport: 'width=device-width, initial-scale=1',
        description,
        robots: 'noindex',
        'og:type': 'website',
        'og:url': canonical,
        'og:title': title,
        'og:description': description,
        'og:image': image,
        'og:image:type': 'image/jpeg',
        'og:image:width': '1200',
        'og:image:height': '630',
        'og:image:alt': imageAlt,
        'twitter:card': 'summary_large_image',
        'twitter:title': title,
        'twitter:description': description,
        'twitter:image': image,
        'twitter:image:alt': imageAlt,
      },
      iframe: {
        src: 'https://d3i1gpu82pqyr4.cloudfront.net/',
        title,
        sandbox: ['allow-downloads', 'allow-pointer-lock', 'allow-same-origin', 'allow-scripts'],
      },
      imageExists: true,
    })
  })
})
