import type { Product } from '../sidebar'
import { products } from './navbar'

interface HomepageProject {
  product: Product
  description: string
  cta: string
  href: string
  markdownHref: string
}

function productFor(slug: string): Product {
  const product = products.find((candidate) => candidate.slug === slug)
  if (!product) throw new Error(`Missing homepage product: ${slug}`)
  return product
}

const harness = productFor('/harness')
const harnessSdk = productFor('/harness-sdk')
const box = productFor('/box')
const evals = productFor('/evals')
const decider = productFor('/decider')

export const homepageStartProjects: HomepageProject[] = [
  {
    product: harness,
    description:
      'Tools, memory, sessions, and context management come configured. Customize the parts your application needs.',
    cta: 'Explore Harness',
    href: harness.href,
    markdownHref: '/docs/user-guide/harness/index.md',
  },
  {
    product: harnessSdk,
    description:
      'Choose and wire the model, tools, memory, session management, and hooks for direct control of the agent loop.',
    cta: 'Build with the SDK',
    href: harnessSdk.href,
    markdownHref: '/docs/user-guide/sdk/quickstart/overview/index.md',
  },
]

export const homepageCapabilities: (HomepageProject & { action: string })[] = [
  {
    product: box,
    action: 'Sandbox agent work',
    description: 'Run agent work in a sandbox with explicit permissions.',
    cta: 'Use Strands Box',
    href: box.href,
    markdownHref: '/docs/user-guide/box/quickstart/index.md',
  },
  {
    product: evals,
    action: 'Validate agent behavior',
    description: 'Test agent behavior and find failures before you ship.',
    cta: 'Run an evaluation',
    href: evals.href,
    markdownHref: '/docs/user-guide/evals-sdk/index.md',
  },
  {
    product: decider,
    action: 'Make fast decisions',
    description: 'Use a small, fast System One model to route requests, classify inputs, and score outcomes.',
    cta: 'Try Decider',
    href: decider.href,
    markdownHref: '/docs/labs/strands-decider/overview/index.md',
  },
]
