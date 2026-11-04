import { readFileSync, readdirSync } from 'node:fs'

import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface WorkflowStep {
  uses?: string
  with?: Record<string, unknown>
  run?: string
}

interface Workflow {
  on?: Record<string, unknown>
  jobs?: Record<string, { steps?: WorkflowStep[] }>
}

const repositoryRoot = new URL('../../../', import.meta.url)
const workflowsDirectory = new URL('.github/workflows/', repositoryRoot)

function loadWorkflow(fileName: string): Workflow {
  const source = readFileSync(new URL(fileName, workflowsDirectory), 'utf8')
  return yaml.load(source) as Workflow
}

describe('external docs workflows', () => {
  it('keeps ordinary site builds pinned to the committed lock', () => {
    const packageJson = JSON.parse(readFileSync(new URL('site/package.json', repositoryRoot), 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.prebuild).not.toContain('external-docs:update-lock')
  })

  it('resolves production inputs once and builds from immutable revisions', () => {
    const workflow = loadWorkflow('docs-deploy-github-pages.yml')
    const steps = workflow.jobs?.deploy?.steps ?? []
    const updateIndexes = steps.flatMap((step, index) =>
      step.run?.includes('npm run external-docs:update-lock') ? [index] : []
    )
    const samplesResolveIndexes = steps.flatMap((step, index) =>
      step.run?.includes('samples-source" rev-parse HEAD') ? [index] : []
    )
    const samplesCheckoutIndexes = steps.flatMap((step, index) =>
      step.uses?.startsWith('actions/checkout@') && step.with?.repository === 'strands-agents/samples' ? [index] : []
    )
    const buildIndex = steps.findIndex((step) => step.run?.includes('npm run cms:build'))

    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_dispatch'])
    expect(updateIndexes).toHaveLength(1)
    expect(samplesResolveIndexes).toEqual(updateIndexes)
    expect(samplesCheckoutIndexes).toHaveLength(1)
    expect(steps[samplesCheckoutIndexes[0]].with?.ref).toBe('main')
    expect(samplesCheckoutIndexes[0]).toBeLessThan(updateIndexes[0])
    expect(updateIndexes[0]).toBe(buildIndex - 1)
  })

  it('does not schedule any workflow that resolves moving external refs', () => {
    const updaterWorkflows = readdirSync(workflowsDirectory)
      .filter((fileName) => fileName.endsWith('.yml'))
      .filter((fileName) =>
        readFileSync(new URL(fileName, workflowsDirectory), 'utf8').includes('external-docs:update-lock')
      )

    expect(updaterWorkflows.sort()).toEqual(['docs-deploy-github-pages.yml', 'docs-external-sync.yml'])
    for (const fileName of updaterWorkflows) {
      expect(loadWorkflow(fileName).on?.schedule, fileName).toBeUndefined()
    }
  })
})
