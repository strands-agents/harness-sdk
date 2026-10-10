/**
 * Build-time symbol-level pairing between the Python and TypeScript API
 * reference trees, used by the language toggle to deep-link between them.
 *
 * The two trees are URL'd on different schemes — Python pages are module
 * paths (`docs/api/python/strands.models.bedrock`) while TypeScript pages are
 * symbol names (`docs/api/typescript/BedrockModel`) — so slugs never match.
 * They do share symbol names, though: per the cross-SDK parity conventions,
 * a class documented in both SDKs has the same PascalCase identifier. The
 * Python generator emits an `<a id="{module}.{Symbol}">` anchor for every
 * top-level symbol a module page documents, and each TypeScript page is named
 * by its symbol, so joining on symbol name recovers the pairing.
 *
 * The result maps doc-collection ids to switch targets (paths with a trailing
 * slash, optionally with a `#anchor`):
 *   - Python page -> the TypeScript page of a symbol it documents
 *   - TypeScript page -> the Python module page, anchored at the symbol
 * Pages whose symbols exist in only one SDK are absent from the map and fall
 * back to the section index in getLanguageSwitchTarget.
 */

const PY_PREFIX = 'docs/api/python/'
const TS_PREFIX = 'docs/api/typescript/'

export interface ApiDocEntry {
  id: string
  body?: string
}

/**
 * Whether a PascalCase symbol is the natural name for a snake_case module
 * segment. Compared case-insensitively with underscores stripped so acronym
 * casing still matches (`conversation_manager` ~ `ConversationManager`,
 * `a2a_agent` ~ `A2AAgent`).
 */
function symbolMatchesSegment(symbol: string, segment: string): boolean {
  return symbol.toLowerCase() === segment.replace(/_/g, '').toLowerCase()
}

/** Escape every regex metacharacter so the string matches literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Top-level symbols documented by a Python module page, in document order. */
function extractPythonSymbols(moduleName: string, body: string): string[] {
  // Match anchors exactly one level below the module (members like
  // `module.Class.method` have a further dot and are excluded).
  const escaped = escapeRegExp(moduleName)
  const anchorRe = new RegExp(`<a id="${escaped}\\.([A-Za-z_][A-Za-z0-9_]*)"`, 'g')
  const seen = new Set<string>()
  const symbols: string[] = []
  for (const match of body.matchAll(anchorRe)) {
    const symbol = match[1]
    if (symbol && !seen.has(symbol)) {
      seen.add(symbol)
      symbols.push(symbol)
    }
  }
  return symbols
}

/**
 * Build the bidirectional counterpart map from the docs content collection.
 *
 * @param entries - Doc entries; only `docs/api/{python,typescript}/` ids are used
 * @returns Map from doc id to counterpart target (`/`-less slug + trailing slash + optional #anchor)
 */
export function buildApiCounterpartMap(entries: readonly ApiDocEntry[]): Map<string, string> {
  const tsSymbols = new Set<string>()
  for (const entry of entries) {
    // The trailing slash in the prefix excludes the section index page itself
    if (entry.id.startsWith(TS_PREFIX)) {
      tsSymbols.add(entry.id.slice(TS_PREFIX.length))
    }
  }

  const map = new Map<string, string>()
  // Symbol -> Python pages documenting it (to resolve TS pages, preferring an
  // unambiguous home for symbols that appear in several modules)
  const symbolToPyPages = new Map<string, string[]>()

  for (const entry of entries) {
    if (!entry.id.startsWith(PY_PREFIX) || !entry.body) continue
    const moduleName = entry.id.slice(PY_PREFIX.length)
    if (!moduleName) continue

    const symbols = extractPythonSymbols(moduleName, entry.body)
    for (const symbol of symbols) {
      const pages = symbolToPyPages.get(symbol)
      if (pages) pages.push(entry.id)
      else symbolToPyPages.set(symbol, [entry.id])
    }

    const matches = symbols.filter((symbol) => tsSymbols.has(symbol))
    if (matches.length === 0) continue
    // A module usually documents one primary class named after itself
    // (`conversation_manager` -> ConversationManager); prefer it when several
    // symbols match, otherwise take the first documented match.
    const lastSegment = moduleName.split('.').pop() ?? ''
    const primary = matches.find((symbol) => symbolMatchesSegment(symbol, lastSegment)) ?? matches[0]
    map.set(entry.id, `/${TS_PREFIX}${primary}/`)
  }

  for (const symbol of tsSymbols) {
    const pages = symbolToPyPages.get(symbol)
    if (!pages || pages.length === 0) continue
    // Symbols shared by several modules: prefer the stable module, then the
    // shortest path, then alphabetical — deterministic and biased toward the
    // page a reader most likely wants.
    const best = [...pages].sort(
      (a, b) =>
        Number(a.includes('.experimental.')) - Number(b.includes('.experimental.')) ||
        a.length - b.length ||
        a.localeCompare(b)
    )[0]!
    const moduleName = best.slice(PY_PREFIX.length)
    map.set(`${TS_PREFIX}${symbol}`, `/${best}/#${moduleName}.${symbol}`)
  }

  return map
}

let cachedMap: Map<string, string> | undefined

/**
 * Memoized accessor for component use: the collection is stable within a
 * build, and LanguageToggle renders on every page (twice — desktop + mobile
 * header), so building the map per render would repeat the same regex work
 * over every Python page body ~2x per page across the whole static build.
 *
 * The cache ignores `entries` after the first call, so in `astro dev` the map
 * is stale until server restart if generated API pages change. Acceptable:
 * the map only changes when the SDK docs are regenerated, which requires a
 * restart anyway.
 */
export function getApiCounterpartMap(entries: readonly ApiDocEntry[]): Map<string, string> {
  cachedMap ??= buildApiCounterpartMap(entries)
  return cachedMap
}
