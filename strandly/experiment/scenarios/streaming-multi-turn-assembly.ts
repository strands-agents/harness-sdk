import { createAgent } from '../src/agent-factory.js'
import { tool } from '../../../strands-ts/src/tools/tool-factory.js'
import { z } from 'zod'
import { scenario } from '../src/scenario.js'
import { toolPairingIntact, historyWellFormed, contextUnderWindow, stateConsistent } from '../src/invariants.js'
import type { ProfilerObserver } from '../src/observer.js'

const WINDOW = 8

export default scenario({
  description: 'Agent makes many rapid-fire tool calls across 10 invocations, generating high throughput of model responses and tool results that stress the streaming assembly path — each cycle issues 7-8 parallel fetches returning large chunked data (~3000+ chars each) that must be reassembled correctly, then validates via a submit_report tool that checksums match.',
  stresses: 'The streaming pipeline under extreme message throughput and payload size. Each invocation does 7-8 parallel tool calls returning ~3000+ char structured JSON with nested objects, arrays of records, and metadata fields; across 10 invocations with WINDOW=8, the SDK must stream model responses, assemble content blocks from deltas, dispatch tools, and feed results back — all while the conversation manager truncates completed turns. With CHAOS=1, ~10% of fetches return corrupted payloads (missing fields, truncated data) that the agent must detect and re-fetch. Any streaming bug that corrupts content-block assembly or drops a tool_result mid-stream shows up as tool-pairing failures, checksum mismatches, or garbled output.',
  dimensions: ['streaming', 'tool-dispatch', 'context-management'],
  run,
})

async function run(profiler: ProfilerObserver) {
  let totalChunksServed = 0
  let totalCallsMade = 0
  let corruptedPayloads = 0
  let reportSubmissions = 0
  let reportValidationFailures = 0

  // Track checksums per category for validation
  const categoryChecksums: Record<string, number[]> = {}

  const chaosEnabled = process.env.CHAOS === '1'

  const fetchChunk = tool({
    name: 'fetch_data_chunk',
    description: 'Fetch a numbered data chunk. Returns structured JSON with an id, payload containing nested records with metadata, and a checksum. If the response contains "CORRUPTED" in the status field, the payload is invalid and must be re-fetched.',
    inputSchema: z.object({ chunkId: z.number(), category: z.string() }),
    callback: (input) => {
      totalCallsMade++

      // CHAOS: ~10% chance of returning a corrupted payload
      if (chaosEnabled && Math.random() < 0.1) {
        corruptedPayloads++
        // Return a corrupted payload — missing fields, truncated data
        const corrupted = JSON.stringify({
          id: input.chunkId,
          category: input.category,
          status: 'CORRUPTED',
          payload: `{"records":[{"id":${input.chunkId * 100},"val`,  // truncated mid-JSON
          checksum: -1,
          error_hint: 'CACHE_MISS: partial read, data corrupted during transfer. Re-fetch this chunk.',
        })
        return corrupted
      }

      totalChunksServed++

      // Large payload ~3000+ chars with nested objects, arrays of records, and metadata
      const records = Array.from({ length: 15 }, (_, i) => ({
        id: input.chunkId * 100 + i,
        value: `${input.category}_metric_${i}`,
        timestamp: 1719000000000 + i * 3600000,
        status: i % 3 === 0 ? 'active' : i % 3 === 1 ? 'pending' : 'archived',
        metadata: {
          source: `pipeline-${input.category}-${Math.floor(i / 5)}`,
          version: `2.${i}.0`,
          tags: [`env:prod`, `region:us-east-${(i % 3) + 1}`, `tier:${i < 5 ? 'hot' : 'cold'}`],
          dimensions: { latency_ms: 12 + i * 3, throughput_rps: 1000 - i * 50, error_rate: 0.001 * (i + 1) },
        },
        lineage: {
          parent_id: input.chunkId * 100 + i - 1,
          created_by: `worker-${input.category}-${i % 4}`,
          created_at: `2024-06-${String(10 + i).padStart(2, '0')}T08:${String(i * 3).padStart(2, '0')}:00Z`,
          transform_chain: [`ingest`, `validate`, `enrich-${input.category}`, `index`],
        },
      }))

      const payload = JSON.stringify({
        records,
        pagination: { offset: input.chunkId * 15, limit: 15, total: 150 },
        aggregates: {
          count: records.length,
          active: records.filter(r => r.status === 'active').length,
          avg_latency: records.reduce((s, r) => s + r.metadata.dimensions.latency_ms, 0) / records.length,
        },
      })

      const checksum = payload.length

      // Track for validation
      if (!categoryChecksums[input.category]) categoryChecksums[input.category] = []
      categoryChecksums[input.category].push(checksum)

      return JSON.stringify({ id: input.chunkId, category: input.category, status: 'OK', payload, checksum, served: totalChunksServed })
    },
  })

  const submitReport = tool({
    name: 'submit_report',
    description: 'Submit a summary report of processed chunks. Validates that the reported checksum total matches the server-side total for that category. Returns accepted:true if checksums match, or an error with the expected value if they do not. The agent MUST fix mismatches before proceeding.',
    inputSchema: z.object({ category: z.string(), chunkCount: z.number(), totalChecksum: z.number() }),
    callback: (input) => {
      totalCallsMade++
      reportSubmissions++

      const expectedChecksums = categoryChecksums[input.category] || []
      const expectedTotal = expectedChecksums.reduce((s, v) => s + v, 0)

      // Validate checksum — the agent must have summed correctly
      if (expectedChecksums.length > 0 && Math.abs(input.totalChecksum - expectedTotal) > 50) {
        // Allow small variance since agent may approximate, but large mismatches fail
        reportValidationFailures++
        return JSON.stringify({
          accepted: false,
          category: input.category,
          error: 'CHECKSUM_MISMATCH',
          reportedChecksum: input.totalChecksum,
          expectedChecksum: expectedTotal,
          reportedChunks: input.chunkCount,
          expectedChunks: expectedChecksums.length,
          hint: 'Re-verify your checksum calculation or re-fetch corrupted chunks.',
        })
      }

      return JSON.stringify({
        accepted: true,
        category: input.category,
        reportedChunks: input.chunkCount,
        totalChecksum: input.totalChecksum,
        systemTotal: totalChunksServed,
        validatedAt: new Date().toISOString(),
      })
    },
  })

  const agent = createAgent(profiler, {
    systemPrompt: `You are a data pipeline processor. For each category you're given, fetch ALL the chunk IDs listed (issue them in parallel when possible for speed), then submit a report with the count and total checksum (sum of all checksum values from successful fetches).

IMPORTANT RULES:
- Issue all fetch_data_chunk calls in parallel for maximum throughput.
- If any chunk response has status "CORRUPTED" or checksum -1, you MUST re-fetch that chunk — do not include corrupted checksums in your total.
- Only count and sum checksums from responses with status "OK".
- The submit_report tool validates your checksum — if it returns accepted:false, re-verify and resubmit.
- Process each category in a single pass — do not re-fetch chunks that already returned status "OK".`,
    tools: [fetchChunk, submitReport],
    windowSize: WINDOW,
  })

  const categories = [
    { name: 'metrics', chunks: [1, 2, 3, 4, 5, 6, 7, 8] },
    { name: 'logs', chunks: [10, 11, 12, 13, 14, 15, 16] },
    { name: 'traces', chunks: [20, 21, 22, 23, 24, 25, 26, 27] },
    { name: 'alerts', chunks: [30, 31, 32, 33, 34, 35, 36] },
    { name: 'configs', chunks: [40, 41, 42, 43, 44, 45, 46, 47] },
    { name: 'events', chunks: [50, 51, 52, 53, 54, 55, 56] },
    { name: 'telemetry', chunks: [60, 61, 62, 63, 64, 65, 66, 67] },
    { name: 'snapshots', chunks: [70, 71, 72, 73, 74, 75, 76] },
    { name: 'indexes', chunks: [80, 81, 82, 83, 84, 85, 86, 87] },
    { name: 'manifests', chunks: [90, 91, 92, 93, 94, 95, 96] },
  ]

  for (const cat of categories) {
    const task = `Fetch data chunks ${cat.chunks.join(', ')} for category "${cat.name}" (issue all fetch_data_chunk calls in parallel), then submit_report with the chunk count and total checksum (sum of checksum values from all OK responses).`
    profiler.recordInvocationInput(task)
    const result = await agent.invoke(task, { limits: { turns: 6 } })
    profiler.recordResult(result)
  }

  profiler.recordInvariants(
    toolPairingIntact(agent.messages),
    historyWellFormed(agent.messages),
    contextUnderWindow(agent.messages, 8),
  )

  // State oracle: every chunk should have been fetched at least once (may be more due to re-fetches).
  const expectedChunks = categories.reduce((sum, c) => sum + c.chunks.length, 0)
  profiler.recordInvariants(
    stateConsistent(
      'all-chunks-served',
      totalChunksServed >= expectedChunks,
      totalChunksServed >= expectedChunks
        ? `all ${expectedChunks} chunks served (${totalCallsMade} total tool calls, ${corruptedPayloads} corrupted payloads returned)`
        : `only ${totalChunksServed}/${expectedChunks} chunks served (${totalCallsMade} tool calls) — agent stopped short`,
    ),
    stateConsistent(
      'reports-submitted',
      reportSubmissions >= categories.length,
      reportSubmissions >= categories.length
        ? `${reportSubmissions} reports submitted for ${categories.length} categories (${reportValidationFailures} validation failures)`
        : `only ${reportSubmissions}/${categories.length} reports submitted — agent skipped submit_report`,
    ),
  )
}
