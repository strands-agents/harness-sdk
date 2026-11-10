/**
 * Vite plugin that automatically runs `npm run sdk:generate`
 * if the SDK API docs are not present, simplifying the getting-started experience.
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Plugin } from 'vite'

function areApiDocsPresent(): boolean {
  return existsSync('.build/api-docs')
}

function run(command: string): void {
  console.log(`[sdk-setup] Running: ${command}`)
  execSync(command, { stdio: 'inherit' })
}

function setupSdks(): void {
  if (areApiDocsPresent()) return

  console.log('[sdk-setup] API docs not found — running sdk:generate...')
  run('npm run sdk:generate')
  console.log('[sdk-setup] SDK setup complete.')
}

export default function sdkSetupPlugin(): Plugin {
  return {
    name: 'vite-plugin-sdk-setup',
    enforce: 'pre',
    buildStart() {
      setupSdks()
    },
    // configureServer runs after the watcher is up (buildStart fires before it),
    // so newly generated files are picked up by Astro's content layer.
    configureServer(server) {
      setupSdks()
      server.watcher.emit('change', '.build/api-docs')
    },
  }
}
