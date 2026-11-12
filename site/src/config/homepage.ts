import type { Product } from '../sidebar'
import { homepageProductGroups } from './navbar'

interface HomepageToolCopy {
  category: string
  title: string
  description: string
}

export interface HomepageTool extends HomepageToolCopy {
  product: Product
}

const toolCopy: Record<string, HomepageToolCopy> = {
  Box: {
    category: 'Agent sandbox',
    title: 'Contain the agent.',
    description: 'Isolate the agent and set policies for files, programs, network requests, and MCP tool calls.',
  },
  Decider: {
    category: 'Decision model',
    title: 'Make focused decisions.',
    description: 'Classify and route work with yes/no, choice, and score answers plus calibrated confidence.',
  },
  Evals: {
    category: 'Evaluation toolkit',
    title: 'Find failures before deployment.',
    description: 'Evaluate outputs and trajectories, diagnose failures, and simulate users and tools.',
  },
}

export const homepageTools: HomepageTool[] = homepageProductGroups.tools.map((product) => {
  const copy = toolCopy[product.label]
  if (!copy) throw new Error(`Missing homepage tool copy: ${product.label}`)
  return { product, ...copy }
})
