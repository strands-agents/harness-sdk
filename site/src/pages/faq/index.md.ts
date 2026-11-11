import type { APIRoute } from 'astro'

import {
  FAQ_INTRO,
  FAQ_TITLE,
  faqAnswerMarkdown,
  faqCategories,
  faqItems,
  faqMarkdownHref,
  isExternalFaqHref,
} from '../../config/faq'
import { siteLink } from '../../util/links'

function markdownLink(href: string): string {
  if (isExternalFaqHref(href)) return href
  return siteLink(faqMarkdownHref(href))
}

export function buildFaqMarkdown(): string {
  const lines = [`# ${FAQ_TITLE}`, '', FAQ_INTRO, '']

  for (const category of faqCategories) {
    lines.push(`## ${category.label}`, '')
    for (const item of faqItems.filter((faq) => faq.category === category.id)) {
      lines.push(`### ${item.question}`, '', faqAnswerMarkdown(item.answer, markdownLink), '')
    }
  }

  return lines.join('\n')
}

export const GET: APIRoute = () => {
  return new Response(buildFaqMarkdown(), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  })
}
