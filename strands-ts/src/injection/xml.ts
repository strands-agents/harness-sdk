/**
 * Minimal XML escaping for folding untrusted text into an XML-shaped block.
 *
 * Memory entries and other injected content are frequently user-derived, so interpolating them raw
 * into `<entry>…</entry>` both breaks the block structurally (a stray `</entry>` or `"`) and opens a
 * stored-prompt-injection surface. These helpers are deliberately tiny — enough to keep a `<memory>`
 * block well-formed, not a general-purpose serializer. `untrustedJsonBlock` is the counterpart for a
 * JSON value read by an evaluator model: the value stays JSON, written so that it cannot contain the
 * closing delimiter.
 */

/**
 * Escapes text content for placement between XML tags: `&` (first, so later replacements are not
 * double-escaped), then `<` and `>`.
 *
 * @param value - The raw text to escape
 * @returns The escaped text, safe to place in element content
 * @internal Used by the memory default formatter
 */
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Escapes a value for placement inside a double-quoted XML attribute: the {@link escapeXmlText} rules
 * plus `"` and `'`.
 *
 * @param value - The raw attribute value to escape
 * @returns The escaped value, safe to place inside a quoted attribute
 * @internal Default-format helper; not part of the public surface.
 */
export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * Serializes a value as JSON between `<tag>` and `</tag>` delimiters. `</` is written as `<\/` and
 * non-ASCII characters as `\uXXXX`. Both parse back to the same value, so the body is ASCII and cannot
 * contain the closing delimiter.
 *
 * @param tag - The delimiter tag name
 * @param value - The JSON-serializable value to enclose
 * @returns The delimited block
 * @internal Used by the evaluator prompts of the vended interventions
 */
export function untrustedJsonBlock(tag: string, value: unknown): string {
  const body = JSON.stringify(value, null, 2)
    .replace(/<\//g, '<\\/')
    .replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `<${tag}>\n${body}\n</${tag}>`
}
