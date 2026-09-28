import { describe, it, expect } from 'vitest'
import { htmlToMarkdown, htmlToMarkdownWithRules, createTurndownService } from '../src/util/html-to-markdown'

describe('HTML to Markdown Conversion', () => {
  describe('htmlToMarkdown', () => {
    it('should convert basic HTML elements', () => {
      const html = '<h1>Title</h1><p>This is a paragraph.</p>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('# Title')
      expect(markdown).toContain('This is a paragraph.')
    })

    it('should convert links', () => {
      const html = '<a href="https://example.com">Example Link</a>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toBe('[Example Link](https://example.com)')
    })

    it('should convert lists', () => {
      const html = '<ul><li>Item 1</li><li>Item 2</li></ul>'
      const markdown = htmlToMarkdown(html)

      // Turndown adds extra spaces after bullet marker
      expect(markdown).toMatch(/-\s+Item 1/)
      expect(markdown).toMatch(/-\s+Item 2/)
    })

    it('should convert code blocks with language', () => {
      const html = '<pre><code class="language-typescript">const x = 1;</code></pre>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('```typescript')
      expect(markdown).toContain('const x = 1;')
      expect(markdown).toContain('```')
    })

    it('should convert code blocks without language', () => {
      const html = '<pre><code>plain code</code></pre>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('```')
      expect(markdown).toContain('plain code')
    })

    it('should convert inline code', () => {
      const html = '<p>Use <code>npm install</code> to install.</p>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('`npm install`')
    })

    it('should convert emphasis and strong', () => {
      const html = '<p><em>italic</em> and <strong>bold</strong></p>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('*italic*')
      expect(markdown).toContain('**bold**')
    })

    it('should convert headings at different levels', () => {
      const html = '<h1>H1</h1><h2>H2</h2><h3>H3</h3>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('# H1')
      expect(markdown).toContain('## H2')
      expect(markdown).toContain('### H3')
    })

    it('should handle nested elements', () => {
      const html = '<div><p>Paragraph with <strong>bold <em>and italic</em></strong> text.</p></div>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('**bold *and italic***')
    })

    it('should convert blockquotes', () => {
      const html = '<blockquote><p>This is a quote.</p></blockquote>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('> This is a quote.')
    })

    it('should convert images', () => {
      const html = '<img src="image.png" alt="Alt text">'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toBe('![Alt text](image.png)')
    })

    it('should handle complex HTML structure', () => {
      const html = `
        <article>
          <h1>Article Title</h1>
          <p>Introduction paragraph with <a href="/link">a link</a>.</p>
          <h2>Section</h2>
          <ul>
            <li>First item</li>
            <li>Second item with <code>code</code></li>
          </ul>
          <pre><code class="language-python">def hello():
    print("Hello")</code></pre>
        </article>
      `
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('# Article Title')
      expect(markdown).toContain('[a link](/link/index.md)')
      expect(markdown).toContain('## Section')
      expect(markdown).toMatch(/-\s+First item/)
      expect(markdown).toContain('`code`')
      expect(markdown).toContain('```python')
      expect(markdown).toContain('def hello():')
    })

    it('should convert expressive-code format with data-language attribute', () => {
      const html = `<pre data-language="python" dir="ltr"><code><div class="ec-line"><div class="code">from strands import Agent</div></div><div class="ec-line"><div class="code">agent = Agent()</div></div></code></pre>`
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('```python')
      expect(markdown).toContain('from strands import Agent')
      expect(markdown).toContain('agent = Agent()')
      expect(markdown).toMatch(/from strands import Agent\nagent = Agent\(\)/)
    })

    it('should remove sr-only elements', () => {
      const html = '<h2>Title<span class="sr-only">Section titled "Title"</span></h2>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('## Title')
      expect(markdown).not.toContain('Section titled')
    })

    it('should remove empty anchor links', () => {
      const html = '<h2>Title<a href="#title" class="sl-anchor-link"><svg></svg></a></h2>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('## Title')
      expect(markdown).not.toContain('[](#title)')
    })

    it('should wrap tab panels with markers', () => {
      const html = `
        <starlight-tabs>
          <ul role="tablist">
            <li><a role="tab" id="tab-1">Python</a></li>
            <li><a role="tab" id="tab-2">TypeScript</a></li>
          </ul>
          <div role="tabpanel" aria-labelledby="tab-1">Python content</div>
          <div role="tabpanel" aria-labelledby="tab-2">TypeScript content</div>
        </starlight-tabs>
      `
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('(( tab "Python" ))')
      expect(markdown).toContain('Python content')
      expect(markdown).toContain('(( /tab "Python" ))')
      expect(markdown).toContain('(( tab "TypeScript" ))')
      expect(markdown).toContain('TypeScript content')
      expect(markdown).toContain('(( /tab "TypeScript" ))')
    })

    it('should remove tab navigation lists', () => {
      const html = `
        <ul role="tablist">
          <li><a role="tab" href="#tab-panel-1">Python</a></li>
          <li><a role="tab" href="#tab-panel-2">TypeScript</a></li>
        </ul>
      `
      const markdown = htmlToMarkdown(html)

      expect(markdown).not.toContain('[Python]')
      expect(markdown).not.toContain('[TypeScript]')
      expect(markdown).not.toContain('#tab-panel')
    })

    it('should remove script tags', () => {
      const html = '<p>Content</p><script>alert("hello")</script>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('Content')
      expect(markdown).not.toContain('alert')
      expect(markdown).not.toContain('script')
    })

    it('should remove lite-youtube elements so no bare [Play] link appears', () => {
      const html = `
        <p>*<a href="https://www.youtube.com/watch?v=abc123">Watch on YouTube</a>*</p>
        <lite-youtube videoid="abc123" title="Lesson 1">
          <a class="lty-playbtn" href="https://www.youtube.com/watch?v=abc123">Play</a>
        </lite-youtube>
      `
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('[Watch on YouTube](https://www.youtube.com/watch?v=abc123)')
      expect(markdown).not.toContain('[Play]')
    })

    it('should strip a bare Play anchor pointing at a YouTube host', () => {
      const html = '<p><a href="https://www.youtube.com/watch?v=abc123">Play</a></p>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).not.toContain('[Play]')
    })

    it('should keep a Play anchor pointing at a look-alike host', () => {
      const html = '<p><a href="https://youtube.com.evil.com/watch?v=abc123">Play</a></p>'
      const markdown = htmlToMarkdown(html)

      expect(markdown).toContain('[Play](https://youtube.com.evil.com/watch?v=abc123)')
    })
  })

  describe('htmlToMarkdownWithRules', () => {
    it('should allow custom rules', () => {
      const html = '<div class="note">This is a note</div>'
      const markdown = htmlToMarkdownWithRules(html, (service) => {
        service.addRule('noteDiv', {
          filter: (node) => {
            return node.nodeName === 'DIV' && (node as Element).classList?.contains('note')
          },
          replacement: (content) => `:::note\n${content}\n:::`,
        })
      })

      expect(markdown).toContain(':::note')
      expect(markdown).toContain('This is a note')
      expect(markdown).toContain(':::')
    })

    it('should allow removing elements', () => {
      const html = '<p>Keep this</p><script>remove this</script>'
      const markdown = htmlToMarkdownWithRules(html, (service) => {
        service.addRule('removeScript', {
          filter: 'script',
          replacement: () => '',
        })
      })

      expect(markdown).toContain('Keep this')
      expect(markdown).not.toContain('remove this')
    })
  })

  describe('createTurndownService', () => {
    it('should respect custom options', () => {
      const service = createTurndownService({
        bulletListMarker: '*',
        strongDelimiter: '__',
      })

      const html = '<ul><li>Item</li></ul><strong>Bold</strong>'
      const markdown = service.turndown(html)

      expect(markdown).toMatch(/\*\s+Item/)
      expect(markdown).toContain('__Bold__')
    })

    it('should use setext heading style when configured', () => {
      const service = createTurndownService({
        headingStyle: 'setext',
      })

      const html = '<h1>Title</h1><h2>Subtitle</h2>'
      const markdown = service.turndown(html)

      expect(markdown).toContain('Title\n=')
      expect(markdown).toContain('Subtitle\n-')
    })

    it('should use different fence characters', () => {
      const service = createTurndownService({
        fence: '~~~',
      })

      const html = '<pre><code>code</code></pre>'
      const markdown = service.turndown(html)

      expect(markdown).toContain('~~~')
    })
  })
})
