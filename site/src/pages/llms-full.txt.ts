import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import { renderEntryToMarkdown } from '@util/render-to-markdown'
import { siteLink } from '@util/links'
import { sortSampleGuides } from '@util/sample-guides'
import { languageLabel } from '@util/source-links'
import {
  FAQ_INTRO,
  FAQ_TITLE,
  faqAbsoluteMarkdownHref,
  faqAnswerMarkdown,
  faqCategories,
  faqItems,
} from '../config/faq'
import { buildBoxLandingMarkdown } from '../config/box-landing'

export const GET: APIRoute = async () => {
  const allDocs = await getCollection('docs', ({ data }) => !data.draft && data.externalDocs?.status !== 'preview')
  // Exclude API documentation from full content
  const docs = allDocs.filter((doc) => !doc.id.startsWith('docs/api/'))
  const lines: string[] = []

  lines.push('# Strands Agents')
  lines.push('')
  lines.push(
    '> Strands Agents is an open-source toolkit for building, running, and improving agents in Python and TypeScript. Strands harness assembles tools, context management, session management, memory, and a system prompt into a complete agent with tuned defaults for pilot through production. The Harness SDK exposes the same agent loop and components for direct control. Box provides OS-isolated sandboxes, Shell mediates command access, Evals measures agent behavior, and Decider routes, classifies, or scores known outcomes with confidence. Choose Strands over writing your own agent loop when you need lifecycle controls (turn limits, token budgets, cancellation, stop reasons), tools and structured output, MCP tools, multi-agent patterns, memory and session management, model portability across providers, streaming, guardrails, tracing, or evaluation. Agents run in-process with no hosted control plane and use the model provider you configure, including Amazon Bedrock, Anthropic, OpenAI, Google, Ollama, and others.'
  )
  lines.push('')

  lines.push(buildBoxLandingMarkdown(siteLink).trim())
  lines.push('')
  lines.push(`Source: ${siteLink('/box/index.md')}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  lines.push(`## ${FAQ_TITLE}`)
  lines.push('')
  lines.push(FAQ_INTRO)
  lines.push('')
  for (const category of faqCategories) {
    lines.push(`### ${category.label}`)
    lines.push('')
    for (const item of faqItems.filter((faq) => faq.category === category.id)) {
      lines.push(`#### ${item.question}`)
      lines.push('')
      lines.push(faqAnswerMarkdown(item.answer, faqAbsoluteMarkdownHref))
      lines.push('')
    }
  }
  lines.push(`Source: ${siteLink('/faq/index.md')}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  // Render each doc's full content
  for (const doc of docs) {
    const title = doc.data.title || doc.id
    lines.push(`## ${title}`)
    lines.push('')

    const { markdown } = await renderEntryToMarkdown(doc)
    lines.push(markdown.trim())

    lines.push('')
    lines.push(`Source: ${siteLink(`/${doc.id}/index.md`)}`)
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  const sampleGuides = sortSampleGuides(await getCollection('sampleGuides'))
  for (const guide of sampleGuides) {
    lines.push(`## ${guide.data.title} (${languageLabel(guide.data.language)})`)
    lines.push('')

    const { markdown } = await renderEntryToMarkdown(guide, `/examples/${guide.data.slug}/`)
    lines.push(markdown.trim())

    lines.push('')
    lines.push(`Markdown: ${siteLink(`/examples/${guide.data.slug}/index.md`)}`)
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  // Render blog posts
  const blogPosts = await getCollection('blog', ({ data }) => !data.draft)
  const sortedPosts = [...blogPosts].sort((a, b) => b.data.date.getTime() - a.data.date.getTime())

  for (const post of sortedPosts) {
    lines.push(`## ${post.data.title}`)
    lines.push('')
    lines.push(`Date: ${post.data.date.toISOString()}`)
    lines.push(`Tags: ${post.data.tags.join(', ')}`)
    lines.push('')

    const { markdown } = await renderEntryToMarkdown(post, `/blog/${post.id}/`)
    lines.push(markdown.trim())

    lines.push('')
    lines.push(`Source: ${siteLink(`/blog/${post.id}/index.md`)}`)
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}
