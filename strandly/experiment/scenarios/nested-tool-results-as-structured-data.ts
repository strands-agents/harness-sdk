import { tool } from '../../../strands-ts/src/tools/tool-factory.js'
import { bash } from '../../../strands-ts/src/vended-tools/bash/index.js'
import { z } from 'zod'
import { createAgent } from '../src/agent-factory.js'
import { scenario } from '../src/scenario.js'
import { toolPairingIntact, historyWellFormed, contextUnderWindow, stateConsistent } from '../src/invariants.js'
import type { ProfilerObserver } from '../src/observer.js'

const WINDOW = 12

// The real strands-ts modules the agent is asked to analyze. They have genuine
// local-import relationships (e.g. tool-factory → function-tool → tool;
// tool-caller → agent → tool), so the cross-referencing task has real answers.
const EARLY_MODULES = [
  'src/agent/agent.ts',
  'src/agent/tool-caller.ts',
  'src/tools/tool-factory.ts',
  'src/tools/function-tool.ts',
  'src/tools/tool.ts',
  'src/hooks/events.ts',
  'src/hooks/registry.ts',
  'src/retry/default-model-retry-strategy.ts',
  'src/session/session-manager.ts',
]
const LATE_MODULES = [
  'src/models/bedrock.ts',
  'src/models/model.ts',
  'src/models/streaming.ts',
  'src/conversation-manager/sliding-window-conversation-manager.ts',
  'src/conversation-manager/summarizing-conversation-manager.ts',
  'src/conversation-manager/conversation-manager.ts',
  'src/agent/snapshot.ts',
  'src/telemetry/tracer.ts',
  'src/registry/tool-registry.ts',
]
const ALL_MODULES = [...EARLY_MODULES, ...LATE_MODULES]

export default scenario({
  description: 'Agent works with tools returning large structured JSON data (~3000 chars each) that must be parsed, cross-referenced, and used as input to subsequent tool calls — scaled to eighteen real modules so the structured working set grows large and later cross-references depend on earlier results that the window may have truncated.',
  stresses: `How tool results containing structured data survive conversation manager truncation, sustained across eighteen analyses. tool_result content blocks holding multi-thousand-char JSON payloads accumulate; the manager must decide whether to truncate a blob (risking corruption that makes later references fail) or drop the whole message (losing the dependency graph the agent needs to find chains across modules analyzed many turns earlier). The later dependency-chain question genuinely depends on structured data from the earliest analyses, so losing that context breaks the answer. Under CHAOS mode, partial timeout results force retries.`,
  dimensions: ['context-management', 'tool-dispatch'],
  run,
})

async function run(profiler: ProfilerObserver) {
  const CHAOS = process.env.CHAOS === '1'

  // Track which modules were actually analyzed so the oracle can assert the
  // agent did the work rather than answering from prior knowledge.
  const analyzed = new Set<string>()

  // Simulates an API that returns large structured responses (~3000 chars)
  const analyzeModule = tool({
    name: 'analyze_module',
    description: 'Analyze a TypeScript module and return structured data about its exports, imports, complexity metrics, dependency graph, class hierarchies, and type relationships. Returns ~3000 chars of structured JSON.',
    inputSchema: z.object({ modulePath: z.string() }),
    callback: async (input) => {
      // CHAOS: ~10% of calls return a partial timeout result
      if (CHAOS && Math.random() < 0.10) {
        return JSON.stringify({
          path: input.modulePath,
          status: 'timeout',
          warning: 'timeout: analysis incomplete, retry for full results',
          partial: { lines: 0, exportCount: 0, importCount: 0 },
        })
      }

      analyzed.add(input.modulePath)
      // Use bash to get real data, then structure it. Bounded with head so it
      // stays fast and never hangs.
      const { execSync } = await import('node:child_process')
      const cwd = process.cwd().replace(/\/strandly\/experiment$/, '/strands-ts')

      let lines = 0
      let exports: string[] = []
      let imports: string[] = []
      let classes: string[] = []
      let interfaces: string[] = []
      let typeAliases: string[] = []
      let functions: string[] = []
      let content = ''
      try {
        content = execSync(`cat "${input.modulePath}" 2>/dev/null | head -300`, { encoding: 'utf-8', cwd })
        lines = content.split('\n').length
        exports = Array.from(content.matchAll(/export\s+(?:class|function|const|interface|type)\s+(\w+)/g)).map(m => m[1]!)
        imports = Array.from(content.matchAll(/import\s+.*from\s+['"]([^'"]+)['"]/g)).map(m => m[1]!)
        classes = Array.from(content.matchAll(/(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/g)).map(m => m[2] ? `${m[1]} extends ${m[2]}` : m[1]!)
        interfaces = Array.from(content.matchAll(/(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+(\w+))?/g)).map(m => m[2] ? `${m[1]} extends ${m[2]}` : m[1]!)
        typeAliases = Array.from(content.matchAll(/(?:export\s+)?type\s+(\w+)\s*=/g)).map(m => m[1]!)
        functions = Array.from(content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)).map(m => m[1]!)
      } catch { /* file not found is ok */ }

      // Build import graph with resolved symbols
      const importGraph = imports.map(i => {
        const importLine = content.match(new RegExp(`import\\s+({[^}]+}|\\w+)\\s+from\\s+['"]${i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`))
        const symbols = importLine ? importLine[1]!.replace(/[{}]/g, '').split(',').map(s => s.trim()) : ['*']
        return { source: i, symbols, isLocal: i.startsWith('.'), resolvedPath: i.startsWith('.') ? `${i.replace(/^\.\//, 'src/')}.ts` : null }
      })

      // Build export detail with approximate line numbers and types
      const exportDetails = exports.map((e, idx) => {
        const lineMatch = content.split('\n').findIndex(l => l.includes(e))
        return {
          name: e,
          kind: classes.some(c => c.startsWith(e)) ? 'class' : interfaces.some(i => i.startsWith(e)) ? 'interface' : typeAliases.includes(e) ? 'type' : functions.includes(e) ? 'function' : 'const',
          lineNumber: lineMatch >= 0 ? lineMatch + 1 : idx * 15 + 1,
          isDefault: content.includes(`export default ${e}`) || content.includes(`export { ${e} as default`),
        }
      })

      return JSON.stringify({
        path: input.modulePath,
        status: 'complete',
        metrics: {
          lines,
          exportCount: exports.length,
          importCount: imports.length,
          classCount: classes.length,
          interfaceCount: interfaces.length,
          typeAliasCount: typeAliases.length,
          functionCount: functions.length,
          complexity: Math.floor(lines / 8),
          cyclomaticEstimate: Math.floor(lines / 12),
        },
        classHierarchy: classes.map(c => {
          const parts = c.split(' extends ')
          return { name: parts[0], extends: parts[1] || null }
        }),
        interfaces: interfaces.map(i => {
          const parts = i.split(' extends ')
          return { name: parts[0], extends: parts[1] || null }
        }),
        typeAliases,
        exports: exportDetails,
        importGraph,
        localDependencies: importGraph.filter(i => i.isLocal).map(i => ({ path: i.source, symbols: i.symbols, resolvedPath: i.resolvedPath })),
        externalDependencies: importGraph.filter(i => !i.isLocal).map(i => ({ package: i.source, symbols: i.symbols })),
      }, null, 2)
    },
  })

  const agent = createAgent(profiler, {
    systemPrompt: `You are a dependency analyst. Use analyze_module to get structured data about modules, then cross-reference the results to find dependency chains, circular dependencies, and architectural layers. You can also use bash for additional investigation, but keep any bash bounded (use head/tail with limits). Your analysis should reference specific data points from the structured results — module names, the "localDependencies" arrays, import paths, class hierarchies, and complexity metrics. If analyze_module returns a timeout/partial result, retry the call to get the full analysis.`,
    tools: [analyzeModule, bash],
    windowSize: WINDOW,
  })

  const tasks = [
    `Analyze these modules one at a time with analyze_module: ${EARLY_MODULES.join(', ')}. For each, note its export count, class hierarchy, and its "localDependencies" array. Pay special attention to the first few modules — you will need their data later.`,
    'Based on the structured data from those analyses, answer: (a) Which module has the most outgoing local dependencies? (b) Which has the most exports? (c) Which classes extend other classes, and what is the inheritance chain? (d) Which module has the highest complexity metric? Cite the exact counts and class names from the structured results.',
    `Now analyze these additional modules: ${LATE_MODULES.join(', ')}. For each, list its local dependencies and class hierarchy.`,
    'Using the "localDependencies" arrays from ALL eighteen modules you analyzed, trace the dependency chains: which of the modules you analyzed import which other modules you analyzed? Build the chains (e.g. A depends on B depends on C). Reference the specific import paths and resolved paths that connect them.',
    'Cross-reference the class hierarchies: across all eighteen modules, build a complete class inheritance tree. Which base classes from the EARLY modules (agent.ts, tool-caller.ts, etc.) are extended by classes in the LATE modules? Name specific classes and the files they live in.',
    'Produce a final dependency report: (a) list every dependency chain of length 3 or more among the analyzed modules, (b) list any circular dependency chains you can identify naming the specific imports that create each cycle, (c) name the single module with the highest complexity metric and its value, (d) identify the "most connected" module — the one that appears in the most dependency chains either as a dependency or dependent, citing the exact count from the earlier analyses, and (e) for the earliest modules you analyzed (agent.ts, tool-caller.ts, tool-factory.ts): what were their exact export counts and local dependency counts? If those results have aged out of your context, say so explicitly.',
  ]

  for (const task of tasks) {
    profiler.recordInvocationInput(task)
    const result = await agent.invoke(task, { limits: { turns: 12 } })
    profiler.recordResult(result)
  }

  // SDK invariants (deterministic, model-independent) read off the final log.
  profiler.recordInvariants(
    toolPairingIntact(agent.messages),
    historyWellFormed(agent.messages),
    contextUnderWindow(agent.messages, WINDOW),
  )

  // State oracle: the analyze_module call set is ground truth for what the agent
  // actually inspected. The final cross-reference questions can only be answered
  // from the structured results, so assert the agent analyzed (near) all of the
  // requested modules — including at least one EARLY module, whose result must
  // survive truncation to participate in the chains asked about in the last
  // turn. A run that never analyzed the early modules, or stopped well short of
  // the full set, did not do the dependent work.
  const missing = ALL_MODULES.filter((m) => !analyzed.has(m))
  const earlyCovered = EARLY_MODULES.some((m) => analyzed.has(m))
  // Allow two slippages for CHAOS retries or path renames, but the bulk
  // must be covered and at least one early module must be present.
  const covered = ALL_MODULES.length - missing.length
  const ok = earlyCovered && covered >= ALL_MODULES.length - 2
  profiler.recordInvariants(
    stateConsistent(
      'modules-analyzed',
      ok,
      ok
        ? `analyzed ${covered}/${ALL_MODULES.length} requested modules (early modules present: chains are answerable)`
        : `analyzed ${covered}/${ALL_MODULES.length} modules; earlyCovered=${earlyCovered}; missing [${missing.join(', ')}]`,
    ),
  )
}
