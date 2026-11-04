import { readFileSync, readdirSync } from 'node:fs'

import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface WorkflowStep {
  env?: Record<string, unknown>
  if?: string
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

function findSamplesCheckout(workflow: Workflow, jobName: string): WorkflowStep | undefined {
  return workflow.jobs?.[jobName]?.steps?.find(
    (step) => step.uses?.startsWith('actions/checkout@') && step.with?.repository === 'strands-agents/samples'
  )
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
    const externalDocsRecordIndexes = steps.flatMap((step, index) =>
      step.run?.includes('products.map(({ id, revision })') ? [index] : []
    )
    const summaryIndexes = steps.flatMap((step, index) =>
      step.run?.includes('Documentation snapshot:') ? [index] : []
    )
    const samplesResolveIndexes = steps.flatMap((step, index) =>
      step.run?.includes('samples-source" rev-parse HEAD') ? [index] : []
    )
    const samplesRecordIndexes = steps.flatMap((step, index) =>
      step.run?.includes('samples@${process.env.SAMPLES_REVISION}') ? [index] : []
    )
    const samplesCheckoutIndexes = steps.flatMap((step, index) =>
      step.uses?.startsWith('actions/checkout@') && step.with?.repository === 'strands-agents/samples' ? [index] : []
    )
    const buildIndex = steps.findIndex((step) => step.run?.includes('npm run cms:build'))
    const deployIndexes = steps.flatMap((step, index) =>
      step.run?.includes('git push origin HEAD:gh-pages') ? [index] : []
    )
    const workflowDispatch = workflow.on?.workflow_dispatch as
      | {
          inputs?: Record<string, { default?: unknown; options?: unknown[] }>
        }
      | undefined
    const docsCiSamplesRef = findSamplesCheckout(loadWorkflow('docs-ci.yml'), 'ci')?.with?.ref
    const externalSyncSamplesRef = findSamplesCheckout(loadWorkflow('docs-external-sync.yml'), 'sync')?.with?.ref
    const deploySamplesRef = steps[samplesCheckoutIndexes[0]]?.with?.ref

    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_dispatch'])
    expect(workflowDispatch?.inputs?.content_snapshot).toMatchObject({
      default: 'latest',
      options: ['latest', 'locked'],
    })
    expect(updateIndexes).toHaveLength(1)
    expect(steps[updateIndexes[0]].if).toContain("inputs.content_snapshot != 'locked'")
    expect(externalDocsRecordIndexes).toHaveLength(1)
    expect(summaryIndexes).toHaveLength(1)
    expect(samplesResolveIndexes).toHaveLength(1)
    expect(samplesRecordIndexes).toHaveLength(1)
    expect(samplesCheckoutIndexes).toHaveLength(1)
    expect(deployIndexes).toHaveLength(1)
    expect(docsCiSamplesRef).toMatch(/^[0-9a-f]{40}$/)
    expect(externalSyncSamplesRef).toBe(docsCiSamplesRef)
    expect(deploySamplesRef).toContain("inputs.content_snapshot == 'locked'")
    expect(deploySamplesRef).toContain(`'${docsCiSamplesRef}'`)
    expect(deploySamplesRef).toContain("'main'")
    expect(steps[deployIndexes[0]].env?.CONTENT_SNAPSHOT).toBe('${{ steps.content_snapshot.outputs.snapshot }}')
    expect(buildIndex).toBeGreaterThan(-1)
    expect(samplesCheckoutIndexes[0]).toBeLessThan(samplesResolveIndexes[0])
    expect(samplesResolveIndexes[0]).toBeLessThan(samplesRecordIndexes[0])
    expect(updateIndexes[0]).toBeLessThan(externalDocsRecordIndexes[0])
    expect(updateIndexes[0]).toBeLessThan(buildIndex)
    expect(externalDocsRecordIndexes[0]).toBeLessThan(buildIndex)
    expect(samplesResolveIndexes[0]).toBeLessThan(buildIndex)
    expect(samplesRecordIndexes[0]).toBeLessThan(buildIndex)
    expect(summaryIndexes[0]).toBeLessThan(buildIndex)
  })

  it('does not schedule docs workflows that resolve moving external refs', () => {
    const updaterWorkflows = readdirSync(workflowsDirectory)
      .filter((fileName) => fileName.startsWith('docs-') && fileName.endsWith('.yml'))
      .filter((fileName) =>
        readFileSync(new URL(fileName, workflowsDirectory), 'utf8').includes('external-docs:update-lock')
      )

    expect(updaterWorkflows.sort()).toEqual(['docs-deploy-github-pages.yml', 'docs-external-sync.yml'])
    for (const fileName of updaterWorkflows) {
      expect(loadWorkflow(fileName).on?.schedule, fileName).toBeUndefined()
    }
  })
})
