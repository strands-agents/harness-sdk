// Report cognitive complexity for TypeScript functions, via the complexijs
// wasm engine. Same conventions as complexipy on the Python side: names are
// qualified as Class::method and nested functions fold into their parent.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { toRepoRelative } from './classify.mjs'

export function loadEngine(toolsDir) {
  const requireFromTools = createRequire(path.join(toolsDir, 'package.json'))
  return requireFromTools('eslint-plugin-complexijs/wasm/complexijs.js')
}

/**
 * Per-function records for the given files. A file the engine cannot parse
 * contributes nothing, so its functions read as absent rather than zero.
 */
export function analyzeTypescriptFiles(engine, files, repoRoot, warn = (m) => console.error(m)) {
  const functions = []
  for (const file of files) {
    let result
    try {
      result = engine.analyze(fs.readFileSync(file, 'utf8'), file, false, false)
    } catch {
      warn(`warning: complexijs could not parse ${file}; its functions are not scored`)
      continue
    }
    const relative = toRepoRelative(file, repoRoot)
    for (const fn of result.functions) {
      functions.push({
        file: relative,
        name: String(fn.name),
        complexity: Number(fn.complexity),
        startLine: Number(fn.line_start),
        endLine: Number(fn.line_end),
      })
    }
  }
  return functions
}
