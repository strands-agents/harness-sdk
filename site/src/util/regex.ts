// Source - https://stackoverflow.com/a/3561711
// Posted by bobince, modified by community. See post 'Timeline' for change history
// Retrieved 2026-03-06, License - CC BY-SA 4.0
declare global {
  interface RegExpConstructor {
    escape?: (s: string) => string
  }
}
export const escapeRegex: (s: string) => string = RegExp.escape ?? ((s) => s.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&'))

/** Build a regex that matches strings starting with a literal prefix, capturing the rest. */
export function startsWith(prefix: string): RegExp {
  return new RegExp(`^${escapeRegex(prefix)}\\/(.+)$`)
}

/** Build a regex that matches a string exactly. */
export function exactly(s: string): RegExp {
  return new RegExp(`^${escapeRegex(s)}$`)
}
