/**
 * Prepares a hand-authored diagram SVG (src/assets/diagrams/<name>.svg) for inlining
 * by <Diagram>. See .agents/references/diagrams.md for the authoring rules.
 */

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Namespaces every id in an SVG with `dg-<name>-`, along with the references to it
 * (`url(#…)` and `href="#…"`, including `xlink:href`).
 *
 * Several diagrams can share a page, and ids are page-global once the SVG is inlined.
 * Without this, `url(#arrow)` in one diagram would resolve to whichever diagram's
 * `#arrow` marker came first in the document.
 */
export function namespaceSvgIds(svg: string, name: string): string {
  const prefix = `dg-${name}-`
  return svg
    .replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
    .replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`)
}

/**
 * Turns a raw diagram SVG into markup ready to inline: strips the XML prolog and
 * comments (authoring notes), namespaces ids, and gives the root <svg> an accessible
 * name from `alt`.
 */
export function prepareDiagramSvg(raw: string, name: string, alt: string): string {
  const cleaned = raw.replace(/<\?xml[^>]*>\s*/, '').replace(/<!--[\s\S]*?-->/g, '')
  return namespaceSvgIds(cleaned, name).replace(
    /<svg\b/,
    `<svg role="img" aria-label="${escapeAttr(alt)}" focusable="false"`
  )
}
