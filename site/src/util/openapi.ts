import { buildCatalogFeedJsonSchema, CATALOG_FEED_PATH, CATALOG_FEED_SCHEMA_VERSION } from './catalog-feed'
import { pathWithBase } from './links'

function normalizeBasePath(basePath: string): string {
  const normalized = basePath.startsWith('/') ? basePath : `/${basePath}`
  return normalized === '/' ? normalized : normalized.replace(/\/$/, '')
}

function pathAtBase(basePath: string, path: string): string {
  return `${basePath === '/' ? '' : basePath}${path}`
}

export function buildOpenApiDocument(origin: string, basePath = pathWithBase('/')) {
  const { $id: _id, $schema: _schema, ...catalogFeedSchema } = buildCatalogFeedJsonSchema(origin)
  const apiServerUrl = normalizeBasePath(basePath)

  return {
    openapi: '3.1.1',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Strands Agents website API',
      version: `${CATALOG_FEED_SCHEMA_VERSION}.0.0`,
      description:
        'Read-only machine-readable data published by strandsagents.com. This API describes website resources, not a hosted agent inference service.',
      license: {
        name: 'Apache License 2.0',
        identifier: 'Apache-2.0',
      },
    },
    servers: [
      {
        url: apiServerUrl,
        description: 'Strands Agents documentation site',
      },
    ],
    externalDocs: {
      description: 'Strands Agents documentation',
      url: pathAtBase(apiServerUrl, '/docs/'),
    },
    tags: [
      {
        name: 'Integrations',
        description: 'Packages, guides, and extensions that work with Strands Agents.',
      },
    ],
    paths: {
      [CATALOG_FEED_PATH]: {
        get: {
          operationId: 'listIntegrations',
          summary: 'List Strands integrations',
          description:
            'Returns the complete public integrations catalog, including supported SDK languages, package registries, maintainers, source repositories, and documentation links.',
          tags: ['Integrations'],
          security: [],
          responses: {
            '200': {
              description: 'The current public integrations catalog.',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/IntegrationCatalog',
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        IntegrationCatalog: catalogFeedSchema,
      },
    },
  } as const
}
