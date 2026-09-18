import { makeApiMock } from '../src/tools/api-mock.js'
import { createAgent } from '../src/agent-factory.js'
import { scenario } from '../src/scenario.js'
import { toolPairingIntact, historyWellFormed, contextUnderWindow, stateConsistent } from '../src/invariants.js'
import type { ProfilerObserver } from '../src/observer.js'

const WINDOW = 14
const UNRELIABLE = process.env.CHAOS === '1'

export default scenario({
  description: 'Drive a realistic REST API with verbose JSON responses, deep pagination (8 pages of users), interdependent endpoints (orders, profiles, teams, permissions, billing), multiple 404s and a 500, then join everything into a complete cross-referenced report across 15 users.',
  stresses: 'Sustained multi-call data assembly where responses are nested JSON with metadata the agent must parse through. Eight pages of users (2 per page), paginated orders (3 pages), per-user profiles (3 of which 404), teams, team permissions (1 404s), and per-user billing status (another join). With CHAOS=1, ~10% of calls return transient 500s requiring retry. The agent must follow pagination exhaustively, parse nested response bodies, handle 404 as skip and 5xx as retry, and keep earlier pages in working memory while the window slides — assembling 6 dimensions of data across ~40+ API calls.',
  dimensions: ['tool-dispatch', 'state-consistency', 'context-management'],
  evaluation: {
    rubric: `Final report must correctly join: 15 users, order totals, profile tiers (3 missing), team assignment, team permission level (1 team missing), and billing status (2 missing). Correct users: Alice through Oscar (ids 1-15). Score 1.0 if all data points correct AND missing items explicitly noted. Score 0.5 if structure right but 1-2 data points wrong. Score 0.0 if users/totals/teams fundamentally wrong.`,
  },
  run,
})

async function run(profiler: ProfilerObserver) {
  // 15 users across 8 pages (2 per page, last page has 1)
  const users = [
    { id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }, { id: 3, name: 'Carol' },
    { id: 4, name: 'Dave' }, { id: 5, name: 'Eve' }, { id: 6, name: 'Frank' },
    { id: 7, name: 'Grace' }, { id: 8, name: 'Heidi' }, { id: 9, name: 'Ivan' },
    { id: 10, name: 'Judy' }, { id: 11, name: 'Karl' }, { id: 12, name: 'Lena' },
    { id: 13, name: 'Mona' }, { id: 14, name: 'Nick' }, { id: 15, name: 'Oscar' },
  ]

  const teams = [
    { name: 'platform', memberIds: [1, 2, 3, 4, 5] },
    { name: 'growth', memberIds: [6, 7, 8, 9, 10] },
    { name: 'infra', memberIds: [11, 12, 13, 14, 15] },
  ]

  const orders = [
    { id: 'o1', userId: 1, total: 120, items: 3 },
    { id: 'o2', userId: 1, total: 45, items: 1 },
    { id: 'o3', userId: 3, total: 80, items: 2 },
    { id: 'o4', userId: 4, total: 200, items: 5 },
    { id: 'o5', userId: 4, total: 35, items: 1 },
    { id: 'o6', userId: 6, total: 60, items: 2 },
    { id: 'o7', userId: 7, total: 150, items: 4 },
    { id: 'o8', userId: 9, total: 90, items: 3 },
    { id: 'o9', userId: 10, total: 75, items: 2 },
    { id: 'o10', userId: 11, total: 180, items: 4 },
    { id: 'o11', userId: 13, total: 95, items: 2 },
    { id: 'o12', userId: 14, total: 40, items: 1 },
    { id: 'o13', userId: 15, total: 110, items: 3 },
  ]
  // Users with NO orders: 2(Bob), 5(Eve), 8(Heidi), 12(Lena) → total = 0

  const profiles: Record<number, { tier: string; joinedYear: number }> = {
    1: { tier: 'gold', joinedYear: 2019 },
    3: { tier: 'silver', joinedYear: 2020 },
    4: { tier: 'gold', joinedYear: 2018 },
    5: { tier: 'bronze', joinedYear: 2022 },
    6: { tier: 'silver', joinedYear: 2021 },
    7: { tier: 'gold', joinedYear: 2019 },
    9: { tier: 'bronze', joinedYear: 2023 },
    10: { tier: 'silver', joinedYear: 2020 },
    11: { tier: 'gold', joinedYear: 2018 },
    13: { tier: 'bronze', joinedYear: 2022 },
    14: { tier: 'silver', joinedYear: 2021 },
    15: { tier: 'gold', joinedYear: 2019 },
  }
  // Missing profiles (404): 2(Bob), 8(Heidi), 12(Lena)

  const billing: Record<number, { plan: string; monthlySpend: number }> = {
    1: { plan: 'enterprise', monthlySpend: 450 },
    3: { plan: 'pro', monthlySpend: 120 },
    4: { plan: 'enterprise', monthlySpend: 800 },
    6: { plan: 'pro', monthlySpend: 95 },
    7: { plan: 'enterprise', monthlySpend: 350 },
    9: { plan: 'starter', monthlySpend: 30 },
    10: { plan: 'pro', monthlySpend: 150 },
    11: { plan: 'enterprise', monthlySpend: 600 },
    13: { plan: 'pro', monthlySpend: 100 },
    14: { plan: 'starter', monthlySpend: 25 },
    15: { plan: 'enterprise', monthlySpend: 500 },
  }
  // Missing billing (404): 2(Bob), 5(Eve), 8(Heidi), 12(Lena)

  // Build endpoints
  const endpoints = [
    // Paginated users: 2 per page = 8 pages
    ...Array.from({ length: 8 }, (_, i) => {
      const pageUsers = users.slice(i * 2, i * 2 + 2)
      const nextPage = i < 7 ? i + 2 : null
      return {
        method: 'GET' as const,
        path: `/users?page=${i + 1}`,
        response: { status: 200, body: { users: pageUsers, pagination: { page: i + 1, totalPages: 8, nextPage, totalUsers: 15 } } },
      }
    }),

    // Paginated orders: 5 per page = 3 pages
    { method: 'GET', path: '/orders?page=1', response: { status: 200, body: { orders: orders.slice(0, 5), pagination: { page: 1, totalPages: 3, nextPage: 2 } } } },
    { method: 'GET', path: '/orders?page=2', response: { status: 200, body: { orders: orders.slice(5, 10), pagination: { page: 2, totalPages: 3, nextPage: 3 } } } },
    { method: 'GET', path: '/orders?page=3', response: { status: 200, body: { orders: orders.slice(10), pagination: { page: 3, totalPages: 3, nextPage: null } } }, latencyMs: 800 },

    // Per-user profiles — some 404
    ...users.map(u => ({
      method: 'GET' as const,
      path: `/users/${u.id}/profile`,
      response: profiles[u.id]
        ? { status: 200, body: { userId: u.id, ...profiles[u.id], accountAge: 2026 - profiles[u.id]!.joinedYear } }
        : { status: 404, body: { error: 'not_found', message: `Profile not found for user ${u.id}` } },
    })),

    // Teams
    { method: 'GET', path: '/teams', response: { status: 200, body: { teams: teams.map(t => ({ ...t, size: t.memberIds.length })) } }, latencyMs: 400 },

    // Per-team permissions — infra 404s
    { method: 'GET', path: '/teams/platform/permissions', response: { status: 200, body: { team: 'platform', level: 'admin', grantedBy: 'system', grantedAt: '2024-01-15' } } },
    { method: 'GET', path: '/teams/growth/permissions', response: { status: 200, body: { team: 'growth', level: 'write', grantedBy: 'admin', grantedAt: '2024-03-20' } } },
    { method: 'GET', path: '/teams/infra/permissions', response: { status: 404, body: { error: 'not_configured', message: 'Permissions not yet configured for team infra' } } },

    // Per-user billing — some 404
    ...users.map(u => ({
      method: 'GET' as const,
      path: `/billing/${u.id}`,
      response: billing[u.id]
        ? { status: 200, body: { userId: u.id, ...billing[u.id], currency: 'USD', lastInvoice: '2026-06-01' } }
        : { status: 404, body: { error: 'no_billing', message: `No billing account for user ${u.id}` } },
    })),
  ]

  const api = makeApiMock(endpoints, { unreliable: UNRELIABLE, failRate: 0.08, rateLimit: UNRELIABLE ? 15 : 0 })

  const agent = createAgent(profiler, {
    systemPrompt: `You are integrating with a paginated REST API via the api_request tool. Responses are JSON objects with status, headers, requestId, and body fields. You must check status before trusting body.

Rules:
- 200 = success, parse body for data
- 404 = resource absent — note it, do NOT retry, do NOT invent data
- 429 = rate limited — wait and retry
- 5xx = transient server error — retry once
- Always follow pagination (nextPage or totalPages) until exhausted
- Responses contain nested objects with metadata — dig into the "body" field for actual data

You will need to join data across several endpoint families. Keep careful track of what you've fetched and assembled.${UNRELIABLE ? '\n\nNOTE: The API is under load. Expect occasional 500/503/429 errors. Retry them.' : ''}`,
    tools: api.tools,
    windowSize: WINDOW,
  })

  const tasks = [
    'Fetch ALL users by paginating through GET /users?page=1 and following pagination until the last page (check totalPages in the pagination field of the response body). Report every user id and name.',

    'Fetch ALL orders by paginating through GET /orders?page=1 until the last page. Compute total order value per user by summing order totals. Users with no orders have total=0. Report the per-user totals.',

    'For each of the 15 users, fetch GET /users/{id}/profile to get their tier and joined year. Some will 404 — note which users have no profile. Do NOT invent data for missing profiles.',

    'Fetch GET /teams to get team membership (which user IDs are on which team). Then for each team, fetch GET /teams/{name}/permissions for the permission level. One team will 404 on permissions — note it.',

    'For each of the 15 users, fetch GET /billing/{id} to get their billing plan and monthly spend. Some will 404 — note which users have no billing. Do NOT invent data.',

    'Now produce a COMPLETE final report table with one row per user containing: name, order total, profile tier (or "no profile"), team, team permission level (or "not configured"), billing plan (or "no billing"), monthly spend (or N/A). Be explicit about every missing value — never invent data you did not receive from the API.',
  ]

  for (const task of tasks) {
    profiler.recordInvocationInput(task)
    const result = await agent.invoke(task, { limits: { turns: 20 } })
    profiler.recordResult(result)
  }

  profiler.recordInvariants(
    toolPairingIntact(agent.messages),
    historyWellFormed(agent.messages),
    contextUnderWindow(agent.messages, WINDOW),
  )

  // State oracle: verify the agent hit all critical paths
  const log = api.getCallLog()
  const hit = (method: string, path: string) => log.some(c => c.method === method && c.path === path)

  const paginatedUsers = hit('GET', '/users?page=8')
  const paginatedOrders = hit('GET', '/orders?page=3')
  const hitMissingProfiles = hit('GET', '/users/2/profile') && hit('GET', '/users/8/profile') && hit('GET', '/users/12/profile')
  const hitMissingPerms = hit('GET', '/teams/infra/permissions')
  const hitBilling = hit('GET', '/billing/1') && hit('GET', '/billing/15')

  const allExercised = paginatedUsers && paginatedOrders && hitMissingProfiles && hitMissingPerms && hitBilling

  profiler.recordInvariants(
    stateConsistent(
      'api-paths-exercised',
      allExercised,
      allExercised
        ? `all paths exercised: paginated to /users?page=8, /orders?page=3, hit missing profiles (2,8,12), infra perms 404, billing endpoints (${log.length} total calls)`
        : `missing: users-page-8=${paginatedUsers}, orders-page-3=${paginatedOrders}, profiles-404=${hitMissingProfiles}, infra-perms=${hitMissingPerms}, billing=${hitBilling} (${log.length} calls)`,
    ),
  )
}
