import { existsSync, readFileSync, readdirSync } from 'node:fs'

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

describe('external docs workflows', () => {
  it('resolves the configured main refs during every site build', () => {
    const packageJson = JSON.parse(readFileSync(new URL('site/package.json', repositoryRoot), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const config = JSON.parse(readFileSync(new URL('site/external-docs.config.json', repositoryRoot), 'utf8')) as {
      products?: Array<{ id?: string; ref?: string }>
    }

    expect(packageJson.scripts?.prebuild).toContain('external-docs:generate')
    expect(packageJson.scripts?.predev).toContain('external-docs:generate')
    expect(packageJson.scripts?.['external-docs:update-lock']).toBeUndefined()
    expect(existsSync(new URL('site/external-docs.lock.json', repositoryRoot))).toBe(false)
    expect(config.products?.map(({ id, ref }) => ({ id, ref }))).toEqual([
      { id: 'strands-box', ref: 'main' },
      { id: 'strands-decider', ref: 'main' },
    ])
  })

  it('records the external revisions resolved by the production build', () => {
    const workflow = loadWorkflow('docs-deploy-github-pages.yml')
    const steps = workflow.jobs?.deploy?.steps ?? []
    const externalDocsRecordIndexes = steps.flatMap((step, index) =>
      step.run?.includes('.build/external-docs/${id}/navigation.json') ? [index] : []
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
          inputs?: Record<string, { default?: unknown; type?: unknown }>
        }
      | undefined
    const deploySamplesRef = steps[samplesCheckoutIndexes[0]]?.with?.ref

    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_dispatch'])
    expect(workflowDispatch?.inputs?.content_snapshot).toBeUndefined()
    expect(workflowDispatch?.inputs?.external_docs_ref_overrides).toMatchObject({
      default: '',
      type: 'string',
    })
    expect(externalDocsRecordIndexes).toHaveLength(1)
    expect(summaryIndexes).toHaveLength(1)
    expect(samplesResolveIndexes).toHaveLength(1)
    expect(samplesRecordIndexes).toHaveLength(1)
    expect(samplesCheckoutIndexes).toHaveLength(1)
    expect(deployIndexes).toHaveLength(1)
    expect(deploySamplesRef).toBe('main')
    expect(steps[buildIndex]?.env?.EXTERNAL_DOCS_REF_OVERRIDES).toBe('${{ inputs.external_docs_ref_overrides }}')
    expect(steps[deployIndexes[0]].env?.CONTENT_SNAPSHOT).toBe('${{ steps.content_snapshot.outputs.snapshot }}')
    expect(buildIndex).toBeGreaterThan(-1)
    expect(samplesCheckoutIndexes[0]).toBeLessThan(samplesResolveIndexes[0])
    expect(samplesResolveIndexes[0]).toBeLessThan(samplesRecordIndexes[0])
    expect(samplesResolveIndexes[0]).toBeLessThan(buildIndex)
    expect(buildIndex).toBeLessThan(externalDocsRecordIndexes[0])
    expect(samplesRecordIndexes[0]).toBe(externalDocsRecordIndexes[0])
    expect(summaryIndexes[0]).toBe(externalDocsRecordIndexes[0])
    expect(externalDocsRecordIndexes[0]).toBeLessThan(deployIndexes[0])
  })

  it('uses Samples main in every docs workflow checkout', () => {
    const samplesRefs = readdirSync(workflowsDirectory)
      .filter((fileName) => fileName.startsWith('docs-') && fileName.endsWith('.yml'))
      .sort()
      .flatMap((fileName) =>
        Object.values(loadWorkflow(fileName).jobs ?? {}).flatMap((job) =>
          (job.steps ?? [])
            .filter(
              (step) => step.uses?.startsWith('actions/checkout@') && step.with?.repository === 'strands-agents/samples'
            )
            .map((step) => ({ fileName, ref: step.with?.ref }))
        )
      )

    expect(samplesRefs).toEqual([
      { fileName: 'docs-ci.yml', ref: 'main' },
      { fileName: 'docs-deploy-github-pages.yml', ref: 'main' },
      { fileName: 'docs-deploy-preview.yml', ref: 'main' },
    ])
  })

  it('does not retain an external docs lock workflow', () => {
    const docsWorkflows = readdirSync(workflowsDirectory).filter(
      (fileName) => fileName.startsWith('docs-') && fileName.endsWith('.yml')
    )

    expect(docsWorkflows).not.toContain('docs-external-sync.yml')
    for (const fileName of docsWorkflows) {
      const source = readFileSync(new URL(fileName, workflowsDirectory), 'utf8')
      expect(source, fileName).not.toContain('external-docs:update-lock')
      expect(source, fileName).not.toContain('external-docs.lock.json')
    }
  })
})
