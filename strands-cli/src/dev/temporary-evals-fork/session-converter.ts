import { Skill } from '@strands-agents/sdk/vended-plugins/skills'
import { join } from 'node:path'

import { savedSessionCount } from '../../session/sessions.js'
import { devSessionsFolder } from '../runtime.js'
import type { DevWorkspace } from '../workspace.js'
import type { TemporaryAgentFacts } from './agent-context.js'
import { prepareTemporaryOptimizerEnvironment } from './environment.js'
import { temporaryWorkspaceDirectory } from './evals-process.js'
import { TEMPORARY_EVALS_FORK } from './fork.js'
import { downloadEvalsSkill, type Download, type TemporaryEvalsSource } from './skill-download.js'

export type { TemporaryEvalsSource }
import { temporaryExperimentFile, temporarySkillsFolder } from './layout.js'

const SKILL_NAME = 'session-converter'

type Fetch = typeof globalThis.fetch

export interface TemporarySessionHistory {
  pastChats(): Promise<number>
  converter(): Promise<string>
}

export interface TemporarySessionHistoryOptions {
  readonly workspace: DevWorkspace
  readonly agent: () => TemporaryAgentFacts
  readonly evals?: TemporaryEvalsSource
  readonly fetch?: Fetch
  readonly environment?: NodeJS.ProcessEnv
  readonly python?: () => Promise<string>
}

const chatsFolder = ({ sessionDirectory }: TemporaryAgentFacts, workspaceDirectory: string): string =>
  sessionDirectory ?? devSessionsFolder(workspaceDirectory)

interface Guide {
  readonly folder: string
  readonly repository: string
  readonly download: Download
  readonly python: string
  readonly workspaceDirectory: string
  readonly chats: string
  readonly currentChat: string | undefined
}

const strandsDevRules = ({ python, workspaceDirectory, chats, currentChat }: Guide): string[] => [
  `Past chats: the chats with this agent are Strands CLI sessions, and ${chats} is ` +
    'their <directory>. Use only them, unless the developer asks for other harnesses, traces, or files.' +
    (currentChat ? ` Skip ${currentChat}, which is this chat.` : ''),
  "Questions: ask the skill's questions one at a time, in plain words, without numbered options. " +
    'Skip a question that the chat already answered.',
  `Commands: run strands-evals as "${python}" -m strands_evals.cli, for example "${python}" -m strands_evals.cli ` +
    `validate <file>. Run the Python scripts of the skill with "${python}". That environment has strands-evals, ` +
    'and python3 on the PATH may not.',
  'Evaluators: call strands_dev_evaluators before you write "evaluators". Replace each unavailable evaluator with ' +
    'the nearest available one, and tell the developer.',
  'Cases: give every case a non-blank input and expected_assertion.',
  `File: save the experiment as ${temporaryExperimentFile(workspaceDirectory, '<name>')}. Use a short new ` +
    'name of letters, numbers, dots, dashes, and underscores, not <timestamp>_<uuid>. Never replace a file.',
  'Cost: reading the chats in step 3 uses the chat model, and synthesizing cases calls a Bedrock model about one ' +
    'time for each case. Before each, say what it reads or makes, and wait for a yes.',
  'Handoff: point to /experiment to review the cases and to /evaluate to run them, not to strands-evals run. ' +
    'For a smoke test, offer /evaluate.',
]

const guideText = (guide: Guide): string => {
  const { folder, repository, download } = guide
  const version = `strands-evals ${download.commit.slice(0, 7)}`
  return [
    `Follow the ${SKILL_NAME} skill below. It is the skill of ${version} from github.com/${repository}, ` +
      `and strands dev saved it in ${folder}. Its links, such as assets/segmenter.md, and <skill_dir> refer to ` +
      'that folder.' +
      (download.stale
        ? ` The skill of the installed strands-evals could not be downloaded (${download.stale}), so this skill ` +
          'comes from an earlier version.'
        : ' strands dev runs the same version of strands-evals.'),
    `Files:\n${download.files.map((file) => `  ${join(folder, ...file.split('/'))}`).join('\n')}`,
    ['In this strands dev chat, these rules replace the matching parts of the skill:', ...strandsDevRules(guide)].join(
      '\n- '
    ),
    Skill.fromFile(folder).instructions,
  ].join('\n\n')
}

export const temporarySessionHistory = ({
  workspace,
  agent,
  evals = TEMPORARY_EVALS_FORK,
  fetch = globalThis.fetch,
  environment = process.env,
  python,
}: TemporarySessionHistoryOptions): TemporarySessionHistory => {
  const evalsPython = (workspaceDirectory: string): Promise<string> =>
    python?.() ??
    prepareTemporaryOptimizerEnvironment({
      workspaceDirectory,
      projectRoot: workspace.root,
      language: workspace.config.language,
    })
  return {
    pastChats: async (): Promise<number> => {
      if (!workspace.directory) return 0
      const facts = agent()
      return savedSessionCount(chatsFolder(facts, workspace.directory), facts.sessionId)
    },
    converter: async (): Promise<string> => {
      const workspaceDirectory = temporaryWorkspaceDirectory(workspace)
      const folder = join(temporarySkillsFolder(workspaceDirectory), SKILL_NAME)
      const [skill, interpreter] = await Promise.all([
        downloadEvalsSkill({
          skill: SKILL_NAME,
          source: evals,
          folder,
          fetch,
          environment,
          hint: 'or describe what to test instead.',
        }),
        evalsPython(workspaceDirectory),
      ])
      const facts = agent()
      return guideText({
        ...skill,
        python: interpreter,
        workspaceDirectory,
        chats: chatsFolder(facts, workspaceDirectory),
        currentChat: facts.sessionId,
      })
    },
  }
}
