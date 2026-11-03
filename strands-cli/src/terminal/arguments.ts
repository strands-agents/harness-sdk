// Splits shell-style arguments without invoking a shell. A backslash only escapes whitespace, quotes,
// and backslashes so unquoted Windows paths keep their separators.
export function splitArguments(input: string): string[] {
  const values: string[] = []
  let value = ''
  let started = false
  let quote: "'" | '"' | undefined

  for (let index = 0; index < input.length; index++) {
    const character = input[index]!
    const networkRoot = value === '' && input[index + 1] === '\\' && /[^\s"'\\]/.test(input[index + 2] ?? '')
    if (quote || !/\s/.test(character)) started = true
    if (quote) {
      if (character === quote) {
        quote = undefined
      } else if (character === '\\' && quote === '"' && !networkRoot && isEscapedCharacter(input[index + 1])) {
        value += input[++index]
      } else {
        value += character
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
    } else if (/\s/.test(character)) {
      if (started) {
        values.push(value)
        value = ''
        started = false
      }
    } else if (character === '\\' && !networkRoot && isEscapedCharacter(input[index + 1])) {
      value += input[++index]
    } else {
      value += character
    }
  }

  if (quote) {
    throw new Error('Close the quoted value and try again.')
  }
  if (started) {
    values.push(value)
  }
  return values
}

function isEscapedCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\s"'\\]/.test(character)
}
