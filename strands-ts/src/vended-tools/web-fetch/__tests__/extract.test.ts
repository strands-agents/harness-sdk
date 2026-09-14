import { describe, it, expect } from 'vitest'
import { htmlToMarkdown } from '../extract.js'

describe('htmlToMarkdown', () => {
  it('strips script and style content', async () => {
    const html = `
      <html><head><title>Hi</title>
      <style>body{color:red}</style>
      </head><body>
      <p>Hello world.</p>
      <script>alert('xss')</script>
      <p>After script.</p>
      </body></html>
    `
    const result = await htmlToMarkdown(html)
    expect(result).toMatch(/# Hi/)
    expect(result).not.toMatch(/alert/)
    expect(result).not.toMatch(/color:red/)
    expect(result).toMatch(/Hello world\./)
    expect(result).toMatch(/After script\./)
  })

  it.each(['nav', 'form', 'iframe', 'svg', 'canvas', 'video', 'audio'])('drops <%s> element entirely', async (tag) => {
    const result = await htmlToMarkdown(`<p>before</p><${tag}>secret content</${tag}><p>after</p>`)
    expect(result).not.toContain('secret content')
    expect(result).toContain('before')
    expect(result).toContain('after')
  })

  it('strips data-URI image blobs', async () => {
    const bigBlob = 'A'.repeat(10000)
    const result = await htmlToMarkdown(`<p>text</p><img src="data:image/png;base64,${bigBlob}" alt="alt text">`)
    expect(result).not.toContain(bigBlob)
    expect(result).not.toMatch(/data:/)
    expect(result).toMatch(/alt text/)
  })

  it('preserves regular images and relative hrefs', async () => {
    expect(await htmlToMarkdown('<img src="https://example.com/pic.png" alt="pic">')).toContain(
      '![pic](https://example.com/pic.png)'
    )
    expect(await htmlToMarkdown('<a href="/about">About</a>')).toContain('[About](/about)')
  })

  it('drops javascript: hrefs but keeps link text', async () => {
    const result = await htmlToMarkdown('<a href="javascript:alert(1)">click</a>')
    expect(result).not.toMatch(/javascript:/)
    expect(result).toMatch(/click/)
  })

  it.each(['\u200b', '\u00ad', '\ufeff', ' '])('drops javascript: href with invisible prefix %s', async (prefix) => {
    const result = await htmlToMarkdown(`<a href="${prefix}javascript:alert(1)">click</a>`)
    expect(result).not.toMatch(/javascript:/)
    expect(result).toContain('click')
  })

  it('drops javascript: img srcs', async () => {
    expect(await htmlToMarkdown('<img src="javascript:alert(1)" alt="x">')).not.toMatch(/javascript:/)
  })

  it('returns alt text for image with empty src', async () => {
    expect(await htmlToMarkdown('<img src="" alt="description">')).toContain('description')
  })

  it.each(['\u200b', '\u00ad', '\ufeff'])('drops javascript: img src with invisible prefix %s', async (prefix) => {
    expect(await htmlToMarkdown(`<img src="${prefix}javascript:alert(1)" alt="x">`)).not.toMatch(/javascript:/)
  })

  it('strips data-URI image blob with invisible prefix', async () => {
    const blob = 'A'.repeat(100)
    const result = await htmlToMarkdown(`<img src="\u200bdata:image/png;base64,${blob}" alt="alt">`)
    expect(result).not.toContain(blob)
    expect(result).toContain('alt')
  })

  it('embeds the page title as a top-level heading', async () => {
    const result = await htmlToMarkdown('<html><head><title>My Page</title></head><body><p>body</p></body></html>')
    expect(result).toMatch(/^# My Page\n/)
    expect(result).toContain('body')
  })

  it('produces no heading when there is no title', async () => {
    expect(await htmlToMarkdown('<p>no title here</p>')).not.toMatch(/^#/)
  })

  it('returns original input on conversion failure', async () => {
    expect(await htmlToMarkdown(null as unknown as string)).toBe(null)
  })
})
