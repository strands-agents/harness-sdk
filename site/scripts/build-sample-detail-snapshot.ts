import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { format, resolveConfig } from 'prettier'

const DEFAULT_REF = '77ae4c2ae832155c515bbcb4d460f5f501aaa815'
const REPOSITORY = 'strands-agents/samples'
const SAMPLE_PATH = 'typescript/01-learn/01-first-agent'
const TEXT_FILES = ['package.json', 'src/firstAgent.ts', 'tsconfig.json'] as const
const MAX_FILE_BYTES = 256 * 1024

function getRef(): string {
  const argumentIndex = process.argv.indexOf('--ref')
  const ref = argumentIndex === -1 ? DEFAULT_REF : process.argv[argumentIndex + 1]

  if (!ref || !/^[0-9a-f]{40}$/.test(ref)) {
    throw new Error('Pass --ref with a full 40-character samples commit SHA.')
  }
  return ref
}

async function fetchText(ref: string, relativePath: string): Promise<string> {
  const encodedPath = `${SAMPLE_PATH}/${relativePath}`
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const url = `https://raw.githubusercontent.com/${REPOSITORY}/${ref}/${encodedPath}`
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to fetch ${relativePath}: ${response.status} ${response.statusText}`)
  }

  const content = await response.text()
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`${relativePath} exceeds the ${MAX_FILE_BYTES}-byte text limit`)
  }
  return content.replace(/\r\n/g, '\n')
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function main(): Promise<void> {
  const ref = getRef()
  const readme = await fetchText(ref, 'README.md')
  const files = await Promise.all(
    TEXT_FILES.map(async (relativePath) => {
      const content = await fetchText(ref, relativePath)
      return {
        path: relativePath,
        language: relativePath.endsWith('.ts') ? 'typescript' : 'json',
        content,
        sha256: sha256(content),
      }
    })
  )

  const snapshot = {
    schemaVersion: 1,
    samples: [
      {
        id: SAMPLE_PATH,
        slug: 'typescript/first-agent',
        source: {
          repository: REPOSITORY,
          commit: ref,
          path: SAMPLE_PATH,
        },
        metadata: {
          title: 'First Agent',
          summary: 'Create and run a minimal Strands agent with TypeScript and Amazon Bedrock.',
          language: 'TypeScript',
          category: 'Learn',
          tags: ['Agent', 'Amazon Bedrock'],
          prerequisites: ['Node.js 22 or later', 'AWS credentials', 'Amazon Bedrock model access'],
        },
        guide: {
          path: 'README.md',
          markdown: readme,
        },
        files,
      },
    ],
  }

  const destination = fileURLToPath(new URL('../src/data/sample-details.json', import.meta.url))
  const prettierConfig = (await resolveConfig(destination)) ?? {}
  const output = await format(JSON.stringify(snapshot), { ...prettierConfig, filepath: destination })
  await writeFile(destination, output)
  console.log(`Wrote ${destination} from ${REPOSITORY}@${ref}`)
}

await main()
