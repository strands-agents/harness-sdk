import { access, readFile } from 'node:fs/promises'
import { URL, fileURLToPath } from 'node:url'
import ts from 'typescript'

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js') || !context.parentURL) {
      throw error
    }
    for (const extension of ['.ts', '.tsx']) {
      const sourceUrl = new URL(specifier.replace(/\.js$/, extension), context.parentURL)
      try {
        await access(sourceUrl)
        return { url: sourceUrl.href, shortCircuit: true }
      } catch {
        // Try the next TypeScript source extension.
      }
    }
    throw error
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts') && !url.endsWith('.tsx')) {
    return nextLoad(url, context)
  }
  const source = await readFile(new URL(url), 'utf8')
  const result = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
    },
  })
  return { format: 'module', source: result.outputText, shortCircuit: true }
}
