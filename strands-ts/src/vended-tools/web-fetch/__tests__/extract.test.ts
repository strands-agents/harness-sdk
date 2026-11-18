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
    ['<img alt="x" src=" a\tb<c>d\\e\x01\x7f\x85.png\n">', '![x](ab%3Cc%3Ed/e%01%7F%C2%85.png)'],
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

  // guards against body text, the page title, and link titles and hrefs changing the structure of the markdown (#6302)
  it.each([
    [
      '<p>See [the docs](https://example.com/docs) for details.</p>',
      'See \\[the docs\\](https://example.com/docs) for details.',
    ],
    [
      '<p>![logo](https://example.com/x.png) a\\[b](https://example.com/c)</p>',
      '!\\[logo\\](https://example.com/x.png) a\\\\\\[b\\](https://example.com/c)',
    ],
    ['<p>Use <code>a[0]</code> and C:\\dir</p>', 'Use `a[0]` and C:\\\\dir'],
    [
      '<title>Guide [part 1](https://example.com/one) # intro</title>',
      '# Guide \\[part 1\\]\\(https://example.com/one) # intro',
    ],
    ['<title>Line one\n\n## Line two</title>', '# Line one ## Line two'],
    ['<title>snake_case *bold* &lt;b&gt;</title>', '# snake\\_case \\*bold\\* &lt;b&gt;'],
    ['<title>\n(1) Inbox\xa0</title>', '# (1) Inbox'],
    ['<html><head><title>\n My Page\n</title></head><body><p>body</p></body></html>', '# My Page\n\nbody'],
    // the first title is written where it stands, where Python starts the output with it
    ['<p>a</p><title>Mid</title><p>b</p>', 'a\n\n# Mid\n\nb'],
    // every title with text is a heading, and a title in a dropped element is dropped
    ['<title> </title><title>One</title><p>body</p><title># Two</title>', '# One\n\nbody\n\n# # Two'],
    [
      '<rss><channel><title>Blog</title><item><description>Hello</description><title>Post</title></item></channel></rss>',
      '# Blog\n\nHello\n\n# Post',
    ],
    ['<html><head><title>T</title><body><p>body</p></body></html>', '# T\n\nbody'],
    ['<svg><title>icon</title></svg><p>body</p>', 'body'],
    [
      '<a href="https://example.com/a" title=\'path C:\\" end\'>link</a>',
      '[link](https://example.com/a "path C:\\\\\\" end")',
    ],
    [
      '<a href="https://example.com/a" title="two\nlines [x] &lt;b&gt;">link</a>',
      '[link](https://example.com/a "two lines \\[x\\] &lt;b&gt;")',
    ],
    ['<a href="https://example.com/a)b">odd</a>', '[odd](https://example.com/a%29b)'],
    ['<a href="https://example.com/a b">space</a>', '[space](https://example.com/a%20b)'],
    ['<a href="https://example.com/a\\)b">odd</a>', '[odd](https://example.com/a/%29b)'],
    // a backslash is a slash before the query of an http(s) or relative URL, as URL parsers read it
    [
      '<a href="docs\\page.htm?q=a\\b">x</a> <a href="mailto:a\\b">m</a>',
      '[x](docs/page.htm?q=a%5Cb) [m](mailto:a%5Cb)',
    ],
    ['<a href="10.0.0.1:80\\a">x</a> <a href="\u200bmailto:a\\b">m</a>', '[x](10.0.0.1:80/a) [m](\u200bmailto:a/b)'],
    ['<a href=" \n">blank</a>', 'blank'],
    ['<a href="b">b</a>', '[b](b)'],
    // an ordinary href and title are not escaped
    ['<a href=" /a?b=1&amp;c=2#d " title="(Plain) title">link [1]</a>', '[link \\[1\\]](/a?b=1&c=2#d "(Plain) title")'],
  ])('escapes text, the title and links in %s', async (html, expected) => {
    expect(await htmlToMarkdown(html)).toBe(expected + '\n')
  })

  // guards against body text starting a heading, list, quote, fence or code span (#6302)
  it.each([
    ['<p># Not a heading</p>', '\\# Not a heading'],
    ['<p>> quote</p><p>- a</p><p>+ b</p><p>12. c</p>', '\\> quote\n\n\\- a\n\n\\+ b\n\n12\\. c'],
    ['<p>1) Not a list</p>', '1\\) Not a list'],
    ['<p>Title</p><p>===</p><p>~~~</p>', 'Title\n\n\\===\n\n\\~~~'],
    ['<p>use `rm -rf` now</p>', 'use \\`rm -rf\\` now'],
    ['<div>1. one<br>2. two</div>', '1\\. one  \n2\\. two'],
    ['a<div><span> # x</span></div>', 'a\n\n\\# x'],
    ['<ul><li>- a</li></ul><blockquote>> b</blockquote><h2># c</h2>', '-   \\- a\n\n> \\> b\n\n## \\# c'],
    // text that does not start a line, and text in code, is unchanged
    [
      '<p><a href="/">Home</a> > <a href="/p">Products</a> - all, C# 1. x</p>',
      '[Home](/) > [Products](/p) - all, C# 1. x',
    ],
    ['<p>#hashtag</p><p>+1</p><p>3.14</p><p>\u0661. x</p>', '#hashtag\n\n+1\n\n3.14\n\n\u0661. x'],
    ['<p>a<i class="icon"></i> - b</p>', 'a - b'],
    [
      '<h2>Intro<a href="#i">#</a></h2><p><span>Step</span> <span>1.</span> Open</p>',
      '## Intro[#](#i)\n\nStep 1. Open',
    ],
    ['<p><code>a\n# b\n[c](u)</code></p>', '`a # b [c](u)`'],
    // image alt text written without the image
    ['<p><img src="data:image/png;base64,AA" alt="# x"></p>', '\\# x'],
    ['<p><img src="data:image/png;base64,AA" alt="* a_b"></p>', '\\* a\\_b'],
    // a line of backticks in a code block does not close its fence
    ['<pre><code>```\ncode\n```</code></pre><p><a href="u">link</a></p>', '````\n```\ncode\n```\n````\n\n[link](u)'],
  ])('escapes block markers and backticks in %s', async (html, expected) => {
    expect(await htmlToMarkdown(html)).toBe(expected + '\n')
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
