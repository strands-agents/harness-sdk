// Splits shell-style arguments without invoking a shell. A backslash only escapes whitespace, quotes,
// and backslashes so unquoted Windows paths keep their separators.
export function splitArguments(input: string): string[] {
  const values: string[] = []
  let value = ''
  let quote: "'" | '"' | undefined

  for (let index = 0; index < input.length; index++) {
    const character = input[index]!
    if (quote) {
      if (character === quote) {
        quote = undefined
      } else if (character === '\\' && quote === '"' && isEscapedCharacter(input[index + 1])) {
        value += input[++index]
      } else {
        value += character
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
    } else if (/\s/.test(character)) {
      if (value) {
        values.push(value)
        value = ''
      }
    } else if (character === '\\' && isEscapedCharacter(input[index + 1])) {
      value += input[++index]
    } else {
      value += character
    }
  }

  if (quote) {
    throw new Error('Close the quoted value and try again.')
  }
  if (value) {
    values.push(value)
  }
  return values
}

function isEscapedCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\s"'\\]/.test(character)
}
