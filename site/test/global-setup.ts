import { execFileSync } from 'node:child_process'
import { readdirSync, realpathSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

const DATA_STORE_PATH = '.astro/data-store.json'
const TIMEOUT_MS = 120_000

// sync writes the store under cacheDir (getDataStoreFile in astro/dist/content/paths.js), so pointing
// cacheDir at .astro targets the path the tests read. Child process: getViteConfig aliases in-process
// 'astro' imports to a types-only stub.
const SYNC_SCRIPT = "const { sync } = await import('astro'); await sync({ cacheDir: './.astro' })"

// Everything the content-layer snapshot is derived from.
const CONTENT_SOURCES = ['src/content', 'src/content.config.ts', '.build/samples/pages']

// Follows symlinks (docs `_generated` dirs point into .build/api-docs); `visited` breaks cycles.
// Directory mtimes are included so a deleted file, which bumps only its parent dir, registers.
function newestMtime(path: string, visited: Set<string>): number {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.mtimeMs
  const resolved = realpathSync(path)
  if (visited.has(resolved)) return 0
  visited.add(resolved)
  let newest = stat.mtimeMs
  for (const entry of readdirSync(path)) {
    newest = Math.max(newest, newestMtime(join(path, entry), visited))
  }
  return newest
}

function storeHoldsCollections(): boolean {
  try {
    // A store this small cannot hold real collections; treat it as absent.
    return statSync(DATA_STORE_PATH).size > 100
  } catch {
    return false
  }
}

// getCollection() reads the snapshot in DATA_STORE_PATH, not the content
// files, so a stale snapshot silently tests against outdated entries.
function isDataStoreFresh(): boolean {
  if (!storeHoldsCollections()) return false
  const storeMtime = statSync(DATA_STORE_PATH).mtimeMs
  return CONTENT_SOURCES.every((source) => newestMtime(source, new Set()) <= storeMtime)
}

export function setup() {
  if (isDataStoreFresh()) return

  console.log('[global-setup] Data store missing or stale — running astro sync...')

  execFileSync('node', ['--input-type=module', '-e', SYNC_SCRIPT], { stdio: 'inherit', timeout: TIMEOUT_MS })
  if (!storeHoldsCollections()) throw new Error(`astro sync did not produce a usable ${DATA_STORE_PATH}`)
  // sync rewrites the store only when matched content changed, so mtime can't
  // confirm freshness here; a sync that exits 0 means the store is current.
  const now = new Date()
  utimesSync(DATA_STORE_PATH, now, now)

  console.log('[global-setup] Data store ready.')
}
