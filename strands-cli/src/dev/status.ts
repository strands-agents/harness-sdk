import { basename } from 'node:path'

export type DevReloadState =
  | { readonly kind: 'watching' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'reloading' }
  | { readonly kind: 'reloaded' }
  | { readonly kind: 'failed'; readonly message: string }

export interface DevStatus {
  /** Agent source file, relative to the project root. */
  readonly entrypoint: string
  readonly reload: DevReloadState
}

export type DevStatusTone = 'success' | 'warning' | 'error'

export function devStatusLabel({ entrypoint, reload }: DevStatus): { text: string; tone: DevStatusTone } {
  switch (reload.kind) {
    case 'watching':
      return { text: '● dev · watching', tone: 'success' }
    case 'pending':
      return { text: '↻ reload pending', tone: 'warning' }
    case 'reloading':
      return { text: '↻ reloading', tone: 'warning' }
    case 'reloaded':
      return { text: `↻ ${basename(entrypoint)} reloaded · session kept`, tone: 'success' }
    case 'failed':
      return { text: '✗ reload failed', tone: 'error' }
  }
}
