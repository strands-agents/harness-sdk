import { startRun } from './streaming-to-the-browser-guide.js'
// --8<-- [start:nextjs_runs_route]
export const runtime = 'nodejs'

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { prompt?: unknown } | null
  const prompt = body?.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) {
    const error = 'prompt must be a non-empty string'
    return Response.json({ error }, { status: 400 })
  }
  return Response.json({ id: startRun(prompt).id }, { status: 201 })
}
// --8<-- [end:nextjs_runs_route]
