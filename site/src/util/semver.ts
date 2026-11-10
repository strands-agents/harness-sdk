/**
 * Compare two version strings (e.g. "1.0.0", "1.0.0-rc.1") newest-first.
 * Numeric release components outrank a prerelease of the same number
 * (1.0.0 > 1.0.0-rc.1 > 1.0.0-rc.0); prerelease identifiers compare
 * numerically where both are numbers, else lexically. Returns >0 if `b` is
 * newer than `a` (so it sorts after, consistent with date-desc usage).
 *
 * Single source of truth: imported by both the runtime page code
 * (util/changelog.ts) and the build-time changelog generator
 * (scripts/changelog). Do not duplicate.
 */
export function compareVersionDesc(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split('-')
    return { core: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre ? pre.split('.') : null }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const d = (pb.core[i] ?? 0) - (pa.core[i] ?? 0)
    if (d !== 0) return d
  }
  // Same core: a release (no prerelease) is newer than any prerelease of it.
  if (!pa.pre && pb.pre) return -1
  if (pa.pre && !pb.pre) return 1
  if (pa.pre && pb.pre) {
    for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
      const x = pa.pre[i] ?? ''
      const y = pb.pre[i] ?? ''
      const nx = Number(x)
      const ny = Number(y)
      const d = Number.isNaN(nx) || Number.isNaN(ny) ? y.localeCompare(x) : ny - nx
      if (d !== 0) return d
    }
  }
  return 0
}
