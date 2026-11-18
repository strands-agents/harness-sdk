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

  it.each(['VBScript:msgbox(1)', 'data:text/html,<script>alert(1)</script>'])(
    'drops %s hrefs but keeps link text',
    async (href) => {
      expect((await htmlToMarkdown(`<a href="${href}">click</a>`)).trim()).toBe('click')
    }
  )

  it('drops javascript: img srcs', async () => {
    expect(await htmlToMarkdown('<img src="javascript:alert(1)" alt="x">')).not.toMatch(/javascript:/)
  })

  it('drops vbscript: img srcs', async () => {
    expect(await htmlToMarkdown('<img src="VBScript:msgbox(1)" alt="x">')).toBe('')
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

  describe.each(['\u2028', '\u2029', '\u200b\u2028 '])('with the line separator prefix %j', (prefix) => {
    it.each(['javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,x'])('drops %s hrefs', async (url) => {
      expect(await htmlToMarkdown(`<a href="${prefix}${url}">click</a>`)).toBe('click\n')
    })

    it.each([
      ['javascript:alert(1)', ''],
      ['vbscript:msgbox(1)', ''],
      ['data:image/png;base64,AAAA', 'x\n'],
    ])('drops %s img srcs', async (src, expected) => {
      expect(await htmlToMarkdown(`<img src="${prefix}${src}" alt="x">`)).toBe(expected)
    })
  })

  it.each(['0890', '0891', '13439', '1343A', '1343B', '1343C', '1343D', '1343E', '1343F'])(
    'drops javascript: href with the format character prefix U+%s',
    async (codePoint) => {
      const prefix = String.fromCodePoint(parseInt(codePoint, 16))
      expect(await htmlToMarkdown(`<a href="${prefix}javascript:alert(1)">click</a>`)).toBe('click\n')
    }
  )

  it('drops javascript: hrefs with a tab inside the scheme', async () => {
    expect(await htmlToMarkdown('<a href="java\tscript:alert(1)">click</a>')).toBe('click\n')
  })

  it.each(['javascript://\u2100%0aalert(1)', 'vbscript://[x', 'data://[x/text/html,x'])(
    'drops %s hrefs with an unparseable host',
    async (url) => {
      expect(await htmlToMarkdown(`<a href="${url}">click</a>`)).toBe('click\n')
    }
  )

  it('keeps an unparseable href and converts the rest of the page', async () => {
    const html = '<h1>Hi</h1><a href="javascript:alert(1)">js</a> <a href="http://[bad">bad</a>'
    expect(await htmlToMarkdown(html)).toBe('# Hi\n\njs [bad](http://[bad)\n')
  })

  it('keeps an unparseable img src', async () => {
    expect(await htmlToMarkdown('<img src="http://[bad" alt="pic">')).toBe('![pic](http://[bad)\n')
  })

  // guards against image alt text and src changing the structure of the markdown (#6243)
  it.each([
    ['<img alt="a](https://example.com/x) [b" src="pic.png">', '![a\\]\\(https://example.com/x) \\[b](pic.png)'],
    [
      '<img alt="[click](https://example.com/y)" src="data:image/png;base64,AAAA">',
      '\\[click\\]\\(https://example.com/y)',
    ],
    ['<img alt="[click](https://example.com/y)" src="">', '\\[click\\]\\(https://example.com/y)'],
    ['<img alt="&lt;https://example.com/a&gt;" src="data:image/png;base64,AAAA">', '&lt;https://example.com/a&gt;'],
    ['<img alt="^back\\slash\n\n`tick` ~~~" src="pic.png">', '![\\^back\\\\slash \\`tick\\` \\~\\~\\~](pic.png)'],
    ['<p>Rated<img alt=" 4 stars " src="data:image/png;base64,AAAA">by users</p>', 'Rated 4 stars by users'],
    // "(" is escaped only where it could open a link destination
    ['<img alt="Logo (dark)" src="pic.png">', '![Logo (dark)](pic.png)'],
    ['<img alt="(dark) Logo" src="pic.png">', '![\\(dark) Logo](pic.png)'],
    ['<img alt="a] (https://example.com/x)" src="pic.png">', '![a\\] \\(https://example.com/x)](pic.png)'],
    [
      '<p>see<img alt=" (https://example.com/y)" src="data:image/png;base64,AAAA"></p>',
      'see \\(https://example.com/y)',
    ],
    ['<a href="https://example.com/"><img alt="a] b" src="pic.png"></a>', '[![a\\] b](pic.png)](https://example.com/)'],
    [
      '<img alt="x" src="pic.png) [click](https://example.com/z">',
      '![x](pic.png%29%20[click]%28https://example.com/z)',
    ],
    ['<img alt="x" src=" a\tb<c>d\\e\x01\x7f\x85.png\n">', '![x](ab%3Cc%3Ed%5Ce%01%7F%C2%85.png)'],
    ['<img alt="x" src="p.png&quot;t&quot;&#39;u&#39;`v">', '![x](p.png%22t%22%27u%27%60v)'],
    // a trailing "!" is escaped only where the alt text is written bare, so a following link stays a link
    [
      '<p><img alt="Wow!" src="data:image/png;base64,AAAA"><a href="https://example.com/">link</a></p>',
      'Wow\\![link](https://example.com/)',
    ],
    ['<p><img alt="Wow!" src=""><a href="https://example.com/">link</a></p>', 'Wow\\![link](https://example.com/)'],
    [
      '<p><span><img alt="Wow! " src="data:image/png;base64,AAAA"> </span><a href="https://example.com/">l</a></p>',
      'Wow\\![l](https://example.com/)',
    ],
    [
      '<p><img alt="Wow!" src="pic.png"><a href="https://example.com/">link</a></p>',
      '![Wow!](pic.png)[link](https://example.com/)',
    ],
    // whitespace and control characters, which Python and JavaScript define differently
    [
      '<img alt="a\x1cb\x85c\ufeffd\xa0e" src="\x1c\x85p\u2028q.png\ufeff\x1c">',
      '![a b c d e](%C2%85p%E2%80%A8q.png%EF%BB%BF)',
    ],
  ])('escapes image alt text and src in %s', async (html, expected) => {
    expect((await htmlToMarkdown(html)).trim()).toBe(expected)
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
