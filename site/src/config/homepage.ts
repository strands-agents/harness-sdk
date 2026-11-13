import type { Product } from '../sidebar'
import { products } from './navbar'

interface HomepageProject {
  product: Product
  marker: string
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
    marker: 'Production-ready defaults',
    description:
      'Take a complete agent from pilot to production with tuned defaults. Replace individual components as your needs grow.',
    cta: 'Build with Harness',
    href: harness.href,
    markdownHref: '/docs/user-guide/harness/index.md',
  },
  {
    product: harnessSdk,
    marker: 'Build from primitives',
    description:
      'Choose and wire the model, tools, memory, session management, and hooks for direct control of the agent loop.',
    cta: 'Build with the SDK',
    href: harnessSdk.href,
    markdownHref: '/docs/user-guide/sdk/quickstart/overview/index.md',
  },
]

export const homepageCapabilities: HomepageProject[] = [
  {
    product: box,
    marker: 'Isolate',
    description: 'Run agent work in OS-isolated sandboxes with explicit filesystem, network, and policy controls.',
    cta: 'Use Strands Box',
    href: box.href,
    markdownHref: '/docs/user-guide/box/quickstart/index.md',
  },
  {
    product: evals,
    marker: 'Evaluate',
    description: 'Run evaluation experiments, detect failures, and measure agent resilience before deployment.',
    cta: 'Run an evaluation',
    href: evals.href,
    markdownHref: '/docs/user-guide/evals-sdk/index.md',
  },
  {
    product: decider,
    marker: 'Decide',
    description: 'Route, classify, or score known outcomes with a small decision model that reports confidence.',
    cta: 'Try Decider',
    href: decider.href,
    markdownHref: '/docs/labs/strands-decider/overview/index.md',
  },
]
