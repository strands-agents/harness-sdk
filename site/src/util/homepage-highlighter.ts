import { createShikiHighlighter, type CreateShikiHighlighterOptions } from '@astrojs/markdown-remark/shiki'

const dogwoodLanguage: NonNullable<CreateShikiHighlighterOptions['langs']>[number] = {
  name: 'dogwood',
  scopeName: 'source.dogwood',
  repository: {},
  patterns: [
    {
      name: 'comment.line.double-slash.dogwood',
      begin: '//',
      end: '$',
    },
    {
      name: 'meta.annotation.dogwood',
      match: '@[A-Za-z_][A-Za-z0-9_]*',
    },
    {
      name: 'keyword.control.dogwood',
      match: '\\b(?:permit|forbid|when)\\b',
    },
    {
      name: 'support.type.dogwood',
      match: '\\bBox(?=::)',
    },
    {
      name: 'string.quoted.double.dogwood',
      begin: '"',
      end: '"',
      patterns: [
        {
          name: 'constant.character.escape.dogwood',
          match: '\\\\.',
        },
      ],
    },
  ],
}

const highlighter = createShikiHighlighter({
  langs: [dogwoodLanguage],
  themes: {
    light: 'github-light-high-contrast',
    dark: 'github-dark-high-contrast',
  },
})

export async function highlightHomepageCode(code: string, language: string): Promise<string> {
  return (await highlighter).codeToHtml(code, language, {
    defaultColor: false,
    attributes: { class: 'homepage-code-example__highlighted-code' },
  })
}
