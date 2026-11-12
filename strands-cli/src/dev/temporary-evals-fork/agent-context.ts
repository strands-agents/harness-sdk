import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'

import type { ChatToolInfo } from '../../agent/types.js'
import type { DevWorkspace } from '../workspace.js'

export interface TemporaryAgentFacts {
  description?: string
  model?: string
  tools?: readonly ChatToolInfo[]
}

export interface TemporaryAgentContext {
  readonly text: string
  readonly summary: string
}

const SOURCE_LIMIT = 12_000
const NOTE_LIMIT = 4_000
const NOTE_COUNT = 4
const NOTE_EXTENSIONS = new Set(['.md', '.txt'])

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}\n[cut at ${limit} characters]` : text

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

const noteFiles = async (folders: readonly string[]): Promise<string[]> => {
  const found = await Promise.all(
    [...new Set(folders)].map(async (folder) => {
      try {
        const entries = await readdir(folder, { withFileTypes: true })
        return entries
          .filter((entry) => entry.isFile() && NOTE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
          .map((entry) => join(folder, entry.name))
      } catch {
        return []
      }
    })
  )
  return found.flat().sort().slice(0, NOTE_COUNT)
}

const toolSection = (tools: readonly ChatToolInfo[]): string | undefined =>
  tools.length > 0
    ? ['Its tools:', ...tools.map(({ name, description }) => `- ${name}: ${description || 'no description'}`)].join(
        '\n'
      )
    : undefined

const summaryOf = (workspace: DevWorkspace, tools: readonly ChatToolInfo[], notes: readonly string[]): string =>
  [
    relative(workspace.root, workspace.entrypoint),
    ...(tools.length > 0 ? [`${tools.length} tool${tools.length === 1 ? '' : 's'}`] : []),
    ...notes.map((path) => relative(workspace.root, path)),
  ].join(' · ')

export const temporaryAgentContext = async (
  workspace: DevWorkspace,
  facts: TemporaryAgentFacts
): Promise<TemporaryAgentContext> => {
  const source = await readText(workspace.entrypoint)
  const notes = await noteFiles([dirname(workspace.entrypoint), workspace.root])
  const tools = facts.tools ?? []
  const noteSections = await Promise.all(
    notes.map(async (path) => {
      const text = await readText(path)
      return text?.trim() ? `The file ${relative(workspace.root, path)}:\n${clip(text, NOTE_LIMIT)}` : undefined
    })
  )
  const text = [
    `This is an AI agent named ${workspace.config.name}.`,
    facts.description ? `Its description: ${facts.description}` : undefined,
    toolSection(tools),
    source
      ? `Its source file ${relative(workspace.root, workspace.entrypoint)}:\n${clip(source, SOURCE_LIMIT)}`
      : undefined,
    ...noteSections,
    'Write realistic requests that users send to this agent, and the outcome that a good answer reaches.',
  ]
    .filter((section): section is string => Boolean(section))
    .join('\n\n')
  return { text, summary: summaryOf(workspace, tools, notes) }
}
