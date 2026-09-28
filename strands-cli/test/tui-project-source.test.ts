import { defineHarnessAgentConfig } from '@strands-agents/harness'
import { expect, it } from 'vitest'

import { agentProjectSource } from '../src/tui/project/source.js'

it('recases Python background task options without dropping them', () => {
  const source = agentProjectSource(
    defineHarnessAgentConfig({
      agentConfig: { backgroundTasks: { waitForCompletion: false, maxConcurrency: 2, timeout: 1_500 } },
    }),
    'python'
  )
  expect(source).toContain('"wait_for_completion": False')
  expect(source).toContain('"max_concurrency": 2')
  expect(source).toContain('"timeout": 1500')
})

it.each(['typescript', 'python'] as const)('anchors local paths to the exported project in %s source', (language) => {
  const source = agentProjectSource(
    defineHarnessAgentConfig({
      skills: ['./agent/skills'],
      interventions: './agent/policy.cedar',
      mcpServers: { local: { command: 'node', args: ['./server.mjs'] } },
    }),
    language
  )
  expect(source).toContain(
    language === 'typescript' ? "projectPath('./agent/skills')" : 'project_path("./agent/skills")'
  )
  expect(source).toContain(language === 'typescript' ? "cwd: projectPath('.')" : '"cwd": project_path(".")')
  expect(source).toContain(
    language === 'typescript' ? "projectPath('./agent/policy.cedar')" : 'project_path("./agent/policy.cedar")'
  )
})
