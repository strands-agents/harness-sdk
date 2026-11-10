/**
 * Auto-import plugin for Astro MDX files.
 *
 * Source: https://github.com/zastrowm/astro-auto-import/blob/mdx_exported_components/packages/astro-auto-import/src/index.ts
 * Original: https://github.com/delucis/astro-auto-import
 * License: MIT
 */

import { parse as parseJs } from 'acorn'
import type { AstroIntegration } from 'astro'
import type { MdxjsEsm } from 'mdast-util-mdx'
import { parse, resolve } from 'node:path'
import type { VFile } from 'vfile'

const resolveModulePath = (path: string) => {
  // Resolve relative paths
  if (path.startsWith('.')) return resolve(path)
  // Don’t resolve other paths (e.g. npm modules)
  return path
}

type NamedImportConfig = string | [from: string, as: string]
type ImportsConfig = (string | Record<string, string | NamedImportConfig[]>)[]

/** Config for a named export from a module */
interface NamedExportConfig {
  name: string
  from: string
}

/** Map of element names to component paths or named export configs */
type DefaultComponentsConfig = Record<string, string | NamedExportConfig>

interface AutoImportConfig {
  imports?: ImportsConfig
  defaultComponents?: DefaultComponentsConfig
}

/**
 * Use a filename to generate a default import name.
 * @example
 * getDefaultImportName('/path/to/cool-component.astro');
 * // => coolcomponent
 */
function getDefaultImportName(path: string): string {
  return parse(path).name.replaceAll(/[^\w\d]/g, '')
}

/**
 * Create an import statement.
 * @param imported Stuff to import (e.g. `Thing` or `{ Named }`)
 * @param module Module to import from (e.g. `module-thing`)
 */
function formatImport(imported: string, module: string): string {
  return `import ${imported} from ${JSON.stringify(module)};`
}

/** Get the parts for a named import statement from config. */
function formatNamedImports(namedImport: NamedImportConfig[]): string {
  const imports: string[] = []
  for (const imp of namedImport) {
    if (typeof imp === 'string') {
      imports.push(imp)
    } else {
      const [from, as] = imp
      imports.push(`${from} as ${as}`)
    }
  }
  return `{ ${imports.join(', ')} }`
}

/** Generate imports from a full imports config array. */
function processImportsConfig(config: ImportsConfig) {
  const imports = []
  for (const option of config) {
    if (typeof option === 'string') {
      imports.push(formatImport(getDefaultImportName(option), resolveModulePath(option)))
    } else {
      for (const path in option) {
        const namedImportsOrNamespace = option[path]
        if (typeof namedImportsOrNamespace === 'string') {
          imports.push(formatImport(`* as ${namedImportsOrNamespace}`, resolveModulePath(path)))
        } else {
          const importString = formatNamedImports(namedImportsOrNamespace!)
          imports.push(formatImport(importString, resolveModulePath(path)))
        }
      }
    }
  }
  return imports
}

/** Prefix used for default component imports to avoid name clashes */
const DEFAULT_COMPONENT_PREFIX = 'AUTO_IMPORT_'

/** Generate imports and export statement for default components config. */
function processDefaultComponentsConfig(config: DefaultComponentsConfig) {
  const imports: string[] = []
  const componentEntries: string[] = []

  for (const elementName in config) {
    const componentConfig = config[elementName]
    const importName = `${DEFAULT_COMPONENT_PREFIX}${elementName}`

    if (typeof componentConfig === 'string') {
      // Default export: import AUTO_IMPORT_p from './src/CustomParagraph.astro';
      imports.push(formatImport(importName, resolveModulePath(componentConfig)))
    } else {
      // Named export: import { CustomBlockquote as AUTO_IMPORT_blockquote } from './src/Components.ts';
      imports.push(
        formatImport(`{ ${componentConfig!.name} as ${importName} }`, resolveModulePath(componentConfig!.from))
      )
    }

    componentEntries.push(`${elementName}: ${importName}`)
  }

  // Generate: export const components = { p: AUTO_IMPORT_p, blockquote: AUTO_IMPORT_blockquote };
  const exportStatement = `export const components = { ${componentEntries.join(', ')} };`

  return { imports, exportStatement }
}

/** Get an MDX node representing a block of JS (imports and/or exports) based on user config. */
function generateMdxEsmNode(js: string): MdxjsEsm {
  return {
    type: 'mdxjsEsm',
    value: '',
    data: {
      estree: {
        // @ts-expect-error - Latest `acorn` types don’t align with MDX types.
        body: [],
        ...parseJs(js, { ecmaVersion: 'latest', sourceType: 'module' }),
        type: 'Program',
        sourceType: 'module',
      },
    },
  }
}

/** Get an MDX node representing a block of imports based on user config. */
function generateImportsNode(config: ImportsConfig): MdxjsEsm {
  const imports = processImportsConfig(config)
  const js = imports.join('\n')
  return generateMdxEsmNode(js)
}

/** Get an MDX node representing imports and export for default components. */
function generateDefaultComponentsNode(config: DefaultComponentsConfig): MdxjsEsm {
  const { imports, exportStatement } = processDefaultComponentsConfig(config)
  const js = [...imports, exportStatement].join('\n')
  return generateMdxEsmNode(js)
}

/** Check if the tree already has an `export const components` or `export { components }` */
function hasComponentsExport(tree: { children: any[] }): boolean {
  for (const node of tree.children) {
    if (node.type !== 'mdxjsEsm') continue
    const estree = node.data?.estree
    if (!estree?.body) continue

    for (const statement of estree.body) {
      // Check for: export const components = ...
      if (statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'VariableDeclaration') {
        for (const decl of statement.declaration.declarations) {
          if (decl.id?.name === 'components') {
            return true
          }
        }
      }
      // Check for: export { components } or export { something as components }
      if (statement.type === 'ExportNamedDeclaration' && statement.specifiers) {
        for (const spec of statement.specifiers) {
          if (spec.exported?.name === 'components') {
            return true
          }
        }
      }
    }
  }
  return false
}

export default function AutoImport(integrationConfig: AutoImportConfig): AstroIntegration {
  return {
    name: 'auto-import',
    hooks: {
      'astro:config:setup': ({ config, updateConfig }) => {
        // Check MDX integration is initialized after auto-import.
        const mdxIndex = config.integrations.findIndex((i) => i.name === '@astrojs/mdx')
        const thisIndex = config.integrations.findIndex((i) => i.name === 'auto-import')
        if (mdxIndex >= 0 && mdxIndex < thisIndex) {
          console.warn(
            '[auto-import] ⚠️ @astrojs/mdx initialized BEFORE astro-auto-import.\n' +
              '              Auto imports in .mdx files won’t work!\n' +
              '              Move the MDX integration after auto-import in your integrations array in astro.config.'
          )
        }

        // Skip adding MDX plug-in if MDX is not being used.
        if (mdxIndex === -1) return

        // Pre-generate nodes
        const importsNode = integrationConfig.imports ? generateImportsNode(integrationConfig.imports) : null
        const defaultComponentsNode = integrationConfig.defaultComponents
          ? generateDefaultComponentsNode(integrationConfig.defaultComponents)
          : null

        // Skip if nothing to inject
        if (!importsNode && !defaultComponentsNode) return

        // Add a remark plugin to inject imports into `.mdx`.
        updateConfig({
          markdown: {
            remarkPlugins: [
              function rehypeInjectMdxImports() {
                return function injectMdxImports(tree: { children: any[] }, vfile: VFile) {
                  if (vfile.basename?.endsWith('.md')) return

                  const nodesToInject: MdxjsEsm[] = []

                  if (importsNode) {
                    nodesToInject.push(importsNode)
                  }

                  // Only inject defaultComponents if the file doesn't already export components
                  if (defaultComponentsNode && !hasComponentsExport(tree)) {
                    nodesToInject.push(defaultComponentsNode)
                  }

                  if (nodesToInject.length > 0) {
                    tree.children.unshift(...nodesToInject)
                  }
                }
              },
            ],
          },
        })
      },
    },
  }
}
