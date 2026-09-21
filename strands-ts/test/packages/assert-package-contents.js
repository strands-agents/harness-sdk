// Regression guard for #3004: the published tarball must never ship test
// artifacts (`__tests__/`, `__fixtures__/`, `*.test.*`). Reads `npm pack
// --dry-run --json` on stdin and fails loudly — an empty, errored, or
// unparseable pack payload is treated as a failure, not a vacuous pass.

const chunks = []

process.stdin.setEncoding('utf8')

for await (const chunk of process.stdin) {
  chunks.push(chunk)
}

const raw = chunks.join('').trim()
if (!raw) {
  throw new Error('[package-contents] no pack output on stdin — prepack or `npm pack` likely failed')
}

let packOutput
try {
  packOutput = JSON.parse(raw)
} catch (error) {
  throw new Error(`[package-contents] could not parse pack output as JSON: ${error.message}\n${raw.slice(0, 500)}`)
}

// `npm pack` prints `{"error":{...}}` and exits non-zero when a lifecycle
// script (e.g. prepack's build) fails; a pipe would otherwise swallow that.
if (packOutput?.error) {
  throw new Error(`[package-contents] npm pack reported an error: ${JSON.stringify(packOutput.error)}`)
}

const files = (Array.isArray(packOutput) ? packOutput[0]?.files : undefined)?.map((file) => file.path)
if (!files || files.length === 0) {
  throw new Error('[package-contents] pack produced no file list — refusing to pass on an empty payload')
}

// These mirror the `!dist/**` negations in package.json's `files` array — keep
// the two lists in sync (adding e.g. `!dist/**/__mocks__` means adding it here).
const forbiddenPatterns = [
  /(^|\/)__tests__(\/|$)/,
  /(^|\/)__fixtures__(\/|$)/,
  /\.test\./,
]

const forbiddenFiles = files.filter((file) => forbiddenPatterns.some((pattern) => pattern.test(file)))

if (forbiddenFiles.length > 0) {
  throw new Error(`Published package includes test artifacts:\n${forbiddenFiles.slice(0, 20).join('\n')}`)
}

console.log(`[package-contents] OK (${files.length} files)`)

for (const module of ['index', 'mock-message-model', 'test-model-provider', 'types']) {
  for (const extension of ['js', 'd.ts']) {
    const path = `dist/src/testing/${module}.${extension}`
    if (!files.includes(path)) {
      throw new Error(`Published package is missing a public testing module: ${path}`)
    }
  }
}
