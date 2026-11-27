import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { buildCatalogFeedJsonSchema } from '../src/util/catalog-feed'
import { buildOpenApiDocument } from '../src/util/openapi'

const ORIGIN = 'https://strandsagents.com'

type Operation = {
  operationId?: string
  description?: string
  parameters?: Array<{ schema?: { type?: string } }>
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>
}

function operations(document: ReturnType<typeof buildOpenApiDocument>): Operation[] {
  return Object.values(document.paths).flatMap((path) =>
    Object.entries(path)
      .filter(([method]) => ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(method))
      .map(([, operation]) => operation)
  )
}

describe('OpenAPI document', () => {
  const document = buildOpenApiDocument(ORIGIN, '/')

  it('describes the existing public integrations endpoint without inventing an execution API', () => {
    expect(document.openapi).toBe('3.1.1')
    expect(document.servers).toEqual([{ url: '/', description: 'Strands Agents documentation site' }])
    expect(document.externalDocs.url).toBe('/docs/')
    expect(Object.keys(document.paths)).toEqual(['/integrations.json'])
    expect(document.paths['/integrations.json'].get.security).toEqual([])
  })

  it('keeps preview descriptions on the preview origin and base path', () => {
    const previewDocument = buildOpenApiDocument(ORIGIN, '/pr-cms-123/')

    expect(previewDocument.servers).toEqual([{ url: '/pr-cms-123', description: 'Strands Agents documentation site' }])
    expect(previewDocument.externalDocs.url).toBe('/pr-cms-123/docs/')
  })

  it('keeps every operation self-describing and function-call compatible', () => {
    const allOperations = operations(document)
    const operationIds = allOperations.map((operation) => operation.operationId)

    expect(allOperations).toHaveLength(1)
    expect(operationIds).toEqual(['listIntegrations'])
    expect(new Set(operationIds).size).toBe(operationIds.length)

    for (const operation of allOperations) {
      expect(operation.description?.length).toBeGreaterThan(20)
      for (const parameter of operation.parameters ?? []) {
        expect(parameter.schema?.type).toBeTruthy()
      }
      for (const response of Object.values(operation.responses ?? {})) {
        expect(response.description?.length).toBeGreaterThan(0)
        for (const representation of Object.values(response.content ?? {})) {
          expect(representation.schema).toBeTruthy()
        }
      }
    }
  })

  it('derives the response schema from the published integrations JSON Schema', () => {
    const { $id: _id, $schema: _schema, ...catalogSchema } = buildCatalogFeedJsonSchema(ORIGIN)

    expect(document.components.schemas.IntegrationCatalog).toEqual(catalogSchema)
    expect(document.paths['/integrations.json'].get.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/IntegrationCatalog',
    })
  })
})

describe('OpenAPI output', () => {
  it('publishes valid JSON at the conventional discovery path', () => {
    const output = JSON.parse(readFileSync(new URL('../dist/openapi.json', import.meta.url), 'utf8'))

    expect(output).toEqual(buildOpenApiDocument(ORIGIN, '/'))
  })

  it('links the OpenAPI description and integrations feed from the Markdown homepage', () => {
    const homepage = readFileSync(new URL('../dist/index.md', import.meta.url), 'utf8')

    expect(homepage).toContain('/openapi.json')
    expect(homepage).toContain('/integrations.json')
  })
})
