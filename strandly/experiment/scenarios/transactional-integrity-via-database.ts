import { makeDatabase } from '../src/tools/database.js'
import { createAgent } from '../src/agent-factory.js'
import { scenario } from '../src/scenario.js'
import { toolPairingIntact, historyWellFormed, contextUnderWindow, stateConsistent } from '../src/invariants.js'
import type { ProfilerObserver } from '../src/observer.js'

const WINDOW = 12
const UNRELIABLE = process.env.CHAOS === '1'

export default scenario({
  description: 'Maintain a growing body of relational data (25 users, 40+ projects across 5 teams) in a paginated database that enforces no constraints. The agent must enforce referential integrity, uniqueness, and team-capacity rules itself — querying paginated results, parsing verbose JSON responses, and catching planted violations across 15 steps of mutations.',
  stresses: 'Tool responses are paginated (max 5 rows per SELECT), wrapped in metadata JSON the agent must parse, and mutations return verbose confirmation objects. The agent must paginate through results to get a complete picture, cannot rely on a single SELECT to see all data, and must parse nested response structures to extract actual values. With 25 users and 40+ projects across 15 steps, early query results are evicted by the sliding window — the agent must re-query rather than rely on stale context. With CHAOS=1, ~10% of calls are rate-limited (429) requiring retry.',
  dimensions: ['state-consistency', 'tool-dispatch', 'context-management'],
  evaluation: {
    rubric: `Ground truth constraints that must hold in final state: (1) zero orphaned projects (every owner_id references an existing user), (2) no user owns more than 6 projects, (3) every project has a non-null priority, (4) no deactivated user owns projects. Planted violations: owner_id 99 and 88 (non-existent), user id 6 gets deactivated mid-scenario, 3 projects inserted without priority. Score 1.0 if all constraints satisfied in final DB state. Score 0.5 if 1 constraint violated. Score 0.0 if 2+ constraints violated.`,
  },
  run,
})

async function run(profiler: ProfilerObserver) {
  const db = makeDatabase({ pageSize: 5, rateLimit: UNRELIABLE ? 12 : 0, verbose: true })

  // Pre-seed the database with realistic initial state
  db.seed('users', ['id', 'name', 'team', 'status'], [
    { id: 1, name: 'Alice', team: 'platform', status: 'active' },
    { id: 2, name: 'Bob', team: 'platform', status: 'active' },
    { id: 3, name: 'Carol', team: 'infra', status: 'active' },
    { id: 4, name: 'Dave', team: 'infra', status: 'active' },
    { id: 5, name: 'Eve', team: 'platform', status: 'active' },
    { id: 6, name: 'Frank', team: 'data', status: 'active' },
    { id: 7, name: 'Grace', team: 'data', status: 'active' },
    { id: 8, name: 'Heidi', team: 'infra', status: 'active' },
    { id: 9, name: 'Ivan', team: 'platform', status: 'active' },
    { id: 10, name: 'Judy', team: 'data', status: 'active' },
    { id: 11, name: 'Karl', team: 'security', status: 'active' },
    { id: 12, name: 'Lena', team: 'security', status: 'active' },
    { id: 13, name: 'Mona', team: 'ml', status: 'active' },
    { id: 14, name: 'Nick', team: 'ml', status: 'active' },
    { id: 15, name: 'Olivia', team: 'platform', status: 'active' },
    { id: 16, name: 'Pat', team: 'infra', status: 'active' },
    { id: 17, name: 'Quinn', team: 'data', status: 'active' },
    { id: 18, name: 'Rosa', team: 'ml', status: 'active' },
    { id: 19, name: 'Sam', team: 'security', status: 'active' },
    { id: 20, name: 'Tina', team: 'infra', status: 'active' },
    { id: 21, name: 'Uri', team: 'platform', status: 'active' },
    { id: 22, name: 'Val', team: 'data', status: 'active' },
    { id: 23, name: 'Wendy', team: 'ml', status: 'active' },
    { id: 24, name: 'Xander', team: 'security', status: 'active' },
    { id: 25, name: 'Yuki', team: 'infra', status: 'active' },
  ])

  db.seed('projects', ['id', 'owner_id', 'title', 'priority', 'team'], [
    { id: 100, owner_id: 1, title: 'Billing API', priority: 'high', team: 'platform' },
    { id: 101, owner_id: 1, title: 'Auth Gateway', priority: 'critical', team: 'platform' },
    { id: 102, owner_id: 1, title: 'Rate Limiter', priority: 'medium', team: 'platform' },
    { id: 103, owner_id: 1, title: 'API Docs', priority: 'low', team: 'platform' },
    { id: 104, owner_id: 1, title: 'SDK Generator', priority: 'medium', team: 'platform' },
    { id: 105, owner_id: 1, title: 'Load Balancer', priority: 'high', team: 'platform' },
    { id: 106, owner_id: 1, title: 'Feature Flags', priority: 'medium', team: 'platform' },
    // Alice owns 7 projects — over the limit of 6
    { id: 107, owner_id: 3, title: 'Log Pipeline', priority: 'high', team: 'infra' },
    { id: 108, owner_id: 3, title: 'Monitoring', priority: 'critical', team: 'infra' },
    { id: 109, owner_id: 4, title: 'Backups', priority: 'high', team: 'infra' },
    { id: 110, owner_id: 5, title: 'User Portal', priority: 'medium', team: 'platform' },
    { id: 111, owner_id: 6, title: 'ETL Jobs', priority: 'high', team: 'data' },
    { id: 112, owner_id: 6, title: 'Data Lake', priority: 'critical', team: 'data' },
    { id: 113, owner_id: 6, title: 'Streaming', priority: 'medium', team: 'data' },
    { id: 114, owner_id: 6, title: 'Analytics', priority: 'high', team: 'data' },
    { id: 115, owner_id: 6, title: 'ML Pipeline', priority: 'medium', team: 'data' },
    { id: 116, owner_id: 6, title: 'Reporting', priority: 'low', team: 'data' },
    { id: 117, owner_id: 6, title: 'Data Catalog', priority: 'medium', team: 'data' },
    // Frank owns 7 projects — also over the limit
    { id: 118, owner_id: 7, title: 'Dashboards', priority: 'medium', team: 'data' },
    { id: 119, owner_id: 8, title: 'Provisioning', priority: 'high', team: 'infra' },
    { id: 120, owner_id: 9, title: 'Search Index', priority: 'medium', team: 'platform' },
    { id: 121, owner_id: 10, title: 'Compliance', priority: 'high', team: 'data' },
    { id: 122, owner_id: 11, title: 'WAF Rules', priority: 'critical', team: 'security' },
    { id: 123, owner_id: 12, title: 'Pen Testing', priority: 'high', team: 'security' },
    { id: 124, owner_id: 13, title: 'Model Training', priority: 'critical', team: 'ml' },
    { id: 125, owner_id: 14, title: 'Inference API', priority: 'high', team: 'ml' },
    { id: 126, owner_id: 15, title: 'Admin Panel', priority: 'medium', team: 'platform' },
    { id: 127, owner_id: 16, title: 'DNS Manager', priority: 'high', team: 'infra' },
    { id: 128, owner_id: 17, title: 'Query Engine', priority: 'medium', team: 'data' },
    // Planted orphans — owners 99 and 88 don't exist
    { id: 129, owner_id: 99, title: 'Ghost Project', priority: 'high', team: 'unknown' },
    { id: 130, owner_id: 88, title: 'Phantom Project', priority: 'medium', team: 'unknown' },
    // Projects with NULL priority — another violation
    { id: 131, owner_id: 18, title: 'Experiment Tracker', priority: null, team: 'ml' },
    { id: 132, owner_id: 19, title: 'Vuln Scanner', priority: null, team: 'security' },
    { id: 133, owner_id: 20, title: 'Terraform Modules', priority: null, team: 'infra' },
  ])

  const agent = createAgent(profiler, {
    systemPrompt: `You are a database administrator managing a relational database with two tables:
- users (id, name, team, status) — 25 users across teams: platform, infra, data, ml, security
- projects (id, owner_id, title, priority, team) — 30+ projects

The database tools return paginated JSON responses (max 5 rows per page — use the cursor/nextCursor to get all rows). Responses are wrapped in metadata you must parse through to get the actual data.

You must enforce these rules (the database does NOT enforce them):
1. Every project.owner_id must reference an existing user (no orphans)
2. No single user may own more than 6 projects (rebalance excess to same-team members)
3. Every project must have a non-null priority (set missing ones to 'medium')
4. Deactivated users must not own projects (reassign to active same-team members)

IMPORTANT: SELECT results are paginated. You MUST follow nextCursor to see all data. A single page shows only 5 rows — do not assume you've seen everything from one page.${UNRELIABLE ? '\n\nNOTE: The database is under load. You may occasionally receive 429 rate-limit errors. If so, retry the same call.' : ''}`,
    tools: db.tools,
    windowSize: WINDOW,
  })

  const tasks = [
    // Step 1-3: Discovery — must paginate through all data
    'List all tables and their schemas using db_describe and db_list_tables. Report what you find.',

    'Query ALL users (remember: results are paginated, max 5 per page — you must follow nextCursor until there are no more pages). Report the total count and list each team with its member count.',

    'Query ALL projects (paginate through every page). Report total count, and identify any projects where owner_id does not match any user id (orphans). Also report any projects with null priority.',

    // Step 4-5: Fix orphans
    'Delete the orphaned projects you found (owner_id referencing non-existent users). Verify deletion by querying for those specific owner_ids afterward.',

    'Fix all projects that have null priority — update each one to set priority to "medium". Verify by selecting those specific projects after the update.',

    // Step 6-8: Overload detection and rebalancing
    'Find which users own more than 6 projects. You need to count projects per owner_id — paginate through ALL projects and tally. Report which users are overloaded and by how much.',

    'Rebalance Alice (id 1) who owns too many projects. Reassign her excess projects (keep her 6 highest-priority ones) to other ACTIVE platform team members who own the fewest projects. Verify Alice now owns exactly 6.',

    'Rebalance Frank (id 6) who also owns too many projects. Reassign his excess (keep his 6 highest-priority) to other ACTIVE data team members with the fewest projects. Verify Frank now owns exactly 6.',

    // Step 9-10: Deactivation and cascade
    'Deactivate user Frank (id 6) — update his status to "deactivated". Then query all projects owned by Frank and reassign them to Grace (id 7, same data team). Verify Frank owns zero projects after.',

    'Deactivate user Eve (id 5) — update her status to "deactivated". Reassign her projects to other active platform team members. Verify she owns zero projects.',

    // Step 11-13: New data + more integrity work
    'Insert 5 new projects: (200, 21, "API v3", "high", "platform"), (201, 22, "Data Warehouse", "critical", "data"), (202, 23, "AutoML", "high", "ml"), (203, 24, "Zero Trust", "critical", "security"), (204, 25, "K8s Operator", "high", "infra"). Verify each insertion succeeded by checking the response.',

    'Insert a project with a non-existent owner: (205, 77, "Rogue Project", "low", "unknown"). Detect this violates integrity (owner 77 does not exist), delete it, and verify deletion.',

    'Deactivate user Bob (id 2). Query his projects, reassign all of them to active platform team members, then verify Bob owns zero projects and all reassigned projects have valid active owners.',

    // Step 14-15: Final audit
    'Run a complete integrity audit: paginate through ALL users and ALL projects. Check all four rules: (1) no orphaned projects, (2) no user owns >6 projects, (3) no null priorities, (4) no deactivated user owns projects. Report violations if any, or confirm all clear.',

    'Produce a final summary: total active users, total deactivated users, total projects, projects per team, and confirmation that all integrity rules pass.',
  ]

  for (const task of tasks) {
    profiler.recordInvocationInput(task)
    const result = await agent.invoke(task, { limits: { turns: 20 } })
    profiler.recordResult(result)
  }

  // --- SDK invariants ---
  profiler.recordInvariants(
    toolPairingIntact(agent.messages),
    historyWellFormed(agent.messages),
    contextUnderWindow(agent.messages, WINDOW),
  )

  // --- State oracle: check all constraints against actual DB state ---
  const users = db.getRows('users')
  const projects = db.getRows('projects')
  const activeUserIds = new Set(users.filter(u => u.status === 'active').map(u => String(u.id)))
  const allUserIds = new Set(users.map(u => String(u.id)))

  // Constraint 1: No orphans
  const orphans = projects.filter(p => !allUserIds.has(String(p.owner_id)))

  // Constraint 2: No user owns > 6
  const ownerCounts = new Map<string, number>()
  for (const p of projects) ownerCounts.set(String(p.owner_id), (ownerCounts.get(String(p.owner_id)) ?? 0) + 1)
  const overloaded = [...ownerCounts.entries()].filter(([_, c]) => c > 6)

  // Constraint 3: No null priorities
  const nullPriority = projects.filter(p => p.priority === null || p.priority === 'NULL' || p.priority === 'null' || p.priority === '')

  // Constraint 4: No deactivated owners
  const deactivatedIds = new Set(users.filter(u => u.status === 'deactivated').map(u => String(u.id)))
  const deactivatedOwning = projects.filter(p => deactivatedIds.has(String(p.owner_id)))

  const violations = [
    orphans.length > 0 ? `${orphans.length} orphaned projects (owners: ${orphans.map(p => p.owner_id).join(', ')})` : null,
    overloaded.length > 0 ? `${overloaded.length} overloaded users (${overloaded.map(([id, c]) => `user ${id}: ${c} projects`).join(', ')})` : null,
    nullPriority.length > 0 ? `${nullPriority.length} projects with null priority` : null,
    deactivatedOwning.length > 0 ? `${deactivatedOwning.length} projects owned by deactivated users` : null,
  ].filter(Boolean)

  profiler.recordInvariants(
    stateConsistent(
      'db-all-constraints',
      violations.length === 0,
      violations.length === 0
        ? `all 4 constraints satisfied (${activeUserIds.size} active users, ${deactivatedIds.size} deactivated, ${projects.length} projects)`
        : `${4 - violations.length}/4 constraints passed. Violations:\n  ${violations.join('\n  ')}`,
    ),
  )
}
