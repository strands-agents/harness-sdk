declare module 'turndown-plugin-gfm' {
  import TurndownService from 'turndown'

  export function gfm(service: TurndownService): void
  export function tables(service: TurndownService): void
  export function strikethrough(service: TurndownService): void
  export function taskListItems(service: TurndownService): void
}
