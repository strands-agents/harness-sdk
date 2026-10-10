import type { HarnessAgentConfig } from '@strands-agents/harness'

import type { AgentProjectLanguage } from './import.js'

export function validatePortableDependencies(
  dependencies: HarnessAgentConfig['dependencies'],
  language: AgentProjectLanguage
): void {
  const specs = language === 'typescript' ? Object.values(dependencies.typescript) : dependencies.python
  for (const original of specs) {
    let value = original.trim()
    let pathOption = false
    if (language === 'python') {
      if (value.startsWith('#')) continue
      const option = /^(?:--(?:editable|requirement|constraint|find-links)(?:=|\s+)|-[ercf]\s*)/u.exec(value)
      if (option) {
        pathOption = true
        value = value.slice(option[0].length).trim()
      } else if (value.startsWith('-')) {
        continue
      }
      value = value
        .replace(/^[\w.-]+(?:\[[^\]]*\])?\s*@\s*/u, '')
        .split(/[;#]/u, 1)[0]!
        .split(/\s+--/u, 1)[0]!
        .trim()
    }
    const local =
      /^(?:(?:[a-z]+\+)?file:|link:|workspace:|\.{1,2}(?:[/\\]|$)|[/\\]|~[/\\]|[a-z]:)/iu.test(value) ||
      value.includes('\\')
    const remote = /^(?:[a-z][a-z0-9+.-]*:|git@[^:]+:)/iu.test(value)
    const archive =
      language === 'typescript'
        ? /\.(?:tgz|tar(?:\.gz)?)$/iu.test(value)
        : /\.(?:whl|zip|tgz|tar(?:\.(?:gz|bz2|xz))?)(?:\[[^\]]*\])?$/iu.test(value)
    if (local || (!remote && (archive || (language === 'python' && (pathOption || /[/\\]/u.test(value)))))) {
      throw new Error(
        `dependencies.${language} entry ${JSON.stringify(original)} refers to an unpackaged local dependency. Use module references with files, or published/remote packages.`
      )
    }
  }
}
