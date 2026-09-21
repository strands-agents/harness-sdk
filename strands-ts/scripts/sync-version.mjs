// Rewrites src/version.ts from package.json so the compiled SDK reports the stamped release version.
// Runs as the `prebuild` npm script; a no-op when the file already matches.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const versionFile = join(packageRoot, 'src', 'version.ts')
const contents = `/**
 * Version of the \`@strands-agents/sdk\` package, as stamped from \`package.json\` by
 * \`scripts/sync-version.mjs\` (the \`prebuild\` npm script). Edit \`package.json\`, not this file.
 *
 * @internal
 */
export const SDK_VERSION = '${version}'
`
if (readFileSync(versionFile, 'utf8') !== contents) writeFileSync(versionFile, contents)
