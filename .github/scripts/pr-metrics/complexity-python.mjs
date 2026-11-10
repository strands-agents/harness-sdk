// Report cognitive complexity for Python functions, via complexipy.
//
// complexipy's JSON output omits line numbers, so we read its SARIF output
// instead: that carries the `startLine`/`endLine` range each function spans,
// which is what diff scoping needs.

import { toRepoRelative } from './classify.mjs'

// "Function 'x' has a cognitive complexity of 37, which exceeds ..."
const COMPLEXITY_RE = /cognitive complexity of (\d+)/

export function parseSarif(sarif, repoRoot) {
  const results = sarif?.runs?.[0]?.results ?? []
  const functions = []

  for (const result of results) {
    const match = COMPLEXITY_RE.exec(result?.message?.text ?? '')
    if (!match) continue

    const location = result?.locations?.[0]?.physicalLocation
    const region = location?.region
    const uri = location?.artifactLocation?.uri
    if (!region?.startLine || !uri) continue

    functions.push({
      file: toRepoRelative(uri, repoRoot),
      name: result?.locations?.[0]?.logicalLocations?.[0]?.name ?? '<anonymous>',
      complexity: Number(match[1]),
      startLine: region.startLine,
      endLine: region.endLine ?? region.startLine,
    })
  }
  return functions
}
