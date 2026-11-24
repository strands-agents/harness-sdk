import { Skill } from '@strands-agents/sdk/vended-plugins/skills'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { savedSessionCount } from '../../session/sessions.js'
import { STRANDS_EVALS_LABEL } from '../evals-package.js'
import { devSessionsFolder } from '../runtime.js'
import type { DevWorkspace } from '../workspace.js'
import type { TemporaryAgentFacts } from './host.js'
import { installedEvalsSkill, prepareTemporaryOptimizerEnvironment } from './environment.js'
import { temporaryWorkspaceDirectory } from './evals-process.js'
import { temporaryExperimentFile } from './layout.js'

const SKILL_NAME = 'session-converter'
const CACHE_FOLDER = '__pycache__'
const TYPESCRIPT_EVALUATORS =
  'Evaluators: strands dev runs this TypeScript agent in its own runner, which records the answer but no trace. ' +
  'Use only evaluators that score the answer, such as OutputEvaluator.'

/** An experiment that is made from the chats with nobody to ask. */
export interface UnattendedConversion {
  /** The name of the experiment to save. */
  readonly name: string
  /** The fewest cases that are worth an experiment. */
  readonly fewestCases: number
}

export interface TemporarySessionHistory {
  pastChats(): Promise<number>
  converter(): Promise<string>
  /** The skill with the rules for an agent that converts the chats on its own, away from the developer's chat. */
  unattendedConverter(conversion: UnattendedConversion): Promise<string>
}

export interface TemporarySessionHistoryOptions {
  readonly workspace: DevWorkspace
  readonly agent: () => TemporaryAgentFacts
  readonly python?: () => Promise<string>
  readonly skillFolder?: (python: string) => Promise<string>
}

const chatsFolder = ({ sessionDirectory }: TemporaryAgentFacts, workspaceDirectory: string): string =>
  sessionDirectory ?? devSessionsFolder(workspaceDirectory)

const skillFiles = async (folder: string): Promise<string[]> =>
  (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && !join(entry.parentPath, entry.name).split(sep).includes(CACHE_FOLDER))
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()

interface Guide {
  readonly folder: string
  readonly files: readonly string[]
  readonly python: string
  readonly workspaceDirectory: string
  readonly chats: string
  readonly currentChat: string | undefined
  readonly language: DevWorkspace['config']['language']
}

const evaluatorRules = ({ language }: Guide, tell: string): string[] =>
  language === 'typescript' ? [`${TYPESCRIPT_EVALUATORS}${tell}`] : []

const strandsDevRules = (guide: Guide): string[] => {
  const { python, workspaceDirectory, chats, currentChat } = guide
  return [
    `Past chats: the chats with this agent are Strands CLI sessions, and ${chats} is ` +
      'their <directory>. Use only them, unless the developer asks for other harnesses, traces, or files.' +
      (currentChat ? ` Skip ${currentChat}, which is this chat.` : ''),
    "Questions: ask the skill's questions one at a time, in plain words, without numbered options. " +
      'Skip a question that the chat already answered.',
    `Commands: run strands-evals as "${python}" -m strands_evals.cli, for example "${python}" -m strands_evals.cli ` +
      `validate <file>. Run the Python scripts of the skill with "${python}". That environment has strands-evals, ` +
      'and python3 on the PATH may not.',
    ...evaluatorRules(guide, ' When you leave out an evaluator that the skill suggests, tell the developer.'),
    'Cases: give every case a non-blank input and expected_assertion.',
    `File: save the experiment as ${temporaryExperimentFile(workspaceDirectory, '<name>')}. Use a short new ` +
      'name of letters, numbers, dots, dashes, and underscores, not <timestamp>_<uuid>. Never replace a file.',
    'Cost: reading the chats in step 3 uses the chat model, and synthesizing cases calls a Bedrock model about one ' +
      'time for each case. Before each, say what it reads or makes, and wait for a yes.',
    'Handoff: point to /experiment to review the cases and to run them, not to strands-evals run. ' +
      'For a smoke test, offer to run them.',
  ]
}

const unattendedRules = (guide: Guide, { name, fewestCases }: UnattendedConversion): string[] => {
  const { python, workspaceDirectory, chats } = guide
  return [
    `Past chats: the chats with this agent are Strands CLI sessions, and ${chats} is their <directory>. Use all of ` +
      'them and nothing else.',
    'Questions: ask none. Nobody reads what you write while you work, and nobody answers. Where the skill asks the ' +
      'developer, take its default, or the choice that keeps the most real requests of the chats.',
    `Commands: run strands-evals as "${python}" -m strands_evals.cli, for example "${python}" -m strands_evals.cli ` +
      `validate <file>. Run the Python scripts of the skill with "${python}". That environment has strands-evals, ` +
      'and python3 on the PATH may not.',
    ...evaluatorRules(guide, ' Replace any other that the skill suggests with the nearest of these.'),
    'Cases: give every case a non-blank input and expected_assertion.',
    `File: save the experiment as ${temporaryExperimentFile(workspaceDirectory, name)}, under exactly that name. ` +
      'Never replace a file, and change no other file of the workspace or of the agent.',
    'Cost: the developer turned this on and knows it is paid, so do not wait for a yes.',
    `End: validate the file. When the chats give fewer than ${fewestCases} cases, save no file. Then reply in one ` +
      'line with the number of cases, or with why there is no file. Start no evaluation and no optimization: strands ' +
      'dev does that with the file.',
  ]
}

const guideText = (guide: Guide, unattended?: UnattendedConversion): string => {
  const { folder, files } = guide
  return [
    `Follow the ${SKILL_NAME} skill below. It is the skill of ${STRANDS_EVALS_LABEL}, which strands dev ` +
      `installed in ${folder}. Its links, such as assets/segmenter.md, and <skill_dir> refer to that folder. ` +
      'strands dev runs the same version of strands-evals.',
    `Files:\n${files.map((file) => `  ${join(folder, ...file.split('/'))}`).join('\n')}`,
    [
      unattended
        ? 'You work for strands dev on your own, and these rules replace the matching parts of the skill:'
        : 'In this strands dev chat, these rules replace the matching parts of the skill:',
      ...(unattended ? unattendedRules(guide, unattended) : strandsDevRules(guide)),
    ].join('\n- '),
    Skill.fromFile(folder).instructions,
  ].join('\n\n')
}

export const temporarySessionHistory = ({
  workspace,
  agent,
  python,
  skillFolder = (interpreter): Promise<string> => installedEvalsSkill(interpreter, SKILL_NAME),
}: TemporarySessionHistoryOptions): TemporarySessionHistory => {
  const evalsPython = (workspaceDirectory: string): Promise<string> =>
    python?.() ??
    prepareTemporaryOptimizerEnvironment({
      workspaceDirectory,
      projectRoot: workspace.root,
      language: workspace.config.language,
    })
  const guide = async (unattended?: UnattendedConversion): Promise<string> => {
    const workspaceDirectory = temporaryWorkspaceDirectory(workspace)
    const interpreter = await evalsPython(workspaceDirectory)
    const folder = await skillFolder(interpreter)
    const facts = agent()
    return guideText(
      {
        folder,
        files: await skillFiles(folder),
        python: interpreter,
        workspaceDirectory,
        chats: chatsFolder(facts, workspaceDirectory),
        currentChat: facts.sessionId,
        language: workspace.config.language,
      },
      unattended
    )
  }
  return {
    pastChats: async (): Promise<number> => {
      if (!workspace.directory) return 0
      const facts = agent()
      return savedSessionCount(chatsFolder(facts, workspace.directory), facts.sessionId)
    },
    converter: (): Promise<string> => guide(),
    unattendedConverter: (conversion): Promise<string> => guide(conversion),
  }
}
