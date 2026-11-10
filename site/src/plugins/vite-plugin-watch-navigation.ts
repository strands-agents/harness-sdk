/**
 * Vite plugin that watches navigation.yml and triggers a full server restart
 * when it changes, so the Astro/Starlight sidebar and navbar stay in sync
 * during development without needing a manual restart.
 */
import path from 'node:path'
import type { Plugin } from 'vite'

const NAVIGATION_CONFIG = path.resolve('./src/config/navigation.yml')

export default function watchNavigationPlugin(): Plugin {
  return {
    name: 'vite-plugin-watch-navigation',
    configureServer(server) {
      // Tell Vite to watch the file
      server.watcher.add(NAVIGATION_CONFIG)

      server.watcher.on('change', (file) => {
        if (file === NAVIGATION_CONFIG) {
          console.log('[watch-navigation] navigation.yml changed — restarting server...')
          server.restart()
        }
      })
    },
  }
}
